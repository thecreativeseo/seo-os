import type { AiDiagnostic } from "@/lib/ai/provider";

/**
 * Development-only diagnostics for failed AI runs.
 *
 * A failed structured-output call is recorded on its AiRun with a code from
 * our vocabulary and nothing else, because a provider's response echoes the
 * evidence. That is right for production and useless for a developer who
 * needs to know which field came back as a string. This module logs, outside
 * production only, a summary that is safe by construction: identifiers,
 * versions, stop reason, block kinds, token counts, and validation issues as
 * path, code, expected constraint, received type and received length. No
 * model text, no evidence, no prompt, no key, no provider message.
 */

export type AiDiagnosticEvent = {
  event:
    | "AI_STRUCTURED_OUTPUT_INVALID"
    | "AI_OUTPUT_TRUNCATED"
    | "AI_PROVIDER_ERROR"
    | "AI_PROVIDER_REFUSED";
  runId: string;
  provider: string;
  model: string;
  agentType: string;
  taskType: string;
  promptVersion: number | null;
  outputSchemaVersion: string;
  errorCode: string;
  httpStatus: number | null;
  stopReason: string | null;
  blockKinds: string[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  issues: AiDiagnostic["issues"];
};

export function diagnosticEventFor(kind: AiDiagnostic["kind"]): AiDiagnosticEvent["event"] {
  switch (kind) {
    case "output_truncated":
      return "AI_OUTPUT_TRUNCATED";
    case "provider_http_error":
      return "AI_PROVIDER_ERROR";
    case "refused":
      return "AI_PROVIDER_REFUSED";
    default:
      return "AI_STRUCTURED_OUTPUT_INVALID";
  }
}

/** True outside production. The switch is the environment, not a flag someone forgets. */
export function aiDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production";
}

/** One line, machine-readable, and containing only what the type allows. */
export function formatAiDiagnostic(event: AiDiagnosticEvent): string {
  return JSON.stringify(event);
}

export function logAiDiagnostic(
  event: AiDiagnosticEvent,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!aiDiagnosticsEnabled(env)) return;
  console.warn(`[ai-diagnostic] ${formatAiDiagnostic(event)}`);
}
