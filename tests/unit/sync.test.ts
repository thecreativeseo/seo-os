import { describe, expect, it } from "vitest";

import {
  INITIAL_WINDOW_DAYS,
  idempotencyKeyFor,
  landingPageToUrl,
  resolveSyncWindow,
} from "@/server/services/sync";
import { parseGa4Date } from "@/server/connectors/google/analytics";

/**
 * The pure parts of sync: which period gets read, what makes two requests the same
 * request, and how an outside identifier becomes one of ours.
 */

const NOW = new Date("2026-09-02T09:00:00Z");

describe("sync window", () => {
  it("ends three days back, not today", () => {
    // Search Console revises the last two to three days upward. Reading them would
    // show every site declining, then quietly correct itself.
    const window = resolveSyncWindow({ latestDataDate: null }, { now: NOW });
    expect(window.endDate).toBe("2026-08-30");
  });

  it("reaches back 90 days on a first sync", () => {
    const window = resolveSyncWindow({ latestDataDate: null }, { now: NOW });

    expect(window.startDate).toBe("2026-06-02");
    const days =
      (Date.parse(window.endDate) - Date.parse(window.startDate)) / 86_400_000 + 1;
    expect(days).toBe(INITIAL_WINDOW_DAYS);
  });

  it("re-reads a short overlap on an incremental sync", () => {
    // Not resuming exactly where it left off: the last few stored days are still
    // provisional, and re-reading them is how they become final.
    const window = resolveSyncWindow(
      { latestDataDate: new Date("2026-08-20T00:00:00Z") },
      { now: NOW },
    );

    expect(window.startDate).toBe("2026-08-17");
    expect(window.endDate).toBe("2026-08-30");
  });

  it("does not reach back further than the initial window", () => {
    // A connection dormant for a year must not request a year on its next run.
    const window = resolveSyncWindow(
      { latestDataDate: new Date("2025-01-01T00:00:00Z") },
      { now: NOW },
    );

    expect(window.startDate).toBe("2026-06-02");
  });

  it("honours an explicit day count", () => {
    const window = resolveSyncWindow({ latestDataDate: null }, { now: NOW, days: 7 });

    expect(window.startDate).toBe("2026-08-24");
    expect(window.endDate).toBe("2026-08-30");
  });
});

describe("idempotency key", () => {
  it("is stable for the same period and type", () => {
    const window = { startDate: "2026-06-02", endDate: "2026-08-30" };

    expect(idempotencyKeyFor("GSC_METRICS", window)).toBe(
      idempotencyKeyFor("GSC_METRICS", window),
    );
  });

  it("separates providers and periods", () => {
    const window = { startDate: "2026-06-02", endDate: "2026-08-30" };
    const later = { startDate: "2026-06-03", endDate: "2026-08-31" };

    expect(idempotencyKeyFor("GSC_METRICS", window)).not.toBe(
      idempotencyKeyFor("GA4_METRICS", window),
    );
    expect(idempotencyKeyFor("GSC_METRICS", window)).not.toBe(
      idempotencyKeyFor("GSC_METRICS", later),
    );
  });
});

describe("GA4 landing page mapping", () => {
  const host = "example.com";

  it("builds a URL from a path", () => {
    expect(landingPageToUrl("/pricing", host)).toBe("https://example.com/pricing");
  });

  it("passes an absolute URL through", () => {
    expect(landingPageToUrl("https://example.com/blog", host)).toBe(
      "https://example.com/blog",
    );
  });

  it("refuses GA4's placeholders", () => {
    // "(not set)" and "(other)" are GA4 saying it could not attribute the session.
    // Storing them would attach real sessions to a page that does not exist.
    expect(landingPageToUrl("(not set)", host)).toBeNull();
    expect(landingPageToUrl("(other)", host)).toBeNull();
    expect(landingPageToUrl("", host)).toBeNull();
    expect(landingPageToUrl("pricing", host)).toBeNull();
  });
});

describe("GA4 date parsing", () => {
  it("converts YYYYMMDD", () => {
    expect(parseGa4Date("20260830")).toBe("2026-08-30");
  });

  it("returns null for anything else", () => {
    expect(parseGa4Date("2026-08-30")).toBeNull();
    expect(parseGa4Date("")).toBeNull();
  });
});
