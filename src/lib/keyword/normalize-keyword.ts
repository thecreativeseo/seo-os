import { foldSearchText } from "@/lib/text/fold-search-text";

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

export type KeywordNormalizeError =
  | "empty"
  | "too_long"
  | "invalid_language"
  | "invalid_market"
  | "invalid_locale";

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

/** Used when a website has not stated its own. */
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_MARKET = "PH";

const LANGUAGE = /^[a-z]{2}$/;
const MARKET = /^[A-Z]{2}$/;

export type MarketIdentity = {
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
 */
export function resolveMarketIdentity(
  identity: MarketIdentity = {},
): { ok: true; value: Omit<NormalizedKeyword, "normalized"> } | { ok: false; reason: KeywordNormalizeError } {
  const language = (identity.language ?? DEFAULT_LANGUAGE).trim().toLowerCase();
  const market = (identity.market ?? DEFAULT_MARKET).trim().toUpperCase();

  if (!LANGUAGE.test(language)) {
    return { ok: false, reason: "invalid_language" };
  }

  if (!MARKET.test(market)) {
    return { ok: false, reason: "invalid_market" };
  }

  return { ok: true, value: { language, market, locale: `${language}-${market}` } };
}

export function normalizeKeyword(
  input: string,
  identity: MarketIdentity = {},
): KeywordNormalizeResult {
  const normalized = foldSearchText(input);

  if (normalized.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (normalized.length > MAX_KEYWORD_LENGTH) {
    return { ok: false, reason: "too_long" };
  }

  const resolved = resolveMarketIdentity(identity);

  if (!resolved.ok) {
    return resolved;
  }

  return { ok: true, value: { normalized, ...resolved.value } };
}

export const KEYWORD_NORMALIZE_ERROR_MESSAGES: Record<KeywordNormalizeError, string> = {
  empty: "Enter a keyword.",
  too_long: "That keyword is longer than any provider supports.",
  invalid_language: "Language must be a two-letter code, for example en.",
  invalid_market: "Market must be a two-letter country code, for example PH.",
  invalid_locale: "Locale must be a language and market, for example en-PH.",
};
