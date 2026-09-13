import crypto from "node:crypto";

import { prisma } from "@/server/db/prisma";
import {
  monthCompleteBy,
  planRawRetention,
  RAW_RETENTION_COMPLETE_MONTHS,
  RAW_RETENTION_POLICY,
  shiftMonth,
  type MonthState,
  type RetentionAuditRecord,
} from "@/lib/gsc/retention";
import { selectGscReadTier, type GscTierDecision } from "@/lib/metrics/gsc-tier";
import { resolveWindows, type DateRange } from "@/lib/metrics/compare";

/**
 * The retention dry run (P1 GSC raw retention). Reads everything a purge would
 * need to know and deletes nothing: there is no delete statement in this
 * module, no flag that adds one, and nothing here holds a transaction open.
 *
 * For every website with raw rows it draws the retention window from that
 * website's own latestDataDate, names the months older than the window as
 * candidates, and for each candidate proves what a purge must have proven
 * first: raw exists for the month, both rollups exist for it, they were
 * derived from raw at least as new as raw is, they equal raw — clicks,
 * impressions, CTR, weighted position, days seen, and the exact set of keys —
 * and the month ended before the newest completely read day. A candidate
 * that fails any of these is blocked with the reason. A calendar month is
 * safe only when every website holding raw in it is safe; the eventual
 * physical unit of deletion is a website-month, executed only inside a
 * globally safe month, so that no report — per website or across the
 * workspace — ever finds a month half in one tier and half in the other.
 */

export type WebsiteMonthReport = RetentionAuditRecord & {
  /** Approximate bytes the month's raw rows occupy, from the table's average. */
  approxBytes: number;
};

export type MonthSummary = {
  month: string;
  websites: number;
  safe: boolean;
  states: Record<MonthState, number>;
  rawRows: number;
  approxBytes: number;
};

export type TierSimulation = {
  label: string;
  current: DateRange;
  previous: DateRange;
  today: GscTierDecision;
  afterPurge: GscTierDecision;
};

export type RetentionDryRun = {
  retentionRunId: string;
  evaluatedAt: string;
  policy: typeof RAW_RETENTION_POLICY;
  retentionMonths: number;
  /** The newest latestDataDate across the websites evaluated. */
  latestDataDate: string | null;
  /** The oldest month the website with the newest data would keep. */
  retainedFrom: string | null;
  bytesPerRawRow: number;
  websites: {
    websiteId: string;
    latestDataDate: string | null;
    currentMonth: string | null;
    retainedFrom: string | null;
    /** What tier selection would say before and after a purge of this website's safe candidates. */
    simulations: TierSimulation[];
  }[];
  records: WebsiteMonthReport[];
  months: MonthSummary[];
  /** Rows that would be deleted if every safe website-month were purged. */
  purgeableRows: number;
  purgeableBytes: number;
  blocked: number;
  /** SAFE when at least one candidate exists and none is blocked; BLOCKED when any is; NONE without candidates. */
  verdict: "SAFE" | "BLOCKED" | "NONE";
};

type Scope = { websiteIds?: string[] };

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

const EMPTY_STATES = (): Record<MonthState, number> => ({
  KEEP_CURRENT_PARTIAL: 0,
  KEEP_RETENTION_WINDOW: 0,
  CANDIDATE_FOR_PURGE: 0,
  BLOCKED_INCOMPLETE_ROLLUP: 0,
  BLOCKED_MISMATCH: 0,
  BLOCKED_UNKNOWN: 0,
});

type RawMonthFacts = {
  rows: number;
  clicks: number;
  impressions: number;
  pageDays: number;
  queryPages: number;
  maxUpdatedAt: Date | null;
};

async function rawMonth(websiteId: string, month: string): Promise<RawMonthFacts> {
  const rows = await prisma.$queryRaw<
    {
      rows: bigint;
      clicks: bigint | null;
      impressions: bigint | null;
      page_days: bigint;
      query_pages: bigint;
      max_updated_at: Date | null;
    }[]
  >`
    SELECT COUNT(*)::bigint AS rows,
           SUM(clicks)::bigint AS clicks,
           SUM(impressions)::bigint AS impressions,
           COUNT(DISTINCT (page_id, date))::bigint AS page_days,
           COUNT(DISTINCT (query_id, page_id))::bigint AS query_pages,
           MAX(updated_at) AS max_updated_at
    FROM gsc_metric_daily
    WHERE website_id = ${websiteId}::uuid
      AND date >= ${month}::date AND date < ${shiftMonth(month, 1)}::date
  `;
  const row = rows[0]!;
  return {
    rows: Number(row.rows),
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    pageDays: Number(row.page_days),
    queryPages: Number(row.query_pages),
    maxUpdatedAt: row.max_updated_at,
  };
}

/**
 * The proofs for one website-month. Every comparison is between raw, grouped
 * the way the rollup is grouped, and the rollup as stored — the same
 * arithmetic the rollup writer uses, so equality means the rollup is what
 * raw would derive now.
 */
async function proveWebsiteMonth(
  websiteId: string,
  month: string,
  latestDataDate: string,
  raw: RawMonthFacts,
): Promise<{ equality: RetentionAuditRecord["rollupEquality"]; state: MonthState; reason: string | null }> {
  const next = shiftMonth(month, 1);

  if (!monthCompleteBy(month, latestDataDate)) {
    return { equality: "NOT_CHECKED", state: "BLOCKED_UNKNOWN", reason: "month not complete by latestDataDate" };
  }

  const [pd, qpm] = await Promise.all([
    prisma.$queryRaw<
      { rows: bigint; clicks: bigint | null; impressions: bigint | null; min_computed: Date | null; min_source: Date | null }[]
    >`
      SELECT COUNT(*)::bigint AS rows, SUM(clicks)::bigint AS clicks, SUM(impressions)::bigint AS impressions,
             MIN(computed_at) AS min_computed, MIN(source_max_updated_at) AS min_source
      FROM gsc_page_daily
      WHERE website_id = ${websiteId}::uuid AND date >= ${month}::date AND date < ${next}::date
    `,
    prisma.$queryRaw<
      { rows: bigint; clicks: bigint | null; impressions: bigint | null; min_computed: Date | null; min_source: Date | null }[]
    >`
      SELECT COUNT(*)::bigint AS rows, SUM(clicks)::bigint AS clicks, SUM(impressions)::bigint AS impressions,
             MIN(computed_at) AS min_computed, MIN(source_max_updated_at) AS min_source
      FROM gsc_query_page_monthly
      WHERE website_id = ${websiteId}::uuid AND month = ${month}::date
    `,
  ]);
  const pageDaily = pd[0]!;
  const monthly = qpm[0]!;

  if (Number(pageDaily.rows) === 0 || Number(monthly.rows) === 0) {
    return { equality: "MISSING", state: "BLOCKED_INCOMPLETE_ROLLUP", reason: "rollup rows missing for month" };
  }

  // Derived after the newest raw write: the oldest derivation stamp in the
  // month must not precede the newest raw row in it. (Per-key source stamps
  // legitimately differ from key to key, so they are not what is compared.)
  const staleness = [pageDaily, monthly].some(
    (tier) =>
      raw.maxUpdatedAt !== null && tier.min_computed !== null && tier.min_computed < raw.maxUpdatedAt,
  );
  if (staleness) {
    return { equality: "NOT_CHECKED", state: "BLOCKED_INCOMPLETE_ROLLUP", reason: "rollup older than newest raw write" };
  }

  // Sums and key counts, both tiers.
  if (
    Number(pageDaily.clicks) !== raw.clicks ||
    Number(pageDaily.impressions) !== raw.impressions ||
    Number(pageDaily.rows) !== raw.pageDays ||
    Number(monthly.clicks) !== raw.clicks ||
    Number(monthly.impressions) !== raw.impressions ||
    Number(monthly.rows) !== raw.queryPages
  ) {
    return { equality: "MISMATCH", state: "BLOCKED_MISMATCH", reason: "sums or key counts differ from raw" };
  }

  // Every stored CTR, position and day count against what raw yields now, and
  // no rollup key that raw does not imply.
  const [pdDetail, qpmDetail, orphans] = await Promise.all([
    prisma.$queryRaw<{ mismatches: bigint }[]>`
      WITH expected AS (
        SELECT page_id, date,
          CASE WHEN SUM(impressions) > 0 THEN ROUND(SUM(clicks)::numeric / SUM(impressions)::numeric, 6) END AS ctr,
          CASE WHEN COALESCE(SUM(impressions) FILTER (WHERE position IS NOT NULL), 0) > 0
               THEN ROUND(SUM(position * impressions) FILTER (WHERE position IS NOT NULL)
                          / SUM(impressions) FILTER (WHERE position IS NOT NULL)::numeric, 3) END AS position
        FROM gsc_metric_daily
        WHERE website_id = ${websiteId}::uuid AND date >= ${month}::date AND date < ${next}::date
        GROUP BY page_id, date)
      SELECT COUNT(*) FILTER (WHERE e.ctr IS DISTINCT FROM p.ctr OR e.position IS DISTINCT FROM p.position)::bigint AS mismatches
      FROM expected e
      JOIN gsc_page_daily p ON p.website_id = ${websiteId}::uuid AND p.page_id = e.page_id AND p.date = e.date
    `,
    prisma.$queryRaw<{ mismatches: bigint }[]>`
      WITH expected AS (
        SELECT query_id, page_id,
          CASE WHEN SUM(impressions) > 0 THEN ROUND(SUM(clicks)::numeric / SUM(impressions)::numeric, 6) END AS ctr,
          CASE WHEN COALESCE(SUM(impressions) FILTER (WHERE position IS NOT NULL), 0) > 0
               THEN ROUND(SUM(position * impressions) FILTER (WHERE position IS NOT NULL)
                          / SUM(impressions) FILTER (WHERE position IS NOT NULL)::numeric, 3) END AS position,
          COUNT(DISTINCT date)::int AS days
        FROM gsc_metric_daily
        WHERE website_id = ${websiteId}::uuid AND date >= ${month}::date AND date < ${next}::date
        GROUP BY query_id, page_id)
      SELECT COUNT(*) FILTER (WHERE e.ctr IS DISTINCT FROM q.ctr OR e.position IS DISTINCT FROM q.position OR e.days <> q.days_with_data)::bigint AS mismatches
      FROM expected e
      JOIN gsc_query_page_monthly q ON q.website_id = ${websiteId}::uuid AND q.query_id = e.query_id AND q.page_id = e.page_id AND q.month = ${month}::date
    `,
    prisma.$queryRaw<{ orphans: bigint }[]>`
      SELECT (
        (SELECT COUNT(*) FROM gsc_page_daily p
          WHERE p.website_id = ${websiteId}::uuid AND p.date >= ${month}::date AND p.date < ${next}::date
            AND NOT EXISTS (SELECT 1 FROM gsc_metric_daily m WHERE m.website_id = p.website_id AND m.page_id = p.page_id AND m.date = p.date))
        +
        (SELECT COUNT(*) FROM gsc_query_page_monthly q
          WHERE q.website_id = ${websiteId}::uuid AND q.month = ${month}::date
            AND NOT EXISTS (SELECT 1 FROM gsc_metric_daily m WHERE m.website_id = q.website_id AND m.query_id = q.query_id AND m.page_id = q.page_id
                              AND m.date >= ${month}::date AND m.date < ${next}::date))
      )::bigint AS orphans
    `,
  ]);

  if (Number(pdDetail[0]!.mismatches) > 0 || Number(qpmDetail[0]!.mismatches) > 0) {
    return { equality: "MISMATCH", state: "BLOCKED_MISMATCH", reason: "ctr, position or day count differs from raw" };
  }
  if (Number(orphans[0]!.orphans) > 0) {
    return { equality: "MISMATCH", state: "BLOCKED_MISMATCH", reason: "rollup keys without raw behind them" };
  }

  return { equality: "EQUAL", state: "CANDIDATE_FOR_PURGE", reason: null };
}

/** How tier selection would answer for representative comparisons, today and after the purge. */
function simulate(latestDataDate: string, rawFloorToday: string | null, rawFloorAfter: string | null): TierSimulation[] {
  const cases: { label: string; current: DateRange; previous: DateRange }[] = [];
  for (const preset of ["28d", "90d"] as const) {
    const windows = resolveWindows(latestDataDate, preset);
    cases.push({ label: `${preset} vs previous`, current: windows.current, previous: windows.previous });
  }
  // Straddling the post-purge floor: a custom range whose previous period reaches past it.
  if (rawFloorAfter) {
    const start = shiftMonth(rawFloorAfter, 1);
    const previousStart = shiftMonth(rawFloorAfter, -1);
    cases.push({
      label: "straddles post-purge floor",
      current: { start, end: latestDataDate },
      previous: { start: previousStart, end: isoDate(new Date(new Date(`${start}T00:00:00Z`).getTime() - 86_400_000)) },
    });
    cases.push({
      label: "whole months before post-purge floor",
      current: { start: shiftMonth(rawFloorAfter, -2), end: isoDate(new Date(new Date(`${rawFloorAfter}T00:00:00Z`).getTime() - 86_400_000)) },
      previous: { start: shiftMonth(rawFloorAfter, -4), end: isoDate(new Date(new Date(`${shiftMonth(rawFloorAfter, -2)}T00:00:00Z`).getTime() - 86_400_000)) },
    });
  }
  return cases.map((c) => ({
    ...c,
    today: selectGscReadTier({ current: c.current, previous: c.previous, rawFloor: rawFloorToday, latestDataDate }),
    afterPurge: selectGscReadTier({ current: c.current, previous: c.previous, rawFloor: rawFloorAfter, latestDataDate }),
  }));
}

/** The whole dry run, for every website with raw rows or for the ones named. Read-only. */
export async function planGscRetentionDryRun(scope: Scope = {}): Promise<RetentionDryRun> {
  const retentionRunId = crypto.randomUUID();
  const evaluatedAt = new Date().toISOString();

  const spans = await prisma.gscMetricDaily.groupBy({
    by: ["websiteId"],
    where: scope.websiteIds ? { websiteId: { in: scope.websiteIds } } : undefined,
    _min: { date: true },
    orderBy: { websiteId: "asc" },
  });

  const size = await prisma.$queryRaw<{ bytes: bigint; rows: bigint }[]>`
    SELECT pg_total_relation_size('gsc_metric_daily')::bigint AS bytes, COUNT(*)::bigint AS rows FROM gsc_metric_daily
  `;
  const bytesPerRawRow = Number(size[0]!.rows) > 0 ? Math.round(Number(size[0]!.bytes) / Number(size[0]!.rows)) : 0;

  const records: WebsiteMonthReport[] = [];
  const websites: RetentionDryRun["websites"] = [];
  let latestOverall: string | null = null;
  let retainedFromOverall: string | null = null;

  for (const span of spans) {
    const websiteId = span.websiteId;
    const connection = await prisma.connection.findFirst({
      where: { websiteId, provider: "GOOGLE_SEARCH_CONSOLE" },
      select: { latestDataDate: true },
    });
    const latestDataDate = connection?.latestDataDate ? isoDate(connection.latestDataDate) : null;
    if (latestDataDate && (!latestOverall || latestDataDate > latestOverall)) latestOverall = latestDataDate;

    const monthRows = await prisma.$queryRaw<{ month: Date }[]>`
      SELECT DISTINCT date_trunc('month', date)::date AS month FROM gsc_metric_daily WHERE website_id = ${websiteId}::uuid ORDER BY 1
    `;
    const plan = planRawRetention({ latestDataDate, rawMonths: monthRows.map((row) => isoDate(row.month)) });
    if (plan.retainedFrom && (!retainedFromOverall || plan.retainedFrom > retainedFromOverall)) {
      retainedFromOverall = plan.retainedFrom;
    }

    let safeFloorAfter: string | null = span._min.date ? isoDate(span._min.date) : null;

    for (const entry of plan.months) {
      const began = Date.now();
      const raw = await rawMonth(websiteId, entry.month);
      let state: MonthState = entry.state;
      let equality: RetentionAuditRecord["rollupEquality"] = "NOT_CHECKED";
      let reason: string | null = entry.state === "BLOCKED_UNKNOWN" ? "no latestDataDate for website" : null;

      if (entry.state === "CANDIDATE_FOR_PURGE" && latestDataDate) {
        const proof = await proveWebsiteMonth(websiteId, entry.month, latestDataDate, raw);
        state = proof.state;
        equality = proof.equality;
        reason = proof.reason;
      }

      records.push({
        retentionRunId,
        evaluatedAt,
        policy: RAW_RETENTION_POLICY,
        websiteId,
        latestDataDate,
        month: entry.month,
        rawRows: raw.rows,
        rollupEquality: equality,
        decision: state,
        blockedReason: reason,
        deletedRows: null,
        durationMs: Date.now() - began,
        approxBytes: raw.rows * bytesPerRawRow,
      });
    }

    // After a purge of this website's safe candidates, raw would start at the
    // oldest month that is not a safe candidate.
    const kept = plan.months.filter((entry) => {
      const record = records.find((r) => r.websiteId === websiteId && r.month === entry.month)!;
      return record.decision !== "CANDIDATE_FOR_PURGE";
    });
    if (kept.length > 0 && safeFloorAfter) {
      const oldestKept = kept[0]!.month;
      safeFloorAfter = safeFloorAfter > oldestKept ? safeFloorAfter : oldestKept;
    }

    websites.push({
      websiteId,
      latestDataDate,
      currentMonth: plan.currentMonth,
      retainedFrom: plan.retainedFrom,
      simulations: latestDataDate
        ? simulate(latestDataDate, span._min.date ? isoDate(span._min.date) : null, safeFloorAfter)
        : [],
    });
  }

  // Month-level safety: every website holding raw in the month must be safe.
  const byMonth = new Map<string, MonthSummary>();
  for (const record of records) {
    const summary = byMonth.get(record.month) ?? {
      month: record.month,
      websites: 0,
      safe: true,
      states: EMPTY_STATES(),
      rawRows: 0,
      approxBytes: 0,
    };
    summary.websites += 1;
    summary.states[record.decision] += 1;
    summary.rawRows += record.rawRows;
    summary.approxBytes += record.approxBytes;
    if (record.decision !== "CANDIDATE_FOR_PURGE") summary.safe = false;
    byMonth.set(record.month, summary);
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  const safeMonths = new Set(months.filter((m) => m.safe).map((m) => m.month));
  const purgeable = records.filter((r) => r.decision === "CANDIDATE_FOR_PURGE" && safeMonths.has(r.month));
  const blocked = records.filter((r) => r.decision.startsWith("BLOCKED_")).length;
  const candidates = records.filter((r) => r.decision === "CANDIDATE_FOR_PURGE" || r.decision === "BLOCKED_INCOMPLETE_ROLLUP" || r.decision === "BLOCKED_MISMATCH").length;

  return {
    retentionRunId,
    evaluatedAt,
    policy: RAW_RETENTION_POLICY,
    retentionMonths: RAW_RETENTION_COMPLETE_MONTHS,
    latestDataDate: latestOverall,
    retainedFrom: retainedFromOverall,
    bytesPerRawRow,
    websites,
    records,
    months,
    purgeableRows: purgeable.reduce((sum, r) => sum + r.rawRows, 0),
    purgeableBytes: purgeable.reduce((sum, r) => sum + r.approxBytes, 0),
    blocked,
    verdict: candidates === 0 ? "NONE" : purgeable.length === candidates ? "SAFE" : "BLOCKED",
  };
}

// Deliberately absent: any function that deletes. The purge, when it exists,
// will be a separate module with its own gate, and will call this first.
