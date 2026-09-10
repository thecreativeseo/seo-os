import { describe, expect, it } from "vitest";

import {
  DAY_EXCEEDS_PROVIDER_LIMIT,
  WINDOW_BUDGET_EXHAUSTED,
  WINDOW_NOT_ATTEMPTED,
  digestHex,
  foldDigest,
  ingestByDateWindows,
  initialWindows,
  newDigest,
  shiftDate,
  splitWindow,
  windowLength,
  type DateWindow,
} from "@/lib/sync/windows";

/**
 * Cutting a period into windows (P1 large-sync completeness).
 *
 * Two things have to be true of any partition, and neither is obvious from
 * reading the code: the windows cover the requested period exactly once, and
 * they keep covering it exactly once after a window is split. A gap loses a
 * day's data silently; an overlap asks for the same day twice and pays for it
 * twice. Both are checked here by reconstructing the set of days.
 */

/** Every date a set of windows covers, in order, with duplicates kept. */
function daysCovered(windows: DateWindow[]): string[] {
  const days: string[] = [];
  for (const window of windows) {
    for (let cursor = window.startDate; cursor <= window.endDate; cursor = shiftDate(cursor, 1)) {
      days.push(cursor);
    }
  }
  return days;
}

/** Every date in a range, as the answer to compare a partition against. */
function expectedDays(range: DateWindow): string[] {
  const days: string[] = [];
  for (let cursor = range.startDate; cursor <= range.endDate; cursor = shiftDate(cursor, 1)) {
    days.push(cursor);
  }
  return days;
}

function expectExactCover(windows: DateWindow[], range: DateWindow): void {
  const covered = daysCovered(windows);
  const wanted = expectedDays(range);

  // Sorted comparison catches a gap and a missing day; the length comparison
  // against a Set catches a day covered twice.
  expect([...covered].sort()).toEqual([...wanted].sort());
  expect(new Set(covered).size).toBe(covered.length);
}

describe("date arithmetic", () => {
  it("moves whole days in UTC, across a month boundary", () => {
    expect(shiftDate("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftDate("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles a leap day", () => {
    expect(shiftDate("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDate("2024-02-29", 1)).toBe("2024-03-01");
    expect(windowLength({ startDate: "2024-02-01", endDate: "2024-02-29" })).toBe(29);
  });

  it("counts both ends of a window", () => {
    expect(windowLength({ startDate: "2026-09-01", endDate: "2026-09-01" })).toBe(1);
    expect(windowLength({ startDate: "2026-09-01", endDate: "2026-09-07" })).toBe(7);
  });
});

describe("the first cut", () => {
  const cases: [string, DateWindow, number][] = [
    ["a period that divides evenly", { startDate: "2026-09-01", endDate: "2026-09-14" }, 7],
    ["a period that does not", { startDate: "2026-09-01", endDate: "2026-09-10" }, 7],
    ["a single day", { startDate: "2026-09-01", endDate: "2026-09-01" }, 7],
    ["a period shorter than the window", { startDate: "2026-09-01", endDate: "2026-09-03" }, 7],
    ["a ninety-day period", { startDate: "2026-06-08", endDate: "2026-09-05" }, 7],
    ["a period across a month end", { startDate: "2026-08-28", endDate: "2026-09-04" }, 3],
    ["a period across a leap day", { startDate: "2024-02-26", endDate: "2024-03-03" }, 2],
  ];

  for (const [label, range, days] of cases) {
    it(`covers ${label} exactly once`, () => {
      const windows = initialWindows(range, days);
      expectExactCover(windows, range);

      // Chronological, and never reaching outside the period.
      expect(windows[0]!.startDate).toBe(range.startDate);
      expect(windows[windows.length - 1]!.endDate).toBe(range.endDate);
      for (const window of windows) expect(window.startDate <= window.endDate).toBe(true);
    });
  }

  it("never overhangs the end of the period", () => {
    const range = { startDate: "2026-09-01", endDate: "2026-09-10" };
    const windows = initialWindows(range, 7);

    expect(windows).toEqual([
      { startDate: "2026-09-01", endDate: "2026-09-07" },
      { startDate: "2026-09-08", endDate: "2026-09-10" },
    ]);
  });
});

describe("splitting a window", () => {
  it("divides it in two with no shared day", () => {
    const window = { startDate: "2026-09-01", endDate: "2026-09-08" };
    const [left, right] = splitWindow(window);

    expect(left).toEqual({ startDate: "2026-09-01", endDate: "2026-09-04" });
    expect(right).toEqual({ startDate: "2026-09-05", endDate: "2026-09-08" });
    expectExactCover([left, right], window);
  });

  it("gives the extra day to the left half on an odd length", () => {
    const window = { startDate: "2026-09-01", endDate: "2026-09-07" };
    const [left, right] = splitWindow(window);

    expect(windowLength(left)).toBe(4);
    expect(windowLength(right)).toBe(3);
    expectExactCover([left, right], window);
  });

  it("splits a two-day window into two single days", () => {
    const [left, right] = splitWindow({ startDate: "2026-09-01", endDate: "2026-09-02" });
    expect(left).toEqual({ startDate: "2026-09-01", endDate: "2026-09-01" });
    expect(right).toEqual({ startDate: "2026-09-02", endDate: "2026-09-02" });
  });

  it("refuses to split a single day, because there is nothing smaller to ask", () => {
    expect(() => splitWindow({ startDate: "2026-09-01", endDate: "2026-09-01" })).toThrow();
  });
});

describe("reading a period in windows", () => {
  const range = { startDate: "2026-06-08", endDate: "2026-09-05" };

  it("accepts every window when nothing truncates", async () => {
    const asked: DateWindow[] = [];

    const outcome = await ingestByDateWindows(range, async (window) => {
      asked.push(window);
      return { rows: 100, pages: 1, truncated: false };
    });

    expect(outcome.complete).toBe(true);
    expect(outcome.incomplete).toEqual([]);
    expect(outcome.code).toBeNull();
    expectExactCover(asked, range);
    // Ninety days in sevens.
    expect(asked).toHaveLength(13);
  });

  it("splits only the windows that truncate, and still covers the period once", async () => {
    // One busy week; everything else is ordinary.
    const busy = "2026-07-06";
    const accepted: DateWindow[] = [];

    const outcome = await ingestByDateWindows(range, async (window) => {
      const coversBusy = window.startDate <= busy && busy <= window.endDate;
      // The busy day alone is fine; any window containing it and more is not.
      const truncated = coversBusy && windowLength(window) > 1;

      if (!truncated) accepted.push(window);
      return { rows: 10, pages: 1, truncated };
    });

    expect(outcome.complete).toBe(true);
    // The accepted windows — not the discarded probes — are the partition.
    expectExactCover(accepted, range);
  });

  it("keeps a day that will not fit, and says why, without abandoning the rest", async () => {
    const stubborn = "2026-07-06";

    const outcome = await ingestByDateWindows(range, async (window) => {
      const covers = window.startDate <= stubborn && stubborn <= window.endDate;
      return { rows: 10, pages: 1, truncated: covers };
    });

    expect(outcome.complete).toBe(false);
    expect(outcome.incomplete).toHaveLength(1);
    expect(outcome.incomplete[0]).toMatchObject({
      startDate: stubborn,
      endDate: stubborn,
      complete: false,
      code: DAY_EXCEEDS_PROVIDER_LIMIT,
    });

    // Every other day was still read, and the whole period is still accounted
    // for exactly once between the complete and incomplete windows.
    expectExactCover(outcome.windows, range);
  });

  it("stops at the request ceiling rather than looping, and says the rest was not tried", async () => {
    const outcome = await ingestByDateWindows(
      range,
      async () => ({ rows: 10, pages: 1, truncated: false }),
      { maxRequests: 5 },
    );

    expect(outcome.requests).toBe(5);
    expect(outcome.complete).toBe(false);
    expect(outcome.code).toBe(WINDOW_BUDGET_EXHAUSTED);
    expect(outcome.incomplete.every((window) => window.code === WINDOW_NOT_ATTEMPTED)).toBe(true);
    // Nothing is lost track of: attempted and unattempted together are the period.
    expectExactCover(outcome.windows, range);
  });

  it("reads one window at a time, never two at once", async () => {
    let inFlight = 0;
    let peak = 0;

    await ingestByDateWindows(range, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { rows: 1, pages: 1, truncated: false };
    });

    expect(peak).toBe(1);
  });

  it("asks in date order, so an interrupted period is a prefix of itself", async () => {
    const asked: string[] = [];

    await ingestByDateWindows(
      { startDate: "2026-09-01", endDate: "2026-09-08" },
      async (window) => {
        asked.push(window.startDate);
        // Only the first window truncates, so its halves are asked next — before
        // the windows that follow it.
        const first = window.startDate === "2026-09-01" && windowLength(window) === 4;
        return { rows: 1, pages: 1, truncated: first };
      },
      { initialDays: 4 },
    );

    expect(asked).toEqual(["2026-09-01", "2026-09-01", "2026-09-03", "2026-09-05"]);
  });

  it("counts a discarded probe's requests, so splitting cannot be free", async () => {
    let discarded = 0;

    const outcome = await ingestByDateWindows(
      { startDate: "2026-09-01", endDate: "2026-09-02" },
      async (window) => ({ rows: 1, pages: 3, truncated: windowLength(window) > 1 }),
      {
        onDiscard: () => {
          discarded += 1;
        },
      },
    );

    expect(discarded).toBe(1);
    // The parent's three requests plus three for each of the two halves.
    expect(outcome.requests).toBe(9);
    expect(outcome.complete).toBe(true);
  });
});

describe("the checksum", () => {
  const rowsOf = (n: number) => Array.from({ length: n }, (_, index) => `row-${index}`);

  /** Folds rows into a digest in whatever order they are given. */
  const digestOf = (groups: string[][]): string => {
    const total = newDigest();
    for (const group of groups) {
      const window = newDigest();
      for (const row of group) {
        const single = newDigest();
        foldDigest(single, Buffer.from(row.padEnd(32, " ").slice(0, 32)));
        foldDigest(window, single);
      }
      foldDigest(total, window);
    }
    return digestHex(total);
  };

  it("is the same however the rows are grouped into windows and pages", () => {
    const rows = rowsOf(60);

    const oneWindow = digestOf([rows]);
    const threeWindows = digestOf([rows.slice(0, 20), rows.slice(20, 40), rows.slice(40)]);
    const manySmallPages = digestOf(
      Array.from({ length: 12 }, (_, index) => rows.slice(index * 5, index * 5 + 5)),
    );

    expect(threeWindows).toBe(oneWindow);
    expect(manySmallPages).toBe(oneWindow);
  });

  it("changes when a row changes", () => {
    expect(digestOf([rowsOf(10)])).not.toBe(digestOf([[...rowsOf(9), "row-different"]]));
  });

  it("is unaffected by the order rows arrive in", () => {
    const rows = rowsOf(30);
    expect(digestOf([[...rows].reverse()])).toBe(digestOf([rows]));
  });
});
