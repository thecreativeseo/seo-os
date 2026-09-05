import type { DraftFinding } from "@/lib/content/constraints";
import type { ReconciledClaim } from "@/lib/content/reconcile";
import type { ContentDraftStatus } from "@/generated/prisma/client";

/**
 * The draft workflow as a person reads it (docs/P4_SPEC.md §9-§12; M4.4).
 *
 * Pure functions between the services and the screens: what a finding
 * means and what to do about it, which controls a person may use in a
 * given state and why not otherwise, how a claim's support is described
 * without evidence ids, how the drafts list is filtered, and the plain
 * sentence for each state. The screens render these; the tests read them.
 */

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type FindingSeverity = DraftFinding["severity"];

export type FindingExplanation = {
  title: string;
  /** What the server found, in the finding's own words. */
  what: string;
  /** Why it matters to the reader, the site, or QA. */
  why: string;
  /** What the person should do next. */
  next: string;
  /** Where the rule comes from, when it comes from somewhere. */
  source: string | null;
};

function quoted(text: string | undefined): string {
  return text ? ` “${text}”` : "";
}

export function describeFinding(finding: DraftFinding): FindingExplanation {
  switch (finding.kind) {
    case "PROHIBITED_CLAIM":
      return {
        title: "Prohibited claim",
        what: finding.message,
        why: "The approved Business Context forbids this claim. Publishing it would say something the business has agreed not to say.",
        next: `Remove or reword the passage${quoted(finding.excerpt)}.`,
        source: "Business Context",
      };
    case "AVOID_TOPIC":
      return {
        title: "Topic to avoid",
        what: finding.message,
        why: "The Business Context lists this as a topic the site does not cover.",
        next: `Take the topic out of the passage${quoted(finding.excerpt)}.`,
        source: "Business Context",
      };
    case "STALE_CLAIM":
      return {
        title: "Claim rests on a fact that is no longer approved",
        what: finding.message,
        why: "The Brand Fact behind this claim was revoked or is no longer approved, so nothing supports the claim any more.",
        next: `Remove the claim${quoted(finding.excerpt)}, or have the fact approved again under Brand Facts and revise.`,
        source: "Brand Fact",
      };
    case "UNSUPPORTED_NUMERIC_CLAIM":
      return {
        title: "Figure without an approved fact",
        what: finding.message,
        why: "Numbers need an approved fact behind them. QA will ask where this one comes from.",
        next: `Cite an approved Brand Fact for the figure${quoted(finding.excerpt)}, or remove it.`,
        source: null,
      };
    case "EXTERNAL_LINK_REMOVED":
      return {
        title: "External link removed",
        what: finding.message,
        why: "Generated text may only link to the targets the brief named. The link was removed; its text was kept.",
        next: finding.url
          ? `If ${finding.url} belongs here, add it by hand in a revision; it will be flagged for QA.`
          : "If the link belongs here, add it by hand in a revision; it will be flagged for QA.",
        source: "Brief link targets",
      };
    case "EXTERNAL_LINK_UNAPPROVED":
      return {
        title: "External link awaiting QA",
        what: finding.message,
        why: "A person added a link to a site the brief did not name as a target. It is kept; QA decides whether it stays.",
        next: finding.url
          ? `Nothing now. Be ready to justify ${finding.url} at QA, or replace it with an approved target.`
          : "Nothing now. Be ready to justify the link at QA, or replace it with an approved target.",
        source: "Brief link targets",
      };
    case "UNSAFE_LINK_REMOVED":
      return {
        title: "Unsafe link removed",
        what: finding.message,
        why: "The link used a scheme that cannot be published safely.",
        next: "Use an https link instead, if a link is needed at all.",
        source: null,
      };
    case "LINK_TARGET_NOT_IN_BRIEF":
      return {
        title: "Internal link outside the brief",
        what: finding.message,
        why: "The brief named the pages to link to; this page was not among them.",
        next: "Keep it if it helps the reader. QA will see it.",
        source: "Brief link targets",
      };
    case "RULE_CHECK":
      return {
        title: "SEO rule not met",
        what: finding.message,
        why: "An active SEO rule of this website is not met. Blocking rules must be met before review; others are for QA.",
        next: `Change the ${finding.field ? finding.field.replace(/_/g, " ") : "text"} so the rule is met.`,
        source: "SEO Rule",
      };
    default:
      return {
        title: "Finding",
        what: finding.message,
        why: "The server found something worth a person's attention.",
        next: "Read the message and decide.",
        source: null,
      };
  }
}

export type FindingGroups = Record<FindingSeverity, DraftFinding[]>;

export function groupFindings(findings: DraftFinding[]): FindingGroups {
  const groups: FindingGroups = { BLOCKING: [], WARNING: [], INFO: [] };
  for (const finding of findings) {
    groups[finding.severity].push(finding);
  }
  return groups;
}

export function countFindings(findings: DraftFinding[]): {
  blocking: number;
  warning: number;
  info: number;
} {
  const groups = groupFindings(findings);
  return {
    blocking: groups.BLOCKING.length,
    warning: groups.WARNING.length,
    info: groups.INFO.length,
  };
}

/** What must be fixed before review can be requested - one sentence per blocking finding. */
export function reviewBlockers(findings: DraftFinding[]): string[] {
  return findings
    .filter((finding) => finding.severity === "BLOCKING")
    .map((finding) => {
      const explained = describeFinding(finding);
      return `${explained.title}: ${explained.next}`;
    });
}

// ---------------------------------------------------------------------------
// Controls, by state and role
// ---------------------------------------------------------------------------

export type ControlsInput = {
  canWrite: boolean;
  canReview: boolean;
  draftStatus: ContentDraftStatus;
  /** The work item is still DRAFTING (later stages close the draft to changes). */
  itemDrafting: boolean;
  /** The pinned brief is still the approved version. */
  briefCurrent: boolean;
  hasRevision: boolean;
  /** The current revision has blocking findings. */
  blocking: boolean;
  aiConfigured: boolean;
};

export type DraftControls = {
  readOnly: boolean;
  readOnlyReason: string | null;
  canEdit: boolean;
  canGenerate: boolean;
  /** Why Generate is not offered, when it is not. */
  generateReason: string | null;
  canRequestReview: boolean;
  /** Why Request review is not offered or is disabled, when it is not. */
  requestReviewReason: string | null;
  canReturn: boolean;
  canStartFromNewBrief: boolean;
};

const CLOSED_STATUSES: ContentDraftStatus[] = ["SUPERSEDED", "ARCHIVED"];

/**
 * Which controls a screen shows, matching the service rules. The server
 * decides; this only keeps the screen from offering what will be refused.
 */
export function draftControls(input: ControlsInput): DraftControls {
  const closed = CLOSED_STATUSES.includes(input.draftStatus);
  const readOnlyReason = closed
    ? input.draftStatus === "SUPERSEDED"
      ? "This draft is superseded: a later draft was started from a newer approved brief. It is kept as it was and cannot be changed."
      : "This draft is archived and cannot be changed."
    : !input.itemDrafting
      ? "The work item has moved past drafting; the draft is read-only here."
      : !input.canWrite
        ? "You can read this draft. Editing needs a member's access or above."
        : null;
  const open = !closed && input.itemDrafting;
  const writer = open && input.canWrite;

  const canEdit = writer;
  const canGenerate =
    writer && input.draftStatus === "DRAFTING" && input.briefCurrent && input.aiConfigured;
  const generateReason = !writer
    ? null
    : input.draftStatus === "AWAITING_EDITOR_REVIEW"
      ? "Review has been requested. Return it to drafting, or save a revision, before generating again."
      : !input.briefCurrent
        ? "Generation against a superseded brief is closed. Start a draft from the approved version to generate again."
        : !input.aiConfigured
          ? "No AI provider is configured — write the revision by hand."
          : null;

  const canRequestReview =
    writer && input.draftStatus === "DRAFTING" && input.hasRevision && !input.blocking;
  const requestReviewReason = !writer
    ? null
    : input.draftStatus === "AWAITING_EDITOR_REVIEW"
      ? "Review has already been requested."
      : !input.hasRevision
        ? "Nothing to review yet. Generate or write a revision first."
        : input.blocking
          ? "The current revision has blocking findings. Save a revision that resolves them first."
          : null;

  return {
    readOnly: !canEdit,
    readOnlyReason,
    canEdit,
    canGenerate,
    generateReason,
    canRequestReview,
    requestReviewReason,
    canReturn: open && input.canReview && input.draftStatus === "AWAITING_EDITOR_REVIEW",
    canStartFromNewBrief: open && input.canWrite && !input.briefCurrent,
  };
}

// ---------------------------------------------------------------------------
// Claims and evidence, in words
// ---------------------------------------------------------------------------

export type RevisionClaimLike = {
  text: string;
  evidenceId: string | null;
  status: "SUPPORTED" | "UNSUPPORTED";
  reason: string | null;
};

export type ClaimStatus = "SUPPORTED" | "UNSUPPORTED" | "STALE";

export type ClaimPresentation = {
  text: string;
  status: ClaimStatus;
  /** "Approved Brand Fact", "Business Context", "No source" ... */
  source: string;
  detail: string | null;
  evidenceId: string | null;
};

const SOURCE_LABELS: Record<string, string> = {
  ctx: "Business Context",
  goal: "Business Goal",
  fact: "Brand Fact",
  rule: "SEO Rule",
  gsc: "Search Console metric",
  ga4: "Analytics metric",
  kwm: "Keyword metric",
  rank: "Ranking",
  own: "Internal link target",
  topic: "Topic",
  comp: "Competitor",
  content: "Page content",
  signal: "Signal",
  opp: "Opportunity",
  diag: "Diagnosis",
  dec: "Decision",
};

/** The kind of record an evidence id points at, as a label. */
export function evidenceSourceLabel(evidenceId: string | null | undefined): string {
  if (!evidenceId) return "No source";
  const kind = evidenceId.split(":")[0] ?? "";
  return SOURCE_LABELS[kind] ?? "Evidence record";
}

export function claimPresentation(
  claim: RevisionClaimLike,
  staleClaims: ReconciledClaim[] = [],
): ClaimPresentation {
  const stale = staleClaims.find(
    (row) =>
      (claim.evidenceId && row.evidenceId === claim.evidenceId) ||
      row.text.trim().toLowerCase() === claim.text.trim().toLowerCase(),
  );
  if (stale) {
    return {
      text: claim.text,
      status: "STALE",
      source: `${evidenceSourceLabel(stale.evidenceId)} — no longer approved`,
      detail: stale.reason,
      evidenceId: claim.evidenceId,
    };
  }
  if (claim.status === "SUPPORTED") {
    return {
      text: claim.text,
      status: "SUPPORTED",
      source: `Approved ${evidenceSourceLabel(claim.evidenceId)}`,
      detail: "This claim comes from approved business evidence.",
      evidenceId: claim.evidenceId,
    };
  }
  return {
    text: claim.text,
    status: "UNSUPPORTED",
    source: claim.evidenceId
      ? `${evidenceSourceLabel(claim.evidenceId)} — not accepted`
      : "No source",
    detail: claim.reason,
    evidenceId: claim.evidenceId,
  };
}

/** A content hash, short enough to sit in a sentence. */
export function shortHash(hash: string | null | undefined, keep = 12): string {
  if (!hash) return "—";
  const [prefix, value] = hash.includes(":") ? hash.split(":", 2) : ["", hash];
  const body = value ?? "";
  return `${prefix ? `${prefix}:` : ""}${body.length > keep ? `${body.slice(0, keep)}…` : body}`;
}

// ---------------------------------------------------------------------------
// The drafts list
// ---------------------------------------------------------------------------

export const DRAFT_STATUS_FILTERS = [
  "all",
  "DRAFTING",
  "AWAITING_EDITOR_REVIEW",
  "SUPERSEDED",
] as const;
export type DraftStatusFilter = (typeof DRAFT_STATUS_FILTERS)[number];
export const DRAFT_AUTHOR_FILTERS = ["all", "AI", "HUMAN"] as const;
export type DraftAuthorFilter = (typeof DRAFT_AUTHOR_FILTERS)[number];

export type DraftFilters = {
  status: DraftStatusFilter;
  contentType: string;
  blocking: boolean;
  awaitingReview: boolean;
  superseded: boolean;
  author: DraftAuthorFilter;
};

export const DEFAULT_DRAFT_FILTERS: DraftFilters = {
  status: "all",
  contentType: "all",
  blocking: false,
  awaitingReview: false,
  superseded: false,
  author: "all",
};

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "on";
}

export function parseDraftFilters(query: Record<string, string | undefined>): DraftFilters {
  const status = DRAFT_STATUS_FILTERS.includes(query.status as DraftStatusFilter)
    ? (query.status as DraftStatusFilter)
    : "all";
  const author = DRAFT_AUTHOR_FILTERS.includes(query.author as DraftAuthorFilter)
    ? (query.author as DraftAuthorFilter)
    : "all";
  const contentType = query.type && /^[A-Z_]{1,40}$/.test(query.type) ? query.type : "all";
  return {
    status,
    contentType,
    blocking: flag(query.blocking),
    awaitingReview: flag(query.awaiting),
    superseded: flag(query.superseded),
    author,
  };
}

export function draftFiltersToQuery(filters: DraftFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.status !== "all") query.status = filters.status;
  if (filters.contentType !== "all") query.type = filters.contentType;
  if (filters.blocking) query.blocking = "1";
  if (filters.awaitingReview) query.awaiting = "1";
  if (filters.superseded) query.superseded = "1";
  if (filters.author !== "all") query.author = filters.author;
  return query;
}

export type DraftListRowLike = {
  status: ContentDraftStatus;
  contentType: string | null;
  blocking: boolean;
  authorKind: "AI" | "HUMAN" | null;
};

export function applyDraftFilters<T extends DraftListRowLike>(
  rows: T[],
  filters: DraftFilters,
): T[] {
  return rows.filter((row) => {
    if (filters.status !== "all" && row.status !== filters.status) return false;
    if (filters.contentType !== "all" && row.contentType !== filters.contentType) return false;
    if (filters.blocking && !row.blocking) return false;
    if (filters.awaitingReview && row.status !== "AWAITING_EDITOR_REVIEW") return false;
    if (filters.superseded && row.status !== "SUPERSEDED") return false;
    if (filters.author !== "all" && row.authorKind !== filters.author) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// States, in plain English
// ---------------------------------------------------------------------------

export type DraftStateKind =
  | "no_drafts"
  | "no_provider"
  | "generation_in_progress"
  | "generation_failed"
  | "no_revision"
  | "blocking"
  | "awaiting_review"
  | "newer_brief"
  | "superseded"
  | "stale_evidence";

export type DraftStateText = { title: string; body: string };

export function draftStateText(
  kind: DraftStateKind,
  detail: { briefVersion?: number; approvedVersion?: number; count?: number } = {},
): DraftStateText {
  switch (kind) {
    case "no_drafts":
      return {
        title: "No drafts yet",
        body: "A draft starts from an approved brief. Open a work item whose brief is approved and choose Start drafting.",
      };
    case "no_provider":
      return {
        title: "No AI provider is configured",
        body: "No AI provider is configured — write the first revision by hand. Generated drafts arrive once an API key is added under Settings.",
      };
    case "generation_in_progress":
      return {
        title: "A draft is being generated",
        body: "A generation for this work item is already running. Wait for it to finish, then reload; a second one will not start meanwhile.",
      };
    case "generation_failed":
      return {
        title: "The draft could not be generated",
        body: "Nothing was stored. The run is recorded with its reason under AI runs; try again, or write the revision by hand.",
      };
    case "no_revision":
      return {
        title: "No revision yet",
        body: "Generate the first draft from the brief, or write it by hand. Either way it becomes revision 1.",
      };
    case "blocking":
      return {
        title: `${detail.count ?? "Some"} blocking finding${detail.count === 1 ? "" : "s"}`,
        body: "The current revision cannot go for review until a new revision resolves them. The findings say what to change.",
      };
    case "awaiting_review":
      return {
        title: "Review requested",
        body: "An editor with SEO lead access or above reviews the current revision. Saving a new revision sends the draft back to drafting.",
      };
    case "newer_brief":
      return {
        title: `This draft is based on Brief v${detail.briefVersion ?? "?"}. Brief v${detail.approvedVersion ?? "?"} is now approved.`,
        body: "The draft was not moved. Generation against the older brief is closed; hand-written revisions are still allowed. Start a draft from the new version to work from it - this draft and every revision are kept.",
      };
    case "superseded":
      return {
        title: "Superseded draft",
        body: "A later draft was started from a newer approved brief. Everything here is kept as it was and can be read, but not changed.",
      };
    case "stale_evidence":
      return {
        title: `${detail.count ?? "Some"} brief claim${detail.count === 1 ? "" : "s"} no longer supported`,
        body: "A fact the approved brief relied on has since been revoked. Those claims were not offered to the writer and must not appear in the draft.",
      };
  }
}

/** The length a draft is asked for, by work type - the same words the task uses. */
export function targetLengthFor(workType: string): string {
  return workType === "TITLE_META_UPDATE"
    ? "A title, meta title, meta description and a short body of 150-300 words"
    : "900-1,500 words";
}
