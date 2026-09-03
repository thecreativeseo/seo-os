import { z } from "zod";

/**
 * The shape a page diagnosis must arrive in (docs/P3_SPEC.md §26).
 *
 * Typed output rather than prose we parse afterwards. The difference is not
 * convenience: a model asked for free text will happily write "clicks fell
 * because of cannibalization" with nothing behind it, whereas a model asked for
 * this shape has to name the evidence IDs in a field, and a field is something
 * the server can check. Every claim therefore arrives already attached to the
 * thing that would falsify it.
 *
 * The enums are deliberately restated here as string literals rather than
 * imported from the generated Prisma client. This schema is sent to a provider as
 * a tool schema and is the contract with something outside the process; if the
 * database enum gains a value, that should be a decision to also offer it to the
 * model, made by editing this file and versioning the prompt — not a silent
 * widening of what a model may return.
 *
 * Version 2 adds recommendations (§21–§23). Version 1 asked for findings only;
 * runs recorded against it are read with the fields it had, which is why the
 * recommendations array defaults to empty rather than being required.
 */

export const PAGE_DIAGNOSIS_SCHEMA_VERSION = "2";
export const PAGE_DIAGNOSIS_SCHEMA_NAME = "page_diagnosis";

/** §16. Ordered as the spec lists them; INSUFFICIENT_EVIDENCE is a real answer. */
export const DIAGNOSTIC_CATEGORIES = [
  "INTENT_MISMATCH",
  "CTR_SERP_MISMATCH",
  "KEYWORD_OWNERSHIP_CONFLICT",
  "CANNIBALIZATION",
  "CONTENT_GAP",
  "CONTENT_STALENESS",
  "WEAK_INTERNAL_SUPPORT",
  "COMPETITOR_DISPLACEMENT",
  "TECHNICAL_INDEXATION",
  "TECHNICAL_RENDERING",
  "TECHNICAL_CANONICALIZATION",
  "SERP_FEATURE_CHANGE",
  "SEASONALITY",
  "CONVERSION_MISMATCH",
  "INSUFFICIENT_EVIDENCE",
  "OTHER",
] as const;

/** §17. */
export const FINDING_VERDICTS = [
  "CONFIRMED",
  "STRONGLY_SUPPORTED",
  "SUSPECT",
  "CLEAR",
  "UNKNOWN",
  "NOT_APPLICABLE",
] as const;

export const CONFIDENCE_LEVELS = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;

/** §22. P3 proposes; P4 executes approved work. */
export const RECOMMENDATION_TYPES = [
  "CONTENT_REFRESH",
  "CONTENT_CREATE",
  "TITLE_META_UPDATE",
  "INTENT_REALIGNMENT",
  "KEYWORD_OWNERSHIP_FIX",
  "INTERNAL_LINK_UPDATE",
  "PAGE_CONSOLIDATION",
  "PAGE_SPLIT",
  "TECHNICAL_INVESTIGATION",
  "TECHNICAL_FIX",
  "SERP_REVIEW",
  "CONVERSION_REVIEW",
  "MONITOR_ONLY",
  "REQUEST_MORE_EVIDENCE",
  "OTHER",
] as const;

export const PRIORITY_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

/** Effort and risk share a scale (§21). UNKNOWN is honest, not a placeholder. */
export const LEVELS = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;

/**
 * Evidence IDs as the model returns them.
 *
 * Only length-bounded here. Nothing about the format is enforced at this layer
 * on purpose: an ID that merely looks right is worth no more than one that does
 * not, because acceptance is decided later by resolving it inside the caller's
 * tenant scope against the sealed package. Rejecting malformed IDs here would
 * only teach a model to produce well-formed fabrications.
 */
const evidenceId = z.string().min(1).max(200);

/**
 * The cap on citations per finding or recommendation.
 *
 * Generous rather than tight — a finding that rests on thirty measurements is a
 * good finding — but present, because an unbounded array is an unbounded write.
 */
const evidenceIds = z.array(evidenceId).max(50);

export const findingSchema = z.object({
  category: z.enum(DIAGNOSTIC_CATEGORIES),
  verdict: z.enum(FINDING_VERDICTS),
  confidence: z.enum(CONFIDENCE_LEVELS),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4000),
  supporting_evidence_ids: evidenceIds,
  contradicting_evidence_ids: evidenceIds,
  /**
   * §20. What would have to be known to say more, in the model's words.
   *
   * A required array rather than an optional one: asking for the field every
   * time makes "nothing is missing" a claim the model has to make explicitly by
   * returning an empty array, instead of something that happens by omission.
   */
  missing_evidence: z.array(z.string().min(1).max(500)).max(20),
});

export type FindingOutput = z.infer<typeof findingSchema>;

/**
 * One proposal (§21–§23).
 *
 * Every guardrail the spec lists is either a field here or a check the server
 * runs on one: evidence is cited in `evidence_ids`, confidence/effort/risk are
 * required, the expected effect is descriptive and is stripped of any number
 * server-side, rule conflicts are declared rather than discovered, and missing
 * evidence is named. None of it is trusted as returned; all of it is checked.
 */
export const recommendationSchema = z.object({
  type: z.enum(RECOMMENDATION_TYPES),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  rationale: z.string().min(1).max(4000),
  priority: z.enum(PRIORITY_LEVELS),
  confidence: z.enum(CONFIDENCE_LEVELS),
  effort: z.enum(LEVELS),
  risk: z.enum(LEVELS),
  evidence_ids: evidenceIds,
  /**
   * Words only. This is the one field that speaks about the future, so any
   * digit in it is a forecast, and the server removes it (§23).
   */
  expected_effect_description: z.string().max(1000).nullable().default(null),
  /**
   * Rule evidence IDs the model believes this proposal conflicts with. Declaring
   * a conflict is how a BLOCKING rule stops a recommendation before a person
   * ever sees it as approvable.
   */
  conflicting_rule_ids: evidenceIds.default([]),
  /** §23: state when more evidence is required. */
  missing_evidence: z.array(z.string().min(1).max(500)).max(10).default([]),
});

export type RecommendationOutput = z.infer<typeof recommendationSchema>;

/**
 * Proposals per diagnosis. A page with more than eight things wrong with it
 * needs a smaller list, not a longer one.
 */
export const MAX_RECOMMENDATIONS = 8;

export const pageDiagnosisSchema = z.object({
  executive_summary: z.string().min(1).max(4000),
  /**
   * One finding per category is what the store can hold (`@@unique` on
   * diagnosis + category), so sixteen is the real ceiling and the schema says so
   * rather than letting the server discard the overflow later.
   */
  findings: z.array(findingSchema).max(DIAGNOSTIC_CATEGORIES.length),
  overall_confidence: z.enum(CONFIDENCE_LEVELS),
  recommendations: z.array(recommendationSchema).max(MAX_RECOMMENDATIONS).default([]),
});

export type PageDiagnosisOutput = z.infer<typeof pageDiagnosisSchema>;
