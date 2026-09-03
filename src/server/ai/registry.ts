import type { AiModelProvider } from "@/lib/ai/provider";
import { AnthropicProvider } from "@/server/ai/providers/anthropic";
import { NullProvider } from "@/server/ai/providers/null";
import { StubProvider, type StubOptions } from "@/server/ai/providers/stub";

/**
 * Choosing the provider (docs/P3_SPEC.md §6).
 *
 * The one place a vendor is named outside its own file. It reads
 * ANTHROPIC_API_KEY, so it must never be reached from a client component: the key
 * is not NEXT_PUBLIC_ and would be undefined there, but the rule is about intent,
 * not about what happens to work.
 *
 * Resolution, in order:
 *
 *   AI_PROVIDER=stub      the scripted provider, for tests and Demo Mode
 *   AI_PROVIDER=null      explicitly disabled
 *   ANTHROPIC_API_KEY set Anthropic
 *   otherwise             NullProvider
 *
 * The default when nothing is configured is a provider that fails cleanly, never
 * one that improvises. A missing key should read as "AI is not configured", not
 * as a diagnosis nobody can source.
 */

export const DEFAULT_MODEL = "claude-sonnet-5";

let cached: AiModelProvider | undefined;

export function resolveProvider(): AiModelProvider {
  if (cached) return cached;

  cached = build();
  return cached;
}

function build(): AiModelProvider {
  const configured = process.env.AI_PROVIDER?.trim().toLowerCase();

  if (configured === "stub") return new StubProvider();
  if (configured === "null") return new NullProvider();

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return new NullProvider();

  const model = process.env.AI_DIAGNOSIS_MODEL?.trim() || DEFAULT_MODEL;

  return new AnthropicProvider(apiKey, model);
}

/**
 * Whether the product can run a diagnosis at all.
 *
 * Used by the UI to explain why the button is disabled, instead of letting
 * somebody press it and receive a failure they cannot interpret.
 */
export function isAiConfigured(): boolean {
  return resolveProvider().name !== "null";
}

/** Replaces the provider. Tests and Demo Mode only. */
export function setProvider(provider: AiModelProvider): void {
  cached = provider;
}

/** Installs a scripted provider and hands it back for assertions. */
export function useStubProvider(options: StubOptions = {}): StubProvider {
  const stub = new StubProvider(options);
  cached = stub;
  return stub;
}

/** Forgets the cached provider, so the next call re-reads the environment. */
export function resetProvider(): void {
  cached = undefined;
}
