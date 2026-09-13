import type { DateRange } from "@/lib/metrics/compare";

/**
 * Choosing where a Search Console comparison is read from (P1 GSC reader
 * tiering).
 *
 * Raw rows — one per page, query and day — are canonical but will not be kept
 * forever. Two rollups derived from them are: a page's totals per day, and a
 * query's totals per page per calendar month. A comparison is always two
 * equal-length periods, current and previous, and the rule is that both are
 * read from the same tier: raw when raw holds every day of both, the rollups
 * otherwise. Never one period from each — the two tiers agree on totals but
 * not on grain, and a comparison across them would be a comparison of two
 * different questions.
 *
 * Availability is a fact about the data, never about the calendar: the
 * earliest raw day the website actually has, and the newest day it has data
 * for, which is also what the windows themselves are anchored on. Nothing
 * here knows what today is.
 */

export type GscReadTier = "RAW" | "ROLLUP" | "NONE";

export type GscTierReason =
  /** Every day of both periods is in raw. */
  | "both_in_raw"
  /** The previous period starts before the earliest raw day; the current one does not. */
  | "previous_before_raw"
  /** The current period itself starts before the earliest raw day. */
  | "current_before_raw"
  /** The website has freshness but no raw rows at all: only the rollups remain. */
  | "no_raw"
  /** The website has no data date yet, so there is nothing to read from either tier. */
  | "no_data"
  /** The current period ends after the newest day with data; neither tier can serve it. */
  | "extends_past_latest";

export type GscTierDecision = { tier: GscReadTier; reason: GscTierReason };

export type GscTierInput = {
  current: DateRange;
  previous: DateRange;
  /** The earliest raw day the website has, or null when it has none. */
  rawFloor: string | null;
  /** The newest day with data — the anchor the windows were built from. */
  latestDataDate: string | null;
};

/**
 * RAW when both periods lie entirely within [rawFloor, latestDataDate];
 * ROLLUP when either period starts before rawFloor; NONE when there is no
 * data date or the request reaches past it. The reason says which.
 */
export function selectGscReadTier(input: GscTierInput): GscTierDecision {
  const { current, previous, rawFloor, latestDataDate } = input;

  if (!latestDataDate) return { tier: "NONE", reason: "no_data" };
  if (current.end > latestDataDate) return { tier: "NONE", reason: "extends_past_latest" };
  if (!rawFloor) return { tier: "ROLLUP", reason: "no_raw" };
  if (current.start < rawFloor) return { tier: "ROLLUP", reason: "current_before_raw" };
  if (previous.start < rawFloor) return { tier: "ROLLUP", reason: "previous_before_raw" };
  return { tier: "RAW", reason: "both_in_raw" };
}

/** Consecutive whole calendar months, as first days, ascending. */
export type MonthRange = { months: string[] };

export type MonthAlignment =
  | { ok: true; months: string[] }
  | { ok: false; reason: "start_not_month_start" | "end_not_month_end" | "empty" };

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function firstOfNextMonth(month: string): string {
  const [year, monthNumber] = month.slice(0, 7).split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
}

function lastOfMonth(month: string): string {
  const next = new Date(`${firstOfNextMonth(month)}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

/**
 * The monthly rollup can only truthfully answer for whole calendar months. A
 * range that starts mid-month or ends mid-month is refused with the reason,
 * rather than being widened or narrowed to the nearest months; the caller
 * decides what to ask instead. A range that is whole months comes back as
 * the list of those months.
 */
export function alignToCalendarMonths(range: DateRange): MonthAlignment {
  if (range.end < range.start) return { ok: false, reason: "empty" };
  if (range.start !== firstOfMonth(range.start)) {
    return { ok: false, reason: "start_not_month_start" };
  }
  if (range.end !== lastOfMonth(range.end)) return { ok: false, reason: "end_not_month_end" };

  const months: string[] = [];
  for (let month = firstOfMonth(range.start); month <= range.end; month = firstOfNextMonth(month)) {
    months.push(month);
  }
  return { ok: true, months };
}

/** The same number of whole months immediately before the given ones. */
export function precedingMonths(months: string[]): string[] {
  if (months.length === 0) return [];
  const result: string[] = [];
  let month = months[0]!;
  for (let count = 0; count < months.length; count += 1) {
    const [year, monthNumber] = month.slice(0, 7).split("-").map(Number) as [number, number];
    month = new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 10);
    result.unshift(month);
  }
  return result;
}
