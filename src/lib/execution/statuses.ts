import type {
  ContentBriefStatus,
  ContentDraftStatus,
  ContentWorkItemStatus,
  ExecutionStatus,
  PublishApprovalStatus,
} from "@/generated/prisma/client";

/**
 * The P4 state machines (docs/P4_SPEC.md §6, §7, §9, §21, §24), as data.
 *
 * Every transition a service may make is listed here and nowhere else, so a
 * status can only move along an edge somebody wrote down. A terminal state has
 * no edges out. The tables are exhaustive over their enums; the unit tests
 * check that against the generated client, so adding a status without deciding
 * where it can go fails the build rather than silently becoming a dead end.
 */

type Transitions<S extends string> = Readonly<Record<S, readonly S[]>>;

/**
 * Work items (§6). The status is a projection of the item's children, written
 * by the service in the same transaction as the child change.
 *
 * Verification (D5): PUBLISHED → VERIFYING while checks run; VERIFIED when
 * they pass; back to PUBLISHED - the content is live - when they do not, with
 * the execution left VERIFYING and its issue open.
 */
export const WORK_ITEM_TRANSITIONS: Transitions<ContentWorkItemStatus> = {
  QUEUED: ["BRIEFING", "CANCELLED", "ARCHIVED"],
  BRIEFING: ["DRAFTING", "CANCELLED", "ARCHIVED"],
  DRAFTING: ["QA", "CANCELLED", "ARCHIVED"],
  QA: ["AWAITING_EDITOR_REVIEW", "DRAFTING", "CANCELLED", "ARCHIVED"],
  AWAITING_EDITOR_REVIEW: ["APPROVED_FOR_CMS", "DRAFTING", "QA", "CANCELLED", "ARCHIVED"],
  APPROVED_FOR_CMS: ["CMS_DRAFT_CREATED", "QA", "CANCELLED", "ARCHIVED"],
  CMS_DRAFT_CREATED: ["AWAITING_PUBLISH_APPROVAL", "QA", "CANCELLED", "ARCHIVED"],
  AWAITING_PUBLISH_APPROVAL: ["PUBLISHING", "CMS_DRAFT_CREATED", "QA", "CANCELLED", "ARCHIVED"],
  PUBLISHING: ["PUBLISHED", "FAILED"],
  PUBLISHED: ["VERIFYING", "ARCHIVED"],
  VERIFYING: ["VERIFIED", "PUBLISHED"],
  VERIFIED: ["ARCHIVED"],
  FAILED: ["CMS_DRAFT_CREATED", "CANCELLED", "ARCHIVED"],
  CANCELLED: [],
  ARCHIVED: [],
};

/** Work items a person may still be waiting on. Mirrors the SQL partial index. */
export const OPEN_WORK_ITEM_STATUSES: readonly ContentWorkItemStatus[] = [
  "QUEUED",
  "BRIEFING",
  "DRAFTING",
  "QA",
  "AWAITING_EDITOR_REVIEW",
  "APPROVED_FOR_CMS",
  "CMS_DRAFT_CREATED",
  "AWAITING_PUBLISH_APPROVAL",
  "PUBLISHING",
  "PUBLISHED",
  "VERIFYING",
  "VERIFIED",
  "FAILED",
];

/** Briefs (§7). An approved version can only be superseded or archived. */
export const BRIEF_TRANSITIONS: Transitions<ContentBriefStatus> = {
  DRAFT: ["AWAITING_REVIEW", "APPROVED", "ARCHIVED"],
  AWAITING_REVIEW: ["APPROVED", "DRAFT", "ARCHIVED"],
  APPROVED: ["SUPERSEDED", "ARCHIVED"],
  SUPERSEDED: ["ARCHIVED"],
  ARCHIVED: [],
};

/** Drafts (§9). A new revision on an approved draft sends it back to QA. */
export const DRAFT_TRANSITIONS: Transitions<ContentDraftStatus> = {
  DRAFTING: ["AWAITING_EDITOR_REVIEW", "AWAITING_QA", "SUPERSEDED", "ARCHIVED"],
  AWAITING_QA: ["AWAITING_EDITOR_REVIEW", "DRAFTING", "SUPERSEDED", "ARCHIVED"],
  AWAITING_EDITOR_REVIEW: [
    "DRAFTING",
    "APPROVED",
    "REJECTED",
    "AWAITING_QA",
    "SUPERSEDED",
    "ARCHIVED",
  ],
  APPROVED: ["AWAITING_QA", "SUPERSEDED", "ARCHIVED"],
  REJECTED: ["DRAFTING", "SUPERSEDED", "ARCHIVED"],
  SUPERSEDED: ["ARCHIVED"],
  ARCHIVED: [],
};

/**
 * Executions (§21). Draft executions go READY → EXECUTING; publish executions
 * pass through AWAITING_APPROVAL. VERIFYING has one exit: VERIFIED. A failed
 * check keeps it there, with the issue open, until a later attempt passes or
 * a person resolves it (D5). ROLLED_BACK is a manual operation for a later
 * phase; P4 ships no automatic rollback.
 */
export const EXECUTION_TRANSITIONS: Transitions<ExecutionStatus> = {
  PROPOSED: ["READY", "CANCELLED"],
  READY: ["EXECUTING", "AWAITING_APPROVAL", "PROPOSED", "CANCELLED"],
  AWAITING_APPROVAL: ["APPROVED", "READY", "CANCELLED"],
  APPROVED: ["EXECUTING", "CANCELLED"],
  EXECUTING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: ["VERIFYING"],
  VERIFYING: ["VERIFIED"],
  VERIFIED: ["ROLLED_BACK"],
  FAILED: ["READY", "APPROVED", "CANCELLED"],
  CANCELLED: [],
  ROLLED_BACK: [],
};

/** Executions that hold their slot: one per (work item, type). Mirrors the SQL partial index. */
export const ACTIVE_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "PROPOSED",
  "READY",
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTING",
];

/** Publish approvals (§24). A decided approval never changes again. */
export const APPROVAL_TRANSITIONS: Transitions<PublishApprovalStatus> = {
  REQUESTED: ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"],
  APPROVED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransition<S extends string>(table: Transitions<S>, from: S, to: S): boolean {
  return table[from].includes(to);
}

export function isTerminal<S extends string>(table: Transitions<S>, status: S): boolean {
  return table[status].length === 0;
}

export function terminalStatuses<S extends string>(table: Transitions<S>): S[] {
  return (Object.keys(table) as S[]).filter((status) => isTerminal(table, status));
}
