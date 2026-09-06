import type { ContentQaStatus, ContentQaType } from "@/generated/prisma/client";

/**
 * What a QA check says, and how the sayings add up (docs/P4_SPEC.md §12; M5
 * plan §5, D1, D6, D11).
 *
 * A finding names a code, the type it belongs to, a severity, who found it
 * (a deterministic checker version or an AI run), and what it points at.
 * BLOCKING is reserved for deterministic checks over what the business wrote
 * down. NOT_CHECKED is a coverage statement, not a verdict: a sub-check that
 * had nothing to check with says so and the type it belongs to can never
 * read PASS because of it.
 */

export type QaSeverity = "BLOCKING" | "WARNING" | "INFO";
export type QaSource = "DETERMINISTIC" | "AI_JUDGED";

export const QA_TYPES: readonly ContentQaType[] = [
  "BRAND_FACT_VALIDATION",
  "SEO_RULE_VALIDATION",
  "ON_PAGE_SEO",
  "INTENT_ALIGNMENT",
  "ANSWER_READINESS",
  "INTERNAL_LINKING",
  "CLAIM_SAFETY",
  "STRUCTURE",
  "READABILITY",
  "DUPLICATION_RISK",
];

/**
 * Why a sub-check had nothing to check with. Legitimate absences only: a
 * checker that fails for a reason of its own fails the run instead (D11).
 */
export const NOT_CHECKED_REASONS = [
  "NO_PROVIDER",
  "AI_RUN_FAILED",
  "NO_PAGE_SNAPSHOT",
  "NO_OTHER_PAGES",
  "NO_KEYWORD",
  "NO_TEXTUAL_RULES",
  "NO_KEY_QUESTIONS",
  "NO_REQUIRED_SECTIONS",
  "NO_CONTEXT_VERSION",
  "NOT_PRODUCED_YET",
] as const;
export type NotCheckedReason = (typeof NOT_CHECKED_REASONS)[number];

export type QaFindingCode =
  | "MISSING_APPROVED_FACT"
  | "STALE_CLAIM"
  | "UNSUPPORTED_CLAIM"
  | "UNRESOLVED_EVIDENCE"
  | "PROHIBITED_CLAIM"
  | "AVOID_TOPIC"
  | "UNSUPPORTED_NUMERIC_CLAIM"
  | "HIGH_RISK_CLAIM"
  | "UNLISTED_CLAIM"
  | "PARAPHRASED_PROHIBITION"
  | "UNSAFE_LINK"
  | "RULE_FAILED"
  | "RULE_UNCLEAR"
  | "TITLE_MISSING"
  | "TITLE_TOO_LONG"
  | "META_MISSING"
  | "META_TOO_LONG"
  | "H1_MISSING"
  | "H1_MULTIPLE"
  | "HEADING_SKIP"
  | "SLUG_MISSING"
  | "SLUG_INVALID"
  | "SLUG_TAKEN"
  | "SLUG_DIFFERS"
  | "KEYWORD_ABSENT"
  | "KEYWORD_NOT_IN_TITLE"
  | "DUPLICATE_TITLE"
  | "DUPLICATE_META"
  | "SECTION_MISSING"
  | "SECTION_UNMATCHED"
  | "SECTION_OUT_OF_ORDER"
  | "SECTION_EMPTY"
  | "LENGTH_OUT_OF_BAND"
  | "LINK_UNRESOLVED"
  | "LINK_TARGET_UNUSED"
  | "GENERIC_ANCHOR"
  | "EXTERNAL_LINK"
  | "LINK_SUGGESTED"
  | "LONG_SENTENCES"
  | "WALL_OF_TEXT"
  | "NEAR_DUPLICATE"
  | "UNCHANGED_REFRESH"
  | "INTENT_PARTIAL"
  | "INTENT_MISALIGNED"
  | "QUESTION_UNANSWERED"
  | "QUESTION_PARTIAL"
  | "CTA_MISSING"
  | "VOICE_MISMATCH"
  | "NOT_CHECKED";

export type QaFindingRefs = {
  factId?: string;
  ruleId?: string;
  pageId?: string;
  pagePath?: string;
  evidenceId?: string;
  question?: string;
  section?: string;
  check?: string;
  category?: string;
  reason?: NotCheckedReason;
};

export type QaFinding = {
  code: QaFindingCode;
  qaType: ContentQaType;
  severity: QaSeverity;
  source: QaSource;
  /** A judgement a person must confirm before it can be acted on (D6). */
  needsHumanConfirmation: boolean;
  message: string;
  /** Where: title, meta_title, meta_description, excerpt, slug, body, claims. */
  field?: string;
  /** Verbatim text, verified against the revision by whoever recorded it. */
  excerpt?: string;
  refs?: QaFindingRefs;
  /** A checker version, or an AI run id. */
  by: string;
};

/** One sub-check of a type: whether it ran, and if not, why. */
export type QaCoverage = {
  check: string;
  status: "CHECKED" | "NOT_CHECKED";
  reason?: NotCheckedReason;
};

export type QaTypeResult = {
  qaType: ContentQaType;
  status: ContentQaStatus;
  source: QaSource | "MIXED";
  findings: QaFinding[];
  coverage: QaCoverage[];
  /** Set when the whole type is NOT_CHECKED. */
  notCheckedReason: NotCheckedReason | null;
  /** What the checks looked at, in counts and ids, so a reader knows they were fed. */
  considered: Record<string, number | string | string[]>;
};

export type QaCounts = {
  blocking: number;
  warning: number;
  info: number;
  notChecked: number;
};

/**
 * A type's status from its findings and coverage. FAIL if anything blocks.
 * NOT_CHECKED if nothing of it could run. Otherwise a warning if any finding
 * warns or any sub-check could not run - partial coverage is never PASS.
 */
export function deriveTypeStatus(findings: QaFinding[], coverage: QaCoverage[]): ContentQaStatus {
  if (findings.some((finding) => finding.severity === "BLOCKING")) return "FAIL";
  const notChecked = coverage.filter((entry) => entry.status === "NOT_CHECKED");
  if (coverage.length > 0 && notChecked.length === coverage.length) return "NOT_CHECKED";
  if (notChecked.length > 0 || findings.some((finding) => finding.severity === "WARNING")) {
    return "PASS_WITH_WARNINGS";
  }
  return "PASS";
}

/** The run's outcome from its types. FAIL beats everything; PASS needs every type to pass. */
export function deriveOutcome(results: QaTypeResult[]): ContentQaStatus {
  if (results.some((result) => result.status === "FAIL")) return "FAIL";
  if (results.every((result) => result.status === "PASS")) return "PASS";
  return "PASS_WITH_WARNINGS";
}

export function countFindings(results: QaTypeResult[]): QaCounts {
  const counts: QaCounts = { blocking: 0, warning: 0, info: 0, notChecked: 0 };
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.code === "NOT_CHECKED") continue;
      if (finding.severity === "BLOCKING") counts.blocking += 1;
      else if (finding.severity === "WARNING") counts.warning += 1;
      else counts.info += 1;
    }
    counts.notChecked += result.coverage.filter((entry) => entry.status === "NOT_CHECKED").length;
  }
  return counts;
}

/** The finding that says a sub-check could not run. Shown, never hidden. */
export function notCheckedFinding(
  qaType: ContentQaType,
  check: string,
  reason: NotCheckedReason,
  by: string,
  options: { needsHumanConfirmation?: boolean; message?: string } = {},
): QaFinding {
  return {
    code: "NOT_CHECKED",
    qaType,
    severity: "WARNING",
    source: "DETERMINISTIC",
    needsHumanConfirmation: options.needsHumanConfirmation ?? false,
    message:
      options.message ?? `${describeCheck(check)} could not be checked: ${describeReason(reason)}.`,
    refs: { check, reason },
    by,
  };
}

export function describeReason(reason: NotCheckedReason): string {
  switch (reason) {
    case "NO_PROVIDER":
      return "no AI provider is configured";
    case "AI_RUN_FAILED":
      return "the AI run did not complete";
    case "NO_PAGE_SNAPSHOT":
      return "no content has been captured for the target page";
    case "NO_OTHER_PAGES":
      return "no other page of this website has captured content";
    case "NO_KEYWORD":
      return "the brief names no primary keyword";
    case "NO_TEXTUAL_RULES":
      return "there are no rules to judge";
    case "NO_KEY_QUESTIONS":
      return "the brief lists no key questions";
    case "NO_REQUIRED_SECTIONS":
      return "the brief lists no required sections";
    case "NO_CONTEXT_VERSION":
      return "there is no approved Business Context";
    case "NOT_PRODUCED_YET":
      return "this check is not built yet";
  }
}

function describeCheck(check: string): string {
  return check.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Builds a type result: status and coverage derived, nothing hand-set. */
export function typeResult(input: {
  qaType: ContentQaType;
  findings: QaFinding[];
  coverage: QaCoverage[];
  considered?: Record<string, number | string | string[]>;
  source?: QaSource | "MIXED";
}): QaTypeResult {
  const status = deriveTypeStatus(input.findings, input.coverage);
  const uncovered = input.coverage.filter((entry) => entry.status === "NOT_CHECKED");
  return {
    qaType: input.qaType,
    status,
    source: input.source ?? "DETERMINISTIC",
    findings: input.findings,
    coverage: input.coverage,
    notCheckedReason:
      status === "NOT_CHECKED" ? (uncovered[0]?.reason ?? "NOT_PRODUCED_YET") : null,
    considered: input.considered ?? {},
  };
}

/** Shortens text for an excerpt without ever changing the words it keeps. */
export function clip(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
