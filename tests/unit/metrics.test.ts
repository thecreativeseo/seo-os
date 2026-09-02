import { describe, expect, it } from "vitest";

import {
  aggregateGa4,
  aggregateGsc,
  engagementRate,
  type GscRow,
} from "@/lib/metrics/aggregate";
import {
  compareValues,
  daysBetween,
  freshnessInDays,
  isStale,
  resolveCustomWindows,
  resolveWindows,
} from "@/lib/metrics/compare";

/**
 * "Any metric-integrity failure = P1 FAIL." These are the rules that make that
 * criterion mechanical rather than aspirational.
 */

describe("CTR is recomputed from totals, never averaged", () => {
  it("divides total clicks by total impressions", () => {
    const rows: GscRow[] = [
      { clicks: 10, impressions: 1000, position: 5 },
      { clicks: 90, impressions: 1000, position: 5 },
    ];

    expect(aggregateGsc(rows).ctr).toBeCloseTo(100 / 2000, 10);
  });

  it("differs from the mean of row CTRs when volumes are uneven", () => {
    // The case that makes averaging dangerous: a tiny row with a huge CTR.
    const rows: GscRow[] = [
      { clicks: 3, impressions: 3, position: 1 }, // row CTR 100%
      { clicks: 100, impressions: 30_000, position: 20 }, // row CTR 0.33%
    ];

    const totals = aggregateGsc(rows);
    const naiveMean = (3 / 3 + 100 / 30_000) / 2;

    expect(totals.ctr).toBeCloseTo(103 / 30_003, 10);
    expect(totals.ctr).toBeLessThan(0.005);
    // The naive mean would report over 50%.
    expect(naiveMean).toBeGreaterThan(0.5);
  });

  it("returns null rather than zero when there are no impressions", () => {
    expect(aggregateGsc([{ clicks: 0, impressions: 0, position: null }]).ctr).toBeNull();
    expect(aggregateGsc([]).ctr).toBeNull();
  });
});

describe("position is impression-weighted", () => {
  it("weights by impressions, not by row count", () => {
    const rows: GscRow[] = [
      { clicks: 0, impressions: 10_000, position: 3 },
      { clicks: 0, impressions: 10, position: 90 },
    ];

    const totals = aggregateGsc(rows);
    const naiveMean = (3 + 90) / 2;

    // (3×10000 + 90×10) / 10010
    expect(totals.position).toBeCloseTo(30_900 / 10_010, 6);
    expect(totals.position).toBeLessThan(4);
    expect(naiveMean).toBe(46.5);
  });

  it("ignores rows with no impressions rather than counting them as zero", () => {
    const rows: GscRow[] = [
      { clicks: 0, impressions: 100, position: 10 },
      { clicks: 0, impressions: 0, position: 1 },
    ];

    expect(aggregateGsc(rows).position).toBe(10);
  });

  it("ignores rows with a null position", () => {
    const rows: GscRow[] = [
      { clicks: 0, impressions: 100, position: 10 },
      { clicks: 0, impressions: 100, position: null },
    ];

    expect(aggregateGsc(rows).position).toBe(10);
  });

  it("returns null when nothing carries positional information", () => {
    expect(aggregateGsc([{ clicks: 1, impressions: 5, position: null }]).position).toBeNull();
  });
});

describe("GA4 totals distinguish measured zero from not measured", () => {
  it("returns null when a metric is never reported", () => {
    const totals = aggregateGa4([
      { sessions: 10, engagedSessions: 5, users: 8, newUsers: 4, keyEvents: null, conversions: null, revenue: null },
      { sessions: 12, engagedSessions: 6, users: 9, newUsers: 3, keyEvents: null, conversions: null, revenue: null },
    ]);

    expect(totals.sessions).toBe(22);
    // Nobody measured these. Reporting 0 would let the interface claim the business
    // had no conversions when in fact none were counted.
    expect(totals.keyEvents).toBeNull();
    expect(totals.conversions).toBeNull();
    expect(totals.revenue).toBeNull();
  });

  it("returns zero when zero was actually measured", () => {
    const totals = aggregateGa4([
      { sessions: 10, engagedSessions: 5, users: 8, newUsers: 4, keyEvents: 0, conversions: null, revenue: null },
    ]);

    expect(totals.keyEvents).toBe(0);
  });

  it("treats a missing day as zero once a metric is measured at all", () => {
    const totals = aggregateGa4([
      { sessions: 10, engagedSessions: 5, users: 8, newUsers: 4, keyEvents: 3, conversions: null, revenue: null },
      { sessions: 10, engagedSessions: 5, users: 8, newUsers: 4, keyEvents: null, conversions: null, revenue: null },
    ]);

    expect(totals.keyEvents).toBe(3);
  });

  it("recomputes engagement rate from totals", () => {
    const totals = aggregateGa4([
      { sessions: 100, engagedSessions: 40, users: null, newUsers: null, keyEvents: null, conversions: null, revenue: null },
      { sessions: 100, engagedSessions: 80, users: null, newUsers: null, keyEvents: null, conversions: null, revenue: null },
    ]);

    expect(engagementRate(totals)).toBeCloseTo(120 / 200, 10);
  });
});

describe("comparison windows", () => {
  it("defaults to 28 days against the previous 28", () => {
    const windows = resolveWindows("2026-08-30", "28d");

    expect(windows.current).toEqual({ start: "2026-08-03", end: "2026-08-30" });
    expect(windows.previous).toEqual({ start: "2026-07-06", end: "2026-08-02" });
    expect(daysBetween(windows.current)).toBe(28);
    expect(daysBetween(windows.previous)).toBe(28);
  });

  it("never overlaps the two windows", () => {
    for (const preset of ["7d", "28d", "90d"] as const) {
      const windows = resolveWindows("2026-08-30", preset);
      // An overlap would count a day twice and manufacture growth.
      expect(Date.parse(windows.previous.end)).toBeLessThan(
        Date.parse(windows.current.start),
      );
      expect(daysBetween(windows.current)).toBe(daysBetween(windows.previous));
    }
  });

  it("anchors to the latest data date, not to today", () => {
    // Anchoring to today would include days that have not arrived yet, which reads
    // as a decline.
    const windows = resolveWindows("2026-08-30", "7d");
    expect(windows.current.end).toBe("2026-08-30");
  });

  it("compares a custom range against an equally long window", () => {
    const windows = resolveCustomWindows({ start: "2026-08-01", end: "2026-08-10" });

    expect(windows.days).toBe(10);
    expect(windows.previous).toEqual({ start: "2026-07-22", end: "2026-07-31" });
  });

  it("handles a month boundary", () => {
    const windows = resolveWindows("2026-03-01", "7d");
    expect(windows.current.start).toBe("2026-02-23");
    expect(windows.previous).toEqual({ start: "2026-02-16", end: "2026-02-22" });
  });
});

describe("change calculation", () => {
  it("reports the blueprint's decline exactly", () => {
    const change = compareValues(920, 1240);

    expect(change.absolute).toBe(-320);
    expect(change.percentage).toBeCloseTo(-0.258, 3);
    expect(change.state).toBe("down");
  });

  it("calls a rise from zero New rather than a percentage", () => {
    const change = compareValues(40, 0);

    expect(change.state).toBe("new");
    // Neither Infinity nor a fabricated 100%.
    expect(change.percentage).toBeNull();
    expect(change.absolute).toBe(40);
  });

  it("calls a fall to zero gone", () => {
    expect(compareValues(0, 40).state).toBe("gone");
    expect(compareValues(0, 40).percentage).toBe(-1);
  });

  it("treats zero to zero as flat, not as new", () => {
    const change = compareValues(0, 0);
    expect(change.state).toBe("flat");
    expect(change.percentage).toBeNull();
  });

  it("reports unknown when either side was never measured", () => {
    expect(compareValues(null, 10).state).toBe("unknown");
    expect(compareValues(10, null).state).toBe("unknown");
    expect(compareValues(10, null).percentage).toBeNull();
  });
});

describe("freshness", () => {
  const today = new Date("2026-09-02T09:00:00Z");

  it("counts whole days behind", () => {
    expect(freshnessInDays("2026-08-30", today)).toBe(3);
    expect(freshnessInDays("2026-09-02", today)).toBe(0);
  });

  it("does not flag the normal Search Console lag as stale", () => {
    // Treating expected lag as a problem would train people to ignore the warning.
    expect(isStale("2026-08-30", today)).toBe(false);
  });

  it("flags data that is genuinely behind", () => {
    expect(isStale("2026-08-25", today)).toBe(true);
  });

  it("treats never-synced as stale", () => {
    expect(isStale(null, today)).toBe(true);
    expect(freshnessInDays(null, today)).toBeNull();
  });
});
