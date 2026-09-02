import { describe, expect, it } from "vitest";

import {
  DEMO_PAGES,
  DEMO_STORIES,
  STRIKING_DISTANCE_QUERIES,
  buildDemoFixture,
  buildDemoQueries,
  demoEndDate,
} from "@/lib/demo/fixture";

/**
 * The demo has to be reproducible and internally consistent: an investor demo that
 * shows different numbers on Tuesday and Friday is worse than no demo, and one
 * whose figures do not add up would undermine the exact claim the product makes.
 */

const END = demoEndDate(new Date("2026-09-02T00:00:00Z"));

describe("determinism", () => {
  it("produces identical data for the same end date", () => {
    const a = buildDemoFixture(END);
    const b = buildDemoFixture(END);

    expect(a.gsc.length).toBe(b.gsc.length);
    expect(a.gsc[0]).toEqual(b.gsc[0]);
    expect(a.gsc.at(-1)).toEqual(b.gsc.at(-1));
    expect(a.ga4).toEqual(b.ga4);
  });

  it("builds the same query set every time", () => {
    expect(buildDemoQueries()).toEqual(buildDemoQueries());
  });
});

describe("shape", () => {
  const fixture = buildDemoFixture(END);

  it("covers 90 days ending three days ago", () => {
    const dates = new Set(fixture.gsc.map((row) => row.date));
    expect(dates.size).toBe(90);
    // Search Console lags; the demo must not imply same-day data.
    expect(fixture.currentPeriodEnd).toBe("2026-08-30");
  });

  it("has a page and query count inside the spec's range", () => {
    expect(DEMO_PAGES.length).toBeGreaterThanOrEqual(20);
    expect(DEMO_PAGES.length).toBeLessThanOrEqual(40);

    const queries = new Set(fixture.gsc.map((row) => row.query));
    expect(queries.size).toBeGreaterThanOrEqual(100);
    expect(queries.size).toBeLessThanOrEqual(300);
  });

  it("compares 28 days against the previous 28", () => {
    const days = (from: string, to: string) =>
      (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;

    expect(days(fixture.currentPeriodStart, fixture.currentPeriodEnd)).toBe(28);
    expect(days(fixture.previousPeriodStart, fixture.previousPeriodEnd)).toBe(28);
    expect(Date.parse(fixture.previousPeriodEnd)).toBeLessThan(
      Date.parse(fixture.currentPeriodStart),
    );
  });
});

describe("internal consistency", () => {
  const fixture = buildDemoFixture(END);

  it("never reports more clicks than impressions", () => {
    // A row violating this would fail the database CHECK and, worse, would make
    // CTR exceed 100% somewhere in the interface.
    expect(fixture.gsc.every((row) => row.clicks <= row.impressions)).toBe(true);
  });

  it("keeps positions in a plausible range", () => {
    expect(fixture.gsc.every((row) => row.position >= 1 && row.position <= 60)).toBe(true);
  });

  it("gives every GA4 page at least as many sessions as organic clicks", () => {
    // A landing page also receives direct and referral traffic, so analytics must
    // never appear to be a mirror of search.
    const organic = new Map<string, number>();
    for (const row of fixture.gsc) {
      const key = `${row.date}|${row.path}`;
      organic.set(key, (organic.get(key) ?? 0) + row.clicks);
    }

    for (const row of fixture.ga4) {
      const key = `${row.date}|${row.path}`;
      expect(row.sessions).toBeGreaterThanOrEqual(organic.get(key) ?? 0);
    }
  });

  it("records key events only on pages that convert", () => {
    const converting = new Set(
      DEMO_PAGES.filter(
        (page) => page.pageType === "COMMERCIAL" || page.path === "/trial" || page.path === "/",
      ).map((page) => page.path),
    );

    for (const row of fixture.ga4) {
      if (!converting.has(row.path)) {
        expect(row.keyEvents).toBe(0);
      }
    }
  });
});

/**
 * The stories exist in the DATA. These assert the numbers a person would compute
 * by hand — the signal engine in N4 has to find them without being told.
 */
describe("demo stories are present in the data", () => {
  const fixture = buildDemoFixture(END);

  function clicksFor(path: string, from: string, to: string): number {
    return fixture.gsc
      .filter((row) => row.path === path && row.date >= from && row.date <= to)
      .reduce((total, row) => total + row.clicks, 0);
  }

  function impressionsFor(path: string, from: string, to: string): number {
    return fixture.gsc
      .filter((row) => row.path === path && row.date >= from && row.date <= to)
      .reduce((total, row) => total + row.impressions, 0);
  }

  const current = [fixture.currentPeriodStart, fixture.currentPeriodEnd] as const;
  const previous = [fixture.previousPeriodStart, fixture.previousPeriodEnd] as const;

  it("contains one meaningful traffic decline", () => {
    const path = "/product/retention-analytics";
    const now = clicksFor(path, ...current);
    const before = clicksFor(path, ...previous);

    expect(now).toBeLessThan(before);
    const change = (now - before) / before;
    expect(change).toBeLessThan(-0.2);
  });

  it("contains one strong winner", () => {
    const path = "/compare/mixpanel-alternative";
    const now = clicksFor(path, ...current);
    const before = clicksFor(path, ...previous);

    expect((now - before) / before).toBeGreaterThan(0.2);
  });

  it("contains two CTR opportunities: impressions up, clicks flat", () => {
    for (const path of ["/blog/what-is-retention", "/blog/cohort-analysis-guide"]) {
      const impressionsNow = impressionsFor(path, ...current);
      const impressionsBefore = impressionsFor(path, ...previous);
      const clicksNow = clicksFor(path, ...current);
      const clicksBefore = clicksFor(path, ...previous);

      expect((impressionsNow - impressionsBefore) / impressionsBefore).toBeGreaterThan(0.3);

      const ctrNow = clicksNow / impressionsNow;
      const ctrBefore = clicksBefore / impressionsBefore;
      expect(ctrNow).toBeLessThan(ctrBefore);
    }
  });

  it("contains three striking-distance queries", () => {
    for (const query of STRIKING_DISTANCE_QUERIES) {
      const rows = fixture.gsc.filter(
        (row) =>
          row.query === query &&
          row.date >= fixture.currentPeriodStart &&
          row.date <= fixture.currentPeriodEnd,
      );

      expect(rows.length).toBeGreaterThan(0);

      const impressions = rows.reduce((total, row) => total + row.impressions, 0);
      // Impression-weighted, the same way the aggregation layer will compute it.
      const position =
        rows.reduce((total, row) => total + row.position * row.impressions, 0) / impressions;

      expect(impressions).toBeGreaterThan(100);
      expect(position).toBeGreaterThan(7);
      expect(position).toBeLessThan(21);
    }
  });

  it("contains one conversion decline with search broadly flat", () => {
    const path = "/pricing";

    const keyEvents = (from: string, to: string) =>
      fixture.ga4
        .filter((row) => row.path === path && row.date >= from && row.date <= to)
        .reduce((total, row) => total + row.keyEvents, 0);

    const now = keyEvents(...current);
    const before = keyEvents(...previous);
    expect((now - before) / before).toBeLessThan(-0.2);

    // Clicks stay roughly level, so the change reads as an analytics story rather
    // than a search one.
    const clickChange =
      (clicksFor(path, ...current) - clicksFor(path, ...previous)) /
      clicksFor(path, ...previous);
    expect(Math.abs(clickChange)).toBeLessThan(0.15);
  });

  it("declares one story per blueprint requirement", () => {
    const kinds = DEMO_STORIES.map((story) => story.kind);
    expect(kinds.filter((kind) => kind === "decline")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "winner")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "ctr_opportunity")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "conversion_decline")).toHaveLength(1);
  });
});
