/**
 * Period comparison (docs/P1_SPEC.md §13).
 *
 * Default is the last 28 days against the 28 before it. The comparison window ends
 * the day before the current one begins, so no day is counted twice — an overlap
 * would make growth appear where there is none.
 *
 * Zero denominators are the interesting case. A page that went from 0 to 40 clicks
 * has not grown by infinity or by 100%; it is new. The spec asks for "a safe state
 * such as New", and conflating that with a percentage would put a meaningless
 * number in front of someone making a decision.
 */

export type PeriodPreset = "7d" | "28d" | "90d" | "custom";

export type DateRange = {
  /** YYYY-MM-DD, inclusive. */
  start: string;
  /** YYYY-MM-DD, inclusive. */
  end: string;
};

export type ComparisonWindows = {
  current: DateRange;
  previous: DateRange;
  days: number;
  preset: PeriodPreset;
};

const PRESET_DAYS: Record<Exclude<PeriodPreset, "custom">, number> = {
  "7d": 7,
  "28d": 28,
  "90d": 90,
};

function toDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shift(value: string, days: number): string {
  const date = toDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

export function daysBetween(range: DateRange): number {
  return (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 + 1;
}

/**
 * Builds both windows from the most recent day that has data.
 *
 * `latestDataDate` is deliberately not "today". Search Console reports two to
 * three days behind, and anchoring to today would silently include days that are
 * empty because they have not arrived yet — which reads as a decline.
 */
export function resolveWindows(
  latestDataDate: string,
  preset: Exclude<PeriodPreset, "custom"> = "28d",
): ComparisonWindows {
  const days = PRESET_DAYS[preset];

  const current: DateRange = {
    start: shift(latestDataDate, -(days - 1)),
    end: latestDataDate,
  };

  const previous: DateRange = {
    start: shift(current.start, -days),
    end: shift(current.start, -1),
  };

  return { current, previous, days, preset };
}

/** A custom current range, compared against the equally long window before it. */
export function resolveCustomWindows(current: DateRange): ComparisonWindows {
  const days = daysBetween(current);

  return {
    current,
    previous: {
      start: shift(current.start, -days),
      end: shift(current.start, -1),
    },
    days,
    preset: "custom",
  };
}

export type ChangeState = "up" | "down" | "flat" | "new" | "gone" | "unknown";

export type Change = {
  current: number | null;
  previous: number | null;
  /** current - previous. null when either side is unknown. */
  absolute: number | null;
  /** Fractional change, e.g. -0.258. null when there is no meaningful denominator. */
  percentage: number | null;
  state: ChangeState;
};

/**
 * Compares two values.
 *
 *   new      previous was zero and current is not — there is no percentage to give
 *   gone     current is zero and previous was not
 *   unknown  either side was never measured
 */
export function compareValues(
  current: number | null,
  previous: number | null,
): Change {
  if (current === null || previous === null) {
    return {
      current,
      previous,
      absolute: null,
      percentage: null,
      state: "unknown",
    };
  }

  const absolute = current - previous;

  if (previous === 0) {
    return {
      current,
      previous,
      absolute,
      // Dividing by zero would produce Infinity; "100%" would be a fabrication.
      percentage: null,
      state: current === 0 ? "flat" : "new",
    };
  }

  const percentage = absolute / previous;

  return {
    current,
    previous,
    absolute,
    percentage,
    state:
      current === 0 ? "gone" : absolute > 0 ? "up" : absolute < 0 ? "down" : "flat",
  };
}

/** How stale the data is, in whole days, relative to a given "today". */
export function freshnessInDays(latestDataDate: string | null, today: Date): number | null {
  if (!latestDataDate) return null;

  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );

  return Math.round((todayUtc - Date.parse(latestDataDate)) / 86_400_000);
}

/**
 * Search Console is expected to run two to three days behind, so staleness is only
 * worth flagging beyond that. Calling normal lag a problem would train people to
 * ignore the warning.
 */
export const EXPECTED_LAG_DAYS = 3;
export const STALE_AFTER_DAYS = 4;

export function isStale(latestDataDate: string | null, today: Date): boolean {
  const days = freshnessInDays(latestDataDate, today);
  return days === null || days > STALE_AFTER_DAYS;
}
