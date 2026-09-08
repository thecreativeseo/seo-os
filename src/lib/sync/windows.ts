/**
 * Fetching a long period in pieces (P1 large-sync completeness).
 *
 * A provider will only return so many rows for one request, however many times
 * it is paged: Search Console and GA4 both stop at four hundred thousand. A
 * property busy enough to exceed that in ninety days could never be read
 * completely, and the run said PARTIAL forever — not because anything failed,
 * but because the question was too big to ask in one go.
 *
 * So the question is asked in smaller pieces. The requested period is cut into
 * date windows, each fetched on its own; a window that still comes back
 * truncated is cut in half and its halves asked separately, down to a single
 * day. The dates are the same dates; only the asking changes.
 *
 * Two properties matter and both are tested. The windows cover the requested
 * interval exactly once — no gap, no overlapping boundary day. And they are
 * fetched strictly one at a time, so memory stays bounded by one window's
 * pages rather than by the length of the period.
 */

/** An inclusive pair of ISO dates. Both ends belong to the window. */
export type DateWindow = { startDate: string; endDate: string };

/** A window's first attempt fell back to days and still could not be read. */
export const DAY_EXCEEDS_PROVIDER_LIMIT = "day_exceeds_provider_limit";
/** The run reached its ceiling on provider requests before finishing. */
export const WINDOW_BUDGET_EXHAUSTED = "window_budget_exhausted";
/** The budget ran out before this window was tried at all. */
export const WINDOW_NOT_ATTEMPTED = "not_attempted";

/** Where a period is first cut. Seven days is small enough for a busy site. */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * The most provider requests one sync may make.
 *
 * Ninety days in seven-day windows is a dozen or so requests; this leaves room
 * for a period that splits all the way down to days and pages within them,
 * while still stopping a runaway rather than looping.
 */
export const DEFAULT_MAX_REQUESTS = 1_000;

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtc(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, (month ?? 1) - 1, day ?? 1);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A date moved by whole days, staying in UTC so no timezone can shift it. */
export function shiftDate(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** How many days a window covers, counting both ends. */
export function windowLength(window: DateWindow): number {
  return Math.floor((toUtc(window.endDate) - toUtc(window.startDate)) / DAY_MS) + 1;
}

/**
 * Cuts a window in two, deterministically.
 *
 * The left half takes the extra day when the length is odd, which is arbitrary
 * but fixed: the same window always splits the same way, so a replay asks the
 * provider exactly the questions the first attempt asked.
 */
export function splitWindow(window: DateWindow): [DateWindow, DateWindow] {
  const length = windowLength(window);
  if (length < 2) throw new Error("a single day cannot be split");

  const leftDays = Math.ceil(length / 2);
  const leftEnd = shiftDate(window.startDate, leftDays - 1);

  return [
    { startDate: window.startDate, endDate: leftEnd },
    { startDate: shiftDate(leftEnd, 1), endDate: window.endDate },
  ];
}

/**
 * The first cut: consecutive windows covering the period exactly once.
 *
 * The last window is short rather than overhanging, so no date outside the
 * requested period is ever asked for and none inside it is asked for twice.
 */
export function initialWindows(range: DateWindow, days = DEFAULT_WINDOW_DAYS): DateWindow[] {
  const size = Math.max(1, Math.floor(days));
  const windows: DateWindow[] = [];

  let start = range.startDate;
  while (start <= range.endDate) {
    const end = shiftDate(start, size - 1);
    windows.push({ startDate: start, endDate: end > range.endDate ? range.endDate : end });
    start = shiftDate(start, size);
  }

  return windows;
}

/** What one window's fetch turned out to be. */
export type WindowResult = {
  rows: number;
  /** Provider requests spent on this window. */
  pages: number;
  /** True when the provider had more to give than it would return. */
  truncated: boolean;
};

/** What is known about a window afterwards, safe to record. */
export type WindowReport = DateWindow & {
  rows: number;
  pages: number;
  complete: boolean;
  truncated: boolean;
  code?: string;
};

export type AdaptiveResult = {
  /** Every window that was accepted or refused, chronologically. */
  windows: WindowReport[];
  /** True only when every window in the period was read completely. */
  complete: boolean;
  /** Provider requests spent, across every window including discarded probes. */
  requests: number;
  /** The windows that could not be completed. Empty when complete. */
  incomplete: WindowReport[];
  /** Why the period as a whole is incomplete, when it is. */
  code: string | null;
};

export type AdaptiveOptions = {
  initialDays?: number;
  maxRequests?: number;
  /**
   * Called when a window's rows are kept, immediately after its fetch.
   *
   * Kept does not mean complete: a single day the provider truncated is kept
   * too, because there is nothing smaller to ask and the rows it did give are
   * the best that day will have. What it is not is provisional — nothing will
   * replace those rows, so they count.
   */
  onAccept?: (window: DateWindow) => void;
  /**
   * Called when a truncated window is abandoned in favour of its halves.
   *
   * Its rows were already written — they are real rows for real dates — but
   * they are a subset of what the halves will write at the same grain, so the
   * caller rolls back what it counted for the probe and lets the halves count
   * instead.
   *
   * Exactly one of onAccept and onDiscard is called for each fetch, so a caller
   * can settle a window's contribution without repeating the driver's decision.
   */
  onDiscard?: (window: DateWindow) => void;
};

/**
 * Reads a period completely, in windows, one at a time.
 *
 * Iterative rather than recursive: the pending windows are an explicit queue,
 * so the depth of splitting cannot become the depth of the call stack. A
 * split pushes its halves to the front, which keeps the whole traversal in
 * date order — useful when something fails, because what was read is then a
 * prefix of the period rather than a scatter.
 */
export async function ingestByDateWindows(
  range: DateWindow,
  fetchWindow: (window: DateWindow) => Promise<WindowResult>,
  options: AdaptiveOptions = {},
): Promise<AdaptiveResult> {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const pending = initialWindows(range, options.initialDays ?? DEFAULT_WINDOW_DAYS);
  const windows: WindowReport[] = [];

  let requests = 0;
  let code: string | null = null;

  while (pending.length > 0) {
    if (requests >= maxRequests) {
      code = WINDOW_BUDGET_EXHAUSTED;
      break;
    }

    const window = pending.shift()!;
    const result = await fetchWindow(window);
    requests += Math.max(1, result.pages);

    if (!result.truncated) {
      options.onAccept?.(window);
      windows.push({ ...window, ...result, complete: true });
      continue;
    }

    if (windowLength(window) === 1) {
      // One day, and the provider still will not give all of it. There is
      // nothing smaller to ask for, so what it gave is kept — those rows are
      // the best that day will have — and the period carries on incomplete.
      options.onAccept?.(window);
      windows.push({ ...window, ...result, complete: false, code: DAY_EXCEEDS_PROVIDER_LIMIT });
      continue;
    }

    options.onDiscard?.(window);
    const [left, right] = splitWindow(window);
    pending.unshift(left, right);
  }

  for (const window of pending) {
    windows.push({
      ...window,
      rows: 0,
      pages: 0,
      complete: false,
      truncated: false,
      code: WINDOW_NOT_ATTEMPTED,
    });
  }

  windows.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const incomplete = windows.filter((window) => !window.complete);

  return { windows, complete: incomplete.length === 0, requests, incomplete, code };
}

// ---------------------------------------------------------------------------
// The checksum
// ---------------------------------------------------------------------------

/**
 * Evidence of what was read, independent of how it was asked for.
 *
 * A running hash folds rows in the order they arrive, which means the same
 * dataset hashes differently depending on page size, chunk size and where the
 * date windows fell — so it could not be compared across two runs that split
 * the period differently.
 *
 * Instead each row is hashed on its own and the digests are combined with XOR,
 * which does not care about order. That also makes a window's contribution
 * separable: a window is folded in only once it is accepted, so a truncated
 * probe leaves no trace, and no list of what to undo has to be kept.
 *
 * Every logical row is folded exactly once — provider pages within a window do
 * not overlap, and accepted windows do not share dates — which is what XOR
 * requires to be meaningful.
 */
export const DIGEST_BYTES = 32;

export function newDigest(): Uint8Array {
  return new Uint8Array(DIGEST_BYTES);
}

export function foldDigest(into: Uint8Array, digest: Uint8Array): void {
  for (let index = 0; index < DIGEST_BYTES; index += 1) {
    into[index] ^= digest[index]!;
  }
}

export function digestHex(digest: Uint8Array): string {
  return Buffer.from(digest).toString("hex");
}
