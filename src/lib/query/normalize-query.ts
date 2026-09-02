/**
 * Search query normalization for Query identity (docs/P1_SPEC.md §7).
 *
 * A Query is unique on (websiteId, normalizedQuery). Search Console already
 * lowercases and collapses most variation, but not all of it, and two rows that
 * differ only by spacing would otherwise become two queries whose metrics never
 * add up to the real total.
 *
 * Deliberately conservative. Stemming, stop-word removal and de-pluralisation all
 * merge queries that people actually search differently and that rank
 * differently — "seo agency" and "seo agencies" are not the same query, and
 * treating them as one would hide exactly the kind of split this phase exists to
 * surface. Normalization here is limited to typographic noise.
 */

export type QueryNormalizeError = "empty" | "too_long";

export type QueryNormalizeResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: QueryNormalizeError };

/** Search Console rejects queries beyond this length; anything longer is malformed. */
const MAX_QUERY_LENGTH = 300;

export function normalizeQuery(input: string): QueryNormalizeResult {
  const collapsed = input
    // Unicode spaces, tabs and newlines all become a single space.
    .replace(/\s+/gu, " ")
    .trim()
    // Curly quotes and dashes are typographic variants of the same query.
    .replace(/[‘’‛′]/gu, "'")
    .replace(/[“”‟″]/gu, '"')
    .replace(/[‐-―]/gu, "-")
    // Combining marks are folded so "café" and "café" are one query. Base
    // accented characters are left alone: "cafe" and "café" stay distinct, because
    // they are typed and ranked separately.
    .normalize("NFC")
    .toLowerCase();

  if (collapsed.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (collapsed.length > MAX_QUERY_LENGTH) {
    return { ok: false, reason: "too_long" };
  }

  return { ok: true, normalized: collapsed };
}

export const QUERY_NORMALIZE_ERROR_MESSAGES: Record<QueryNormalizeError, string> = {
  empty: "Enter a search query.",
  too_long: "That query is longer than Search Console supports.",
};
