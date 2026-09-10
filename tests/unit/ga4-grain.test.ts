import { describe, expect, it } from "vitest";

import {
  GA4_ADDITIVE_METRICS,
  GA4_DISTINCT_METRICS,
  Ga4WindowAccumulator,
  ga4GrainKey,
  hasUniqueGa4Grains,
} from "@/lib/sync/ga4-grain";
import type { Ga4MetricName } from "@/server/connectors/google/analytics";

/**
 * One measurement per landing page per day (P1 GA4 normalized-grain
 * reliability).
 *
 * GA4 reports a page once per spelling — with and without a query string, a
 * trailing slash, an index file — and SEO OS stores it once. What these tests
 * are about is that "once" is arrived at by the right arithmetic for each
 * metric: sessions add, unique users do not, and a number GA4 never reported
 * is never written.
 */

const ALL: Ga4MetricName[] = [
  "sessions",
  "engagedSessions",
  "totalUsers",
  "newUsers",
  "keyEvents",
  "totalRevenue",
];
const CORE: Ga4MetricName[] = ["sessions", "engagedSessions", "totalUsers", "newUsers"];

const PAGE = "https://sprout.ph/careers";
const DAY = "2026-08-30";

describe("the classification", () => {
  it("adds counts and sums of events, and never adds people", () => {
    expect([...GA4_ADDITIVE_METRICS]).toEqual([
      "sessions",
      "engagedSessions",
      "keyEvents",
      "totalRevenue",
    ]);
    expect([...GA4_DISTINCT_METRICS]).toEqual(["totalUsers", "newUsers"]);
  });
});

describe("a page GA4 reported once", () => {
  it("is stored exactly as reported, user counts included", () => {
    const window = new Ga4WindowAccumulator(ALL);
    window.add(DAY, PAGE, {
      sessions: 40,
      engagedSessions: 25,
      totalUsers: 35,
      newUsers: 20,
      keyEvents: 3,
      totalRevenue: 12.5,
    });

    const [row] = window.drain();
    expect(row).toMatchObject({
      date: DAY,
      url: PAGE,
      rawRows: 1,
      sessions: 40,
      engagedSessions: 25,
      users: 35,
      newUsers: 20,
      keyEvents: 3,
      revenue: 12.5,
    });
  });

  it("keeps a metric the property cannot report as null, and a reported zero as zero", () => {
    const window = new Ga4WindowAccumulator(CORE);
    window.add(DAY, PAGE, { sessions: 40, engagedSessions: 0, totalUsers: 35, newUsers: 20 });

    const [row] = window.drain();
    expect(row!.keyEvents).toBeNull();
    expect(row!.revenue).toBeNull();
    expect(row!.engagedSessions).toBe(0);
  });
});

describe("the production shape: spellings of one page", () => {
  it("adds sessions, engaged sessions, key events and revenue", () => {
    const window = new Ga4WindowAccumulator(ALL);
    // /careers and /careers?utm_source=x, both normalized to PAGE upstream.
    window.add(DAY, PAGE, {
      sessions: 30,
      engagedSessions: 20,
      totalUsers: 28,
      newUsers: 15,
      keyEvents: 2,
      totalRevenue: 10,
    });
    window.add(DAY, PAGE, {
      sessions: 10,
      engagedSessions: 5,
      totalUsers: 9,
      newUsers: 5,
      keyEvents: 1,
      totalRevenue: 2.5,
    });

    const rows = window.drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rawRows: 2,
      sessions: 40,
      engagedSessions: 25,
      keyEvents: 3,
      revenue: 12.5,
    });
  });

  it("leaves users and new users unknown, because people can be in both rows", () => {
    const window = new Ga4WindowAccumulator(ALL);
    window.add(DAY, PAGE, { sessions: 30, totalUsers: 28, newUsers: 15 });
    window.add(DAY, PAGE, { sessions: 10, totalUsers: 9, newUsers: 5 });

    const [row] = window.drain();
    // Not 37, not 28, not 9, not 18.5, not the first, not the last.
    expect(row!.users).toBeNull();
    expect(row!.newUsers).toBeNull();
    // The additive figure alongside it is still exact.
    expect(row!.sessions).toBe(40);
  });

  it("does not resurrect user counts once a third row arrives", () => {
    const window = new Ga4WindowAccumulator(ALL);
    window.add(DAY, PAGE, { sessions: 1, totalUsers: 1, newUsers: 1 });
    window.add(DAY, PAGE, { sessions: 1, totalUsers: 1, newUsers: 1 });
    window.add(DAY, PAGE, { sessions: 1, totalUsers: 1, newUsers: 1 });

    const [row] = window.drain();
    expect(row).toMatchObject({ rawRows: 3, sessions: 3, users: null, newUsers: null });
  });
});

describe("what stays apart", () => {
  it("keeps different pages, and the same page on different days, separate", () => {
    const window = new Ga4WindowAccumulator(CORE);
    window.add(DAY, PAGE, { sessions: 1, totalUsers: 1 });
    window.add(DAY, "https://sprout.ph/careers?p=2", { sessions: 2, totalUsers: 2 });
    window.add("2026-08-31", PAGE, { sessions: 3, totalUsers: 3 });

    const rows = window.drain();
    expect(rows).toHaveLength(3);
    // Nothing collapsed, so every row keeps GA4's own user count.
    expect(rows.map((row) => row.users)).toEqual([1, 2, 3]);
    expect(rows.every((row) => row.rawRows === 1)).toBe(true);
  });
});

describe("independence from provider order", () => {
  const rows: [string, string, Record<string, number>][] = [
    [
      DAY,
      PAGE,
      {
        sessions: 30,
        engagedSessions: 20,
        totalUsers: 28,
        newUsers: 15,
        keyEvents: 2,
        totalRevenue: 0.1,
      },
    ],
    [
      DAY,
      "https://sprout.ph/pricing",
      {
        sessions: 7,
        engagedSessions: 3,
        totalUsers: 7,
        newUsers: 1,
        keyEvents: 0,
        totalRevenue: 99.99,
      },
    ],
    [
      DAY,
      PAGE,
      {
        sessions: 10,
        engagedSessions: 5,
        totalUsers: 9,
        newUsers: 5,
        keyEvents: 1,
        totalRevenue: 0.2,
      },
    ],
    [
      DAY,
      PAGE,
      {
        sessions: 1,
        engagedSessions: 1,
        totalUsers: 1,
        newUsers: 0,
        keyEvents: 0,
        totalRevenue: 0.3,
      },
    ],
  ];

  const drained = (order: typeof rows) => {
    const window = new Ga4WindowAccumulator(ALL);
    for (const [date, url, metrics] of order) window.add(date, url, metrics);
    return window
      .drain()
      .sort((a, b) =>
        ga4GrainKey({ date: a.date, pageId: a.url }).localeCompare(
          ga4GrainKey({ date: b.date, pageId: b.url }),
        ),
      );
  };

  it("stores bit-identical measurements however the rows arrived", () => {
    const forward = drained(rows);
    const reversed = drained([...rows].reverse());
    const shuffled = drained([rows[2]!, rows[0]!, rows[3]!, rows[1]!]);

    // toEqual on numbers is exact: revenue is summed in a canonical order so
    // 0.1 + 0.2 + 0.3 lands on the same bits every time.
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
    expect(forward.find((row) => row.url === PAGE)!.revenue).toBe(
      [0.1, 0.2, 0.3].sort().reduce((sum, part) => sum + part, 0),
    );
  });
});

describe("what the accumulator holds", () => {
  it("grows with distinct pages and days, not with rows", () => {
    const window = new Ga4WindowAccumulator(CORE);
    for (let index = 0; index < 5_000; index += 1) {
      // Five thousand rows for twenty pages.
      window.add(DAY, `https://sprout.ph/p-${index % 20}`, { sessions: 1, totalUsers: 1 });
    }

    expect(window.size).toBe(20);
    const rows = window.drain();
    expect(rows).toHaveLength(20);
    expect(rows.reduce((sum, row) => sum + (row.sessions ?? 0), 0)).toBe(5_000);
    expect(rows.every((row) => row.rawRows === 250 && row.users === null)).toBe(true);
    // Drained means empty.
    expect(window.size).toBe(0);
  });
});

describe("the key", () => {
  it("is the unique index of ga4_landing_page_metric_daily", () => {
    expect(ga4GrainKey({ date: DAY, pageId: "P" })).toBe(`${DAY}|P`);
  });

  it("detects a batch that names a grain twice", () => {
    expect(
      hasUniqueGa4Grains([
        { date: DAY, pageId: "P" },
        { date: DAY, pageId: "Q" },
      ]),
    ).toBe(true);
    expect(
      hasUniqueGa4Grains([
        { date: DAY, pageId: "P" },
        { date: DAY, pageId: "P" },
      ]),
    ).toBe(false);
  });
});
