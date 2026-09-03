import {
  aiError,
  wrapUntrusted,
  type AiErrorCode,
  type AiModelProvider,
  type EmbedRequest,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type HealthResult,
} from "@/lib/ai/provider";

/**
 * A provider that answers from a script.
 *
 * Two jobs. In tests it makes the diagnosis pipeline provable without a network:
 * the assembler, the evidence validator, the guardrails and the review flow can
 * all be exercised against a known answer, including answers that are wrong on
 * purpose — a finding citing an evidence ID from another tenant, a
 * recommendation with no citation, a forecast in a summary. Those cases are the
 * point. They cannot be produced reliably by asking a real model to misbehave.
 *
 * In Demo Mode it lets the flagship story run without a live call, which matters
 * on a conference network.
 *
 * It validates its own scripted answers against the caller's schema, so a fixture
 * that drifts away from the schema fails in the test that uses it rather than
 * quietly returning a shape the rest of the code cannot read.
 *
 * What it never does is invent an answer. With no script it fails with
 * `not_configured`, because a stub that improvised would put fabricated findings
 * in front of somebody who thought the feature worked.
 */

export type StubResponder = (request: GenerateStructuredRequest<unknown>) => unknown;

export type StubOptions = {
  /** Answers, consumed in order. Each is validated against the request's schema. */
  responses?: unknown[];
  /** Or a function, for answers that depend on the request. */
  respond?: StubResponder;
  /** Fail instead of answering, to exercise the error paths. */
  failWith?: AiErrorCode;
  /** Reported on every result, so cost and token accounting can be tested. */
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
};

export type RecordedRequest = {
  system: string;
  task: string;
  untrustedData?: string;
  /** Exactly what a vendor implementation would send as the user turn. */
  renderedUserContent: string;
  schemaName: string;
  outputSchemaVersion: string;
};

export class StubProvider implements AiModelProvider {
  readonly name = "stub";
  readonly model: string;

  /** Every request, in order. Tests assert against this. */
  readonly requests: RecordedRequest[] = [];

  private readonly queue: unknown[];

  constructor(private readonly options: StubOptions = {}) {
    this.model = options.model ?? "stub-1";
    this.queue = [...(options.responses ?? [])];
  }

  async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    // Recorded before any early return, so a failing call is still observable.
    this.requests.push({
      system: request.system,
      task: request.task,
      untrustedData: request.untrustedData,
      renderedUserContent: request.untrustedData
        ? `${request.task}\n\n${wrapUntrusted(request.untrustedData)}`
        : request.task,
      schemaName: request.schemaName,
      outputSchemaVersion: request.outputSchemaVersion,
    });

    const usage = {
      inputTokens: this.options.usage?.inputTokens ?? null,
      outputTokens: this.options.usage?.outputTokens ?? null,
    };

    const fail = (code: AiErrorCode) => ({
      ok: false as const,
      error: aiError(code),
      usage,
      provider: this.name,
      model: this.model,
    });

    if (this.options.failWith) return fail(this.options.failWith);

    const scripted = this.options.respond
      ? this.options.respond(request as GenerateStructuredRequest<unknown>)
      : this.queue.shift();

    // Out of script. Not an answer we are willing to invent.
    if (scripted === undefined) return fail("not_configured");

    const parsed = request.schema.safeParse(scripted);

    if (!parsed.success) {
      // A fixture that no longer matches its schema. Surfaced as invalid_output
      // rather than cast, so the test that relies on it is the test that fails.
      return fail("invalid_output");
    }

    return { ok: true, value: parsed.data, usage, provider: this.name, model: this.model };
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    // Deterministic, and not pretending to be meaningful: these vectors encode
    // nothing about the text beyond its identity. Semantic retrieval is deferred,
    // and a stub that returned convincing-looking vectors would make a broken
    // retrieval implementation look like it worked.
    return {
      ok: true,
      model: this.model,
      usage: { inputTokens: null, outputTokens: null },
      vectors: request.texts.map((text) => [hash(text) / 0xffffffff]),
    };
  }

  async healthCheck(): Promise<HealthResult> {
    return this.options.failWith
      ? { ok: false, provider: this.name, error: aiError(this.options.failWith) }
      : { ok: true, provider: this.name, model: this.model };
  }
}

function hash(value: string): number {
  let result = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619) >>> 0;
  }

  return result;
}
