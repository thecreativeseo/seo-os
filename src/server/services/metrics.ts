import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  compareValues,
  resolveWindows,
  type Change,
  type ComparisonWindows,
  type DateRange,
  type PeriodPreset,
} from "@/lib/metrics/compare";
import { engagementRate, type Ga4Totals, type GscTotals } from "@/lib/metrics/aggregate";

/**
 * Reads aggregated metrics.
 *
 * Aggregation happens in SQL because eighteen thousand rows per website is already
 * more than is sensible to move into Node, and it will only grow. The rules are the
 * same ones aggregate.ts states, written once here in SQL and asserted against the
 * pure implementation by an integration test — so the two cannot drift apart.
 *
 *   ctr      = SUM(clicks) / SUM(impressions)                    never AVG(ctr)
 *   position = SUM(position × impressions) / SUM(impressions)    impression-weighted
 *
 * Every query is scoped by websiteId taken from a verified TenantContext. The ids
 * are never interpolated as text: Prisma.sql parameterises them, so a tenant id
 * cannot be used to smuggle SQL.
 */

export type MetricsWindow = ComparisonWindows;

/** The latest day this website has GSC data for. Null before the first sync. */
export async function getLatestDataDate(context: TenantContext): Promise<string | null> {
  const row = await prisma.gscMetricDaily.aggregate({
    where: { websiteId: context.website.id },
    _max: { date: true },
  });

  return row._max.date ? row._max.date.toISOString().slice(0, 10) : null;
}

export async function resolveWebsiteWindows(
  context: TenantContext,
  preset: Exclude<PeriodPreset, "custom"> = "28d",
): Promise<{ windows: MetricsWindow; latestDataDate: string | null }> {
  const latestDataDate = await getLatestDataDate(context);

  return {
    latestDataDate,
    // Before any data exists there is nothing to anchor to; the caller renders an
    // empty state rather than a window over nothing.
    windows: resolveWindows(latestDataDate ?? new Date().toISOString().slice(0, 10), preset),
  };
}

type GscAggregateRow = {
  clicks: bigint | null;
  impressions: bigint | null;
  position: number | null;
};

async function gscTotalsFor(
  websiteId: string,
  range: DateRange,
  extra: Prisma.Sql = Prisma.empty,
): Promise<GscTotals> {
  const rows = await prisma.$queryRaw<GscAggregateRow[]>`
    SELECT
      SUM(m.clicks)::bigint AS clicks,
      SUM(m.impressions)::bigint AS impressions,
      -- Impression-weighted, not AVG(position).
      (SUM(m.position * m.impressions) / NULLIF(SUM(m.impressions), 0))::float AS position
    FROM gsc_metric_daily m
    WHERE m.website_id = ${websiteId}::uuid
      AND m.date BETWEEN ${range.start}::date AND ${range.end}::date
      ${extra}
  `;

  const row = rows[0];
  const clicks = Number(row?.clicks ?? 0);
  const impressions = Number(row?.impressions ?? 0);

  return {
    clicks,
    impressions,
    // Recomputed from totals, never read from the stored per-row ctr.
    ctr: impressions > 0 ? clicks / impressions : null,
    position: row?.position ?? null,
  };
}

type Ga4AggregateRow = {
  sessions: bigint | null;
  engaged_sessions: bigint | null;
  users: bigint | null;
  new_users: bigint | null;
  key_events: bigint | null;
  conversions: bigint | null;
  revenue: Prisma.Decimal | null;
  measured_key_events: bigint;
  measured_conversions: bigint;
  measured_revenue: bigint;
};

async function ga4TotalsFor(
  websiteId: string,
  range: DateRange,
  extra: Prisma.Sql = Prisma.empty,
): Promise<Ga4Totals> {
  const rows = await prisma.$queryRaw<Ga4AggregateRow[]>`
    SELECT
      SUM(g.sessions)::bigint AS sessions,
      SUM(g.engaged_sessions)::bigint AS engaged_sessions,
      SUM(g.users)::bigint AS users,
      SUM(g.new_users)::bigint AS new_users,
      SUM(g.key_events)::bigint AS key_events,
      SUM(g.conversions)::bigint AS conversions,
      SUM(g.revenue) AS revenue,
      -- COUNT ignores NULLs, so these say whether the metric was measured at all.
      -- Without them a property that never reports revenue would show 0 revenue,
      -- which is indistinguishable from having earned nothing.
      COUNT(g.key_events)::bigint AS measured_key_events,
      COUNT(g.conversions)::bigint AS measured_conversions,
      COUNT(g.revenue)::bigint AS measured_revenue
    FROM ga4_landing_page_metric_daily g
    WHERE g.website_id = ${websiteId}::uuid
      AND g.date BETWEEN ${range.start}::date AND ${range.end}::date
      ${extra}
  `;

  const row = rows[0];
  const asNumber = (value: bigint | null): number | null =>
    value === null || value === undefined ? null : Number(value);

  return {
    sessions: asNumber(row?.sessions ?? null),
    engagedSessions: asNumber(row?.engaged_sessions ?? null),
    users: asNumber(row?.users ?? null),
    newUsers: asNumber(row?.new_users ?? null),
    keyEvents: Number(row?.measured_key_events ?? 0) > 0 ? asNumber(row?.key_events ?? null) : null,
    conversions:
      Number(row?.measured_conversions ?? 0) > 0 ? asNumber(row?.conversions ?? null) : null,
    revenue: Number(row?.measured_revenue ?? 0) > 0 ? Number(row?.revenue ?? 0) : null,
  };
}

export type WebsiteSummary = {
  windows: MetricsWindow;
  latestDataDate: string | null;
  gsc: { current: GscTotals; previous: GscTotals };
  ga4: { current: Ga4Totals; previous: Ga4Totals };
  changes: {
    clicks: Change;
    impressions: Change;
    ctr: Change;
    position: Change;
    sessions: Change;
    keyEvents: Change;
    engagementRate: Change;
  };
};

/** The executive snapshot behind the P1 Command Center. */
export async function getWebsiteSummary(
  context: TenantContext,
  preset: Exclude<PeriodPreset, "custom"> = "28d",
): Promise<WebsiteSummary> {
  const { windows, latestDataDate } = await resolveWebsiteWindows(context, preset);
  const websiteId = context.website.id;

  const [gscCurrent, gscPrevious, ga4Current, ga4Previous] = await Promise.all([
    gscTotalsFor(websiteId, windows.current),
    gscTotalsFor(websiteId, windows.previous),
    ga4TotalsFor(websiteId, windows.current),
    ga4TotalsFor(websiteId, windows.previous),
  ]);

  return {
    windows,
    latestDataDate,
    gsc: { current: gscCurrent, previous: gscPrevious },
    ga4: { current: ga4Current, previous: ga4Previous },
    changes: {
      clicks: compareValues(gscCurrent.clicks, gscPrevious.clicks),
      impressions: compareValues(gscCurrent.impressions, gscPrevious.impressions),
      ctr: compareValues(gscCurrent.ctr, gscPrevious.ctr),
      position: compareValues(gscCurrent.position, gscPrevious.position),
      sessions: compareValues(ga4Current.sessions, ga4Previous.sessions),
      keyEvents: compareValues(ga4Current.keyEvents, ga4Previous.keyEvents),
      engagementRate: compareValues(
        engagementRate(ga4Current),
        engagementRate(ga4Previous),
      ),
    },
  };
}

export type PageMetricRow = {
  pageId: string;
  path: string;
  url: string;
  pageType: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  previousClicks: number;
  previousImpressions: number;
  previousCtr: number | null;
  sessions: number | null;
  keyEvents: number | null;
};

/**
 * Per-page metrics for both windows in one query.
 *
 * A FULL OUTER JOIN rather than an inner one: a page with traffic in only one
 * window still has to appear, otherwise pages that arrived or disappeared — the
 * most interesting ones — would be missing from the explorer.
 */
export async function getPageMetrics(
  context: TenantContext,
  windows: MetricsWindow,
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<PageMetricRow[]> {
  const websiteId = context.website.id;
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;
  const search = options.search?.trim();

  const searchClause = search
    ? Prisma.sql`AND p.path ILIKE ${`%${search}%`}`
    : Prisma.empty;

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
    sessions: bigint | null;
    key_events: bigint | null;
    measured_key_events: bigint;
  };

  const rows = await prisma.$queryRaw<Row[]>`
    WITH current AS (
      SELECT page_id,
             SUM(clicks)::bigint AS clicks,
             SUM(impressions)::bigint AS impressions,
             (SUM(position * impressions) / NULLIF(SUM(impressions), 0))::float AS position
      FROM gsc_metric_daily
      WHERE website_id = ${websiteId}::uuid
        AND date BETWEEN ${windows.current.start}::date AND ${windows.current.end}::date
      GROUP BY page_id
    ),
    previous AS (
      SELECT page_id,
             SUM(clicks)::bigint AS clicks,
             SUM(impressions)::bigint AS impressions
      FROM gsc_metric_daily
      WHERE website_id = ${websiteId}::uuid
        AND date BETWEEN ${windows.previous.start}::date AND ${windows.previous.end}::date
      GROUP BY page_id
    ),
    analytics AS (
      SELECT page_id,
             SUM(sessions)::bigint AS sessions,
             SUM(key_events)::bigint AS key_events,
             COUNT(key_events)::bigint AS measured_key_events
      FROM ga4_landing_page_metric_daily
      WHERE website_id = ${websiteId}::uuid
        AND date BETWEEN ${windows.current.start}::date AND ${windows.current.end}::date
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
           COALESCE(pr.impressions, 0) AS prev_impressions,
           a.sessions,
           a.key_events,
           COALESCE(a.measured_key_events, 0) AS measured_key_events
    FROM page p
    LEFT JOIN current c ON c.page_id = p.id
    LEFT JOIN previous pr ON pr.page_id = p.id
    LEFT JOIN analytics a ON a.page_id = p.id
    WHERE p.website_id = ${websiteId}::uuid
      AND p.archived_at IS NULL
      ${searchClause}
      AND (c.clicks IS NOT NULL OR pr.clicks IS NOT NULL OR a.sessions IS NOT NULL)
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
      sessions: row.sessions === null ? null : Number(row.sessions),
      keyEvents: Number(row.measured_key_events) > 0 ? Number(row.key_events ?? 0) : null,
    };
  });
}

export type QueryMetricRow = {
  queryId: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  previousClicks: number;
  topPagePath: string | null;
};

export async function getQueryMetrics(
  context: TenantContext,
  windows: MetricsWindow,
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<QueryMetricRow[]> {
  const websiteId = context.website.id;
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;
  const search = options.search?.trim();

  const searchClause = search
    ? Prisma.sql`AND q.query ILIKE ${`%${search}%`}`
    : Prisma.empty;

  type Row = {
    query_id: string;
    query: string;
    clicks: bigint;
    impressions: bigint;
    position: number | null;
    prev_clicks: bigint;
    top_page_path: string | null;
  };

  const rows = await prisma.$queryRaw<Row[]>`
    WITH current AS (
      SELECT query_id,
             SUM(clicks)::bigint AS clicks,
             SUM(impressions)::bigint AS impressions,
             (SUM(position * impressions) / NULLIF(SUM(impressions), 0))::float AS position
      FROM gsc_metric_daily
      WHERE website_id = ${websiteId}::uuid
        AND date BETWEEN ${windows.current.start}::date AND ${windows.current.end}::date
      GROUP BY query_id
    ),
    previous AS (
      SELECT query_id, SUM(clicks)::bigint AS clicks
      FROM gsc_metric_daily
      WHERE website_id = ${websiteId}::uuid
        AND date BETWEEN ${windows.previous.start}::date AND ${windows.previous.end}::date
      GROUP BY query_id
    ),
    top_page AS (
      SELECT DISTINCT ON (m.query_id) m.query_id, p.path
      FROM gsc_metric_daily m
      JOIN page p ON p.id = m.page_id
      WHERE m.website_id = ${websiteId}::uuid
        AND m.date BETWEEN ${windows.current.start}::date AND ${windows.current.end}::date
      GROUP BY m.query_id, p.path
      ORDER BY m.query_id, SUM(m.clicks) DESC
    )
    SELECT q.id AS query_id,
           q.query,
           COALESCE(c.clicks, 0) AS clicks,
           COALESCE(c.impressions, 0) AS impressions,
           c.position,
           COALESCE(pr.clicks, 0) AS prev_clicks,
           tp.path AS top_page_path
    FROM query q
    LEFT JOIN current c ON c.query_id = q.id
    LEFT JOIN previous pr ON pr.query_id = q.id
    LEFT JOIN top_page tp ON tp.query_id = q.id
    WHERE q.website_id = ${websiteId}::uuid
      ${searchClause}
      AND (c.clicks IS NOT NULL OR pr.clicks IS NOT NULL)
    ORDER BY COALESCE(c.clicks, 0) DESC, q.query ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return rows.map((row) => {
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);

    return {
      queryId: row.query_id,
      query: row.query,
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : null,
      position: row.position,
      previousClicks: Number(row.prev_clicks),
      topPagePath: row.top_page_path,
    };
  });
}
