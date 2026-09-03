import type { NormalizedImportRow } from "@/lib/import/formats";

/**
 * Ahrefs API v3 (docs/P2_SPEC.md §7 LIVE API MODE, second provider).
 *
 * Verified against docs.ahrefs.com rather than assumed to resemble the Semrush
 * connector, which it does not. Four differences shape this file:
 *
 *   - The key is a `Authorization: Bearer` header, not a query parameter. So the
 *     request URL is not a secret here, unlike Semrush's — but the header still
 *     never reaches a log, and no upstream body is propagated, because an error
 *     body can echo request headers.
 *   - The answer is JSON with a top-level `keywords` array, not CSV.
 *   - `cpc` is in **USD cents**. Semrush reports dollars. Storing one as the
 *     other makes every CPC a hundred times too high and still looks entirely
 *     plausible, which is the exact failure mode this codebase exists to refuse.
 *   - No `offset` parameter is documented for this endpoint. So this fetches one
 *     page and reports truncation rather than inventing a pagination parameter
 *     and silently getting page two of nothing.
 *
 * `date` and `select` are required by the API, which is why neither is optional
 * below.
 */

const ENDPOINT = "https://api.ahrefs.com/v3/site-explorer/organic-keywords";

/**
 * Ahrefs' documented default is 1000 rows. Ten thousand is requested instead
 * because a domain worth diagnosing ranks for more than a thousand keywords, and
 * capped there because rows consume API units.
 */
export const DEFAULT_LIMIT = 10_000;

/**
 * 60 requests per minute is the documented account limit. Only relevant if this
 * ever pages; kept as the stated fact so a future pagination loop has a number
 * to honour rather than rediscovering it from a 429.
 */
export const REQUESTS_PER_MINUTE = 60;

export type AhrefsErrorCode =
  | "invalid_key"
  | "quota_exhausted"
  | "rate_limited"
  | "not_subscribed"
  | "upstream_error"
  | "request_failed"
  | "invalid_response";

export const AHREFS_ERROR_MESSAGES: Record<AhrefsErrorCode, string> = {
  invalid_key: "Ahrefs rejected the API key. Check it and connect again.",
  quota_exhausted: "This Ahrefs account has no API units left.",
  rate_limited: "Ahrefs is rate limiting these requests. Try again shortly.",
  not_subscribed: "This Ahrefs plan does not include API access to that report.",
  upstream_error: "Ahrefs could not answer this request.",
  request_failed: "Ahrefs could not be reached.",
  invalid_response: "Ahrefs returned data in a shape SEO OS could not read.",
};

export class AhrefsError extends Error {
  constructor(readonly code: AhrefsErrorCode) {
    super(AHREFS_ERROR_MESSAGES[code]);
    this.name = "AhrefsError";
  }
}

/**
 * The columns requested.
 *
 * Every one of these is a confirmed field identifier from the endpoint's
 * documented response schema. Deliberately absent:
 *
 *   - a previous-position field, which this endpoint does not document. The
 *     schema's `previousPosition` therefore stays null for Ahrefs rows rather
 *     than being filled from our own last snapshot, which would present our
 *     arithmetic as the vendor's measurement.
 *   - search intent, which Ahrefs does not return here. Those keywords get
 *     UNKNOWN intent provenance, which is true.
 */
export const SELECT_FIELDS = [
  "keyword",
  "best_position",
  "best_position_url",
  "volume",
  "keyword_difficulty",
  "cpc",
  "serp_features",
] as const;

export type FetchOrganicKeywordsParams = {
  apiKey: string;
  /** Bare domain, e.g. "example.com". */
  target: string;
  /** ISO 3166-1 alpha-2, per the endpoint docs. */
  country: string;
  /** Required by the API. The date the snapshot is asked for. */
  date: string;
  limit?: number;
  /** Injectable so tests exercise parsing and error mapping without a network. */
  fetchImpl?: typeof fetch;
};

export type FetchOrganicKeywordsResult = {
  rows: NormalizedImportRow[];
  /** The response filled the requested limit, so more may exist and be unreachable. */
  truncated: boolean;
  /** Entries returned that could not be read as a keyword row. */
  malformed: number;
  /** Requested fields absent from every row returned. */
  missingFields: string[];
};

/**
 * This domain's organic keywords, as Ahrefs currently has them.
 *
 * One request. No pagination, because no offset or cursor parameter is
 * documented for this endpoint — and a truncated answer that says it is
 * truncated is worth more than a complete-looking one assembled by guessing at a
 * parameter the API may ignore.
 */
export async function fetchOrganicKeywords(
  params: FetchOrganicKeywordsParams,
): Promise<FetchOrganicKeywordsResult> {
  const doFetch = params.fetchImpl ?? fetch;
  const limit = Math.max(1, params.limit ?? DEFAULT_LIMIT);

  const url = new URL(ENDPOINT);
  url.searchParams.set("target", params.target);
  url.searchParams.set("date", params.date);
  url.searchParams.set("select", SELECT_FIELDS.join(","));
  url.searchParams.set("limit", String(limit));
  // The domain and its subdomains, matching what a Website means in this product.
  url.searchParams.set("mode", "subdomains");
  url.searchParams.set("country", params.country);
  url.searchParams.set("output", "json");

  let response: Response;

  try {
    response = await doFetch(url, {
      method: "GET",
      headers: {
        // The secret lives here rather than in the URL, which is why nothing
        // below ever logs or returns the request.
        Authorization: `Bearer ${params.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    // Not inspecting the thrown error: its message can carry request detail.
    throw new AhrefsError("request_failed");
  }

  if (!response.ok) throw classifyStatus(response.status);

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new AhrefsError("invalid_response");
  }

  const parsed = parseKeywords(payload);

  return {
    ...parsed,
    // Exactly the requested number of rows means the limit, not the data, ended
    // the answer.
    truncated: parsed.rows.length >= limit,
  };
}

/**
 * Maps an HTTP status to one of our codes.
 *
 * Status-based rather than body-based, because the error body's JSON shape is not
 * documented and matching on a guessed field name would produce confident wrong
 * classifications. A status code is a fact; an unrecognised one stays generic.
 *
 * The body is never read here. An error body can echo request headers, and this
 * request carries the key in one.
 */
function classifyStatus(status: number): AhrefsError {
  switch (status) {
    case 401:
    case 403:
      // Both mean "this key does not get to do that", and the remedy a person
      // can act on is the same: check the key and the plan.
      return new AhrefsError("invalid_key");
    case 402:
      return new AhrefsError("quota_exhausted");
    case 429:
      return new AhrefsError("rate_limited");
    default:
      return new AhrefsError("upstream_error");
  }
}

/**
 * Reads the documented response into the shape the importer already produces.
 *
 * Reusing `NormalizedImportRow` is the point: fetched rows and uploaded rows go
 * through one write path, so a keyword created here obeys the same identity and
 * provenance rules as one created by a CSV upload.
 */
export function parseKeywords(payload: unknown): {
  rows: NormalizedImportRow[];
  malformed: number;
  missingFields: string[];
} {
  if (typeof payload !== "object" || payload === null) {
    throw new AhrefsError("invalid_response");
  }

  const keywords = (payload as { keywords?: unknown }).keywords;

  // The documented top-level key. Absent means this is not the response we asked
  // for, and reading some other array we happened to find would be inventing a
  // contract.
  if (!Array.isArray(keywords)) {
    throw new AhrefsError("invalid_response");
  }

  const rows: NormalizedImportRow[] = [];
  const seenFields = new Set<string>();
  let malformed = 0;

  for (const entry of keywords) {
    if (typeof entry !== "object" || entry === null) {
      malformed += 1;
      continue;
    }

    const record = entry as Record<string, unknown>;
    for (const field of Object.keys(record)) seenFields.add(field);

    const keyword = text(record.keyword);

    // A row with no keyword names nothing and cannot be stored against one.
    if (!keyword) {
      malformed += 1;
      continue;
    }

    rows.push({
      keyword,
      normalizedKeyword: keyword.toLowerCase(),
      // Not returned by this endpoint. Null is the honest value.
      intent: null,
      position: integer(record.best_position),
      // Not returned by this endpoint either, and deliberately not derived from
      // our own history: that would file our arithmetic as Ahrefs' measurement.
      previousPosition: null,
      searchVolume: integer(record.volume),
      keywordDifficulty: integer(record.keyword_difficulty),
      cpc: centsToCurrency(record.cpc),
      landingUrl: text(record.best_position_url),
      rankingType: "ORGANIC",
      serpFeatures: stringList(record.serp_features),
      // A site-explorer report is about the target; competitor reports are what
      // carry a domain column.
      domain: null,
      // This endpoint dates the report, not each row, so the caller stamps it.
      capturedAt: null,
    });
  }

  const missingFields =
    rows.length === 0
      ? []
      : SELECT_FIELDS.filter((field) => !seenFields.has(field));

  return { rows, malformed, missingFields };
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * An integer, or null.
 *
 * Null rather than zero on anything unreadable. Zero is a measurement, and a
 * position of 0 would read as ranking above first place.
 */
function integer(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }

  return null;
}

/**
 * Ahrefs reports CPC in USD cents; the column stores currency units.
 *
 * The single most consequential line in this file. Semrush reports dollars into
 * the same column, so skipping this conversion would put 1240 where 12.40
 * belongs — a hundredfold error that breaks no constraint, fails no validation,
 * and makes every commercial-value comparison between the two providers wrong
 * while looking like a real number.
 */
export function centsToCurrency(value: unknown): number | null {
  const cents = integer(value);
  return cents === null ? null : cents / 100;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

/**
 * The country code for a website's market.
 *
 * The endpoint documents ISO 3166-1 alpha-2. Sent lowercase, which is the
 * convention across this API's examples; the case is not something the docs
 * state, and a rejected country returns a clean upstream error rather than data
 * about the wrong country — which is the failure worth protecting against.
 *
 * Null with no market set, so the caller refuses rather than defaulting to one.
 */
export function countryForMarket(market: string | null): string | null {
  const trimmed = market?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}
