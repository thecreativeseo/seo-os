import { z } from "zod";

/**
 * The shape a semantic QA judgment must arrive in (docs/P4_SPEC.md §12-§14;
 * M5 plan §4, §11).
 *
 * Judgments, not verdicts: the model says what it saw - whether the piece
 * matches the intent, which questions it answers and where, whether a prose
 * rule reads as respected, which sentences assert business facts, where a
 * prohibited claim is said in other words, whether the call to action and
 * the keyword and the voice are there. The server decides what each means:
 * severities are the server's, excerpts are verified against the revision,
 * ids are resolved or dropped. Nothing here can block anything.
 *
 * Strict from the start: every key present, unknown keys refused, enums
 * exact, every list an array. Limits are stated in the prompt with a margin,
 * because strict tool use cannot carry them on the wire.
 */

export const CONTENT_QA_SCHEMA_VERSION = "1";
export const CONTENT_QA_SCHEMA_NAME = "content_qa";

export const INTENT_STATUSES = ["ALIGNED", "PARTIAL", "MISALIGNED"] as const;
export const ANSWER_STATUSES = ["ANSWERED", "PARTIAL", "NOT_ANSWERED"] as const;
export const ANSWER_FORMS = ["DIRECT", "DEFINITION", "LIST", "TABLE", "SCATTERED", "NONE"] as const;
export const RULE_STATUSES = ["RESPECTED", "NOT_RESPECTED", "UNCLEAR"] as const;
export const CLAIM_CATEGORIES = [
  "COMPANY",
  "PRODUCT",
  "CUSTOMERS",
  "PRICING",
  "RESULTS",
  "CERTIFICATION",
  "COMPARISON",
  "PERFORMANCE",
  "SECURITY_COMPLIANCE",
  "OTHER",
] as const;
export const CTA_STATUSES = ["PRESENT", "WEAK", "ABSENT"] as const;
export const KEYWORD_STATUSES = ["NATURAL", "AWKWARD", "ABSENT"] as const;
export const VOICE_STATUSES = ["MATCHES", "PARTIAL", "DOES_NOT_MATCH"] as const;

/** The canonical caps. The prompt asks for less. */
export const CONTENT_QA_V1_LIMITS = {
  rationale: 400,
  ruleRationale: 300,
  shortRationale: 200,
  excerpt: 300,
  question: 300,
  heading: 200,
  ruleId: 200,
  prohibitedClaim: 300,
  intentExcerpts: 3,
  answers: 20,
  rules: 20,
  claims: 20,
  paraphrases: 10,
} as const;

const excerpt = z.string().min(1).max(CONTENT_QA_V1_LIMITS.excerpt);

export const intentAlignmentSchema = z.strictObject({
  status: z.enum(INTENT_STATUSES),
  rationale: z.string().min(1).max(CONTENT_QA_V1_LIMITS.rationale),
  excerpts: z.array(excerpt).max(CONTENT_QA_V1_LIMITS.intentExcerpts),
});

export const answerReadinessSchema = z.strictObject({
  /** The key question, copied exactly from the task. */
  question: z.string().min(1).max(CONTENT_QA_V1_LIMITS.question),
  status: z.enum(ANSWER_STATUSES),
  heading: z.string().min(1).max(CONTENT_QA_V1_LIMITS.heading).nullable(),
  form: z.enum(ANSWER_FORMS),
  excerpt: excerpt.nullable(),
});

export const ruleJudgmentSchema = z.strictObject({
  /** The rule's id exactly as the task gave it. */
  rule_id: z.string().min(1).max(CONTENT_QA_V1_LIMITS.ruleId),
  status: z.enum(RULE_STATUSES),
  rationale: z.string().min(1).max(CONTENT_QA_V1_LIMITS.ruleRationale),
  excerpt: excerpt.nullable(),
});

export const unlistedClaimSchema = z.strictObject({
  /** The sentence, verbatim. The server decides whether a fact supports it. */
  excerpt,
  category: z.enum(CLAIM_CATEGORIES),
  rationale: z.string().min(1).max(CONTENT_QA_V1_LIMITS.shortRationale),
});

export const prohibitedParaphraseSchema = z.strictObject({
  /** The prohibited claim, copied exactly from the task. */
  prohibited_claim: z.string().min(1).max(CONTENT_QA_V1_LIMITS.prohibitedClaim),
  excerpt,
  rationale: z.string().min(1).max(CONTENT_QA_V1_LIMITS.shortRationale),
});

export const judgmentSchema = <S extends readonly [string, ...string[]]>(
  statuses: S,
  max: number,
) =>
  z.strictObject({
    status: z.enum(statuses),
    rationale: z.string().min(1).max(max),
    excerpt: excerpt.nullable(),
  });

export const contentQaSchemaV1 = z.strictObject({
  intent_alignment: intentAlignmentSchema,
  answer_readiness: z.array(answerReadinessSchema).max(CONTENT_QA_V1_LIMITS.answers),
  rule_judgments: z.array(ruleJudgmentSchema).max(CONTENT_QA_V1_LIMITS.rules),
  unlisted_claims: z.array(unlistedClaimSchema).max(CONTENT_QA_V1_LIMITS.claims),
  prohibited_paraphrases: z.array(prohibitedParaphraseSchema).max(CONTENT_QA_V1_LIMITS.paraphrases),
  /** Null when the task names no primary conversion. */
  call_to_action: judgmentSchema(CTA_STATUSES, CONTENT_QA_V1_LIMITS.shortRationale).nullable(),
  /** Null when the task names no primary keyword. */
  keyword_use: judgmentSchema(KEYWORD_STATUSES, CONTENT_QA_V1_LIMITS.shortRationale).nullable(),
  brand_voice: judgmentSchema(VOICE_STATUSES, CONTENT_QA_V1_LIMITS.ruleRationale),
});

/** The current contract. */
export const contentQaSchema = contentQaSchemaV1;

export type ContentQaOutput = z.infer<typeof contentQaSchemaV1>;

/** Every version on record, by the version string an AiRun carries. */
export const CONTENT_QA_SCHEMAS: Record<string, z.ZodType<ContentQaOutput>> = {
  "1": contentQaSchemaV1,
};
