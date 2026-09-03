import {
  aiError,
  type AiModelProvider,
  type EmbedRequest,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type HealthResult,
} from "@/lib/ai/provider";

/**
 * The provider used when none is configured.
 *
 * Absence of an API key is a normal state — a fresh clone, a CI run, a reviewer
 * looking around — and it must not crash the application or, worse, be papered
 * over with a plausible-looking answer. Every call fails with `not_configured`,
 * which the UI renders as "AI is not configured" and an AiRun records as a failed
 * run with a cause anyone can act on.
 *
 * The alternative, throwing at boot, would mean P0/P1/P2 stopped working the day
 * P3 shipped.
 */
export class NullProvider implements AiModelProvider {
  readonly name = "null";
  readonly model = "none";

  async generateStructured<T>(
    _request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    return {
      ok: false,
      error: aiError("not_configured"),
      usage: { inputTokens: null, outputTokens: null },
      provider: this.name,
      model: this.model,
    };
  }

  async embed(_request: EmbedRequest): Promise<EmbedResult> {
    return { ok: false, error: aiError("not_configured") };
  }

  async healthCheck(): Promise<HealthResult> {
    return { ok: false, provider: this.name, error: aiError("not_configured") };
  }
}
