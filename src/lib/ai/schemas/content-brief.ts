import { z } from "zod";

/**
 * The shape a content brief must arrive in (docs/P4_SPEC.md §7, §8).
 *
 * The same discipline as the diagnosis schema: every field that makes a
 * claim about the business - what may be said, what must not be said, which
 * rule applies, which page to link - names the evidence ID it rests on, and
 * the server checks each one against the sealed package before anything is
 * stored. A brief that says "trusted by 10,000 businesses" with no fact behind
 * it does not get to say it.
 *
 * Enums are restated as literals on purpose (see page-diagnosis.ts): this is a
 * contract with something outside the process.
 */

export const CONTENT_BRIEF_SCHEMA_VERSION = "1";
export const CONTENT_BRIEF_SCHEMA_NAME = "content_brief";

export const CONTENT_TYPES = [
  "ARTICLE",
  "GUIDE",
  "LANDING_PAGE",
  "PRODUCT_PAGE",
  "COMPARISON",
  "FAQ",
  "CASE_STUDY",
  "OTHER",
] as const;

/** Mirrors KeywordIntent (P2). */
export const SEARCH_INTENTS = [
  "INFORMATIONAL",
  "COMMERCIAL",
  "TRANSACTIONAL",
  "NAVIGATIONAL",
  "LOCAL",
  "MIXED",
  "UNKNOWN",
] as const;

const evidenceId = z.string().min(1).max(200);

/** A sentence that rests on one record. */
export const citedTextSchema = z.object({
  text: z.string().min(1).max(500),
  evidence_id: evidenceId,
});

export const sectionSchema = z.object({
  heading: z.string().min(1).max(200),
  purpose: z.string().min(1).max(500),
});

export const internalLinkTargetSchema = z.object({
  /** An ownership or content record naming the page to link to. */
  evidence_id: evidenceId,
  anchor_text: z.string().min(1).max(200),
  reason: z.string().min(1).max(300),
});

export const ruleConstraintSchema = z.object({
  /** The SEO rule's evidence ID. */
  evidence_id: evidenceId,
  /** What the rule means for this piece, in the writer's terms. */
  constraint: z.string().min(1).max(400),
});

export const contentBriefSchema = z.object({
  title: z.string().min(1).max(200),
  content_type: z.enum(CONTENT_TYPES),
  search_intent: z.enum(SEARCH_INTENTS),
  primary_conversion: z.string().max(300).nullable().default(null),
  audience: z.string().min(1).max(1000),
  customer_problem: z.string().min(1).max(1000),
  desired_outcome: z.string().min(1).max(1000),
  recommended_angle: z.string().min(1).max(1000),
  key_questions: z.array(z.string().min(1).max(300)).max(12).default([]),
  required_sections: z.array(sectionSchema).max(15).default([]),
  optional_sections: z.array(sectionSchema).max(10).default([]),
  internal_link_targets: z.array(internalLinkTargetSchema).max(10).default([]),
  /** Facts the piece will need that the package does not hold. Named, not invented. */
  external_evidence_requirements: z.array(z.string().min(1).max(300)).max(10).default([]),
  approved_claims: z.array(citedTextSchema).max(15).default([]),
  prohibited_claims: z.array(citedTextSchema).max(15).default([]),
  seo_rule_constraints: z.array(ruleConstraintSchema).max(10).default([]),
  /** Keyword records worth targeting alongside the primary keyword. */
  secondary_keyword_evidence_ids: z.array(evidenceId).max(10).default([]),
  brand_voice_notes: z.string().max(1000).nullable().default(null),
  /** What a better brief would have needed. Lowers nothing; informs the editor. */
  missing_evidence: z.array(z.string().min(1).max(300)).max(10).default([]),
});

export type ContentBriefOutput = z.infer<typeof contentBriefSchema>;
export type BriefSection = z.infer<typeof sectionSchema>;
