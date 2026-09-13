/**
 * Deciding which raw Search Console months a website may let go of (P1 GSC
 * raw retention), without touching any of them.
 *
 * The policy is stated in calendar months, because the monthly rollup that
 * outlives raw is stated in calendar months and a purge must never split a
 * month between the two tiers: raw keeps the month the newest data falls in,
 * however partial, and the thirteen complete months before it. Everything
 * older is a candidate — a candidate, not a decision. A candidate becomes
 * safe only once the rollups for that website and month are proven to exist
 * and to equal raw, and a calendar month as a whole is safe only when every
 * website with raw rows in it is.
 *
 * Time here is the website's own: latestDataDate, the newest day whose period
 * was read completely, which only moves when a whole period was. Today is
 * never consulted. A website with no latestDataDate has no window at all, and
 * every month it holds stays where it is, marked unknown rather than guessed.
 */

/** The complete calendar months kept before the current one. Not days: months. */
export const RAW_RETENTION_COMPLETE_MONTHS = 13;

/** Named so a report and an audit record can say which rule they applied. */
export const RAW_RETENTION_POLICY = "raw:current-month+13-complete-months";

export type MonthState =
  /** The month latestDataDate falls in. Always kept, whole or partial. */
  | "KEEP_CURRENT_PARTIAL"
  /** One of the complete months inside the window. Kept. */
  | "KEEP_RETENTION_WINDOW"
  /** Older than the window. May be purged once proven safe. */
  | "CANDIDATE_FOR_PURGE"
  /** A candidate whose rollups are missing or not fresh enough to trust. */
  | "BLOCKED_INCOMPLETE_ROLLUP"
  /** A candidate whose rollups do not equal raw. */
  | "BLOCKED_MISMATCH"
  /** No window can be drawn — no latestDataDate — or a check could not run. */
  | "BLOCKED_UNKNOWN";

export type MonthPlan = { month: string; state: MonthState };

export type RetentionPlan = {
  /** The month latestDataDate falls in, as its first day. Null without a data date. */
  currentMonth: string | null;
  /** The oldest month raw keeps, as its first day. Null without a data date. */
  retainedFrom: string | null;
  months: MonthPlan[];
};

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The first day of the month `offset` months after (or, negative, before) the given one. */
export function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.slice(0, 7).split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 10);
}

/** The last day of a calendar month. */
export function lastOfMonth(month: string): string {
  const next = new Date(`${shiftMonth(month, 1)}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

/** Whether a calendar month ended on or before the newest completely read day. */
export function monthCompleteBy(month: string, latestDataDate: string | null): boolean {
  return latestDataDate !== null && lastOfMonth(month) <= latestDataDate;
}

/**
 * Sorts the months a website holds raw rows for into kept, candidate and
 * unknown, from its latestDataDate. Pure: the same inputs always give the same
 * plan, and nothing about the calendar today is an input.
 */
export function planRawRetention(input: {
  latestDataDate: string | null;
  /** First days of the calendar months that hold raw rows, in any order. */
  rawMonths: string[];
  retentionMonths?: number;
}): RetentionPlan {
  const retentionMonths = input.retentionMonths ?? RAW_RETENTION_COMPLETE_MONTHS;
  const months = [...new Set(input.rawMonths.map(firstOfMonth))].sort();

  if (!input.latestDataDate) {
    return {
      currentMonth: null,
      retainedFrom: null,
      months: months.map((month) => ({ month, state: "BLOCKED_UNKNOWN" as const })),
    };
  }

  const currentMonth = firstOfMonth(input.latestDataDate);
  const retainedFrom = shiftMonth(currentMonth, -retentionMonths);

  return {
    currentMonth,
    retainedFrom,
    months: months.map((month) => {
      if (month >= currentMonth) return { month, state: "KEEP_CURRENT_PARTIAL" };
      if (month >= retainedFrom) return { month, state: "KEEP_RETENTION_WINDOW" };
      return { month, state: "CANDIDATE_FOR_PURGE" };
    }),
  };
}

/**
 * What the eventual purge will write down, one record per website and month
 * it evaluated, before it deletes anything and again after. Defined now so the
 * dry run reports in the same shape; not yet a table, because the dry run has
 * nothing to make durable. When a purge exists, this becomes an audit event
 * and the counts fill in.
 */
export type RetentionAuditRecord = {
  retentionRunId: string;
  evaluatedAt: string;
  policy: typeof RAW_RETENTION_POLICY;
  websiteId: string;
  latestDataDate: string | null;
  month: string;
  rawRows: number;
  rollupEquality: "EQUAL" | "MISMATCH" | "MISSING" | "NOT_CHECKED";
  decision: MonthState;
  blockedReason: string | null;
  /** Null until a purge has actually run for this record. */
  deletedRows: number | null;
  durationMs: number;
};
