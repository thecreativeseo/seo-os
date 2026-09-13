import { describe, expect, it } from "vitest";

import {
  lastOfMonth,
  monthCompleteBy,
  planRawRetention,
  RAW_RETENTION_COMPLETE_MONTHS,
  shiftMonth,
} from "@/lib/gsc/retention";
import { resolveWindows } from "@/lib/metrics/compare";
import { selectGscReadTier } from "@/lib/metrics/gsc-tier";

/**
 * Deciding which raw months may go (P1 GSC raw retention), on paper.
 *
 * The policy is calendar months from the website's own latestDataDate: the
 * month that day falls in, whole or partial, and the thirteen complete months
 * before it. Everything older is a candidate. Today is never an input.
 */

const SIXTEEN_MONTHS = Array.from({ length: 16 }, (_, index) => shiftMonth("2025-06-01", index));

describe("month arithmetic", () => {
  it("moves by whole months across year ends and leap years", () => {
    expect(shiftMonth("2026-09-01", -13)).toBe("2025-08-01");
    expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(shiftMonth("2025-12-01", 1)).toBe("2026-01-01");
    expect(lastOfMonth("2028-02-01")).toBe("2028-02-29");
    expect(lastOfMonth("2026-02-01")).toBe("2026-02-28");
    expect(lastOfMonth("2026-12-01")).toBe("2026-12-31");
  });

  it("calls a month complete only once its last day is on or before latestDataDate", () => {
    expect(monthCompleteBy("2026-08-01", "2026-08-31")).toBe(true);
    expect(monthCompleteBy("2026-08-01", "2026-09-10")).toBe(true);
    expect(monthCompleteBy("2026-08-01", "2026-08-30")).toBe(false);
    expect(monthCompleteBy("2026-09-01", "2026-09-10")).toBe(false);
    expect(monthCompleteBy("2026-08-01", null)).toBe(false);
  });
});

describe("the retention window", () => {
  it("keeps the current month and thirteen complete months, and names the rest candidates", () => {
    expect(RAW_RETENTION_COMPLETE_MONTHS).toBe(13);
    const plan = planRawRetention({ latestDataDate: "2026-09-10", rawMonths: SIXTEEN_MONTHS });

    expect(plan.currentMonth).toBe("2026-09-01");
    expect(plan.retainedFrom).toBe("2025-08-01");
    const byState = Object.fromEntries(
      ["KEEP_CURRENT_PARTIAL", "KEEP_RETENTION_WINDOW", "CANDIDATE_FOR_PURGE"].map((state) => [
        state,
        plan.months.filter((entry) => entry.state === state).map((entry) => entry.month),
      ]),
    );
    expect(byState["KEEP_CURRENT_PARTIAL"]).toEqual(["2026-09-01"]);
    expect(byState["KEEP_RETENTION_WINDOW"]).toEqual(
      Array.from({ length: 13 }, (_, index) => shiftMonth("2025-08-01", index)),
    );
    // Exactly the boundary month is kept; the one before it is not.
    expect(byState["KEEP_RETENTION_WINDOW"]![0]).toBe("2025-08-01");
    expect(byState["CANDIDATE_FOR_PURGE"]).toEqual(["2025-06-01", "2025-07-01"]);
  });

  it("keeps the current month even on its last day, and even when it is the only month", () => {
    const plan = planRawRetention({ latestDataDate: "2026-09-30", rawMonths: ["2026-09-01"] });
    expect(plan.months).toEqual([{ month: "2026-09-01", state: "KEEP_CURRENT_PARTIAL" }]);
  });

  it("is anchored on latestDataDate, not on the newest raw month or the calendar", () => {
    // Raw reaches into October (a partial run), but the newest complete day is in September.
    const plan = planRawRetention({
      latestDataDate: "2026-09-10",
      rawMonths: ["2025-06-01", "2025-08-01", "2026-09-01", "2026-10-01"],
    });
    expect(plan.currentMonth).toBe("2026-09-01");
    expect(plan.months.find((entry) => entry.month === "2026-10-01")?.state).toBe("KEEP_CURRENT_PARTIAL");
    expect(plan.months.find((entry) => entry.month === "2025-08-01")?.state).toBe("KEEP_RETENTION_WINDOW");
    expect(plan.months.find((entry) => entry.month === "2025-06-01")?.state).toBe("CANDIDATE_FOR_PURGE");
  });

  it("has no window at all without a data date: every month is unknown, none a candidate", () => {
    const plan = planRawRetention({ latestDataDate: null, rawMonths: SIXTEEN_MONTHS });
    expect(plan.currentMonth).toBeNull();
    expect(plan.retainedFrom).toBeNull();
    expect(new Set(plan.months.map((entry) => entry.state))).toEqual(new Set(["BLOCKED_UNKNOWN"]));
  });

  it("yields no candidates when raw is younger than the window", () => {
    // Production today: June to September 2026 against a September 2026 data date.
    const plan = planRawRetention({
      latestDataDate: "2026-09-10",
      rawMonths: ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"],
    });
    expect(plan.months.filter((entry) => entry.state === "CANDIDATE_FOR_PURGE")).toEqual([]);
    expect(plan.retainedFrom).toBe("2025-08-01");
  });

  it("is deterministic and indifferent to input order and duplicates", () => {
    const shuffled = [...SIXTEEN_MONTHS].reverse().concat(SIXTEEN_MONTHS.slice(0, 3));
    expect(planRawRetention({ latestDataDate: "2026-09-10", rawMonths: shuffled })).toEqual(
      planRawRetention({ latestDataDate: "2026-09-10", rawMonths: SIXTEEN_MONTHS }),
    );
  });
});

describe("what the readers would do after a purge", () => {
  const latest = "2026-09-10";
  const floorToday = "2025-06-01";
  const floorAfter = "2025-08-01";

  it("keeps the product's short windows on raw, before and after", () => {
    for (const preset of ["28d", "90d"] as const) {
      const windows = resolveWindows(latest, preset);
      expect(selectGscReadTier({ ...windows, rawFloor: floorToday, latestDataDate: latest }).tier).toBe("RAW");
      expect(selectGscReadTier({ ...windows, rawFloor: floorAfter, latestDataDate: latest }).tier).toBe("RAW");
    }
  });

  it("sends a comparison that straddles the new floor to the rollups, both periods", () => {
    const current = { start: "2025-09-01", end: latest };
    const previous = { start: "2024-08-23", end: "2025-08-31" };
    expect(selectGscReadTier({ current, previous, rawFloor: floorToday, latestDataDate: latest })).toEqual({
      tier: "ROLLUP",
      reason: "previous_before_raw",
    });
    expect(selectGscReadTier({ current, previous, rawFloor: floorAfter, latestDataDate: latest })).toEqual({
      tier: "ROLLUP",
      reason: "previous_before_raw",
    });
  });

  it("sends whole months before the new floor to the rollups, never mixed", () => {
    const current = { start: "2025-06-01", end: "2025-07-31" };
    const previous = { start: "2025-04-01", end: "2025-05-31" };
    // Today those months are still raw for the current period but the previous
    // reaches before the floor: rollups for both. After the purge: still rollups.
    expect(selectGscReadTier({ current, previous, rawFloor: floorToday, latestDataDate: latest }).tier).toBe("ROLLUP");
    expect(selectGscReadTier({ current, previous, rawFloor: floorAfter, latestDataDate: latest })).toEqual({
      tier: "ROLLUP",
      reason: "current_before_raw",
    });
  });
});
