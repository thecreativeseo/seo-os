/**
 * Metric aggregation (docs/P1_SPEC.md §8, P1_ACCEPTANCE_CRITERIA "GSC metric integrity").
 *
 * "Any metric-integrity failure = P1 FAIL." This module is the only place metrics
 * are combined, so the rules below cannot be violated by an ad-hoc query elsewhere.
 *
 * Two rules, both about not averaging an average:
 *
 *   CTR is recomputed from totals — SUM(clicks) / SUM(impressions). Averaging the
 *   per-row ctr column weights a row with 3 impressions the same as one with
 *   30,000, which produces a number that is not the site's click-through rate and
 *   is usually wildly wrong.
 *
 *   Position is impression-weighted — SUM(position × impressions) / SUM(impressions).
 *   The spec forbids "undocumented naive AVG(position)"; this is the documented
 *   alternative, and it is what Search Console itself reports. A position held on
 *   10,000 impressions should not count the same as one held on three.
 *
 * Unavailable is not zero. Every function returns null when there is nothing to
 * divide by, and callers must render that as "No data" rather than 0.
 */

export type GscRow = {
  clicks: number;
  impressions: number;
  /** As reported per row. Never averaged. */
  position: number | null;
};

export type GscTotals = {
  clicks: number;
  impressions: number;
  /** null when there were no impressions to divide by. */
  ctr: number | null;
  /** Impression-weighted mean. null when there were no impressions. */
  position: number | null;
};

export const POSITION_METHOD = "impression-weighted" as const;

export function aggregateGsc(rows: readonly GscRow[]): GscTotals {
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  let positionImpressions = 0;

  for (const row of rows) {
    clicks += row.clicks;
    impressions += row.impressions;

    // A row with no impressions carries no positional information, and a row with
    // a null position must not silently contribute zero.
    if (row.position !== null && row.impressions > 0) {
      weightedPosition += row.position * row.impressions;
      positionImpressions += row.impressions;
    }
  }

  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: positionImpressions > 0 ? weightedPosition / positionImpressions : null,
  };
}

export type Ga4Row = {
  sessions: number | null;
  engagedSessions: number | null;
  users: number | null;
  newUsers: number | null;
  keyEvents: number | null;
  conversions: number | null;
  revenue: number | null;
};

export type Ga4Totals = {
  sessions: number | null;
  engagedSessions: number | null;
  users: number | null;
  newUsers: number | null;
  keyEvents: number | null;
  conversions: number | null;
  revenue: number | null;
};

/**
 * Sums GA4 metrics, preserving the difference between "measured zero" and "not
 * measured".
 *
 * If every row for a metric is null, the total is null — the property does not
 * report it. If any row has a value, nulls in other rows are treated as zero for
 * that day. Returning 0 for an unmeasured metric would let the interface claim the
 * business had no conversions when in fact nobody counted them.
 */
export function aggregateGa4(rows: readonly Ga4Row[]): Ga4Totals {
  const keys = [
    "sessions",
    "engagedSessions",
    "users",
    "newUsers",
    "keyEvents",
    "conversions",
    "revenue",
  ] as const;

  const totals = {} as Ga4Totals;

  for (const key of keys) {
    let sum = 0;
    let measured = false;

    for (const row of rows) {
      const value = row[key];
      if (value !== null && value !== undefined) {
        sum += value;
        measured = true;
      }
    }

    totals[key] = measured ? sum : null;
  }

  return totals;
}

/** Engagement rate, recomputed from totals for the same reason CTR is. */
export function engagementRate(totals: Ga4Totals): number | null {
  if (totals.sessions === null || totals.sessions === 0) return null;
  if (totals.engagedSessions === null) return null;
  return totals.engagedSessions / totals.sessions;
}
