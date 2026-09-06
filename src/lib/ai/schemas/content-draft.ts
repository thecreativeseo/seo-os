import { z } from "zod";

/**
 * The shape a content draft must arrive in (docs/P4_SPEC.md §10, §11).
 *
 * The body is markdown; everything the server will check about it is also
 * asked for as data. Every business claim the draft makes is listed with the
 * evidence ID of the approved fact it rests on - or null, which the server
 * records as unsupported rather than hiding. Facts the writer needed and did
 * not have go in open_questions, never into the body as if known.
 *
 * Enums and bounds are restated here rather than imported (see
 * page-diagnosis.ts): this is a contract with something outside the process.
 *
 * Two versions are on record. Version 1 is what every run before the
 * real-provider fix was validated against; it stays exactly as it was, for
 * those runs. Version 2 is the current contract: a strict object (unknown
 * keys refused), every list required as an array, and more room for the two
 * descriptive fields a real model overran - an open question and the change
 * summary. Nothing else moved: the slug pattern, the claim and link shapes,
 * the evidence id bounds and every other limit are those of version 1.
 */

export const CONTENT_DRAFT_SCHEMA_VERSION = "2";
export const CONTENT_DRAFT_SCHEMA_NAME = "content_draft";

/** URL-safe, lowercase, hyphenated; the CMS gets exactly this. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// --- Version 1: preserved for the runs that were validated against it ------

export const draftClaimSchema = z.object({
  text: z.string().min(1).max(500),
  /** The brand fact or business context record behind the claim, or null when there is none. */
  evidence_id: z.string().min(1).max(200).nullable().default(null),
});

export const contentDraftSchemaV1 = z.object({
  title: z.string().min(1).max(200),
  slug: z.string().regex(SLUG_PATTERN).max(120).nullable().default(null),
  excerpt: z.string().max(500).nullable().default(null),
  meta_title: z.string().max(200).nullable().default(null),
  meta_description: z.string().max(400).nullable().default(null),
  body_markdown: z.string().min(1).max(80_000),
  claims: z.array(draftClaimSchema).max(40).default([]),
  internal_links_used: z
    .array(
      z.object({
        evidence_id: z.string().min(1).max(200),
        anchor_text: z.string().min(1).max(200),
      }),
    )
    .max(20)
    .default([]),
  /** Which of the brief's required sections the draft covers, by heading. */
  sections_covered: z.array(z.string().min(1).max(200)).max(30).default([]),
  /** Facts the piece needs that the evidence does not hold. Named, not invented. */
  open_questions: z.array(z.string().min(1).max(300)).max(20).default([]),
  change_summary: z.string().min(1).max(500),
});

// --- Version 2: the current contract ---------------------------------------

/**
 * The two limits version 2 changed, and only those. The prompt asks for a
 * comfortable margin below each.
 */
export const CONTENT_DRAFT_V2_LIMITS = {
  openQuestion: 500,
  changeSummary: 1000,
} as const;

export const draftClaimSchemaV2 = z.strictObject({
  text: z.string().min(1).max(500),
  /** The brand fact or business context record behind the claim, or null when there is none. */
  evidence_id: z.string().min(1).max(200).nullable(),
});

export const internalLinkUsedSchemaV2 = z.strictObject({
  evidence_id: z.string().min(1).max(200),
  anchor_text: z.string().min(1).max(200),
});

export const contentDraftSchemaV2 = z.strictObject({
  title: z.string().min(1).max(200),
  slug: z.string().regex(SLUG_PATTERN).max(120).nullable(),
  excerpt: z.string().max(500).nullable(),
  meta_title: z.string().max(200).nullable(),
  meta_description: z.string().max(400).nullable(),
  body_markdown: z.string().min(1).max(80_000),
  claims: z.array(draftClaimSchemaV2).max(40),
  internal_links_used: z.array(internalLinkUsedSchemaV2).max(20),
  /** Which of the brief's required sections the draft covers, by heading. */
  sections_covered: z.array(z.string().min(1).max(200)).max(30),
  /** Facts the piece needs that the evidence does not hold. Named, not invented. */
  open_questions: z.array(z.string().min(1).max(CONTENT_DRAFT_V2_LIMITS.openQuestion)).max(20),
  change_summary: z.string().min(1).max(CONTENT_DRAFT_V2_LIMITS.changeSummary),
});

/** The current contract. */
export const contentDraftSchema = contentDraftSchemaV2;

export type ContentDraftOutput = z.infer<typeof contentDraftSchemaV2>;
export type DraftClaim = z.infer<typeof draftClaimSchemaV2>;

/** Every version on record, by the version string an AiRun carries. */
export const CONTENT_DRAFT_SCHEMAS: Record<string, z.ZodType<ContentDraftOutput>> = {
  "1": contentDraftSchemaV1,
  "2": contentDraftSchemaV2,
};
