import type { CsvRow } from "@/lib/import/csv";
import { normalizeKeyword } from "@/lib/keyword/normalize-keyword";
import { normalizeUrl } from "@/lib/url/normalize-url";
import type { ImportSource, KeywordIntent } from "@/generated/prisma/client";

/**
 * Reading a Semrush export (docs/P2_SPEC.md §7).
 *
 * Semrush exports differ by report, and the column names drift between versions
 * and locales. Rather than requiring one exact header set, each format declares
 * the columns it cannot do without and the aliases it has been seen using; the
 * best-matching format wins, and the person confirms it before anything commits.
 *
 * Identification is a suggestion, never an assumption. Guessing wrong would
 * attribute rankings to the wrong entity, so the preview always names the format
 * it detected and lets it be changed.
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

type FormatSpec = {
  source: ImportSource;
  label: string;
  /** Every one of these must be present for the format to be considered. */
  required: string[][];
  /** Presence of these raises confidence but is not required. */
  distinguishing: string[][];
};

/**
 * Column aliases, lowercased. Semrush has shipped several spellings of the same
 * column, and a locale-switched export uses different capitalisation again.
 */
const COLUMN = {
  keyword: ["keyword", "keywords", "query"],
  position: ["position", "current position", "pos"],
  previousPosition: ["previous position", "previous pos", "prev. pos", "prev position"],
  searchVolume: ["search volume", "volume", "avg. monthly searches"],
  difficulty: ["keyword difficulty", "kd", "difficulty", "kd %"],
  cpc: ["cpc", "cpc (usd)", "cpc usd"],
  url: ["url", "landing page", "landing url", "page"],
  intent: ["keyword intents", "keyword intent", "intent", "intents"],
  serpFeatures: ["serp features by keyword", "serp features", "serp_features"],
  positionType: ["position type", "ranking type", "type"],
  timestamp: ["timestamp", "date", "captured at", "captured_at"],
  domain: ["domain", "competitor", "competitor domain", "website"],
} as const;

const FORMATS: FormatSpec[] = [
  {
    source: "SEMRUSH_COMPETITORS",
    label: "Semrush competitor positions",
    // Checked before positions: a competitor export is a positions export plus a
    // domain column, so the more specific format has to be tried first.
    required: [COLUMN.keyword.slice(), COLUMN.position.slice(), COLUMN.domain.slice()],
    distinguishing: [COLUMN.url.slice()],
  },
  {
    source: "SEMRUSH_POSITIONS",
    label: "Semrush organic positions",
    required: [COLUMN.keyword.slice(), COLUMN.position.slice()],
    distinguishing: [COLUMN.url.slice(), COLUMN.previousPosition.slice()],
  },
  {
    source: "SEMRUSH_KEYWORD_OVERVIEW",
    label: "Semrush keyword overview",
    required: [COLUMN.keyword.slice(), COLUMN.searchVolume.slice()],
    distinguishing: [COLUMN.difficulty.slice(), COLUMN.intent.slice()],
  },
  {
    source: "MANUAL_CSV",
    label: "Keyword list",
    required: [COLUMN.keyword.slice()],
    distinguishing: [],
  },
];

function findHeader(headers: string[], aliases: readonly string[]): string | null {
  const lowered = headers.map((header) => header.trim().toLowerCase());

  for (const alias of aliases) {
    const position = lowered.indexOf(alias);
    if (position !== -1) return headers[position]!;
  }

  return null;
}

export type FormatDetection = {
  source: ImportSource;
  label: string;
  /** 0–1. Shown to the person so a weak guess looks weak. */
  confidence: number;
};

/** Best-guess format for a header row. Always confirmed by a person. */
export function detectFormat(headers: string[]): FormatDetection | null {
  for (const format of FORMATS) {
    const hasRequired = format.required.every((aliases) => findHeader(headers, aliases) !== null);

    if (!hasRequired) continue;

    const matchedHints = format.distinguishing.filter(
      (aliases) => findHeader(headers, aliases) !== null,
    ).length;

    const confidence =
      format.distinguishing.length === 0
        ? 0.5
        : 0.6 + 0.4 * (matchedHints / format.distinguishing.length);

    return { source: format.source, label: format.label, confidence };
  }

  return null;
}

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

  // Semrush timestamps arrive as a full date-time in several shapes; anything
  // Date can read is accepted, anything else is left null rather than guessed.
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
 * Semrush's intent labels mapped onto our controlled vocabulary.
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
  MANUAL_CSV: "Keyword list",
};
