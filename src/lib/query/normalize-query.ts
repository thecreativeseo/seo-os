import { foldSearchText } from "@/lib/text/fold-search-text";

/**
 * Search query normalization for Query identity (docs/P1_SPEC.md §7).
 *
 * A Query is unique on (websiteId, normalizedQuery). Search Console already
 * lowercases and collapses most variation, but not all of it, and two rows that
 * differ only by spacing would otherwise become two queries whose metrics never
 * add up to the real total.
 *
 * The folding itself lives in foldSearchText, shared with keyword normalization:
 * a GSC query and a Semrush keyword that are the same string must produce the same
 * identity, and two copies of the rules would eventually disagree.
 */

export type QueryNormalizeError = "empty" | "too_long";

export type QueryNormalizeResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: QueryNormalizeError };

/** Search Console rejects queries beyond this length; anything longer is malformed. */
const MAX_QUERY_LENGTH = 300;

export function normalizeQuery(input: string): QueryNormalizeResult {
  const collapsed = foldSearchText(input);

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
