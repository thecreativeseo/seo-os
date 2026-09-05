import { z } from "zod";

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  aiError,
  summariseIssues,
  wrapUntrusted,
  type AiDiagnostic,
  type AiErrorCode,
  type AiModelProvider,
  type AiUsage,
  type EmbedRequest,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type HealthResult,
} from "@/lib/ai/provider";

/**
 * The Anthropic provider.
 *
 * The only file in the codebase that knows this vendor exists. Everything above
 * it talks to AiModelProvider, so replacing it is a change here and one line in
 * the registry.
 *
 * Structured output is obtained by declaring a single tool whose input schema is
 * the answer's schema and requiring the model to call it, in strict mode: the
 * provider then constrains generation to the schema's structure - objects are
 * objects, arrays are arrays, enums are enums, required keys are present. Plain
 * tool use turned out to be best-effort; a current model returned nine of ten
 * array fields as strings in two attempts out of three. Strict mode accepts a
 * subset of JSON Schema, so the tool schema is a projection of the canonical
 * Zod schema with the unsupported keywords removed. The canonical schema still
 * validates every answer afterwards: strict mode is an extra generation
 * constraint, never a replacement for server validation, and a shape that
 * "nearly" matches is not stored.
 *
 * The API key is read at call time and never stored on the instance beyond this
 * module, never logged, and never included in an error. Provider response bodies
 * are not stored either: they echo the request, and the request contains the
 * evidence. What a failure may carry is a structural diagnostic - stop reason,
 * block kinds, usage, and validation issues as paths, codes, types and lengths.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const contentBlock = z.union([
  z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.string() }),
]);

const responseSchema = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z.array(contentBlock).default([]),
  usage: z
    .object({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
    })
    .optional(),
});

/** HTTP status to our own vocabulary. The provider's message never travels. */
function codeForStatus(status: number): AiErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  return "provider_error";
}

/**
 * JSON Schema keywords strict tool use does not accept. They express limits the
 * canonical Zod schema enforces after the answer arrives, so nothing is lost
 * by leaving them out of what the provider sees.
 */
export const STRICT_UNSUPPORTED_KEYWORDS: readonly string[] = [
  "default",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "$schema",
];

export class AnthropicProvider implements AiModelProvider {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const noUsage: AiUsage = { inputTokens: null, outputTokens: null };
    const fail = (code: AiErrorCode, usage: AiUsage, diagnostic?: AiDiagnostic) => ({
      ok: false as const,
      error: aiError(code),
      usage,
      provider: this.name,
      model: this.model,
      ...(diagnostic ? { diagnostic } : {}),
    });
    const diagnose = (
      kind: AiDiagnostic["kind"],
      usage: AiUsage,
      fields: Partial<Omit<AiDiagnostic, "kind" | "usage">> = {},
    ): AiDiagnostic => ({
      kind,
      httpStatus: null,
      stopReason: null,
      blockKinds: [],
      issues: [],
      ...fields,
      usage,
    });

    // Trusted instruction and untrusted evidence go in separate turns, and the
    // evidence is labelled as data. See wrapUntrusted for what this does and does
    // not buy.
    const userContent = request.untrustedData
      ? `${request.task}\n\n${wrapUntrusted(request.untrustedData)}`
      : request.task;

    const body = {
      model: this.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // Sent only when a caller asks for one. Current models reject the parameter
      // outright ("`temperature` is deprecated for this model"), and a default of
      // 0 would fail every request against them.
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      system: request.system,
      messages: [{ role: "user", content: userContent }],
      tools: [
        {
          name: request.schemaName,
          description: "Return the answer in this shape. This is the only way to answer.",
          input_schema: toToolSchema(request.schema),
          // Constrained generation: the structure is enforced while the answer
          // is written, not merely requested.
          strict: true,
        },
      ],
      // Forced, not suggested: a prose answer is not an answer we can store.
      tool_choice: { type: "tool", name: request.schemaName },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return fail(
        error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable",
        noUsage,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // The body is deliberately not read. It can contain the request, and the
      // request contains the evidence. The status alone is the diagnostic.
      return fail(
        codeForStatus(response.status),
        noUsage,
        diagnose("provider_http_error", noUsage, { httpStatus: response.status }),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return fail(
        "invalid_output",
        noUsage,
        diagnose("unparseable_response", noUsage, { httpStatus: response.status }),
      );
    }

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      return fail(
        "invalid_output",
        noUsage,
        diagnose("unparseable_response", noUsage, { httpStatus: response.status }),
      );
    }

    const usage: AiUsage = {
      inputTokens: parsed.data.usage?.input_tokens ?? null,
      outputTokens: parsed.data.usage?.output_tokens ?? null,
    };
    const stopReason = parsed.data.stop_reason ?? null;
    const blockKinds = parsed.data.content.map((block) => block.type);
    const base = { httpStatus: response.status, stopReason, blockKinds };

    if (stopReason === "refusal") {
      return fail("refused", usage, diagnose("refused", usage, base));
    }

    // The output budget ran out. Whatever came back is incomplete, whether or
    // not a tool block made it through, and is reported as such rather than as
    // a shape mismatch.
    if (stopReason === "max_tokens") {
      return fail("output_truncated", usage, diagnose("output_truncated", usage, base));
    }

    const toolUse = parsed.data.content.find(
      (block): block is { type: "tool_use"; name: string; input: unknown } =>
        block.type === "tool_use",
    );

    if (!toolUse) {
      // Answered in prose despite being told not to. There is nothing to store.
      return fail("invalid_output", usage, diagnose("invalid_structured_output", usage, base));
    }

    // The model's output is validated against the canonical schema the tool
    // schema was projected from. A shape that "nearly" matches is not stored.
    const value = request.schema.safeParse(toolUse.input);
    if (!value.success) {
      return fail(
        "invalid_output",
        usage,
        diagnose("invalid_structured_output", usage, {
          ...base,
          issues: summariseIssues(value.error.issues, toolUse.input),
        }),
      );
    }

    return {
      ok: true,
      value: value.data,
      usage,
      provider: this.name,
      model: this.model,
    };
  }

  async embed(_request: EmbedRequest): Promise<EmbedResult> {
    // Anthropic does not serve an embeddings endpoint, and semantic retrieval is
    // deferred (§29). Saying so is better than returning vectors from somewhere
    // the caller did not ask for.
    return { ok: false, error: aiError("unsupported") };
  }

  async healthCheck(): Promise<HealthResult> {
    const result = await this.generateStructured({
      system: "Reply using the tool. Nothing else.",
      task: "Reply with ok.",
      schema: z.object({ ok: z.literal("ok") }),
      schemaName: "health_check",
      outputSchemaVersion: "1",
      maxOutputTokens: 64,
      timeoutMs: 20_000,
    });

    return result.ok
      ? { ok: true, provider: this.name, model: this.model }
      : { ok: false, provider: this.name, error: result.error };
  }
}

/**
 * Turns a Zod schema into a strict tool input schema.
 *
 * The canonical schema is rendered as JSON Schema for its output type (so
 * fields with defaults are required, as strict mode wants), then projected
 * onto the subset strict tool use accepts: types, enums, constants, required
 * lists, `additionalProperties: false`, item schemas and nullable unions
 * survive; length, size, numeric and pattern constraints and defaults do not.
 * Those still hold - the canonical schema checks them on the way back. The
 * root is forced to an object because a tool's input always is one.
 */
export function toToolSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  const projected = projectStrict(json) as Record<string, unknown>;

  return { type: "object", ...projected };
}

const UNSUPPORTED = new Set(STRICT_UNSUPPORTED_KEYWORDS);

/** Removes unsupported keywords everywhere in a schema tree. */
export function projectStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(projectStrict);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED.has(key)) continue;
      // `properties` and `$defs` are maps keyed by user names, which may
      // collide with keyword names; their values are schemas, their keys are not.
      out[key] =
        key === "properties" || key === "$defs"
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([name, child]) => [
                name,
                projectStrict(child),
              ]),
            )
          : projectStrict(value);
    }
    return out;
  }
  return node;
}
