/**
 * How long an interactive transaction may wait to start, and how long it may
 * live, in the one environment that needs more than Prisma's defaults.
 *
 * Prisma gives an interactive transaction two seconds to acquire a connection
 * and five seconds to finish. In production those are generous: a request does
 * a few round trips and commits. The test suite is a different shape. It runs a
 * hundred files at once against a shared PostgreSQL in another region, each
 * building whole tenants inside transactions, and under that load a healthy
 * transaction was measured taking six to twelve seconds while round trips ran
 * at 61ms p50 and 319ms p90. Failures moved between unrelated suites, and each
 * failing test passed on its own.
 *
 * So the test environment, and only the test environment, gets a larger
 * budget. This is a change to how much patience the suite has, not to what any
 * product transaction does: the same statements run, in the same order, with
 * the same locks. Nothing here is a performance fix and nothing here reaches
 * production, where NODE_ENV is never "test" and the resolver returns null.
 *
 * The values can be overridden for experiments through two variables. An
 * override that is not a positive whole number of milliseconds falls back to
 * the default for that value rather than to Prisma's, so a typo in a shell
 * cannot silently put the suite back on a five-second budget.
 */

export const TEST_TRANSACTION_BUDGET = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

export const TEST_MAX_WAIT_VARIABLE = "PRISMA_TEST_TRANSACTION_MAX_WAIT_MS";
export const TEST_TIMEOUT_VARIABLE = "PRISMA_TEST_TRANSACTION_TIMEOUT_MS";

export type TransactionBudget = {
  /** Milliseconds a transaction may wait to acquire a connection. */
  maxWait: number;
  /** Milliseconds a transaction may run before Prisma cancels it. */
  timeout: number;
};

/** A positive whole number of milliseconds, or null for anything else. */
export function parseMilliseconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The budget for this process, or null to leave Prisma's defaults untouched.
 *
 * Only NODE_ENV=test gets one. A maxWait larger than the timeout is clamped
 * down to it, because a transaction cannot usefully wait longer to start than
 * it is then allowed to live.
 */
export function resolveTransactionBudget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TransactionBudget | null {
  if (env.NODE_ENV !== "test") return null;

  const timeout = parseMilliseconds(env[TEST_TIMEOUT_VARIABLE]) ?? TEST_TRANSACTION_BUDGET.timeout;
  const maxWait = parseMilliseconds(env[TEST_MAX_WAIT_VARIABLE]) ?? TEST_TRANSACTION_BUDGET.maxWait;

  return { maxWait: Math.min(maxWait, timeout), timeout };
}
