import type { CsvRow } from "@/lib/import/csv";
import { normalizeKeyword } from "@/lib/keyword/normalize-keyword";
import { normalizeUrl } from "@/lib/url/normalize-url";
import type { ConnectionProvider, ImportSource, KeywordIntent } from "@/generated/prisma/client";

/**
 * Reading a keyword export (docs/P2_SPEC.md §7).
 *
 * Semrush and Ahrefs both answer the same questions and disagree about the
 * answers. Their volumes come from different models and their difficulty scores
 * are both labelled 0–100 while being computed completely differently: an Ahrefs
 * KD of 40 and a Semrush KD of 40 are not the same claim. So every row this module
 * produces is attributed to the provider that made it, and nothing downstream
 * compares the two without knowing which said what.
 *
 * Detection has two independent parts, because they are two different questions:
 *
 *   - **Which vendor wrote this file?** Answered by fingerprint columns each one
 *     ships and the other does not.
 *   - **What shape is it?** Positions, keyword overview, competitor rankings, or
 *     a plain list — answered by which columns are present at all.
 *
 * Both are suggestions. The person confirms the format before anything commits,
 * because reading a competitor export as our own positions would attribute their
 * rankings to us.
 */

export type NormalizedImportRow = {
  keyword: string;
  normalizedKeyword: string;
  intent: string | null;
  position: number | null;
  previousPosition: number | null;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  landingUrl: string | null;
  rankingType: string | null;
  serpFeatures: string[];
  /** Present on competitor exports; the domain the row is about. */
  domain: string | null;
  capturedAt: string | null;
};

export type RowValidation =
  | { ok: true; value: NormalizedImportRow }
  | { ok: false; reason: string };

/**
 * Column aliases, lowercased.
 *
 * Both vendors have shipped several spellings of the same column, and a
 * locale-switched export capitalises differently again. Aliases are pooled rather
 * than kept per vendor: a column means the same thing whoever wrote it, and the
 * vendor question is answered separately below.
 */
const COLUMN = {
  keyword: ["keyword", "keywords", "query"],
  position: ["position", "current position", "current pos", "pos"],
  previousPosition: [
    "previous position",
    "previous pos",
    "prev. pos",
    "prev position",
    "prev. position",
  ],
  searchVolume: ["search volume", "volume", "global volume", "avg. monthly searches"],
  difficulty: ["keyword difficulty", "kd", "difficulty", "kd %"],
  cpc: ["cpc", "cpc (usd)", "cpc usd"],
  url: ["url", "current url", "landing page", "landing url", "page", "current top page"],
  intent: ["keyword intents", "keyword intent", "intent", "intents"],
  serpFeatures: ["serp features by keyword", "serp features", "serp_features"],
  positionType: ["position type", "ranking type", "type"],
  timestamp: ["timestamp", "date", "updated", "last update", "last updated", "captured at"],
  domain: ["domain", "competitor", "competitor domain", "website", "target"],
} as const;

/**
 * Columns one vendor ships and the other does not.
 *
 * Deliberately narrow. A fingerprint that both vendors could plausibly emit would
 * silently mis-attribute a file, and mis-attribution is the one failure that
 * corrupts the data rather than merely rejecting it.
 */
const VENDOR_FINGERPRINTS: { provider: ConnectionProvider; columns: string[] }[] = [
  {
    provider: "AHREFS",
    columns: [
      "current url",
      "previous url",
      "cps",
      "parent topic",
      "traffic potential",
      "global volume",
      "last update",
      "current top page",
    ],
  },
  {
    provider: "SEMRUSH",
    columns: [
      "timestamp",
      "keyword intents",
      "position type",
      "search volume",
      "traffic (%)",
      "traffic cost",
      "number of results",
      "competitive density",
    ],
  },
];

type Shape = "POSITIONS" | "KEYWORD_OVERVIEW" | "COMPETITORS" | "MANUAL";

type ShapeSpec = {
  shape: Shape;
  required: readonly (readonly string[])[];
  distinguishing: readonly (readonly string[])[];
};

const SHAPES: ShapeSpec[] = [
  {
    // Checked first: a competitor export is a positions export plus a domain
    // column, so the more specific shape has to win or every competitor row
    // would be filed as ours.
    shape: "COMPETITORS",
    required: [COLUMN.keyword, COLUMN.position, COLUMN.domain],
    distinguishing: [COLUMN.url],
  },
  {
    shape: "POSITIONS",
    required: [COLUMN.keyword, COLUMN.position],
    distinguishing: [COLUMN.url, COLUMN.previousPosition],
  },
  {
    shape: "KEYWORD_OVERVIEW",
    required: [COLUMN.keyword, COLUMN.searchVolume],
    distinguishing: [COLUMN.difficulty, COLUMN.intent],
  },
  {
    shape: "MANUAL",
    required: [COLUMN.keyword],
    distinguishing: [],
  },
];

const SOURCE_FOR: Record<string, ImportSource> = {
  "SEMRUSH:POSITIONS": "SEMRUSH_POSITIONS",
  "SEMRUSH:KEYWORD_OVERVIEW": "SEMRUSH_KEYWORD_OVERVIEW",
  "SEMRUSH:COMPETITORS": "SEMRUSH_COMPETITORS",
  "AHREFS:POSITIONS": "AHREFS_POSITIONS",
  "AHREFS:KEYWORD_OVERVIEW": "AHREFS_KEYWORD_OVERVIEW",
  "AHREFS:COMPETITORS": "AHREFS_COMPETITORS",
};

/**
 * The provider whose numbers an import carries.
 *
 * A hand-written list has none, and that null is the point: no provider value
 * honestly describes a CSV somebody typed, and labelling those figures with a
 * vendor would attribute a measurement to a company that never made it.
 */
export function providerForSource(source: ImportSource): ConnectionProvider | null {
  if (source.startsWith("SEMRUSH_")) return "SEMRUSH";
  if (source.startsWith("AHREFS_")) return "AHREFS";
  return null;
}

function findHeader(headers: string[], aliases: readonly string[]): string | null {
  const lowered = headers.map((header) => header.trim().toLowerCase());

  for (const alias of aliases) {
    const position = lowered.indexOf(alias);
    if (position !== -1) return headers[position]!;
  }

  return null;
}

/** Which vendor wrote this file, by the columns only they ship. */
export function detectProvider(headers: string[]): ConnectionProvider | null {
  const lowered = new Set(headers.map((header) => header.trim().toLowerCase()));

  const scores = VENDOR_FINGERPRINTS.map((vendor) => ({
    provider: vendor.provider,
    hits: vendor.columns.filter((column) => lowered.has(column)).length,
  })).sort((a, b) => b.hits - a.hits);

  const best = scores[0];

  if (!best || best.hits === 0) return null;

  // A tie means the fingerprints are not doing their job; better to say "not
  // sure" and let a person choose than to guess between two vendors.
  if (scores[1] && scores[1].hits === best.hits) return null;

  return best.provider;
}

export type FormatDetection = {
  /**
   * Null when the file carries provider metrics but names no vendor. The caller
   * must then ask rather than assume — see the note below.
   */
  source: ImportSource | null;
  shape: Shape;
  label: string;
  provider: ConnectionProvider | null;
  /** 0–1. Shown to the person so a weak guess looks weak. */
  confidence: number;
};

/**
 * Best-guess format for a header row. Always confirmed by a person.
 *
 * The interesting case is a file that clearly holds volume, difficulty and
 * positions but carries no column that names its vendor. There are three things
 * that could be done with it and only one of them is honest:
 *
 *   - Guess a vendor. Attributes a difficulty score to a scale it was not computed
 *     on, and the mistake is invisible afterwards.
 *   - Treat it as a plain keyword list. Silently drops every metric in the file,
 *     which looks like a successful import of much less data than was supplied.
 *   - Say so, and ask. Costs one click.
 *
 * So `source` comes back null, and the upload refuses until a person picks.
 */
export function detectFormat(headers: string[]): FormatDetection | null {
  const provider = detectProvider(headers);

  for (const spec of SHAPES) {
    const hasRequired = spec.required.every((aliases) => findHeader(headers, aliases) !== null);

    if (!hasRequired) continue;

    const matchedHints = spec.distinguishing.filter(
      (aliases) => findHeader(headers, aliases) !== null,
    ).length;

    const shapeConfidence =
      spec.distinguishing.length === 0
        ? 0.5
        : 0.6 + 0.4 * (matchedHints / spec.distinguishing.length);

    if (spec.shape === "MANUAL") {
      return {
        source: "MANUAL_CSV",
        shape: spec.shape,
        label: IMPORT_SOURCE_LABELS.MANUAL_CSV,
        provider: null,
        confidence: shapeConfidence,
      };
    }

    const source = provider ? (SOURCE_FOR[`${provider}:${spec.shape}`] ?? null) : null;

    return {
      source,
      shape: spec.shape,
      label: source ? IMPORT_SOURCE_LABELS[source] : SHAPE_LABELS[spec.shape],
      provider,
      // An unidentified vendor caps confidence: the shape is known, the
      // attribution is not.
      confidence: provider ? shapeConfidence : Math.min(shapeConfidence, 0.5),
    };
  }

  return null;
}

const SHAPE_LABELS: Record<Shape, string> = {
  POSITIONS: "Organic positions",
  KEYWORD_OVERVIEW: "Keyword overview",
  COMPETITORS: "Competitor positions",
  MANUAL: "Keyword list",
};

function readNumber(value: string | undefined): number | null {
  if (value === undefined) return null;

  // Thousands separators and a stray percent sign are normal in an export.
  const cleaned = value.trim().replace(/[,\s%]/g, "");

  if (cleaned === "" || cleaned === "-" || cleaned.toLowerCase() === "n/a") return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function readDate(value: string | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim();

  // Already ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // Timestamps arrive in several shapes across vendors and locales; anything Date
  // can read is accepted, anything else is left null rather than guessed.
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export type MapOptions = {
  headers: string[];
  language?: string | null;
  market?: string | null;
  /** Used when the export carries no date of its own. */
  fallbackCapturedAt: string;
};

/**
 * Turns one CSV row into the normalized shape, or explains why it cannot.
 *
 * A row that fails here is reported, never repaired: guessing at a missing keyword
 * or an unparseable position would put a number in the product that nobody
 * measured.
 */
export function mapRow(row: CsvRow, options: MapOptions): RowValidation {
  const { headers } = options;

  const keywordHeader = findHeader(headers, COLUMN.keyword);
  const rawKeyword = keywordHeader ? (row[keywordHeader] ?? "") : "";

  const keyword = normalizeKeyword(rawKeyword, {
    language: options.language,
    market: options.market,
  });

  if (!keyword.ok) {
    return { ok: false, reason: `keyword_${keyword.reason}` };
  }

  const read = (aliases: readonly string[]): string | undefined => {
    const header = findHeader(headers, aliases);
    return header ? row[header] : undefined;
  };

  const position = readNumber(read(COLUMN.position));
  const previousPosition = readNumber(read(COLUMN.previousPosition));
  const searchVolume = readNumber(read(COLUMN.searchVolume));
  const difficulty = readNumber(read(COLUMN.difficulty));
  const cpc = readNumber(read(COLUMN.cpc));

  // Range checks. A position of 0 or 4,000 is a malformed export rather than a
  // ranking, and storing it would distort every average built on it.
  if (position !== null && (position < 1 || position > 200)) {
    return { ok: false, reason: "position_out_of_range" };
  }

  if (previousPosition !== null && (previousPosition < 1 || previousPosition > 200)) {
    return { ok: false, reason: "previous_position_out_of_range" };
  }

  if (searchVolume !== null && searchVolume < 0) {
    return { ok: false, reason: "negative_search_volume" };
  }

  if (difficulty !== null && (difficulty < 0 || difficulty > 100)) {
    return { ok: false, reason: "difficulty_out_of_range" };
  }

  const rawUrl = read(COLUMN.url)?.trim() ?? "";
  let landingUrl: string | null = null;

  if (rawUrl !== "") {
    const parsed = normalizeUrl(rawUrl);

    if (!parsed.ok) {
      return { ok: false, reason: `url_${parsed.reason}` };
    }

    landingUrl = parsed.value.normalized;
  }

  const serpFeatures = (read(COLUMN.serpFeatures) ?? "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);

  const domain = read(COLUMN.domain)?.trim() || null;

  return {
    ok: true,
    value: {
      keyword: rawKeyword.trim(),
      normalizedKeyword: keyword.value.normalized,
      intent: read(COLUMN.intent)?.trim() || null,
      position,
      previousPosition,
      searchVolume,
      keywordDifficulty: difficulty,
      cpc,
      landingUrl,
      rankingType: read(COLUMN.positionType)?.trim() || null,
      serpFeatures,
      domain,
      capturedAt: readDate(read(COLUMN.timestamp)) ?? options.fallbackCapturedAt,
    },
  };
}

/**
 * Provider intent labels mapped onto our controlled vocabulary.
 *
 * Anything unrecognised becomes UNKNOWN rather than a guess: an intent is what
 * decides whether a keyword is commercially interesting, and inventing one would
 * quietly move an opportunity up the queue.
 */
export function mapIntent(value: string | null): KeywordIntent {
  if (!value) return "UNKNOWN";

  const labels = value
    .toLowerCase()
    .split(/[,/]/)
    .map((label) => label.trim())
    .filter(Boolean);

  if (labels.length === 0) return "UNKNOWN";
  if (labels.length > 1) return "MIXED";

  switch (labels[0]) {
    case "informational":
    case "i":
      return "INFORMATIONAL";
    case "commercial":
    case "c":
      return "COMMERCIAL";
    case "transactional":
    case "t":
      return "TRANSACTIONAL";
    case "navigational":
    case "n":
      return "NAVIGATIONAL";
    case "local":
      return "LOCAL";
    default:
      return "UNKNOWN";
  }
}

export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  SEMRUSH_POSITIONS: "Semrush organic positions",
  SEMRUSH_KEYWORD_OVERVIEW: "Semrush keyword overview",
  SEMRUSH_COMPETITORS: "Semrush competitor positions",
  AHREFS_POSITIONS: "Ahrefs organic keywords",
  AHREFS_KEYWORD_OVERVIEW: "Ahrefs keywords explorer",
  AHREFS_COMPETITORS: "Ahrefs competitor keywords",
  MANUAL_CSV: "Keyword list",
};
