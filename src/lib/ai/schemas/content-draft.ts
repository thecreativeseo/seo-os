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
 */

export const CONTENT_DRAFT_SCHEMA_VERSION = "1";
export const CONTENT_DRAFT_SCHEMA_NAME = "content_draft";

/** URL-safe, lowercase, hyphenated; the CMS gets exactly this. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const draftClaimSchema = z.object({
  text: z.string().min(1).max(500),
  /** The brand fact or business context record behind the claim, or null when there is none. */
  evidence_id: z.string().min(1).max(200).nullable().default(null),
});

export const contentDraftSchema = z.object({
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

export type ContentDraftOutput = z.infer<typeof contentDraftSchema>;
export type DraftClaim = z.infer<typeof draftClaimSchema>;
