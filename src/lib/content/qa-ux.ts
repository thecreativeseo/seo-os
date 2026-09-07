import type { ContentQaType } from "@/generated/prisma/client";
import type { NotCheckedReason, QaFinding, QaSeverity } from "@/lib/content/qa/findings";

/**
 * QA in words (M5.4). The screens read from here, so what a person sees is
 * decided in one place and can be tested without a browser: what each check
 * is, what its outcome means, whether a person or a measurement found
 * something, why a check could not run, and what to do next.
 *
 * Nothing here decides anything. Every control this file describes is
 * checked again by the service, which is the only authority.
 */

// ---------------------------------------------------------------------------
// The ten checks
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<ContentQaType, string> = {
  BRAND_FACT_VALIDATION: "Brand facts",
  SEO_RULE_VALIDATION: "SEO rules",
  ON_PAGE_SEO: "On-page SEO",
  INTENT_ALIGNMENT: "Search intent",
  ANSWER_READINESS: "Answer readiness",
  INTERNAL_LINKING: "Internal linking",
  CLAIM_SAFETY: "Claim safety",
  STRUCTURE: "Structure",
  READABILITY: "Readability",
  DUPLICATION_RISK: "Duplication risk",
};

const TYPE_DESCRIPTIONS: Record<ContentQaType, string> = {
  BRAND_FACT_VALIDATION: "Every claim the piece lists, against the brand facts approved right now.",
  SEO_RULE_VALIDATION: "The website's active SEO rules, measured where they can be measured.",
  ON_PAGE_SEO: "Title, description, headings, slug and the primary keyword, by presence.",
  INTENT_ALIGNMENT: "Whether the piece serves the search intent the brief named.",
  ANSWER_READINESS: "Whether the brief's key questions are answered, and where.",
  INTERNAL_LINKING: "Links that resolve, targets the brief named, and pages worth linking.",
  CLAIM_SAFETY: "Prohibited claims, avoided topics, and assertions with no approved fact.",
  STRUCTURE: "The brief's required sections, their order, and the length band.",
  READABILITY: "Sentence and paragraph length, measured rather than scored.",
  DUPLICATION_RISK: "Overlap with the page being refreshed and with other pages.",
};

export function qaTypeLabel(type: string): string {
  return TYPE_LABELS[type as ContentQaType] ?? words(type);
}

export function qaTypeDescription(type: string): string {
  return TYPE_DESCRIPTIONS[type as ContentQaType] ?? "";
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export function qaStatusLabel(status: string): string {
  switch (status) {
    case "PASS":
      return "Passed";
    case "PASS_WITH_WARNINGS":
      return "Passed with warnings";
    case "FAIL":
      return "Failed";
    case "NOT_CHECKED":
      return "Not checked";
    default:
      return words(status);
  }
}

/** How a status should read at a glance: never colour alone (M5.4 §23). */
export function qaStatusTone(status: string): "pass" | "warn" | "fail" | "unknown" {
  switch (status) {
    case "PASS":
      return "pass";
    case "PASS_WITH_WARNINGS":
      return "warn";
    case "FAIL":
      return "fail";
    default:
      return "unknown";
  }
}

export function qaRunStatusLabel(status: string): string {
  switch (status) {
    case "RUNNING":
      return "Running";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Could not complete";
    default:
      return words(status);
  }
}

export function qaSourceLabel(source: string): string {
  switch (source) {
    case "DETERMINISTIC":
      return "Measured";
    case "AI_JUDGED":
      return "AI judged";
    case "MIXED":
      return "Measured and AI judged";
    default:
      return words(source);
  }
}

export function findingSourceLabel(source: string): string {
  return source === "AI_JUDGED" ? "AI judged" : "Measured";
}

export function severityLabel(severity: QaSeverity): string {
  switch (severity) {
    case "BLOCKING":
      return "Blocking";
    case "WARNING":
      return "Warning";
    default:
      return "For information";
  }
}

/**
 * What a work item's QA state is called on a queue (M5.4 §2). The database
 * enum is not renamed; these are the words a person reads.
 */
export function qaWorkItemLabel(itemStatus: string, outcome: string | null | undefined): string {
  switch (itemStatus) {
    case "QA":
      return outcome === "FAIL" ? "QA blocked" : outcome ? "QA passed" : "Ready for QA";
    case "AWAITING_EDITOR_REVIEW":
      return "Awaiting final approval";
    case "APPROVED_FOR_CMS":
      return "Approved for CMS";
    default:
      return words(itemStatus);
  }
}

/** The short QA state for a work-item queue column (M5.4 §18). */
export function qaColumnLabel(input: {
  itemStatus: string;
  outcome?: string | null;
  runStatus?: string | null;
  stale?: boolean;
  approved?: boolean;
}): string {
  if (input.approved) return "Approved for CMS";
  if (input.itemStatus === "APPROVED_FOR_CMS") return "Approved for CMS";
  if (!input.runStatus) {
    return input.itemStatus === "QA" || input.itemStatus === "AWAITING_EDITOR_REVIEW"
      ? "Ready"
      : "—";
  }
  if (input.runStatus === "RUNNING") return "Running";
  if (input.runStatus === "FAILED") return "Run failed";
  if (input.stale) return "Stale";
  switch (input.outcome) {
    case "PASS":
      return "Pass";
    case "PASS_WITH_WARNINGS":
      return "Warn";
    case "FAIL":
      return "Fail";
    default:
      return "Not checked";
  }
}

// ---------------------------------------------------------------------------
// Not checked
// ---------------------------------------------------------------------------

const REASON_LABELS: Record<NotCheckedReason, string> = {
  NO_PROVIDER: "No AI provider is configured",
  AI_RUN_FAILED: "The AI run did not complete",
  INVALID_AI_OUTPUT: "The AI answer did not match the expected shape",
  NO_PAGE_SNAPSHOT: "No page snapshot",
  NO_OTHER_PAGES: "No comparison pages",
  NO_KEYWORD: "No primary keyword in the brief",
  NO_TEXTUAL_RULES: "No rules to judge",
  NO_KEY_QUESTIONS: "No key questions in the brief",
  NO_REQUIRED_SECTIONS: "No required sections in the brief",
  NO_CONTEXT_VERSION: "No approved Business Context",
  NOT_PRODUCED_YET: "This check is not built yet",
};

export function notCheckedReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "No reason recorded";
  return REASON_LABELS[reason as NotCheckedReason] ?? words(reason);
}

/**
 * Whether a check was skipped because the evidence is missing or because an
 * optional capability was unavailable. A person reads these differently: one
 * is fixed by capturing data, the other by configuring the product.
 */
export function notCheckedKind(
  reason: string | null | undefined,
): "missing evidence" | "capability unavailable" | "unknown" {
  switch (reason) {
    case "NO_PAGE_SNAPSHOT":
    case "NO_OTHER_PAGES":
    case "NO_KEYWORD":
    case "NO_KEY_QUESTIONS":
    case "NO_REQUIRED_SECTIONS":
    case "NO_TEXTUAL_RULES":
    case "NO_CONTEXT_VERSION":
      return "missing evidence";
    case "NO_PROVIDER":
    case "AI_RUN_FAILED":
    case "INVALID_AI_OUTPUT":
    case "NOT_PRODUCED_YET":
      return "capability unavailable";
    default:
      return "unknown";
  }
}

export function notCheckedNext(reason: string | null | undefined): string {
  switch (reason) {
    case "NO_PAGE_SNAPSHOT":
      return "Capture the page's content, then run QA again.";
    case "NO_OTHER_PAGES":
      return "Nothing to do: this website has no other captured pages to compare against.";
    case "NO_KEYWORD":
      return "Name a primary keyword on the brief if this piece should serve one.";
    case "NO_KEY_QUESTIONS":
      return "Add the questions the piece must answer to the brief, if it should answer any.";
    case "NO_REQUIRED_SECTIONS":
      return "Add the sections the piece needs to the brief, if it needs a fixed structure.";
    case "NO_TEXTUAL_RULES":
      return "Nothing to do: every active rule already has a machine check.";
    case "NO_CONTEXT_VERSION":
      return "Approve a Business Context version so prohibited claims can be checked.";
    case "NO_PROVIDER":
      return "Configure an AI provider to have the judged checks run, or approve without them.";
    case "AI_RUN_FAILED":
    case "INVALID_AI_OUTPUT":
      return "Run QA again. If it keeps happening, the judged checks can be acknowledged instead.";
    case "NOT_PRODUCED_YET":
      return "Nothing to do: this check is not built yet.";
    default:
      return "Run QA again, or acknowledge this check when approving.";
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type FindingPresentation = {
  title: string;
  /** Why it matters to the reader, the site, or the business. */
  why: string;
  /** What the person can do next. */
  next: string;
};

const PRESENTATION: Record<string, FindingPresentation> = {
  MISSING_APPROVED_FACT: {
    title: "No approved fact behind a high-risk claim",
    why: "A claim about numbers, prices, customers, certifications, compliance or results is a promise the business has to keep.",
    next: "Have the fact approved in Brand Facts, or take the claim out of the piece.",
  },
  STALE_CLAIM: {
    title: "The fact behind this claim is no longer approved",
    why: "It was approved when the piece was written and has since been revoked or changed.",
    next: "Have the fact approved again, or return the draft for revision and remove the claim.",
  },
  UNSUPPORTED_CLAIM: {
    title: "A claim with nothing behind it",
    why: "Nobody approved a fact for it, so nobody is accountable for it.",
    next: "Add the fact, soften the claim, or accept it as a warning when you approve.",
  },
  UNRESOLVED_EVIDENCE: {
    title: "The evidence cited does not resolve",
    why: "The claim points at a record this website does not have.",
    next: "Return the draft for revision so the claim cites an approved fact.",
  },
  PROHIBITED_CLAIM: {
    title: "A claim the business prohibits",
    why: "The approved Business Context forbids it in any wording.",
    next: "Return the draft for revision. This cannot be approved.",
  },
  AVOID_TOPIC: {
    title: "A topic the business avoids",
    why: "The approved Business Context says to stay off it.",
    next: "Return the draft for revision. This cannot be approved.",
  },
  UNSUPPORTED_NUMERIC_CLAIM: {
    title: "A figure with no approved fact",
    why: "Figures are the claims readers quote back, and this one has no source.",
    next: "Cite an approved fact, or remove the figure.",
  },
  HIGH_RISK_CLAIM: {
    title: "A high-risk claim with no approved fact",
    why: "Guarantees, comparisons, certifications and outcome promises are held against the business.",
    next: "List the claim with its approved fact, or take it out.",
  },
  UNLISTED_CLAIM: {
    title: "A business claim the writer did not list",
    why: "The judge found an assertion in the text that no listed claim covers, and no approved fact matched it.",
    next: "List it with its fact, take it out, or accept it as a warning when you approve.",
  },
  PARAPHRASED_PROHIBITION: {
    title: "A prohibited claim, said in other words",
    why: "The wording differs, the promise does not.",
    next: "Read the passage and decide. Return for revision if it says what the business forbids.",
  },
  UNSAFE_LINK: {
    title: "A link that cannot be published",
    why: "Its scheme can execute code in a reader's browser.",
    next: "Return the draft for revision and remove the link.",
  },
  RULE_FAILED: {
    title: "An SEO rule is not met",
    why: "The website's own rules are how the business keeps its pages consistent.",
    next: "Return the draft for revision, or change the rule if it no longer applies.",
  },
  RULE_UNCLEAR: {
    title: "Whether a rule is met is unclear",
    why: "The rule is written for a reader, not for a measurement.",
    next: "Read the passage and confirm it yourself before approving.",
  },
  TITLE_MISSING: {
    title: "No title",
    why: "The title is the first thing a searcher reads.",
    next: "Return the draft for revision.",
  },
  TITLE_TOO_LONG: {
    title: "The title will be cut in search results",
    why: "Past the length search engines show, the end of the title is invisible.",
    next: "Shorten it, or accept it as a warning.",
  },
  META_MISSING: {
    title: "No meta description",
    why: "Without one, search engines write their own from the page.",
    next: "Add one in a revision, or accept it as a warning.",
  },
  META_TOO_LONG: {
    title: "The meta description will be cut",
    why: "The end of a long description is not shown.",
    next: "Shorten it, or accept it as a warning.",
  },
  H1_MISSING: {
    title: "No H1 in the body",
    why: "The page heading tells a reader what the page is.",
    next: "Nothing, if the title becomes the heading in the CMS.",
  },
  H1_MULTIPLE: {
    title: "More than one H1",
    why: "A page has one subject, and one heading that names it.",
    next: "Return for revision, or accept it as a warning.",
  },
  HEADING_SKIP: {
    title: "A heading level was skipped",
    why: "Screen readers use the levels to build the page outline.",
    next: "Fix the level in a revision when convenient.",
  },
  SLUG_MISSING: {
    title: "No slug",
    why: "New content needs a URL before it can be published.",
    next: "Add one in a revision.",
  },
  SLUG_INVALID: {
    title: "The slug is not URL-safe",
    why: "A CMS will rewrite it, and the rewritten URL may not be the one you expect.",
    next: "Fix it in a revision.",
  },
  SLUG_TAKEN: {
    title: "Another page already ends in this slug",
    why: "Two pages at the same path compete with each other.",
    next: "Choose a different slug, or confirm the pages are different enough.",
  },
  SLUG_DIFFERS: {
    title: "The slug differs from the page's current path",
    why: "Changing a URL needs a redirect, or the page loses what it has earned.",
    next: "Keep the path, or plan the redirect before publishing.",
  },
  KEYWORD_ABSENT: {
    title: "The primary keyword does not appear",
    why: "The piece is meant to serve a search, and the words of that search are missing.",
    next: "Work it in naturally in a revision, or accept it as a warning.",
  },
  KEYWORD_NOT_IN_TITLE: {
    title: "The primary keyword is not in the title or heading",
    why: "It is where a searcher looks first.",
    next: "Consider it in a revision.",
  },
  KEYWORD_AWKWARD: {
    title: "The keyword reads as forced",
    why: "Text written for a search engine reads badly to a person, and to a search engine.",
    next: "Read the passage and decide whether to rewrite it.",
  },
  DUPLICATE_TITLE: {
    title: "Another page uses this title",
    why: "Two pages with one title compete for the same result.",
    next: "Change one of them, or confirm they serve different searches.",
  },
  DUPLICATE_META: {
    title: "Another page uses this description",
    why: "The description should say what is different about this page.",
    next: "Change one of them.",
  },
  SECTION_MISSING: {
    title: "A required section is missing",
    why: "The brief says the piece needs it.",
    next: "Return for revision, or accept it if the brief has moved on.",
  },
  SECTION_UNMATCHED: {
    title: "A covered section has no matching heading",
    why: "The writer says it is covered; no heading says so to a reader.",
    next: "Check the piece answers it somewhere.",
  },
  SECTION_OUT_OF_ORDER: {
    title: "The required sections are out of order",
    why: "The brief's order was chosen for the reader.",
    next: "Reorder in a revision if the order matters.",
  },
  SECTION_EMPTY: {
    title: "A heading with nothing under it",
    why: "An empty section reads as unfinished.",
    next: "Return for revision.",
  },
  LENGTH_OUT_OF_BAND: {
    title: "The piece is outside the brief's length band",
    why: "The band was chosen for the work type.",
    next: "Judge it on the content, not the count.",
  },
  LINK_UNRESOLVED: {
    title: "An internal link points nowhere this website knows",
    why: "A broken link costs the reader and the crawler.",
    next: "Fix the path in a revision.",
  },
  LINK_TARGET_UNUSED: {
    title: "A link target the brief named is unused",
    why: "The brief asked for the link for a reason.",
    next: "Add it in a revision if it still belongs.",
  },
  GENERIC_ANCHOR: {
    title: "Anchor text that says nothing",
    why: "The words of a link tell the reader and the crawler where it goes.",
    next: "Rewrite the anchor in a revision.",
  },
  EXTERNAL_LINK: {
    title: "A link that leaves the site",
    why: "Outbound links were not in the brief; someone should have decided them.",
    next: "Keep it if it earns its place, or remove it in a revision.",
  },
  LINK_SUGGESTED: {
    title: "A page worth linking to",
    why: "It owns one of the brief's secondary keywords and is not linked yet.",
    next: "Add the link in a revision if it helps the reader.",
  },
  LONG_SENTENCES: {
    title: "Long sentences",
    why: "Readers skim past them, and so do the people you are writing for.",
    next: "Break a few up in a revision.",
  },
  WALL_OF_TEXT: {
    title: "A paragraph that runs long",
    why: "A wall of text is skipped rather than read.",
    next: "Split it in a revision.",
  },
  NEAR_DUPLICATE: {
    title: "This overlaps another page",
    why: "Two pages saying the same thing split what either could earn.",
    next: "Differentiate them, or consolidate.",
  },
  UNCHANGED_REFRESH: {
    title: "A refresh that changes almost nothing",
    why: "Republishing the same words changes nothing about the page's problem.",
    next: "Return for revision.",
  },
  INTENT_PARTIAL: {
    title: "The piece only partly serves the intent",
    why: "A reader arriving from that search may not find what they came for.",
    next: "Read the rationale and decide whether to return it.",
  },
  INTENT_MISALIGNED: {
    title: "The piece does not serve the brief's intent",
    why: "It will be read by the wrong people, or by nobody.",
    next: "Read the rationale. Confirm before approving.",
  },
  QUESTION_UNANSWERED: {
    title: "A key question is not answered",
    why: "The brief said the piece must answer it.",
    next: "Return for revision, or accept it as a warning.",
  },
  QUESTION_PARTIAL: {
    title: "A key question is only partly answered",
    why: "A partial answer sends the reader elsewhere to finish.",
    next: "Consider a revision.",
  },
  CTA_MISSING: {
    title: "No call to action for the brief's conversion",
    why: "The piece exists to lead somewhere, and it does not.",
    next: "Add one in a revision, or accept it as a warning.",
  },
  CTA_WEAK: {
    title: "The call to action is weak",
    why: "A reader who is convinced still needs to be told what to do.",
    next: "Strengthen it in a revision.",
  },
  VOICE_MISMATCH: {
    title: "It does not sound like the brand",
    why: "The Business Context describes how this business writes.",
    next: "Read the rationale and decide.",
  },
  NOT_CHECKED: {
    title: "This check did not run",
    why: "Something it needed was not there.",
    next: "See the reason on the check.",
  },
};

const FALLBACK: FindingPresentation = {
  title: "A finding",
  why: "QA recorded this against the approved revision.",
  next: "Read the detail and decide.",
};

export function findingPresentation(finding: Pick<QaFinding, "code">): FindingPresentation {
  return PRESENTATION[finding.code] ?? FALLBACK;
}

export type GroupedFindings = {
  blocking: QaFinding[];
  warning: QaFinding[];
  info: QaFinding[];
  notChecked: QaFinding[];
};

/** Blocking, warning, information, and the checks that did not run (M5.4 §5). */
export function groupFindings(findings: QaFinding[]): GroupedFindings {
  const grouped: GroupedFindings = { blocking: [], warning: [], info: [], notChecked: [] };
  for (const finding of findings) {
    if (finding.code === "NOT_CHECKED") grouped.notChecked.push(finding);
    else if (finding.severity === "BLOCKING") grouped.blocking.push(finding);
    else if (finding.severity === "WARNING") grouped.warning.push(finding);
    else grouped.info.push(finding);
  }
  return grouped;
}

/** Where a finding was found, in words. */
export function fieldLabel(field: string | undefined): string | null {
  if (!field) return null;
  switch (field) {
    case "meta_title":
      return "Meta title";
    case "meta_description":
      return "Meta description";
    case "body":
      return "Body";
    case "claims":
      return "Claim list";
    default:
      return words(field);
  }
}

// ---------------------------------------------------------------------------
// Freshness, staleness, provenance
// ---------------------------------------------------------------------------

export type Currency = {
  revisionApproved: boolean;
  inputsCurrent: boolean;
  latestForRevision: boolean;
  current: boolean;
};

export function freshnessLabel(currency: Currency, runStatus: string): string {
  if (runStatus === "RUNNING") return "Running";
  if (runStatus === "FAILED") return "Did not complete";
  if (currency.current) return "Current";
  if (!currency.latestForRevision) return "Historical";
  return "Stale";
}

/** Why a run no longer speaks for the work, in a sentence a person can act on. */
export function freshnessReason(currency: Currency): string | null {
  if (currency.current) return null;
  if (!currency.revisionApproved) {
    return "This run judged a revision that is no longer the approved one.";
  }
  if (!currency.latestForRevision) return "A later run has judged this revision since.";
  if (!currency.inputsCurrent) {
    return "The brand facts, SEO rules or Business Context changed after this run.";
  }
  return "This run no longer speaks for the work.";
}

const STALE_REASONS: Record<string, string> = {
  REVISION_CHANGED: "The approved revision changed after this approval.",
  QA_INPUTS_CHANGED:
    "Brand facts, SEO rules or Business Context changed after this approval, so the QA behind it is stale.",
  QA_SUPERSEDED: "A later QA run has judged this revision since the approval.",
  BRIEF_SUPERSEDED: "A newer brief version was approved after this approval.",
};

export function staleReasonLabel(reason: string): string {
  return STALE_REASONS[reason] ?? words(reason);
}

export function shortFingerprint(value: string | null | undefined): string {
  if (!value) return "—";
  const digest = value.startsWith("sha256:") ? value.slice(7) : value;
  return `${digest.slice(0, 10)}…`;
}

// ---------------------------------------------------------------------------
// What a person may do (M5.4 §10, §11, §15, §20)
// ---------------------------------------------------------------------------

export type QaControlsInput = {
  canWrite: boolean;
  canReview: boolean;
  /** The work item's status. */
  itemStatus: string;
  /** Whether the work item has an approved revision to check. */
  hasApprovedRevision: boolean;
  /** The latest run, if any. */
  runStatus?: string | null;
  runOutcome?: string | null;
  runCurrent?: boolean;
  blockingCount?: number;
  notCheckedCount?: number;
  /** An effective approval, and whether it still authorizes execution. */
  approved?: boolean;
  approvalStale?: boolean;
  /** The draft is pinned to a brief version that is no longer the approved one. */
  briefSuperseded?: boolean;
};

export type QaControls = {
  canRun: boolean;
  runLabel: "Run QA" | "Re-run QA";
  /** Why running is not offered, when it is not. */
  runReason: string | null;
  canApprove: boolean;
  approveReason: string | null;
  needsNotCheckedAcknowledgement: boolean;
  needsBriefAcknowledgement: boolean;
  canReturn: boolean;
  returnReason: string | null;
};

const QA_STATES = ["QA", "AWAITING_EDITOR_REVIEW", "APPROVED_FOR_CMS"];

export function qaControls(input: QaControlsInput): QaControls {
  const inGate = QA_STATES.includes(input.itemStatus);
  const running = input.runStatus === "RUNNING";
  const hasRun = Boolean(input.runStatus);

  const runReason = !inGate
    ? "QA runs on work that is ready for QA, awaiting final approval, or approved for CMS."
    : !input.hasApprovedRevision
      ? "There is no approved revision to check. Approve a draft first."
      : running
        ? "QA is running for this work item."
        : !input.canWrite
          ? "You can read this report. Running QA needs a member's access or above."
          : null;

  const approveReason = !input.canReview
    ? "Approving for CMS needs an SEO lead, admin or owner."
    : input.itemStatus === "APPROVED_FOR_CMS"
      ? "This work is already approved for CMS."
      : input.itemStatus !== "AWAITING_EDITOR_REVIEW"
        ? "QA has not passed for this work yet."
        : !hasRun
          ? "Run QA first."
          : running
            ? "QA is still running."
            : (input.blockingCount ?? 0) > 0 || input.runOutcome === "FAIL"
              ? "QA found something blocking. Blocking findings cannot be accepted; return the draft for revision."
              : input.runCurrent === false
                ? "The QA behind this work is stale. Run QA again before approving."
                : null;

  return {
    canRun: runReason === null,
    runLabel: hasRun ? "Re-run QA" : "Run QA",
    runReason,
    canApprove: approveReason === null,
    approveReason,
    needsNotCheckedAcknowledgement: (input.notCheckedCount ?? 0) > 0,
    needsBriefAcknowledgement: Boolean(input.briefSuperseded),
    canReturn: inGate && input.canWrite,
    returnReason: !inGate
      ? null
      : input.canWrite
        ? null
        : "Returning for revision needs a member's access or above.",
  };
}

// ---------------------------------------------------------------------------
// Queue filters (M5.4 §2)
// ---------------------------------------------------------------------------

export const QA_STATE_FILTERS = [
  "all",
  "ready",
  "blocked",
  "warnings",
  "awaiting",
  "approved",
] as const;
export type QaStateFilter = (typeof QA_STATE_FILTERS)[number];

export type QaFilters = {
  state: QaStateFilter;
  contentType: string;
  stale: boolean;
  notChecked: boolean;
};

export const DEFAULT_QA_FILTERS: QaFilters = {
  state: "all",
  contentType: "all",
  stale: false,
  notChecked: false,
};

export const QA_STATE_FILTER_LABELS: Record<QaStateFilter, string> = {
  all: "All",
  ready: "Ready for QA",
  blocked: "Blocked",
  warnings: "Passed with warnings",
  awaiting: "Awaiting final approval",
  approved: "Approved for CMS",
};

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function parseQaFilters(query: Record<string, string | undefined>): QaFilters {
  const state = QA_STATE_FILTERS.includes(query.state as QaStateFilter)
    ? (query.state as QaStateFilter)
    : "all";
  const contentType = query.type && /^[A-Z_]{1,40}$/.test(query.type) ? query.type : "all";
  return { state, contentType, stale: flag(query.stale), notChecked: flag(query.notChecked) };
}

export function qaFiltersToQuery(filters: QaFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.state !== "all") query.state = filters.state;
  if (filters.contentType !== "all") query.type = filters.contentType;
  if (filters.stale) query.stale = "1";
  if (filters.notChecked) query.notChecked = "1";
  return query;
}

/** What a queue row must expose for the filters to work on it. */
export type QaFilterable = {
  itemStatus: string;
  contentType: string | null;
  outcome: string | null;
  runStatus: string | null;
  runCurrent: boolean;
  notCheckedCount: number;
  approved: boolean;
  approvalStale: boolean;
};

export function applyQaFilters<T extends QaFilterable>(rows: T[], filters: QaFilters): T[] {
  return rows.filter((row) => {
    if (filters.contentType !== "all" && row.contentType !== filters.contentType) return false;
    if (filters.notChecked && row.notCheckedCount === 0) return false;
    if (filters.stale && !(row.approvalStale || (row.runStatus !== null && !row.runCurrent))) {
      return false;
    }
    switch (filters.state) {
      case "ready":
        return row.itemStatus === "QA" && row.outcome !== "FAIL";
      case "blocked":
        return row.outcome === "FAIL";
      case "warnings":
        return row.outcome === "PASS_WITH_WARNINGS";
      case "awaiting":
        return row.itemStatus === "AWAITING_EDITOR_REVIEW";
      case "approved":
        return row.itemStatus === "APPROVED_FOR_CMS";
      default:
        return true;
    }
  });
}

/**
 * The most actionable first (M5.4 §2, §19): something blocking, then a
 * decision waiting on a person, then work ready to check, then the rest,
 * most recently touched first within each group.
 */
export function qaQueueRank(row: QaFilterable): number {
  if (row.outcome === "FAIL") return 0;
  if (row.itemStatus === "AWAITING_EDITOR_REVIEW") return 1;
  if (row.approved && row.approvalStale) return 2;
  if (row.itemStatus === "QA") return 3;
  return 4;
}

function words(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
