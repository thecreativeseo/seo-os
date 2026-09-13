import type { CmsEntityType, ExecutionStatus } from "@/generated/prisma/client";

/**
 * What a person is told about a CMS execution (M6.4 §13).
 *
 * The backend states are precise and the words for them have to be too, because
 * the four distinctions that matter here are exactly the ones a hurried reader
 * collapses:
 *
 *   a draft is not a published page
 *   created is not verified
 *   approved for the CMS is not executed
 *   written by a model is not approved by a person
 *
 * So there is no label here that could be read as "live", and none that treats
 * "we made it" and "we checked it" as the same event.
 */

/**
 * The word a person's confirmation must carry to create a draft (M6.4 §16).
 *
 * Lives here rather than in the service so the control and the server share
 * one literal. The browser sends it; the server compares it. Only the
 * comparison decides anything.
 */
export const CREATE_WORDPRESS_DRAFT = "CREATE_WORDPRESS_DRAFT";

export type CmsDraftState =
  | "READY"
  | "CREATING"
  | "CREATED"
  | "VERIFIED"
  | "VERIFICATION_FAILED"
  | "RECONCILIATION_REQUIRED"
  | "RETRY_PERMITTED"
  | "REFUSED"
  | "NONE";

export const CMS_DRAFT_STATE_LABELS: Record<CmsDraftState, string> = {
  READY: "Ready to create",
  CREATING: "Creating draft",
  CREATED: "Draft created",
  VERIFIED: "Verified",
  VERIFICATION_FAILED: "Verification failed",
  RECONCILIATION_REQUIRED: "Reconciliation required",
  RETRY_PERMITTED: "Retry permitted",
  REFUSED: "Refused",
  NONE: "Not started",
};

/** One sentence saying what the state means, and what it does not. */
export const CMS_DRAFT_STATE_MESSAGES: Record<CmsDraftState, string> = {
  READY: "Approved for the CMS. Nothing has been sent to WordPress yet.",
  CREATING: "A draft is being created in WordPress now.",
  CREATED: "WordPress holds a draft. It has not been confirmed to match the approved revision.",
  VERIFIED: "WordPress holds a draft that matches the approved revision. It is not published.",
  VERIFICATION_FAILED:
    "The draft exists in WordPress, but it does not match the approved revision. No second draft will be created.",
  RECONCILIATION_REQUIRED:
    "SEO OS cannot prove whether WordPress created a draft. Reconcile before trying again.",
  RETRY_PERMITTED: "Nothing was created in WordPress, so this can be attempted again.",
  REFUSED: "The attempt was refused before anything was sent to WordPress.",
  NONE: "No CMS execution exists for this work yet.",
};

/** What a person may usefully do next. The screen offers only these. */
export type CmsDraftAction = "CREATE" | "RECONCILE" | "REVERIFY" | "NONE";

export const CMS_DRAFT_ACTION_LABELS: Record<Exclude<CmsDraftAction, "NONE">, string> = {
  CREATE: "Create WordPress Draft",
  RECONCILE: "Reconcile WordPress Draft",
  REVERIFY: "Re-verify WordPress Draft",
};

export const TARGET_LABELS: Record<CmsEntityType, string> = {
  POST: "Post",
  PAGE: "Page",
};

/**
 * The state of an execution, read from its own row.
 *
 * `unresolved` comes from the service that owns the rule — an execution whose
 * outcome nobody can state — rather than being re-derived from the status here,
 * so the screen and the action can never disagree about whether a create is
 * allowed.
 */
export function cmsDraftState(
  execution: {
    status: ExecutionStatus;
    externalEntityId: string | null;
    errorCode: string | null;
  } | null,
  options: { unresolved: boolean; retrySafe: boolean; approvedForCms?: boolean },
): CmsDraftState {
  // Approved, with nothing sent yet, is the state most people arrive to act
  // on. Calling that "not started" would be true and useless.
  if (!execution) return options.approvedForCms ? "READY" : "NONE";

  if (options.unresolved && execution.externalEntityId === null) {
    return "RECONCILIATION_REQUIRED";
  }

  switch (execution.status) {
    case "VERIFIED":
      return "VERIFIED";
    case "VERIFYING":
      // The draft exists; the checks either failed or could not be made.
      return execution.errorCode ? "VERIFICATION_FAILED" : "CREATED";
    case "SUCCEEDED":
      return "CREATED";
    case "EXECUTING":
      return "CREATING";
    case "READY":
    case "PROPOSED":
    case "APPROVED":
    case "AWAITING_APPROVAL":
      return "READY";
    case "FAILED":
      return options.retrySafe ? "RETRY_PERMITTED" : "RECONCILIATION_REQUIRED";
    default:
      return "REFUSED";
  }
}

/** What the CMS did with the entity, said without implying it is live. */
export function externalStatusLabel(status: string | null): string {
  if (!status) return "Unknown";
  if (status.toLowerCase() === "draft") return "Draft";
  // Anything else is worth naming exactly, because it is not what we asked for.
  return status;
}

/** A revision hash, shortened for a person, never presented as meaningful text. */
export function shortRevisionHash(hash: string): string {
  const value = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  return value.slice(0, 12);
}
