/**
 * The fixed error table for executions (docs/P4_SPEC.md §29).
 *
 * A code is what a row stores and a person reads; the sentence beside it is
 * ours. A provider's own message never becomes an errorSummary: it echoes the
 * request, and a request can carry things that must not be shown or logged.
 */

export const EXECUTION_ERROR_CODES = [
  "connection_failed",
  "unauthorized",
  "capability_missing",
  "not_found",
  "rate_limited",
  "invalid_response",
  "policy_denied",
  "qa_blocked",
  "stale_approval",
  "approval_missing",
  "verification_failed",
  "content_mismatch",
] as const;

export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number];

export const EXECUTION_ERROR_MESSAGES: Record<ExecutionErrorCode, string> = {
  connection_failed: "The CMS could not be reached.",
  unauthorized: "The CMS rejected the connection's credentials. Reconnect to continue.",
  capability_missing: "The connected CMS user is not allowed to do this.",
  not_found: "The CMS no longer has the item this execution refers to.",
  rate_limited: "The CMS asked us to slow down. Try again in a few minutes.",
  invalid_response: "The CMS answered in a form we did not recognise.",
  policy_denied: "The publishing policy does not allow this.",
  qa_blocked: "A blocking QA issue must be resolved first.",
  stale_approval: "The approval was for a different revision. Request approval again.",
  approval_missing: "This needs a publish approval before it can run.",
  verification_failed: "Published, but the live page did not match what was approved.",
  content_mismatch: "The CMS holds different content from the approved revision.",
};

export class ExecutionError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    message: string = EXECUTION_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export function isExecutionErrorCode(value: string): value is ExecutionErrorCode {
  return (EXECUTION_ERROR_CODES as readonly string[]).includes(value);
}
