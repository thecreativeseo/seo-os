import { z } from "zod";

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  aiError,
  wrapUntrusted,
  type AiModelProvider,
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
 * the answer's schema and requiring the model to call it. Asking for JSON in the
 * prose and parsing what comes back works until the day it does not, and the day
 * it does not is the day a diagnosis silently loses its evidence IDs. The schema
 * is generated from the caller's Zod schema, so validation and the tool contract
 * cannot drift apart.
 *
 * The API key is read at call time and never stored on the instance beyond this
 * module, never logged, and never included in an error. Provider response bodies
 * are not stored either: they echo the request, and the request contains the
 * evidence.
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
function codeForStatus(status: number) {
  if (status === 401 || status === 403) return "unauthorized" as const;
  if (status === 429) return "rate_limited" as const;
  if (status === 529) return "overloaded" as const;
  if (status >= 500) return "provider_error" as const;
  return "provider_error" as const;
}

export class AnthropicProvider implements AiModelProvider {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const usage = { inputTokens: null, outputTokens: null };
    const fail = (code: Parameters<typeof aiError>[0]) => ({
      ok: false as const,
      error: aiError(code),
      usage,
      provider: this.name,
      model: this.model,
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
        },
      ],
      // Forced, not suggested: a prose answer is not an answer we can store.
      tool_choice: { type: "tool", name: request.schemaName },
    };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

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
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // The body is deliberately not read. It can contain the request, and the
      // request contains the evidence.
      return fail(codeForStatus(response.status));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return fail("invalid_output");
    }

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) return fail("invalid_output");

    const reported = {
      inputTokens: parsed.data.usage?.input_tokens ?? null,
      outputTokens: parsed.data.usage?.output_tokens ?? null,
    };

    const withUsage = (code: Parameters<typeof aiError>[0]) => ({
      ok: false as const,
      error: aiError(code),
      usage: reported,
      provider: this.name,
      model: this.model,
    });

    if (parsed.data.stop_reason === "refusal") return withUsage("refused");

    const toolUse = parsed.data.content.find(
      (block): block is { type: "tool_use"; name: string; input: unknown } =>
        block.type === "tool_use",
    );

    if (!toolUse) {
      // Ran out of tokens mid-answer, or answered in prose despite being told not
      // to. Either way there is nothing to store.
      return withUsage(
        parsed.data.stop_reason === "max_tokens" ? "invalid_output" : "invalid_output",
      );
    }

    // The model's output is validated against the same schema the tool was built
    // from. A shape that "nearly" matches is not stored.
    const value = request.schema.safeParse(toolUse.input);
    if (!value.success) return withUsage("invalid_output");

    return {
      ok: true,
      value: value.data,
      usage: reported,
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
 * Turns a Zod schema into a tool input schema.
 *
 * `$schema` is dropped because the API rejects the key, and the root is forced to
 * an object because a tool's input always is one.
 */
export function toToolSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = json;

  return { type: "object", ...rest };
}
