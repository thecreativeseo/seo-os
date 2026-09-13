import { describe, expect, it } from "vitest";

import { resolveCustomWindows, resolveWindows } from "@/lib/metrics/compare";
import {
  alignToCalendarMonths,
  precedingMonths,
  selectGscReadTier,
} from "@/lib/metrics/gsc-tier";

/**
 * Choosing where a comparison is read from (P1 GSC reader tiering).
 *
 * Both periods from raw when raw holds every day of both; both from the
 * rollups otherwise; never one from each. Availability is what the data
 * says — the earliest raw day, the newest day with data — and never today.
 */

const LATEST = "2026-09-08";

describe("choosing a tier", () => {
  it("reads both periods from raw when raw holds every day of both", () => {
    const windows = resolveWindows(LATEST, "28d");
    expect(windows.previous.start).toBe("2026-07-15");
    expect(
      selectGscReadTier({ ...windows, rawFloor: "2026-06-02", latestDataDate: LATEST }),
    ).toEqual({ tier: "RAW", reason: "both_in_raw" });
    // The floor on the very first day of the previous period still counts.
    expect(
      selectGscReadTier({ ...windows, rawFloor: "2026-07-15", latestDataDate: LATEST }),
    ).toEqual({ tier: "RAW", reason: "both_in_raw" });
  });

  it("reads both from the rollups when only the previous period reaches before raw", () => {
    const windows = resolveWindows(LATEST, "28d");
    expect(
      selectGscReadTier({ ...windows, rawFloor: "2026-07-16", latestDataDate: LATEST }),
    ).toEqual({ tier: "ROLLUP", reason: "previous_before_raw" });
  });

  it("reads both from the rollups when the current period itself reaches before raw", () => {
    const windows = resolveCustomWindows({ start: "2026-03-01", end: "2026-08-31" });
    expect(
      selectGscReadTier({ ...windows, rawFloor: "2026-06-02", latestDataDate: LATEST }),
    ).toEqual({ tier: "ROLLUP", reason: "current_before_raw" });
  });

  it("reads from the rollups when there is no raw at all but there was data", () => {
    const windows = resolveWindows(LATEST, "28d");
    expect(selectGscReadTier({ ...windows, rawFloor: null, latestDataDate: LATEST })).toEqual({
      tier: "ROLLUP",
      reason: "no_raw",
    });
  });

  it("answers with nothing, explicitly, when there is no data date", () => {
    const windows = resolveWindows(LATEST, "28d");
    expect(selectGscReadTier({ ...windows, rawFloor: null, latestDataDate: null })).toEqual({
      tier: "NONE",
      reason: "no_data",
    });
    expect(
      selectGscReadTier({ ...windows, rawFloor: "2026-06-02", latestDataDate: null }),
    ).toEqual({ tier: "NONE", reason: "no_data" });
  });

  it("is anchored on the newest day with data, not on the calendar", () => {
    // A window built for a later anchor than the data has: nothing can serve it.
    const windows = resolveWindows("2026-09-20", "28d");
    expect(
      selectGscReadTier({ ...windows, rawFloor: "2026-06-02", latestDataDate: LATEST }),
    ).toEqual({ tier: "NONE", reason: "extends_past_latest" });
    // The same window against a matching anchor is plain RAW.
    expect(
      selectGscReadTier({ ...windows, rawFloor: "2026-06-02", latestDataDate: "2026-09-20" }),
    ).toEqual({ tier: "RAW", reason: "both_in_raw" });
  });

  it("never mixes: one decision covers both periods", () => {
    // Every reachable decision is a single tier for the pair.
    const windows = resolveWindows(LATEST, "90d");
    for (const rawFloor of [null, "2026-01-01", "2026-06-02", "2026-08-01", "2026-09-01"]) {
      const decision = selectGscReadTier({ ...windows, rawFloor, latestDataDate: LATEST });
      expect(["RAW", "ROLLUP"]).toContain(decision.tier);
    }
  });
});

describe("whole calendar months", () => {
  it("accepts a range that is whole months and lists them", () => {
    expect(alignToCalendarMonths({ start: "2026-06-01", end: "2026-08-31" })).toEqual({
      ok: true,
      months: ["2026-06-01", "2026-07-01", "2026-08-01"],
    });
    expect(alignToCalendarMonths({ start: "2028-02-01", end: "2028-02-29" })).toEqual({
      ok: true,
      months: ["2028-02-01"],
    });
  });

  it("refuses a partial month rather than widening or narrowing it", () => {
    expect(alignToCalendarMonths({ start: "2026-06-02", end: "2026-08-31" })).toEqual({
      ok: false,
      reason: "start_not_month_start",
    });
    expect(alignToCalendarMonths({ start: "2026-06-01", end: "2026-08-30" })).toEqual({
      ok: false,
      reason: "end_not_month_end",
    });
    expect(alignToCalendarMonths({ start: "2026-09-01", end: "2026-08-31" })).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("names the same number of months immediately before", () => {
    expect(precedingMonths(["2026-06-01", "2026-07-01", "2026-08-01"])).toEqual([
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
    ]);
    expect(precedingMonths(["2027-01-01"])).toEqual(["2026-12-01"]);
    expect(precedingMonths([])).toEqual([]);
  });
});
