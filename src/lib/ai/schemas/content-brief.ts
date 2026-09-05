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
 *
 * Two versions. Version 1 is what prompt v1 asked for; runs recorded against
 * it are read with it. Version 2 (prompt v2) makes every list a required
 * array - a strict tool schema wants every key present, and a list arriving
 * as a string is refused rather than read - forbids keys the schema does not
 * name, and gives the three descriptive, free-text fields room a real model
 * uses: the reasons for internal links, the external evidence a writer must
 * find, and what the package was missing. Evidence ids, enums, claim texts
 * and the structural fields are exactly as in version 1.
 */

export const CONTENT_BRIEF_SCHEMA_VERSION = "2";
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

/** Version 1: lists default to empty when absent. Kept for runs recorded against prompt v1. */
export const contentBriefSchemaV1 = z.object({
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

/** Version 2's link target: the reason may run to a sentence or two. */
export const internalLinkTargetSchemaV2 = z.strictObject({
  evidence_id: evidenceId,
  anchor_text: z.string().min(1).max(200),
  reason: z.string().min(1).max(500),
});

/** The limits version 2 enforces on descriptive items. The prompt states margins below them. */
export const CONTENT_BRIEF_V2_LIMITS = {
  linkReason: 500,
  externalEvidenceRequirement: 500,
  missingEvidence: 800,
} as const;

/**
 * Version 2: every list is a required array, no unknown keys, and the three
 * descriptive lists have room. Nothing about evidence ids, enums, claim text
 * or citation requirements changes.
 */
export const contentBriefSchemaV2 = z.strictObject({
  title: z.string().min(1).max(200),
  content_type: z.enum(CONTENT_TYPES),
  search_intent: z.enum(SEARCH_INTENTS),
  primary_conversion: z.string().max(300).nullable(),
  audience: z.string().min(1).max(1000),
  customer_problem: z.string().min(1).max(1000),
  desired_outcome: z.string().min(1).max(1000),
  recommended_angle: z.string().min(1).max(1000),
  key_questions: z.array(z.string().min(1).max(300)).max(12),
  required_sections: z.array(z.strictObject(sectionSchema.shape)).max(15),
  optional_sections: z.array(z.strictObject(sectionSchema.shape)).max(10),
  internal_link_targets: z.array(internalLinkTargetSchemaV2).max(10),
  /** Facts the piece will need that the package does not hold. Named, not invented. */
  external_evidence_requirements: z
    .array(z.string().min(1).max(CONTENT_BRIEF_V2_LIMITS.externalEvidenceRequirement))
    .max(10),
  approved_claims: z.array(z.strictObject(citedTextSchema.shape)).max(15),
  prohibited_claims: z.array(z.strictObject(citedTextSchema.shape)).max(15),
  seo_rule_constraints: z.array(z.strictObject(ruleConstraintSchema.shape)).max(10),
  /** Keyword records worth targeting alongside the primary keyword. */
  secondary_keyword_evidence_ids: z.array(evidenceId).max(10),
  brand_voice_notes: z.string().max(1000).nullable(),
  /** What a better brief would have needed. Lowers nothing; informs the editor. */
  missing_evidence: z.array(z.string().min(1).max(CONTENT_BRIEF_V2_LIMITS.missingEvidence)).max(10),
});

/** The current schema: what the active prompt asks for. */
export const contentBriefSchema = contentBriefSchemaV2;

/** Every version, so a stored answer can be read with the shape its run used. */
export const CONTENT_BRIEF_SCHEMAS: Record<string, z.ZodType<ContentBriefOutput>> = {
  "1": contentBriefSchemaV1,
  "2": contentBriefSchemaV2,
};

export type ContentBriefOutput = z.infer<typeof contentBriefSchemaV2>;
export type BriefSection = z.infer<typeof sectionSchema>;
