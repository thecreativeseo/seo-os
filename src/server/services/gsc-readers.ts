import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import type { DateRange } from "@/lib/metrics/compare";
import {
  alignToCalendarMonths,
  precedingMonths,
  selectGscReadTier,
  type GscTierDecision,
} from "@/lib/metrics/gsc-tier";
import {
  getLatestDataDate,
  getPageMetrics,
  getQueryMetrics,
  gscTotalsFor,
  type MetricsWindow,
  type PageMetricRow,
  type QueryMetricRow,
} from "@/server/services/metrics";

/**
 * Reading Search Console from the right tier (P1 GSC reader tiering).
 *
 * The readers the product uses today ask raw for short windows anchored on
 * the newest day with data, and they keep doing exactly that: nothing here is
 * in their path. What this adds is the readers for the two rollups, and one
 * entry point per subject that chooses the tier for a comparison — raw when
 * raw holds every day of both periods, the rollups otherwise, never one of
 * each — so that a longer range can be asked for later without a reader
 * that quietly answers from the wrong place.
 *
 * The rollup readers say the same things the raw readers say, at the grain
 * the rollup has. A page's totals over any range of days come from
 * page-days exactly: clicks and impressions are sums, CTR is recomputed
 * from them, position is weighted by impressions over the page-days that
 * have one. A query's totals come from whole calendar months only. The
 * monthly rollup cannot say what a query did on the 14th, and no reader
 * here pretends it can: a range that is not whole months is refused with
 * the reason, and the months are never widened or narrowed to fit.
 */

export type GscTotals = Awaited<ReturnType<typeof gscTotalsFor>>;

export type GscRawAvailability = {
  /** The earliest raw day the website has. Null when it has none. */
  rawFloor: string | null;
  /** The newest day with data: what the windows are anchored on. */
  latestDataDate: string | null;
};

/** What raw actually holds for this website, read from the rows, never from the calendar. */
export async function getGscRawAvailability(context: TenantContext): Promise<GscRawAvailability> {
  const [floor, latestDataDate] = await Promise.all([
    prisma.gscMetricDaily.aggregate({ where: websiteScope(context), _min: { date: true } }),
    getLatestDataDate(context),
  ]);
  return {
    rawFloor: floor._min.date ? floor._min.date.toISOString().slice(0, 10) : null,
    latestDataDate,
  };
}

type PageDayAggregateRow = {
  clicks: bigint | null;
  impressions: bigint | null;
  position: number | null;
};

function totalsFrom(row: PageDayAggregateRow | undefined): GscTotals {
  const clicks = Number(row?.clicks ?? 0);
  const impressions = Number(row?.impressions ?? 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: row?.position ?? null,
  };
}

/**
 * Website totals over a range, from page-days. Position is weighted by the
 * impressions of the page-days that have one, which is the raw rule applied
 * one level up: a page-day's position is already the impression-weighted
 * mean of its queries, so weighting page-days by their impressions recovers
 * the same mean, to the three decimals the page-day keeps.
 */
export async function pageRollupTotals(websiteId: string, range: DateRange): Promise<GscTotals> {
  const rows = await prisma.$queryRaw<PageDayAggregateRow[]>`
    SELECT
      SUM(clicks)::bigint AS clicks,
      SUM(impressions)::bigint AS impressions,
      (SUM(position * impressions) FILTER (WHERE position IS NOT NULL)
        / NULLIF(SUM(impressions) FILTER (WHERE position IS NOT NULL), 0))::float AS position
    FROM gsc_page_daily
    WHERE website_id = ${websiteId}::uuid
      AND date BETWEEN ${range.start}::date AND ${range.end}::date
  `;
  return totalsFrom(rows[0]);
}

/** A page's two periods from page-days. Search Console only: GA4 is not a rollup. */
export type PageRollupRow = Omit<PageMetricRow, "sessions" | "keyEvents">;

/**
 * Per-page totals for both periods, from page-days. The same shape and the
 * same ordering as getPageMetrics, minus GA4, which has no rollup. A page
 * with traffic in only one period still appears.
 */
export async function pageRollupComparison(
  context: TenantContext,
  windows: MetricsWindow,
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<PageRollupRow[]> {
  const websiteId = context.website.id;
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;
  const search = options.search?.trim();
  const searchClause = search ? Prisma.sql`AND p.path ILIKE ${`%${search}%`}` : Prisma.empty;

  type Row = {
    page_id: string;
    path: string;
    url: string;
    page_type: string;
    clicks: bigint;
    impressions: bigint;
    position: number | null;
    prev_clicks: bigint;
    prev_impressions: bigint;
  };

  const rows = await prisma.$queryRaw<Row[]>`
    WITH current AS (
      SELECT page_id,
             SUM(clicks)::bigint AS clicks,
             SUM(impressions)::bigint AS impressions,
             (SUM(position * impressions) FILTER (WHERE position IS NOT NULL)
               / NULLIF(SUM(impressions) FILTER (WHERE position IS NOT NULL), 0))::float AS position
      FROM gsc_page_daily
      WHERE website_id = ${websiteId}::uuid
        AND date BETWEEN ${windows.current.start}::date AND ${windows.current.end}::date
      GROUP BY page_id
    ),
    previous AS (
      SELECT page_id,
             SUM(clicks)::bigint AS clicks,
             SUM(impressions)::bigint AS impressions
      FROM gsc_page_daily
      WHERE website_id = ${websiteId}::uuid
        AND date BETWEEN ${windows.previous.start}::date AND ${windows.previous.end}::date
      GROUP BY page_id
    )
    SELECT p.id AS page_id,
           p.path,
           p.url,
           p.page_type::text AS page_type,
           COALESCE(c.clicks, 0) AS clicks,
           COALESCE(c.impressions, 0) AS impressions,
           c.position,
           COALESCE(pr.clicks, 0) AS prev_clicks,
           COALESCE(pr.impressions, 0) AS prev_impressions
    FROM page p
    LEFT JOIN current c ON c.page_id = p.id
    LEFT JOIN previous pr ON pr.page_id = p.id
    WHERE p.website_id = ${websiteId}::uuid
      AND p.archived_at IS NULL
      ${searchClause}
      AND (c.clicks IS NOT NULL OR pr.clicks IS NOT NULL)
    ORDER BY COALESCE(c.clicks, 0) DESC, p.path ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return rows.map((row) => {
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    const previousClicks = Number(row.prev_clicks);
    const previousImpressions = Number(row.prev_impressions);
    return {
      pageId: row.page_id,
      path: row.path,
      url: row.url,
      pageType: row.page_type,
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : null,
      position: row.position,
      previousClicks,
      previousImpressions,
      previousCtr: previousImpressions > 0 ? previousClicks / previousImpressions : null,
    };
  });
}

export type PageDayPoint = {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
};

/** One page's days over a range, from page-days: one point per day that has one. */
export async function pageRollupSeries(
  context: TenantContext,
  pageId: string,
  range: DateRange,
): Promise<PageDayPoint[]> {
  const rows = await prisma.gscPageDaily.findMany({
    where: {
      websiteId: context.website.id,
      pageId,
      date: { gte: new Date(range.start), lte: new Date(range.end) },
    },
    orderBy: { date: "asc" },
  });

  return rows.map((row) => ({
    date: row.date.toISOString().slice(0, 10),
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
    position: row.position === null ? null : Number(row.position),
  }));
}

export type QueryPageShare = { pageId: string; path: string; clicks: number; impressions: number };

export type QueryRollupRow = {
  queryId: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  /** Every page the query landed on in the current months, most clicks first. */
  pages: QueryPageShare[];
  /** By clicks, then impressions, then the lowest page id. Null with no current rows. */
  topPageId: string | null;
  topPagePath: string | null;
  previousClicks: number;
  previousImpressions: number;
  previousCtr: number | null;
};

/**
 * Per-query totals for two sets of whole calendar months, from the monthly
 * rollup. A query's total is the sum over the pages it landed on; the pages
 * are kept, and the top page is derived from them by the fixed rule. The
 * previous period is the same number of months immediately before, so both
 * sides are the same grain. Ordered as getQueryMetrics orders.
 */
export async function queryRollupComparison(
  context: TenantContext,
  months: { current: string[]; previous: string[] },
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<QueryRollupRow[]> {
  const websiteId = context.website.id;
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;
  const search = options.search?.trim();
  const searchClause = search ? Prisma.sql`AND q.query ILIKE ${`%${search}%`}` : Prisma.empty;
  if (months.current.length === 0) return [];

  const currentMonths = months.current.map((month) => new Date(month));
  const previousMonths = months.previous.map((month) => new Date(month));

  type Row = {
    query_id: string;
    query: string;
    clicks: bigint;
    impressions: bigint;
    position: number | null;
    prev_clicks: bigint;
    prev_impressions: bigint;
  };

  const rows = await prisma.$queryRaw<Row[]>`
    WITH current AS (
      SELECT query_id,
             SUM(clicks)::bigint AS clicks,
             SUM(impressions)::bigint AS impressions,
             (SUM(position * impressions) FILTER (WHERE position IS NOT NULL)
               / NULLIF(SUM(impressions) FILTER (WHERE position IS NOT NULL), 0))::float AS position
      FROM gsc_query_page_monthly
      WHERE website_id = ${websiteId}::uuid
        AND month = ANY(${currentMonths}::date[])
      GROUP BY query_id
    ),
    previous AS (
      SELECT query_id,
             SUM(clicks)::bigint AS clicks,
             SUM(impressions)::bigint AS impressions
      FROM gsc_query_page_monthly
      WHERE website_id = ${websiteId}::uuid
        AND month = ANY(${previousMonths}::date[])
      GROUP BY query_id
    )
    SELECT q.id AS query_id,
           q.query,
           COALESCE(c.clicks, 0) AS clicks,
           COALESCE(c.impressions, 0) AS impressions,
           c.position,
           COALESCE(pr.clicks, 0) AS prev_clicks,
           COALESCE(pr.impressions, 0) AS prev_impressions
    FROM query q
    LEFT JOIN current c ON c.query_id = q.id
    LEFT JOIN previous pr ON pr.query_id = q.id
    WHERE q.website_id = ${websiteId}::uuid
      ${searchClause}
      AND (c.clicks IS NOT NULL OR pr.clicks IS NOT NULL)
    ORDER BY COALESCE(c.clicks, 0) DESC, q.query ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  if (rows.length === 0) return [];

  // The pages behind each listed query, current months only, in top-page order.
  const queryIds = rows.map((row) => row.query_id);
  const shares = await prisma.$queryRaw<
    { query_id: string; page_id: string; path: string; clicks: bigint; impressions: bigint }[]
  >`
    SELECT m.query_id, m.page_id, p.path,
           SUM(m.clicks)::bigint AS clicks,
           SUM(m.impressions)::bigint AS impressions
    FROM gsc_query_page_monthly m
    JOIN page p ON p.id = m.page_id
    WHERE m.website_id = ${websiteId}::uuid
      AND m.query_id = ANY(${queryIds}::uuid[])
      AND m.month = ANY(${currentMonths}::date[])
    GROUP BY m.query_id, m.page_id, p.path
    ORDER BY m.query_id, SUM(m.clicks) DESC, SUM(m.impressions) DESC, m.page_id ASC
  `;

  const pagesByQuery = new Map<string, QueryPageShare[]>();
  for (const share of shares) {
    const list = pagesByQuery.get(share.query_id) ?? [];
    list.push({
      pageId: share.page_id,
      path: share.path,
      clicks: Number(share.clicks),
      impressions: Number(share.impressions),
    });
    pagesByQuery.set(share.query_id, list);
  }

  return rows.map((row) => {
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    const previousClicks = Number(row.prev_clicks);
    const previousImpressions = Number(row.prev_impressions);
    const pages = pagesByQuery.get(row.query_id) ?? [];
    const top = pages[0] ?? null;
    return {
      queryId: row.query_id,
      query: row.query,
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : null,
      position: row.position,
      pages,
      topPageId: top?.pageId ?? null,
      topPagePath: top?.path ?? null,
      previousClicks,
      previousImpressions,
      previousCtr: previousImpressions > 0 ? previousClicks / previousImpressions : null,
    };
  });
}

export type QueryPageMonthPoint = {
  month: string;
  pageId: string;
  path: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  daysWithData: number;
};

/** One query's months, page by page: the history of where it landed. */
export async function queryPageHistory(
  context: TenantContext,
  queryId: string,
  months: string[],
): Promise<QueryPageMonthPoint[]> {
  if (months.length === 0) return [];
  const rows = await prisma.gscQueryPageMonthly.findMany({
    where: {
      websiteId: context.website.id,
      queryId,
      month: { in: months.map((month) => new Date(month)) },
    },
    include: { page: { select: { path: true } } },
    orderBy: [{ month: "asc" }, { clicks: "desc" }, { impressions: "desc" }, { pageId: "asc" }],
  });

  return rows.map((row) => ({
    month: row.month.toISOString().slice(0, 10),
    pageId: row.pageId,
    path: row.page.path,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
    position: row.position === null ? null : Number(row.position),
    daysWithData: row.daysWithData,
  }));
}

// ---------------------------------------------------------------------------
// Choosing the tier
// ---------------------------------------------------------------------------

async function decide(context: TenantContext, windows: MetricsWindow) {
  const availability = await getGscRawAvailability(context);
  const decision = selectGscReadTier({
    current: windows.current,
    previous: windows.previous,
    rawFloor: availability.rawFloor,
    latestDataDate: availability.latestDataDate,
  });
  return { availability, decision };
}

export type GscPageComparison = {
  decision: GscTierDecision;
  availability: GscRawAvailability;
  totals: { current: GscTotals; previous: GscTotals };
  pages: PageRollupRow[];
};

/**
 * Website totals and per-page rows for a comparison, from whichever tier
 * holds both periods. RAW answers exactly as the product answers today;
 * ROLLUP answers from page-days; NONE answers with nothing, and says why.
 */
export async function readGscPageComparison(
  context: TenantContext,
  windows: MetricsWindow,
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<GscPageComparison> {
  const { availability, decision } = await decide(context, windows);
  const websiteId = context.website.id;

  if (decision.tier === "RAW") {
    const [current, previous, pages] = await Promise.all([
      gscTotalsFor(websiteId, windows.current),
      gscTotalsFor(websiteId, windows.previous),
      getPageMetrics(context, windows, options),
    ]);
    return {
      decision,
      availability,
      totals: { current, previous },
      pages: pages.map(({ sessions: _s, keyEvents: _k, ...row }) => row),
    };
  }

  if (decision.tier === "ROLLUP") {
    const [current, previous, pages] = await Promise.all([
      pageRollupTotals(websiteId, windows.current),
      pageRollupTotals(websiteId, windows.previous),
      pageRollupComparison(context, windows, options),
    ]);
    return { decision, availability, totals: { current, previous }, pages };
  }

  const empty: GscTotals = { clicks: 0, impressions: 0, ctr: null, position: null };
  return { decision, availability, totals: { current: empty, previous: empty }, pages: [] };
}

export type GscQueryComparison =
  | { ok: true; decision: GscTierDecision; tier: "RAW"; queries: QueryMetricRow[] }
  | {
      ok: true;
      decision: GscTierDecision;
      tier: "ROLLUP";
      months: { current: string[]; previous: string[] };
      queries: QueryRollupRow[];
    }
  | { ok: true; decision: GscTierDecision; tier: "NONE"; queries: [] }
  | {
      ok: false;
      decision: GscTierDecision;
      tier: "ROLLUP";
      reason: "start_not_month_start" | "end_not_month_end" | "empty";
    };

/**
 * Per-query rows for a comparison, from whichever tier holds both periods.
 * RAW answers day-exactly, as today. ROLLUP answers only for whole calendar
 * months: the current range must be whole months, and the previous period
 * becomes the same number of months before it, whatever the caller's
 * day-based previous range was — because there is no other honest answer
 * from a monthly grain. A current range that is not whole months is refused.
 */
export async function readGscQueryComparison(
  context: TenantContext,
  windows: MetricsWindow,
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<GscQueryComparison> {
  const { decision } = await decide(context, windows);

  if (decision.tier === "RAW") {
    return { ok: true, decision, tier: "RAW", queries: await getQueryMetrics(context, windows, options) };
  }

  if (decision.tier === "NONE") return { ok: true, decision, tier: "NONE", queries: [] };

  const aligned = alignToCalendarMonths(windows.current);
  if (!aligned.ok) return { ok: false, decision, tier: "ROLLUP", reason: aligned.reason };

  const months = { current: aligned.months, previous: precedingMonths(aligned.months) };
  return {
    ok: true,
    decision,
    tier: "ROLLUP",
    months,
    queries: await queryRollupComparison(context, months, options),
  };
}
