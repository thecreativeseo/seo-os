/**
 * Search Console data access (docs/P1_SPEC.md §8).
 *
 * Requests the documented grain — date × page × query — and returns rows exactly as
 * Google reported them. Nothing here rounds, averages, or fills a gap: a day Google
 * has no row for is a day with no row, not a zero.
 *
 * Two decisions worth stating:
 *
 *   - `dataState: "final"` excludes Search Console's still-settling recent days.
 *     Fresh data revises upward for two to three days, so ingesting it would show
 *     every site as declining and then quietly correct itself. The freshness
 *     indicator elsewhere in the product exists to explain that lag honestly.
 *   - `type: "web"` matches the SearchType.WEB default on the metric row. Image,
 *     video and news are separate search types with separate volumes; merging them
 *     into one figure would misstate the documented grain.
 */

export type SearchConsoleRow = {
  date: string;
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type SearchConsoleErrorCode =
  | "permission_denied"
  | "property_not_found"
  | "rate_limited"
  | "upstream_error"
  | "request_failed"
  | "invalid_response";

export class SearchConsoleError extends Error {
  constructor(
    message: string,
    readonly code: SearchConsoleErrorCode,
  ) {
    super(message);
    this.name = "SearchConsoleError";
  }
}

/** Google's per-request maximum. */
export const ROW_LIMIT = 25_000;

/**
 * A ceiling on pagination, so one sync cannot run indefinitely against a very large
 * property. 400,000 rows at the date × page × query grain is a substantial site;
 * beyond it the run reports PARTIAL rather than pretending it saw everything.
 */
export const MAX_PAGES = 16;

type ApiRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

function mapHttpError(status: number): SearchConsoleErrorCode {
  if (status === 401 || status === 403) return "permission_denied";
  if (status === 404) return "property_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return "request_failed";
}

export type SearchAnalyticsParams = {
  accessToken: string;
  /** The Search Console property, e.g. `sc-domain:example.com`. */
  propertyId: string;
  startDate: string;
  endDate: string;
};

/** One page of results. Exported so the pagination loop can be tested directly. */
export async function fetchSearchAnalyticsPage(
  params: SearchAnalyticsParams & { startRow: number },
): Promise<SearchConsoleRow[]> {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    params.propertyId,
  )}/searchAnalytics/query`;

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: ["date", "page", "query"],
        type: "web",
        dataState: "final",
        rowLimit: ROW_LIMIT,
        startRow: params.startRow,
      }),
    });
  } catch {
    throw new SearchConsoleError("Could not reach Search Console.", "upstream_error");
  }

  if (!response.ok) {
    // Google's error body can echo the request, including the property and the
    // token's audience. The caller gets a code from our own vocabulary instead.
    throw new SearchConsoleError(
      "Search Console rejected the request.",
      mapHttpError(response.status),
    );
  }

  let payload: { rows?: ApiRow[] };

  try {
    payload = (await response.json()) as { rows?: ApiRow[] };
  } catch {
    throw new SearchConsoleError("Search Console returned no readable data.", "invalid_response");
  }

  return (payload.rows ?? []).flatMap((row) => {
    const [date, page, query] = row.keys ?? [];

    // A row missing any dimension cannot be placed at the documented grain, so it
    // is dropped rather than stored against a guessed key.
    if (!date || !page || !query) return [];

    return [
      {
        date,
        page,
        query,
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
      },
    ];
  });
}

export type SearchAnalyticsResult = {
  rows: SearchConsoleRow[];
  /** True when the row ceiling was reached and the property has more to give. */
  truncated: boolean;
};

/** Every row for the period, following pagination up to MAX_PAGES. */
export async function fetchSearchAnalytics(
  params: SearchAnalyticsParams,
): Promise<SearchAnalyticsResult> {
  const rows: SearchConsoleRow[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await fetchSearchAnalyticsPage({ ...params, startRow: page * ROW_LIMIT });
    rows.push(...batch);

    // A short page is the last page: Search Console has no cursor, and asking for
    // one more row past the end returns an empty list, not an error.
    if (batch.length < ROW_LIMIT) {
      return { rows, truncated: false };
    }
  }

  return { rows, truncated: true };
}
