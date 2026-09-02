import { foldSearchText } from "@/lib/text/fold-search-text";
import { marketIdentityFor } from "@/lib/keyword/market";

export { DEFAULT_LANGUAGE, DEFAULT_MARKET, marketIdentityFor } from "@/lib/keyword/market";

/**
 * Keyword identity (docs/P2_SPEC.md §8).
 *
 * A Keyword is unique on (websiteId, normalizedKeyword, locale, language, market).
 * The spec is explicit that there is no single global keyword identity: "payroll
 * software" in the Philippines and the same string in the United States are
 * different keywords with different volumes, different competitors and different
 * money behind them. Collapsing them would produce one row whose numbers describe
 * neither market.
 *
 * The text folding is shared with normalizeQuery through foldSearchText, so a
 * Search Console query and a Semrush keyword that are the same string resolve to
 * the same identity. That join is what lets P2 put first-party evidence next to
 * market evidence at all.
 */

export type KeywordNormalizeError = "empty" | "too_long";

export type NormalizedKeyword = {
  normalized: string;
  /** ISO 639-1, lowercase. */
  language: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  market: string;
  /** language-MARKET, e.g. en-PH. */
  locale: string;
};

export type KeywordNormalizeResult =
  | { ok: true; value: NormalizedKeyword }
  | { ok: false; reason: KeywordNormalizeError };

/**
 * Providers reject keywords beyond roughly this length, and anything longer is a
 * malformed export rather than something a person searched for.
 */
export const MAX_KEYWORD_LENGTH = 300;

export type MarketIdentityInput = {
  language?: string | null;
  market?: string | null;
};

/**
 * Resolves the three locale fields from whatever was supplied.
 *
 * All three are stored non-null with defaults rather than left blank. A null in a
 * unique key does not compare equal to another null in Postgres, so nullable
 * locale columns would silently permit duplicate keywords — the same trap that
 * produced duplicate signals in P1, and one worth designing out rather than
 * indexing around a second time.
 *
 * Coerces rather than rejects. P0 collects market and language as free text, so a
 * website says "United Kingdom" and "English" — and the first version of this
 * refused every keyword from such a site, failing entire imports over a label
 * nobody was told mattered. See lib/keyword/market for why filing under a default
 * is the recoverable choice and refusing is not.
 */
export function resolveMarketIdentity(
  identity: MarketIdentityInput = {},
): Omit<NormalizedKeyword, "normalized"> {
  const resolved = marketIdentityFor(identity);

  return {
    language: resolved.language,
    market: resolved.market,
    locale: resolved.locale,
  };
}

export function normalizeKeyword(
  input: string,
  identity: MarketIdentityInput = {},
): KeywordNormalizeResult {
  const normalized = foldSearchText(input);

  if (normalized.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (normalized.length > MAX_KEYWORD_LENGTH) {
    return { ok: false, reason: "too_long" };
  }

  // Only the keyword itself can fail. A locale label is filed, not validated.
  return { ok: true, value: { normalized, ...resolveMarketIdentity(identity) } };
}

export const KEYWORD_NORMALIZE_ERROR_MESSAGES: Record<KeywordNormalizeError, string> = {
  empty: "Enter a keyword.",
  too_long: "That keyword is longer than any provider supports.",
};
