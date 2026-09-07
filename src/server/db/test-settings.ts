/**
 * Database settings that apply in the test environment and nowhere else.
 *
 * Two of them, both forced by the same fact: the suite runs about a hundred
 * files at once against a shared PostgreSQL in another region, which is a
 * shape no deployed service has.
 *
 * The transaction budget. Prisma gives an interactive transaction two seconds
 * to acquire a connection and five to finish. Under that load a healthy tenant
 * transaction was measured taking six to twelve seconds, with round trips at
 * 61ms p50 and 319ms p90, so tests failed on a stopwatch in suites unrelated
 * to whatever was being built.
 *
 * The pool ceiling. Fixing the budget exposed the next limit: the pooler
 * refusing connections outright, `unable to check out connection from the pool
 * after 15000ms`. Each worker's pg pool defaults to ten connections, so twelve
 * workers could demand a hundred and twenty, and two suites open a second
 * client against DIRECT_URL on top. But a worker runs one file at a time and
 * the tests inside a file run in sequence, so it needs one or two connections,
 * not ten. The default was not sized for anything; it was simply never set.
 *
 * Neither is a product change. The same statements run in the same order with
 * the same locks; the suite is given more patience and asks for fewer
 * connections. Outside NODE_ENV=test every resolver here returns null and the
 * library defaults stand exactly as they did.
 *
 * Overrides exist for experiments. A value that is not a positive whole number
 * falls back to the documented default for that setting, never to the
 * library's, so a typo in a shell cannot quietly restore ten connections or a
 * five-second budget.
 */

export const TEST_TRANSACTION_BUDGET = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

/** The shared application client, one per worker process. */
export const TEST_POOL_MAX = 3;

/**
 * A test-only client on DIRECT_URL. Those exist for narrow setup and assertion
 * reads, not for application traffic, and DIRECT_URL is the pooler's session
 * mode, where connections are scarcest.
 */
export const TEST_DIRECT_POOL_MAX = 1;

export const TEST_MAX_WAIT_VARIABLE = "PRISMA_TEST_TRANSACTION_MAX_WAIT_MS";
export const TEST_TIMEOUT_VARIABLE = "PRISMA_TEST_TRANSACTION_TIMEOUT_MS";
export const TEST_POOL_MAX_VARIABLE = "PRISMA_TEST_POOL_MAX";
export const TEST_DIRECT_POOL_MAX_VARIABLE = "PRISMA_TEST_DIRECT_POOL_MAX";

export type TransactionBudget = {
  /** Milliseconds a transaction may wait to acquire a connection. */
  maxWait: number;
  /** Milliseconds a transaction may run before Prisma cancels it. */
  timeout: number;
};

type Env = Readonly<Record<string, string | undefined>>;

const isTest = (env: Env): boolean => env.NODE_ENV === "test";

/** A positive whole number, or null for anything else. */
export function parsePositiveInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The transaction budget for this process, or null to leave Prisma's defaults
 * untouched. A maxWait larger than the timeout is clamped down to it: a
 * transaction cannot usefully wait longer to start than it may then live.
 */
export function resolveTransactionBudget(env: Env = process.env): TransactionBudget | null {
  if (!isTest(env)) return null;

  const timeout =
    parsePositiveInteger(env[TEST_TIMEOUT_VARIABLE]) ?? TEST_TRANSACTION_BUDGET.timeout;
  const maxWait =
    parsePositiveInteger(env[TEST_MAX_WAIT_VARIABLE]) ?? TEST_TRANSACTION_BUDGET.maxWait;

  return { maxWait: Math.min(maxWait, timeout), timeout };
}

/** Connections the shared application client may open, or null for pg's default. */
export function resolvePoolMax(env: Env = process.env): number | null {
  if (!isTest(env)) return null;
  return parsePositiveInteger(env[TEST_POOL_MAX_VARIABLE]) ?? TEST_POOL_MAX;
}

/** Connections a test-only DIRECT_URL client may open, or null for pg's default. */
export function resolveDirectPoolMax(env: Env = process.env): number | null {
  if (!isTest(env)) return null;
  return parsePositiveInteger(env[TEST_DIRECT_POOL_MAX_VARIABLE]) ?? TEST_DIRECT_POOL_MAX;
}

/**
 * Pool options to spread into a `PrismaPg` construction. Empty outside test, so
 * the key is absent rather than set to a default and pg decides as before.
 */
export function poolOptions(env: Env = process.env): { max?: number } {
  const max = resolvePoolMax(env);
  return max === null ? {} : { max };
}

/**
 * The same, for a test-only client on DIRECT_URL.
 *
 * `overrideMax` is for the one suite that issues concurrent reads and can show
 * it needs more than one connection. It applies only under test; outside it,
 * pg's default stands untouched like everything else here.
 */
export function directPoolOptions(env: Env = process.env, overrideMax?: number): { max?: number } {
  const max = resolveDirectPoolMax(env);
  if (max === null) return {};
  const explicit = env[TEST_DIRECT_POOL_MAX_VARIABLE] !== undefined;
  // An operator's override wins over a suite's; otherwise the suite's evidence does.
  return { max: explicit ? max : (overrideMax ?? max) };
}
