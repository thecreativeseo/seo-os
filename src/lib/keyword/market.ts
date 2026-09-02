/**
 * Turning what a website says about itself into a locale identity.
 *
 * P0 collects "primary market" and "primary language" as free text, because that
 * is the honest way to ask a person a question in an onboarding form. It stores
 * answers like "United Kingdom" and "English".
 *
 * P2 needs ISO codes, because keyword identity includes the market and a
 * free-text label cannot be a key. The first version of this rejected anything
 * that was not already a code, which meant an import into a website onboarded the
 * ordinary way refused every single row — for a reason no one could see, about a
 * field nobody was told mattered.
 *
 * So the rule is: understand what can be understood, fall back to the default for
 * the rest, and never fail an import over a locale label. This is not fabricating
 * a measurement. A market code is a filing decision, not a claim about the world,
 * and filing something under the default is recoverable in a way that refusing to
 * import it is not.
 *
 * `coerced` is returned so a caller can tell somebody what was assumed.
 */

export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_MARKET = "PH";

/** Common answers to "what language?", lowercased. */
const LANGUAGE_NAMES: Record<string, string> = {
  english: "en",
  filipino: "tl",
  tagalog: "tl",
  spanish: "es",
  espanol: "es",
  french: "fr",
  german: "de",
  dutch: "nl",
  italian: "it",
  portuguese: "pt",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  mandarin: "zh",
  arabic: "ar",
  hindi: "hi",
  indonesian: "id",
  vietnamese: "vi",
  thai: "th",
  malay: "ms",
};

/** Common answers to "what market?", lowercased. Also accepts ISO-3 codes. */
const MARKET_NAMES: Record<string, string> = {
  philippines: "PH",
  phl: "PH",
  "united kingdom": "GB",
  uk: "GB",
  gbr: "GB",
  britain: "GB",
  "great britain": "GB",
  england: "GB",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  america: "US",
  australia: "AU",
  aus: "AU",
  canada: "CA",
  can: "CA",
  singapore: "SG",
  sgp: "SG",
  malaysia: "MY",
  mys: "MY",
  indonesia: "ID",
  idn: "ID",
  india: "IN",
  ind: "IN",
  "new zealand": "NZ",
  nzl: "NZ",
  ireland: "IE",
  irl: "IE",
  germany: "DE",
  deu: "DE",
  france: "FR",
  fra: "FR",
  spain: "ES",
  esp: "ES",
  japan: "JP",
  jpn: "JP",
  "united arab emirates": "AE",
  uae: "AE",
  "hong kong": "HK",
  hkg: "HK",
  vietnam: "VN",
  vnm: "VN",
  thailand: "TH",
  tha: "TH",
  global: "US",
  worldwide: "US",
  international: "US",
};

const LANGUAGE_CODE = /^[a-z]{2}$/;
const MARKET_CODE = /^[A-Z]{2}$/;

export type MarketIdentity = {
  language: string;
  market: string;
  locale: string;
  /** True when something had to be assumed, so a caller can say so. */
  coerced: boolean;
};

export function coerceLanguage(input: string | null | undefined): {
  value: string;
  coerced: boolean;
} {
  const raw = (input ?? "").trim();

  if (raw === "") return { value: DEFAULT_LANGUAGE, coerced: false };

  const lower = raw.toLowerCase();

  if (LANGUAGE_CODE.test(lower)) return { value: lower, coerced: false };

  // "en-GB" and "en_GB" both name a language in their first part.
  const base = lower.split(/[-_]/)[0]!;
  if (LANGUAGE_CODE.test(base)) return { value: base, coerced: true };

  const named = LANGUAGE_NAMES[lower];
  if (named) return { value: named, coerced: true };

  return { value: DEFAULT_LANGUAGE, coerced: true };
}

export function coerceMarket(input: string | null | undefined): {
  value: string;
  coerced: boolean;
} {
  const raw = (input ?? "").trim();

  if (raw === "") return { value: DEFAULT_MARKET, coerced: false };

  const upper = raw.toUpperCase();

  if (MARKET_CODE.test(upper)) return { value: upper, coerced: false };

  // "en-GB" names a market in its second part.
  const parts = raw.split(/[-_]/);
  const tail = parts.length > 1 ? parts[parts.length - 1]!.toUpperCase() : "";
  if (MARKET_CODE.test(tail)) return { value: tail, coerced: true };

  const named = MARKET_NAMES[raw.toLowerCase()];
  if (named) return { value: named, coerced: true };

  return { value: DEFAULT_MARKET, coerced: true };
}

/** The locale identity for a website, from whatever it happens to hold. */
export function marketIdentityFor(input: {
  language?: string | null;
  market?: string | null;
}): MarketIdentity {
  const language = coerceLanguage(input.language);
  const market = coerceMarket(input.market);

  return {
    language: language.value,
    market: market.value,
    locale: `${language.value}-${market.value}`,
    coerced: language.coerced || market.coerced,
  };
}
