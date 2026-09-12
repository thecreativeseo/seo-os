import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";

/**
 * Search Console rollups (P1 GSC storage).
 *
 * gsc_metric_daily is the one canonical store of what Search Console said:
 * one row per page, query and day. It is also the table that grows without
 * bound — a busy property adds half a million rows a month — so two compact
 * tiers are derived from it and kept for good: a page's daily totals, and a
 * query's monthly totals per page it landed on.
 *
 * Everything here is a pure function of raw. A rollup is recomputed a whole
 * calendar month at a time from whatever gsc_metric_daily holds for that
 * website and month, and the complete result is written in one transaction:
 * every key raw implies is upserted, every key raw no longer implies is
 * removed. Provider windows, chunk sizes and the order in which pieces
 * arrived leave no trace, because none of them are inputs. Run it twice and
 * the metrics are identical; run it after an overlapping pull and nothing
 * is counted twice, because the overlap replaced raw rows rather than adding
 * to them.
 *
 * The arithmetic is done in Postgres numeric, which is exact and therefore
 * order-independent — a float sum of weighted positions would not be. Clicks
 * and impressions are sums. CTR is the click sum over the impression sum, or
 * null where there were no impressions. Position is weighted by impressions
 * over the rows that have a position, or null where those rows have no
 * impressions between them — the same contract as aggregateGscMeasurements.
 *
 * Whether a month is complete is deliberately not written down here. A month
 * is complete when it ends on or before the connection's latestDataDate,
 * which only advances once a whole period was read; a stored flag would have
 * to be kept in step with that and could fall out of it.
 */

/** An inclusive pair of ISO dates. */
export type DateRange = { startDate: string; endDate: string };

/** The website the rollups belong to. A full context is accepted; only the website is read. */
export type RollupScope = Pick<TenantContext, "website">;

export type RollupRecompute = {
  /** First days of the calendar months recomputed, ascending. */
  months: string[];
  pageDays: number;
  queryPageMonths: number;
};

/** The first day of the month a date falls in, as an ISO date. */
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The first day of the following month. */
export function nextMonth(month: string): string {
  const [year, monthNumber] = month.slice(0, 7).split("-").map(Number) as [number, number];
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Whether a calendar month is complete: it ends on or before the connection's
 * latestDataDate, which only advances once a whole period was read. Derived
 * every time it is asked rather than stored, so it cannot go stale. A month
 * that is not complete may still have rollups — current-best values — but
 * nothing that depends on completeness, such as a later purge, may treat it
 * as done.
 */
export function monthComplete(month: string, latestDataDate: Date | null): boolean {
  if (!latestDataDate) return false;
  const lastDay = new Date(`${nextMonth(month)}T00:00:00.000Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  return latestDataDate.toISOString().slice(0, 10) >= lastDay.toISOString().slice(0, 10);
}

/**
 * The calendar months a date range touches, as first days, ascending. A range
 * that ends in a later month lists every month between, whether or not raw
 * has rows for it: the recompute for an empty month is a no-op that also
 * removes anything stale.
 */
export function monthsTouched(range: DateRange): string[] {
  if (range.endDate < range.startDate) return [];
  const months: string[] = [];
  const last = monthOf(range.endDate);
  for (let month = monthOf(range.startDate); month <= last; month = nextMonth(month)) {
    months.push(month);
  }
  return months;
}

/**
 * Recomputes both rollup tiers for every calendar month the range touches,
 * from canonical raw, one month per transaction.
 *
 * Called once per sync after every raw write has settled — not once per
 * provider window — with the run's whole requested range, so a ninety-day
 * first pull recomputes four months once each rather than each month several
 * times. Safe to call again at any time with any range.
 */
export async function recomputeGscRollups(
  scope: RollupScope,
  range: DateRange,
  options: { now?: Date } = {},
): Promise<RollupRecompute> {
  const now = options.now ?? new Date();
  const months = monthsTouched(range);
  let pageDays = 0;
  let queryPageMonths = 0;

  for (const month of months) {
    const counts = await recomputeMonth(scope.website.id, month, now);
    pageDays += counts.pageDays;
    queryPageMonths += counts.queryPageMonths;
  }

  return { months, pageDays, queryPageMonths };
}

/**
 * One website, one calendar month, both tiers, one transaction. The upsert
 * writes every key raw implies for the month; the delete removes every key
 * raw no longer implies. Between them the month's rollup equals raw exactly.
 */
async function recomputeMonth(
  websiteId: string,
  month: string,
  now: Date,
): Promise<{ pageDays: number; queryPageMonths: number }> {
  const start = month;
  const end = nextMonth(month);

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        INSERT INTO gsc_page_daily
          (website_id, page_id, date, clicks, impressions, ctr, position,
           computed_at, source_max_updated_at)
        SELECT
          website_id,
          page_id,
          date,
          SUM(clicks)::int,
          SUM(impressions)::int,
          CASE WHEN SUM(impressions) > 0
               THEN ROUND(SUM(clicks)::numeric / SUM(impressions)::numeric, 6)
               ELSE NULL END,
          CASE WHEN COALESCE(SUM(impressions) FILTER (WHERE position IS NOT NULL), 0) > 0
               THEN ROUND(
                 SUM(position * impressions) FILTER (WHERE position IS NOT NULL)
                 / SUM(impressions) FILTER (WHERE position IS NOT NULL)::numeric,
                 3)
               ELSE NULL END,
          ${now},
          MAX(updated_at)
        FROM gsc_metric_daily
        WHERE website_id = ${websiteId}::uuid
          AND date >= ${start}::date
          AND date < ${end}::date
        GROUP BY website_id, page_id, date
        ON CONFLICT (website_id, page_id, date) DO UPDATE SET
          clicks = EXCLUDED.clicks,
          impressions = EXCLUDED.impressions,
          ctr = EXCLUDED.ctr,
          position = EXCLUDED.position,
          computed_at = EXCLUDED.computed_at,
          source_max_updated_at = EXCLUDED.source_max_updated_at
      `;

      await tx.$executeRaw`
        DELETE FROM gsc_page_daily d
        WHERE d.website_id = ${websiteId}::uuid
          AND d.date >= ${start}::date
          AND d.date < ${end}::date
          AND NOT EXISTS (
            SELECT 1 FROM gsc_metric_daily m
            WHERE m.website_id = d.website_id
              AND m.page_id = d.page_id
              AND m.date = d.date
          )
      `;

      await tx.$executeRaw`
        INSERT INTO gsc_query_page_monthly
          (website_id, query_id, page_id, month, clicks, impressions, ctr, position,
           days_with_data, computed_at, source_max_updated_at)
        SELECT
          website_id,
          query_id,
          page_id,
          ${start}::date,
          SUM(clicks)::int,
          SUM(impressions)::int,
          CASE WHEN SUM(impressions) > 0
               THEN ROUND(SUM(clicks)::numeric / SUM(impressions)::numeric, 6)
               ELSE NULL END,
          CASE WHEN COALESCE(SUM(impressions) FILTER (WHERE position IS NOT NULL), 0) > 0
               THEN ROUND(
                 SUM(position * impressions) FILTER (WHERE position IS NOT NULL)
                 / SUM(impressions) FILTER (WHERE position IS NOT NULL)::numeric,
                 3)
               ELSE NULL END,
          COUNT(DISTINCT date)::int,
          ${now},
          MAX(updated_at)
        FROM gsc_metric_daily
        WHERE website_id = ${websiteId}::uuid
          AND date >= ${start}::date
          AND date < ${end}::date
        GROUP BY website_id, query_id, page_id
        ON CONFLICT (website_id, query_id, page_id, month) DO UPDATE SET
          clicks = EXCLUDED.clicks,
          impressions = EXCLUDED.impressions,
          ctr = EXCLUDED.ctr,
          position = EXCLUDED.position,
          days_with_data = EXCLUDED.days_with_data,
          computed_at = EXCLUDED.computed_at,
          source_max_updated_at = EXCLUDED.source_max_updated_at
      `;

      await tx.$executeRaw`
        DELETE FROM gsc_query_page_monthly d
        WHERE d.website_id = ${websiteId}::uuid
          AND d.month = ${start}::date
          AND NOT EXISTS (
            SELECT 1 FROM gsc_metric_daily m
            WHERE m.website_id = d.website_id
              AND m.query_id = d.query_id
              AND m.page_id = d.page_id
              AND m.date >= ${start}::date
              AND m.date < ${end}::date
          )
      `;

      const [pageDays, queryPageMonths] = await Promise.all([
        tx.gscPageDaily.count({
          where: { websiteId, date: { gte: new Date(start), lt: new Date(end) } },
        }),
        tx.gscQueryPageMonthly.count({ where: { websiteId, month: new Date(start) } }),
      ]);

      return { pageDays, queryPageMonths };
    },
    { timeout: 120_000 },
  );
}

export type TopPage = {
  queryId: string;
  pageId: string;
  clicks: number;
  impressions: number;
};

/**
 * Which page was a query's top page in a month, derived from the monthly
 * rollup rather than stored: the page with the most clicks, then the most
 * impressions, then the lowest page id. The last step is what makes two
 * runs agree when two pages tie, and it is a rule rather than a preference.
 */
export async function topPagesForMonth(scope: RollupScope, month: string): Promise<TopPage[]> {
  const rows = await prisma.$queryRaw<
    { query_id: string; page_id: string; clicks: number; impressions: number }[]
  >`
    SELECT DISTINCT ON (query_id) query_id, page_id, clicks, impressions
    FROM gsc_query_page_monthly
    WHERE website_id = ${scope.website.id}::uuid
      AND month = ${monthOf(month)}::date
    ORDER BY query_id, clicks DESC, impressions DESC, page_id ASC
  `;

  return rows.map((row) => ({
    queryId: row.query_id,
    pageId: row.page_id,
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
  }));
}

/** Kept so a caller can build the same ordering in its own query. */
export const TOP_PAGE_ORDER = Prisma.sql`clicks DESC, impressions DESC, page_id ASC`;
