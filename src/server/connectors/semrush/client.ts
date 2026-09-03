import type { NormalizedImportRow } from "@/lib/import/formats";
import { resolveMarketCode } from "@/lib/markets";

/**
 * Semrush Analytics API v3 (docs/P2_SPEC.md §7 LIVE API MODE).
 *
 * Verified against developer.semrush.com rather than written from memory: the
 * endpoint is a single GET to https://api.semrush.com/ with `type` selecting the
 * report, the answer is semicolon-separated CSV, and the columns are requested by
 * two-letter codes. Nothing about that is guessable, and a connector that guessed
 * would fail in the one way this codebase cannot tolerate — by returning
 * plausible numbers attached to the wrong keywords.
 *
 * The security note that shapes the whole file: the API key travels in the query
 * string. That is Semrush's design, not ours, and it means the request URL is a
 * secret. So the URL is never logged, never stored on a SyncRun, and never
 * included in an error — and because an upstream error body can echo the request
 * that caused it, no upstream text is ever passed through either. Errors are
 * mapped to our own fixed set before they leave this file.
 */

const ENDPOINT = "https://api.semrush.com/";

/**
 * Semrush's documented maximum is 100,000 rows per request. Ten thousand is used
 * instead because rows are billed — 10 API units each — and a sync that quietly
 * spent a million units on a domain nobody meant to pull would be an expensive
 * surprise. `maxRows` below is the real ceiling.
 */
export const PAGE_SIZE = 10_000;

/**
 * A default ceiling on one sync.
 *
 * Chosen for cost rather than for capability. At 10 units per row this is 500,000
 * units, which is already a large deliberate spend; a caller who wants more must
 * ask for it, so nobody discovers the size of their bill afterwards.
 */
export const DEFAULT_MAX_ROWS = 50_000;

/**
 * Requests per second, per Semrush's published limit (also 10 simultaneous).
 *
 * Honoured by spacing requests rather than by firing ten and hoping. We page
 * sequentially anyway — each page needs the previous offset — so the practical
 * effect is a floor on the gap between calls.
 */
export const MIN_REQUEST_INTERVAL_MS = 100;

export type SemrushErrorCode =
  | "invalid_key"
  | "quota_exhausted"
  | "rate_limited"
  | "unknown_database"
  | "not_subscribed"
  | "upstream_error"
  | "request_failed"
  | "invalid_response";

/**
 * Our messages, not Semrush's.
 *
 * A fixed table because the upstream body may contain the request, and the
 * request contains the key. Nothing read from the wire reaches a log, a SyncRun
 * row, or a screen.
 */
export const SEMRUSH_ERROR_MESSAGES: Record<SemrushErrorCode, string> = {
  invalid_key: "Semrush rejected the API key. Check it and connect again.",
  quota_exhausted: "This Semrush account has no API units left.",
  rate_limited: "Semrush is rate limiting these requests. Try again shortly.",
  unknown_database: "Semrush has no database for this website's market.",
  not_subscribed: "This Semrush plan does not include API access to that report.",
  upstream_error: "Semrush could not answer this request.",
  request_failed: "Semrush could not be reached.",
  invalid_response: "Semrush returned data in a shape SEO OS could not read.",
};

export class SemrushError extends Error {
  constructor(readonly code: SemrushErrorCode) {
    super(SEMRUSH_ERROR_MESSAGES[code]);
    this.name = "SemrushError";
  }
}

/**
 * The columns requested, in order.
 *
 * Requested explicitly rather than accepting the default set, because the default
 * omits keyword difficulty, intent and SERP features — three of the fields
 * P2_SPEC §7 names — and includes trend and traffic-cost columns we have nowhere
 * to put. Order matters: the response is positional CSV with a header, and this
 * list is what the header is checked against.
 */
export const EXPORT_COLUMNS = [
  "Ph", // keyword
  "Po", // current position
  "Pp", // previous position
  "Nq", // search volume
  "Kd", // keyword difficulty
  "Cp", // CPC
  "Ur", // ranking URL
  "In", // intent
  "Fp", // SERP features present
  "Ts", // timestamp
] as const;

/**
 * How each requested column is found in the response header.
 *
 * Columns are located by name, not by the position we asked for them in. The
 * difference matters because of what is and is not verified here: the first six
 * labels below are confirmed against the published example response for
 * `domain_organic`, and the last four are not — that example uses the default
 * column set, which omits difficulty, intent, SERP features and timestamp.
 *
 * Reading positionally would mean betting the data on four labels nobody
 * checked. If Semrush calls its intent column something other than the guesses
 * here, a positional parser writes intent strings into the difficulty field and
 * the numbers look fine. A name lookup cannot do that: an unrecognised column is
 * simply not found, which is visible.
 *
 * So each field lists the spellings we accept. Missing an optional column costs
 * that column and nothing else, and is reported.
 */
const COLUMN_ALIASES = {
  keyword: ["keyword"],
  position: ["position"],
  previousPosition: ["previous position"],
  searchVolume: ["search volume"],
  // Unverified: alias list rather than a single guess, and absence is survivable.
  keywordDifficulty: ["keyword difficulty", "difficulty", "kd"],
  cpc: ["cpc"],
  landingUrl: ["url"],
  intent: ["keyword intents", "keyword intent", "intent", "intents"],
  serpFeatures: ["serp features by keyword", "serp features", "serp feature", "serp_features"],
  capturedAt: ["timestamp", "date"],
} as const;

type FieldName = keyof typeof COLUMN_ALIASES;

/**
 * Without a keyword there is nothing to attach a reading to, and without a
 * position the row says nothing this sync exists to record. Everything else is
 * allowed to be absent.
 */
const REQUIRED_FIELDS: FieldName[] = ["keyword", "position"];

export type FetchOrganicPositionsParams = {
  apiKey: string;
  /** Bare domain, e.g. "example.com". */
  domain: string;
  /** Semrush regional database code, e.g. "us", "uk", "ph". */
  database: string;
  maxRows?: number;
  /**
   * Rows per request. Defaults to `PAGE_SIZE`.
   *
   * Exposed because a very large page can time out on a slow connection, and
   * because pagination is otherwise only reachable at ten thousand rows, which
   * makes the paging loop effectively untestable.
   */
  pageSize?: number;
  /** Injectable so tests exercise parsing and error mapping without a network. */
  fetchImpl?: typeof fetch;
  /** Injectable so the rate-limit spacing does not make tests slow. */
  sleepImpl?: (ms: number) => Promise<void>;
};

export type FetchOrganicPositionsResult = {
  rows: NormalizedImportRow[];
  /** True when `maxRows` stopped us before Semrush ran out of rows to give. */
  truncated: boolean;
  /** Rows Semrush returned that could not be read as a keyword row. */
  malformed: number;
  /**
   * Requested columns absent from the response.
   *
   * Surfaced rather than swallowed: if Semrush stops returning keyword
   * difficulty, the honest outcome is a sync that says difficulty is missing,
   * not one that quietly writes null into every row and looks healthy.
   */
  missingColumns: string[];
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Every organic keyword Semrush has this domain ranking for.
 *
 * One report answers both of P2's questions — `domain_organic` carries position
 * and previous position alongside volume, difficulty and CPC — so rankings and
 * keyword metrics come from a single billed pull rather than two.
 */
export async function fetchOrganicPositions(
  params: FetchOrganicPositionsParams,
): Promise<FetchOrganicPositionsResult> {
  const doFetch = params.fetchImpl ?? fetch;
  const doSleep = params.sleepImpl ?? sleep;
  const maxRows = params.maxRows ?? DEFAULT_MAX_ROWS;
  const pageSize = Math.max(1, Math.min(params.pageSize ?? PAGE_SIZE, PAGE_SIZE));

  const rows: NormalizedImportRow[] = [];
  let malformed = 0;
  let offset = 0;
  let truncated = false;
  let missingColumns: string[] = [];

  while (rows.length < maxRows) {
    if (offset > 0) await doSleep(MIN_REQUEST_INTERVAL_MS);

    const limit = Math.min(pageSize, maxRows - rows.length);
    const body = await request(doFetch, {
      key: params.apiKey,
      type: "domain_organic",
      domain: params.domain,
      database: params.database,
      display_limit: String(limit),
      display_offset: String(offset),
      export_columns: EXPORT_COLUMNS.join(","),
      // Quoted fields, so a keyword containing a semicolon does not shift every
      // column after it. Semrush emits raw values without this.
      export_escape: "1",
    });

    const page = parseCsv(body);
    malformed += page.malformed;
    missingColumns = page.missingColumns;

    // No rows left. Semrush signals the end of a report by returning its
    // "nothing found" error, which `request` maps to an empty body.
    if (page.rows.length === 0) break;

    rows.push(...page.rows);
    offset += page.rows.length;

    // A short page means the report is exhausted, not that we should ask again.
    if (page.rows.length < limit) break;
  }

  // We stopped on our own ceiling rather than on the data running out.
  if (rows.length >= maxRows) truncated = true;

  return { rows, truncated, malformed, missingColumns };
}

/**
 * One HTTP call, with the response classified before anything else looks at it.
 *
 * Returns an empty string for "nothing found", which is a successful empty
 * report rather than a failure — Semrush reports both through the same channel,
 * and conflating them would turn a domain with no rankings into a sync error.
 */
async function request(doFetch: typeof fetch, query: Record<string, string>): Promise<string> {
  const url = new URL(ENDPOINT);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }

  let response: Response;

  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    // Deliberately not inspecting the thrown error. A fetch failure can carry the
    // request URL in its message, and the URL holds the key.
    throw new SemrushError("request_failed");
  }

  if (response.status === 429) throw new SemrushError("rate_limited");

  let body: string;

  try {
    body = await response.text();
  } catch {
    throw new SemrushError("invalid_response");
  }

  if (!response.ok) throw classify(body, "upstream_error");

  // The v3 API answers 200 with an error in the body, so status alone proves
  // nothing. Anything that is not a CSV header is treated as an error.
  if (body.startsWith("ERROR")) throw classify(body, "upstream_error");

  return body;
}

/**
 * Maps an upstream error body to one of ours.
 *
 * Matched on the numeric code, which is stable, rather than on the message text,
 * which is not. Unrecognised codes fall through to a generic error instead of
 * being reported as something specific we have not actually identified.
 *
 * The body is read here and never propagated: `SemrushError` carries only a code
 * from our own table.
 */
function classify(body: string, fallback: SemrushErrorCode): SemrushError {
  const code = /ERROR\s+(\d+)/.exec(body)?.[1];

  switch (code) {
    // Documented on developer.semrush.com: 120 wrong key, 130 not subscribed,
    // 131 wrong database, 132/133 units exhausted, 135 API disabled.
    case "120":
    case "134":
      return new SemrushError("invalid_key");
    case "130":
    case "135":
      return new SemrushError("not_subscribed");
    case "131":
      return new SemrushError("unknown_database");
    case "132":
    case "133":
      return new SemrushError("quota_exhausted");
    default:
      return new SemrushError(fallback);
  }
}

/**
 * Turns Semrush's CSV into the shape the importer already produces.
 *
 * Reusing `NormalizedImportRow` is the point of this function. The CSV importer
 * has been normalizing, deduplicating and attributing these same fields since P2,
 * and a live connector that invented a parallel shape would need all of that
 * written twice and kept in agreement forever. Fetched rows and uploaded rows
 * reach the database through identical code.
 */
export function parseCsv(body: string): {
  rows: NormalizedImportRow[];
  malformed: number;
  /** Columns we asked for and could not find. Reported, never guessed around. */
  missingColumns: FieldName[];
} {
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);

  // An empty report. Not an error: a domain can genuinely rank for nothing.
  if (lines.length === 0) return { rows: [], malformed: 0, missingColumns: [] };

  const headers = splitRow(lines[0]).map((header) => header.trim().toLowerCase());

  const index = {} as Record<FieldName, number | undefined>;
  const missingColumns: FieldName[] = [];

  for (const field of Object.keys(COLUMN_ALIASES) as FieldName[]) {
    const found = headers.findIndex((header) =>
      (COLUMN_ALIASES[field] as readonly string[]).includes(header),
    );

    if (found === -1) missingColumns.push(field);
    else index[field] = found;
  }

  // Not the report we asked for. Better to refuse than to store a column we
  // cannot identify against a field we only assume it means.
  if (REQUIRED_FIELDS.some((field) => index[field] === undefined)) {
    throw new SemrushError("invalid_response");
  }

  const rows: NormalizedImportRow[] = [];
  let malformed = 0;

  for (const line of lines.slice(1)) {
    const cells = splitRow(line);

    // Short of the header's own width, so the cells cannot be trusted to line up.
    if (cells.length !== headers.length) {
      malformed += 1;
      continue;
    }

    const cell = (field: FieldName): string => {
      const at = index[field];
      return at === undefined ? "" : (cells[at] ?? "");
    };

    const keyword = cell("keyword").trim();

    // A row with no keyword names nothing and cannot be stored against one.
    if (!keyword) {
      malformed += 1;
      continue;
    }

    rows.push({
      keyword,
      normalizedKeyword: keyword.toLowerCase(),
      intent: cell("intent").trim() || null,
      position: number(cell("position")),
      previousPosition: number(cell("previousPosition")),
      searchVolume: integer(cell("searchVolume")),
      keywordDifficulty: number(cell("keywordDifficulty")),
      cpc: number(cell("cpc")),
      landingUrl: cell("landingUrl").trim() || null,
      // Semrush's domain_organic report is organic positions by definition.
      rankingType: "ORGANIC",
      serpFeatures: cell("serpFeatures")
        .split(",")
        .map((feature) => feature.trim())
        .filter((feature) => feature.length > 0),
      // A domain report is about this domain; the competitor reports are what
      // carry a domain column.
      domain: null,
      capturedAt: date(cell("capturedAt")),
    });
  }

  return { rows, malformed, missingColumns };
}

/**
 * Splits one semicolon-separated line, honouring `export_escape` quoting.
 *
 * Written out rather than pulled from a CSV library because the delimiter is a
 * semicolon and the quoting rules are Semrush's; a general parser configured
 * wrongly would be harder to verify than fifteen lines that do exactly this.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ";") {
      cells.push(current);
      current = "";
    } else current += char;
  }

  cells.push(current);
  return cells;
}

/**
 * A number, or null.
 *
 * Null rather than zero on anything unreadable, because zero is a measurement
 * and "Semrush did not say" is not one. A position of 0 would read as ranking
 * above first place.
 */
function number(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function integer(raw: string): number | null {
  const value = number(raw);
  return value === null ? null : Math.round(value);
}

/**
 * Semrush's timestamp is Unix seconds; we store the date the reading is about.
 *
 * Returns null rather than today's date when it is unreadable. Substituting now
 * would date a stale reading to this morning, which is the kind of quiet
 * fabrication that makes a trend line lie.
 */
function date(raw: string): string | null {
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const parsed = new Date(seconds * 1000);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString().slice(0, 10);
}

/**
 * The Semrush regional database for a website's market.
 *
 * Semrush keys its databases on country codes, mostly lowercase ISO-3166 with
 * "uk" where ISO says "gb". Anything else is passed through lowercased rather
 * than mapped through a table invented here: an unknown database returns a clean
 * "unknown_database" error from Semrush, which is a better outcome than this
 * function silently substituting the US database and attributing American search
 * volumes to a Philippine site.
 */
export function databaseForMarket(market: string | null): string | null {
  // Resolved first, so a record that still holds "United Kingdom" becomes "uk"
  // and a sentence becomes null — never a lowercased sentence sent as a database.
  const code = resolveMarketCode(market);
  if (code === null) return null;

  return code === "GB" ? "uk" : code.toLowerCase();
}
