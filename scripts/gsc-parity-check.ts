import { prisma } from "@/server/db/prisma";
import { resolveCustomWindows, resolveWindows } from "@/lib/metrics/compare";
import {
  pageRollupComparison,
  pageRollupTotals,
  queryRollupComparison,
} from "@/server/services/gsc-readers";
import { getPageMetrics, getQueryMetrics, gscTotalsFor } from "@/server/services/metrics";
import type { TenantContext } from "@/server/auth/guards";

/**
 * Read-only parity: where raw and the rollups overlap, the rollup readers
 * must answer exactly what the raw readers answer.
 *
 *   npm run db:check:gsc-parity
 *
 * For every website with raw rows: the last 28 days and the 28 before, from
 * page-days versus raw — website totals, every page's two periods, CTR — and
 * the newest two whole months, from the monthly rollup versus raw — every
 * query's totals, previous clicks, and the top page chosen by the same rule
 * on both sides. Position is compared to three decimals, which is what the
 * rollup keeps. Prints counts and mismatches by id only; exits non-zero on
 * any mismatch and changes nothing.
 */

const POSITION_TOLERANCE = 0.002;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function close(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= POSITION_TOLERANCE;
}

type Mismatch = { website: string; check: string; id?: string; field: string };

async function contextFor(websiteId: string): Promise<TenantContext | null> {
  const website = await prisma.website.findUnique({ where: { id: websiteId } });
  if (!website) return null;
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: website.workspaceId } });
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: workspace.organizationId } });
  // Readers scope by website; the actor fields are not consulted for a read.
  return { website, workspace, organization } as TenantContext;
}

async function main(): Promise<void> {
  const spans = await prisma.gscMetricDaily.groupBy({
    by: ["websiteId"],
    _min: { date: true },
    _max: { date: true },
    orderBy: { websiteId: "asc" },
  });

  const mismatches: Mismatch[] = [];
  const skipped = { ga4OnlyOrBeyondCap: 0 };
  let compared = 0;

  for (const span of spans) {
    if (!span._min.date || !span._max.date) continue;
    const context = await contextFor(span.websiteId);
    if (!context) continue;
    const websiteId = context.website.id;
    const latest = isoDate(span._max.date);
    const floor = isoDate(span._min.date);

    // Pages: the product's own 28-day comparison, if raw covers it fully.
    const windows = resolveWindows(latest, "28d");
    if (windows.previous.start >= floor) {
      for (const [label, range] of [["current", windows.current], ["previous", windows.previous]] as const) {
        const raw = await gscTotalsFor(websiteId, range);
        const rolled = await pageRollupTotals(websiteId, range);
        compared += 1;
        for (const field of ["clicks", "impressions", "ctr"] as const) {
          if (raw[field] !== rolled[field]) mismatches.push({ website: websiteId, check: `totals:${label}`, field });
        }
        if (!close(raw.position, rolled.position)) mismatches.push({ website: websiteId, check: `totals:${label}`, field: "position" });
      }

      // The raw reader also lists pages that only GA4 saw, and both readers
      // cap at 500 rows, so the two lists are compared on the pages they
      // share; a raw-only page is a disagreement only if it had Search
      // Console traffic in either period.
      const rawPages = await getPageMetrics(context, windows, { limit: 500 });
      const rolledPages = await pageRollupComparison(context, windows, { limit: 500 });
      const rolledById = new Map(rolledPages.map((row) => [row.pageId, row]));
      for (const raw of rawPages) {
        const rolled = rolledById.get(raw.pageId);
        if (!rolled) {
          const hadGsc = raw.clicks + raw.impressions + raw.previousClicks + raw.previousImpressions > 0;
          if (hadGsc && rolledPages.length < 500) {
            mismatches.push({ website: websiteId, check: "pages", id: raw.pageId, field: "missing" });
          } else {
            skipped.ga4OnlyOrBeyondCap += 1;
          }
          continue;
        }
        compared += 1;
        for (const field of ["clicks", "impressions", "ctr", "previousClicks", "previousImpressions", "previousCtr"] as const) {
          if (raw[field] !== rolled[field]) mismatches.push({ website: websiteId, check: "pages", id: raw.pageId, field });
        }
        if (!close(raw.position, rolled.position)) mismatches.push({ website: websiteId, check: "pages", id: raw.pageId, field: "position" });
      }
    }

    // Queries: the newest two whole months raw covers entirely.
    const lastWhole = new Date(Date.UTC(span._max.date.getUTCFullYear(), span._max.date.getUTCMonth(), 0));
    const currentMonth = `${isoDate(lastWhole).slice(0, 7)}-01`;
    const previousMonthDate = new Date(Date.UTC(lastWhole.getUTCFullYear(), lastWhole.getUTCMonth() - 1, 1));
    const previousMonth = isoDate(previousMonthDate);
    if (previousMonth >= floor && isoDate(lastWhole) >= floor) {
      const previousEnd = new Date(Date.UTC(lastWhole.getUTCFullYear(), lastWhole.getUTCMonth(), 0));
      const monthWindows = {
        ...resolveCustomWindows({ start: currentMonth, end: isoDate(lastWhole) }),
        previous: { start: previousMonth, end: isoDate(previousEnd) },
      };
      const rawQueries = await getQueryMetrics(context, monthWindows, { limit: 500 });
      const rolledQueries = await queryRollupComparison(
        context,
        { current: [currentMonth], previous: [previousMonth] },
        { limit: 500 },
      );
      compared += rawQueries.length;
      const rolledById = new Map(rolledQueries.map((row) => [row.queryId, row]));
      for (const raw of rawQueries) {
        const rolled = rolledById.get(raw.queryId);
        if (!rolled) { mismatches.push({ website: websiteId, check: "queries", id: raw.queryId, field: "missing" }); continue; }
        for (const field of ["clicks", "impressions", "ctr", "previousClicks"] as const) {
          if (raw[field] !== rolled[field]) mismatches.push({ website: websiteId, check: "queries", id: raw.queryId, field });
        }
        if (!close(raw.position, rolled.position)) mismatches.push({ website: websiteId, check: "queries", id: raw.queryId, field: "position" });
      }

      // Top page by the fixed rule, computed on raw here because the raw
      // reader's own DISTINCT ON has no tie-break beyond clicks.
      const rawTop = await prisma.$queryRaw<{ query_id: string; page_id: string }[]>`
        SELECT DISTINCT ON (query_id) query_id, page_id
        FROM (
          SELECT query_id, page_id, SUM(clicks) AS clicks, SUM(impressions) AS impressions
          FROM gsc_metric_daily
          WHERE website_id = ${websiteId}::uuid
            AND date BETWEEN ${currentMonth}::date AND ${isoDate(lastWhole)}::date
          GROUP BY query_id, page_id
        ) t
        ORDER BY query_id, clicks DESC, impressions DESC, page_id ASC
      `;
      const rawTopById = new Map(rawTop.map((row) => [row.query_id, row.page_id]));
      for (const rolled of rolledQueries) {
        if (rolled.clicks === 0 && rolled.impressions === 0) continue;
        compared += 1;
        if (rawTopById.get(rolled.queryId) !== rolled.topPageId) {
          mismatches.push({ website: websiteId, check: "top-page", id: rolled.queryId, field: "topPageId" });
        }
      }
    }

    console.log(JSON.stringify({ at: "parity", website: websiteId, latest, floor, mismatchesSoFar: mismatches.length }));
  }

  const byKind = new Map<string, number>();
  for (const mismatch of mismatches) {
    const key = `${mismatch.check}:${mismatch.field}`;
    byKind.set(key, (byKind.get(key) ?? 0) + 1);
  }
  console.log(
    JSON.stringify({
      at: "parity",
      event: "done",
      websites: spans.length,
      compared,
      skipped,
      mismatches: mismatches.length,
      byKind: Object.fromEntries(byKind),
    }),
  );
  for (const mismatch of mismatches.slice(0, 20)) console.log(JSON.stringify({ at: "parity", ...mismatch }));
  if (mismatches.length > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "unknown";
    const code = (error as { code?: unknown })?.code;
    console.error(JSON.stringify({ at: "parity", event: "failed", name, code }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
