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
  // M6.1. Refusals that happen before any external call, and the two answers
  // about an attempt whose outcome we could not observe.
  "forbidden",
  "not_configured",
  "connection_disabled",
  "invalid_site_url",
  "target_type_unresolved",
  "already_executed",
  "execution_in_progress",
  "execution_cancelled",
  "ambiguous_timeout",
  "reconciled_absent",
  // M6.2. What a provider call can come back as. Named for the condition
  // rather than the remedy, because the remedy differs by whether the CMS
  // was reached and whether it did anything.
  "auth_required",
  "target_invalid",
  "cms_unreachable",
  "cms_permission_denied",
  "cms_client_error",
  "cms_server_error",
  "cms_invalid_response",
  "create_ambiguous",
  "entity_not_found",
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
  forbidden: "This is done by a person with the right role, and not by a job.",
  not_configured: "No CMS connection is set up for this website yet.",
  connection_disabled: "The CMS connection is not currently connected.",
  invalid_site_url: "The CMS connection does not have a usable site address.",
  target_type_unresolved: "Choose whether this should be a post or a page first.",
  already_executed: "This work already has a CMS draft.",
  execution_in_progress: "A CMS action for this work is already running.",
  execution_cancelled: "This CMS action was cancelled and cannot be run again.",
  ambiguous_timeout: "We could not tell whether the CMS created this. It needs reconciling.",
  reconciled_absent: "We checked the CMS and it created nothing, so this is safe to try again.",
  auth_required: "The CMS connection has no usable credentials.",
  target_invalid: "The CMS does not offer that kind of content here.",
  cms_unreachable: "The CMS could not be reached, and nothing was sent.",
  cms_permission_denied: "The connected CMS user is not allowed to create this.",
  cms_client_error: "The CMS refused the request.",
  cms_server_error: "The CMS failed while handling the request.",
  cms_invalid_response: "The CMS answered in a form we did not recognise.",
  create_ambiguous: "We could not tell whether the CMS created this. It needs reconciling.",
  entity_not_found: "The CMS no longer holds the item this execution created.",
};

/**
 * The failures that prove no external entity can exist (M6 plan D10, D11).
 *
 * A new attempt is only safe when we know the last one changed nothing. That is
 * a short list, and everything not on it is treated as unsafe: an answer we
 * could not parse, a timeout, a 500 all leave open the possibility that a post
 * was created and we did not hear about it. Retrying those risks a duplicate in
 * somebody's CMS, which is not recoverable by us.
 *
 * reconciled_absent is on the list because it is the only code that means we
 * went and looked. It is written by reconciliation, never inferred.
 */
export const RETRY_SAFE_FAILURE_CODES: readonly ExecutionErrorCode[] = [
  "connection_failed",
  "unauthorized",
  "capability_missing",
  "policy_denied",
  "rate_limited",
  "not_configured",
  "connection_disabled",
  "invalid_site_url",
  "reconciled_absent",
  // M6.2. Each of these is a refusal, not an attempt: either nothing was
  // sent, or the CMS declined before it could create anything. A 5xx, a
  // client error we could not classify, an unreadable answer and a timeout
  // are all absent from this list on purpose.
  "auth_required",
  "target_invalid",
  "cms_unreachable",
  "cms_permission_denied",
];

/**
 * Whether a failed attempt may be tried again.
 *
 * Default deny: a code that is not on the safe list, including one we do not
 * recognise, means the outcome is unresolved and a person or a reconciliation
 * has to settle it first.
 */
export function isRetrySafeFailure(code: string | null): boolean {
  if (code === null) return false;
  return (RETRY_SAFE_FAILURE_CODES as readonly string[]).includes(code);
}

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
