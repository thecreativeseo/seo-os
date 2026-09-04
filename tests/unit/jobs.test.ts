import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAILY_CRON,
  dailySyncPayload,
  resolveDailyCron,
  websiteSyncPayload,
} from "@/server/jobs/definitions";
import { JOB_NAMES } from "@/server/jobs/queue";

describe("the daily cron setting", () => {
  it("defaults to 03:00 UTC when nothing is set", () => {
    expect(resolveDailyCron(undefined)).toBe(DEFAULT_DAILY_CRON);
    expect(resolveDailyCron("")).toBe(DEFAULT_DAILY_CRON);
    expect(resolveDailyCron("   ")).toBe(DEFAULT_DAILY_CRON);
    expect(DEFAULT_DAILY_CRON).toBe("0 3 * * *");
  });

  it("accepts a five-field expression and trims it", () => {
    expect(resolveDailyCron(" 30 4 * * 1-5 ")).toBe("30 4 * * 1-5");
  });

  it("refuses anything that is not five fields, so a typo fails at start-up", () => {
    expect(() => resolveDailyCron("every day")).toThrow(/five-field/);
    expect(() => resolveDailyCron("0 3 * *")).toThrow(/five-field/);
    expect(() => resolveDailyCron("0 3 * * * *")).toThrow(/five-field/);
  });
});

describe("job payloads", () => {
  it("only accepts a website id that is a uuid", () => {
    expect(websiteSyncPayload.safeParse({ websiteId: "not-a-uuid" }).success).toBe(false);
    expect(websiteSyncPayload.safeParse({}).success).toBe(false);

    const parsed = websiteSyncPayload.safeParse({
      websiteId: "0b1f3f4e-8f7a-4f0e-9d3b-2c2f9a1e5b77",
      requestedAt: "2026-09-04T03:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("lets a cron-fired daily job carry no data at all", () => {
    expect(dailySyncPayload.safeParse(null).success).toBe(true);
    expect(dailySyncPayload.safeParse(undefined).success).toBe(true);
    expect(dailySyncPayload.safeParse({}).success).toBe(true);
    expect(dailySyncPayload.safeParse({ reason: "SYNC_ON_START" }).success).toBe(true);
  });

  it("names queues the way the spec does", () => {
    expect(JOB_NAMES.SYNC_DAILY).toBe("sync.daily");
    expect(JOB_NAMES.WEBSITE_SYNC).toBe("website.sync");
  });
});
