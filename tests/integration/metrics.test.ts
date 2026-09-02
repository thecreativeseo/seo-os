import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { aggregateGsc } from "@/lib/metrics/aggregate";
import { resolveWindows } from "@/lib/metrics/compare";
import {
  getLatestDataDate,
  getPageMetrics,
  getQueryMetrics,
  getWebsiteSummary,
} from "@/server/services/metrics";
import type { TenantContext } from "@/server/auth/guards";

/**
 * The SQL aggregation and the pure aggregation state the same rules in two
 * languages. If they drift, one of them is silently wrong and the numbers on
 * screen stop matching the numbers a test asserts — so the central test here reads
 * the raw rows, aggregates them in TypeScript, and requires the database to agree.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `met-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Metrics ${label}`, slug: `met-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: "OWNER",
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: `${label}-${suffix}.example.com`,
      normalizedDomain: `${label}-${suffix}.example.com`,
    },
  });

  return { user, membership, organization, workspace, website };
}

/** Builds a website with known metrics so expected values can be computed by hand. */
async function seedMetrics(
  context: TenantContext,
  rows: { date: string; path: string; query: string; clicks: number; impressions: number; position: number }[],
) {
  const connection = await prisma.connection.create({
    data: {
      websiteId: context.website.id,
      workspaceId: context.workspace.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      status: "CONNECTED",
    },
  });

  const pageIds = new Map<string, string>();
  const queryIds = new Map<string, string>();

  for (const row of rows) {
    if (!pageIds.has(row.path)) {
      const page = await prisma.page.create({
        data: {
          websiteId: context.website.id,
          url: `https://${context.website.normalizedDomain}${row.path}`,
          normalizedUrl: `https://${context.website.normalizedDomain}${row.path}`,
          path: row.path,
          hostname: context.website.normalizedDomain,
          protocol: "https",
          sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
        },
      });
      pageIds.set(row.path, page.id);
    }

    if (!queryIds.has(row.query)) {
      const query = await prisma.query.create({
        data: {
          websiteId: context.website.id,
          query: row.query,
          normalizedQuery: row.query,
        },
      });
      queryIds.set(row.query, query.id);
    }
  }

  await prisma.gscMetricDaily.createMany({
    data: rows.map((row) => ({
      websiteId: context.website.id,
      pageId: pageIds.get(row.path)!,
      queryId: queryIds.get(row.query)!,
      date: new Date(row.date),
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
      position: row.position,
      sourceConnectionId: connection.id,
    })),
  });

  return { connectionId: connection.id, pageIds, queryIds };
}

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("SQL and pure aggregation agree", () => {
  it("computes identical totals for uneven volumes", async () => {
    const context = await makeContext("agree");

    // Deliberately lopsided: a tiny row with 100% CTR at position 1, and a huge row
    // with a poor CTR at position 30. Averaging either metric would be obvious.
    await seedMetrics(context, [
      { date: "2026-08-10", path: "/a", query: "one", clicks: 3, impressions: 3, position: 1 },
      { date: "2026-08-11", path: "/b", query: "two", clicks: 100, impressions: 30_000, position: 30 },
    ]);

    const rows = await prisma.gscMetricDaily.findMany({
      where: { websiteId: context.website.id },
      select: { clicks: true, impressions: true, position: true },
    });

    const expected = aggregateGsc(
      rows.map((row) => ({
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position === null ? null : Number(row.position),
      })),
    );

    const summary = await getWebsiteSummary(context, "90d");

    expect(summary.gsc.current.clicks).toBe(expected.clicks);
    expect(summary.gsc.current.impressions).toBe(expected.impressions);
    expect(summary.gsc.current.ctr).toBeCloseTo(expected.ctr!, 10);
    expect(summary.gsc.current.position).toBeCloseTo(expected.position!, 6);
  });

  it("does not average row CTR", async () => {
    const context = await makeContext("ctr");
    await seedMetrics(context, [
      { date: "2026-08-10", path: "/a", query: "one", clicks: 3, impressions: 3, position: 1 },
      { date: "2026-08-11", path: "/b", query: "two", clicks: 100, impressions: 30_000, position: 30 },
    ]);

    const summary = await getWebsiteSummary(context, "90d");

    // Correct: 103 / 30003 ≈ 0.34%. Averaging row CTR would give ~50%.
    expect(summary.gsc.current.ctr).toBeCloseTo(103 / 30_003, 8);
    expect(summary.gsc.current.ctr!).toBeLessThan(0.01);
  });

  it("weights position by impressions", async () => {
    const context = await makeContext("pos");
    await seedMetrics(context, [
      { date: "2026-08-10", path: "/a", query: "one", clicks: 0, impressions: 10_000, position: 3 },
      { date: "2026-08-11", path: "/b", query: "two", clicks: 0, impressions: 10, position: 90 },
    ]);

    const summary = await getWebsiteSummary(context, "90d");

    // (3×10000 + 90×10) / 10010 ≈ 3.09, not the naive mean of 46.5.
    expect(summary.gsc.current.position).toBeCloseTo(30_900 / 10_010, 4);
  });
});

describe("windows", () => {
  it("reports the latest data date rather than today", async () => {
    const context = await makeContext("latest");
    await seedMetrics(context, [
      { date: "2026-08-30", path: "/a", query: "one", clicks: 5, impressions: 100, position: 4 },
    ]);

    expect(await getLatestDataDate(context)).toBe("2026-08-30");
  });

  it("returns null before any data exists", async () => {
    const context = await makeContext("nodata");
    expect(await getLatestDataDate(context)).toBeNull();
  });

  it("splits current and previous without overlapping", async () => {
    const context = await makeContext("split");

    // 10 clicks in the current window, 40 in the previous.
    await seedMetrics(context, [
      { date: "2026-08-30", path: "/a", query: "one", clicks: 10, impressions: 100, position: 4 },
      { date: "2026-07-20", path: "/a", query: "one", clicks: 40, impressions: 400, position: 4 },
    ]);

    const summary = await getWebsiteSummary(context, "28d");

    expect(summary.gsc.current.clicks).toBe(10);
    expect(summary.gsc.previous.clicks).toBe(40);
    expect(summary.changes.clicks.percentage).toBeCloseTo(-0.75, 6);
    expect(summary.changes.clicks.state).toBe("down");
  });
});

describe("GA4 totals", () => {
  it("keeps an unmeasured metric null rather than zero", async () => {
    const context = await makeContext("ga4null");

    const connection = await prisma.connection.create({
      data: {
        websiteId: context.website.id,
        workspaceId: context.workspace.id,
        provider: "GOOGLE_ANALYTICS",
        status: "CONNECTED",
      },
    });
    const page = await prisma.page.create({
      data: {
        websiteId: context.website.id,
        url: `https://${context.website.normalizedDomain}/a`,
        normalizedUrl: `https://${context.website.normalizedDomain}/a`,
        path: "/a",
        hostname: context.website.normalizedDomain,
        protocol: "https",
        sourceFirstSeen: "GOOGLE_ANALYTICS",
      },
    });

    await prisma.ga4LandingPageMetricDaily.create({
      data: {
        websiteId: context.website.id,
        pageId: page.id,
        date: new Date("2026-08-30"),
        sessions: 120,
        engagedSessions: 60,
        keyEvents: 0,
        // The property does not measure these.
        conversions: null,
        revenue: null,
        sourceConnectionId: connection.id,
      },
    });

    const summary = await getWebsiteSummary(context, "90d");

    expect(summary.ga4.current.sessions).toBe(120);
    // A measured zero survives as zero.
    expect(summary.ga4.current.keyEvents).toBe(0);
    // An unmeasured metric stays null, so nothing can claim "no revenue".
    expect(summary.ga4.current.conversions).toBeNull();
    expect(summary.ga4.current.revenue).toBeNull();
    // The previous window has no GA4 rows at all, so its totals are null — never
    // measured, not measured as zero. Comparing against it is unknown rather than
    // growth from zero, which is what stops a newly connected property from
    // reporting every metric as infinite growth on day one.
    expect(summary.ga4.previous.sessions).toBeNull();
    expect(summary.changes.sessions.state).toBe("unknown");
    expect(summary.changes.sessions.percentage).toBeNull();
    expect(summary.changes.keyEvents.state).toBe("unknown");
  });

  it("compares against a real zero once the previous window has data", async () => {
    const context = await makeContext("ga4zero");

    const connection = await prisma.connection.create({
      data: {
        websiteId: context.website.id,
        workspaceId: context.workspace.id,
        provider: "GOOGLE_ANALYTICS",
        status: "CONNECTED",
      },
    });
    const page = await prisma.page.create({
      data: {
        websiteId: context.website.id,
        url: `https://${context.website.normalizedDomain}/a`,
        normalizedUrl: `https://${context.website.normalizedDomain}/a`,
        path: "/a",
        hostname: context.website.normalizedDomain,
        protocol: "https",
        sourceFirstSeen: "GOOGLE_ANALYTICS",
      },
    });

    await prisma.ga4LandingPageMetricDaily.createMany({
      data: [
        {
          websiteId: context.website.id,
          pageId: page.id,
          date: new Date("2026-07-20"),
          sessions: 50,
          keyEvents: 0,
          sourceConnectionId: connection.id,
        },
        {
          websiteId: context.website.id,
          pageId: page.id,
          date: new Date("2026-08-30"),
          sessions: 90,
          keyEvents: 7,
          sourceConnectionId: connection.id,
        },
      ],
    });

    const summary = await getWebsiteSummary(context, "28d");

    // Previous key events were measured as zero, so this is genuinely New.
    expect(summary.ga4.previous.keyEvents).toBe(0);
    expect(summary.changes.keyEvents.state).toBe("new");
    expect(summary.changes.keyEvents.percentage).toBeNull();
    expect(summary.changes.sessions.percentage).toBeCloseTo(0.8, 6);
  });
});

describe("explorers", () => {
  it("includes a page that has traffic in only one window", async () => {
    const context = await makeContext("explorer");
    await seedMetrics(context, [
      // Present only in the previous window — a page that disappeared.
      { date: "2026-07-20", path: "/gone", query: "one", clicks: 30, impressions: 300, position: 5 },
      // Present only in the current window — a page that arrived.
      { date: "2026-08-30", path: "/new", query: "two", clicks: 20, impressions: 200, position: 6 },
    ]);

    const windows = resolveWindows("2026-08-30", "28d");
    const pages = await getPageMetrics(context, windows);
    const paths = pages.map((page) => page.path);

    // The most interesting pages are exactly the ones an inner join would drop.
    expect(paths).toContain("/gone");
    expect(paths).toContain("/new");

    const gone = pages.find((page) => page.path === "/gone")!;
    expect(gone.clicks).toBe(0);
    expect(gone.previousClicks).toBe(30);
  });

  it("returns queries with their top page", async () => {
    const context = await makeContext("queries");
    await seedMetrics(context, [
      { date: "2026-08-30", path: "/a", query: "shared", clicks: 5, impressions: 100, position: 4 },
      { date: "2026-08-30", path: "/b", query: "shared", clicks: 40, impressions: 200, position: 3 },
    ]);

    const windows = resolveWindows("2026-08-30", "28d");
    const queries = await getQueryMetrics(context, windows);
    const shared = queries.find((row) => row.query === "shared")!;

    expect(shared.clicks).toBe(45);
    expect(shared.impressions).toBe(300);
    expect(shared.ctr).toBeCloseTo(45 / 300, 10);
    // The page that earned the most clicks for this query.
    expect(shared.topPagePath).toBe("/b");
  });
});

describe("tenant isolation", () => {
  it("does not aggregate another website's metrics", async () => {
    const a = await makeContext("iso-a");
    const b = await makeContext("iso-b");

    await seedMetrics(b, [
      { date: "2026-08-30", path: "/secret", query: "b only", clicks: 999, impressions: 9999, position: 1 },
    ]);

    const summary = await getWebsiteSummary(a, "90d");

    expect(summary.gsc.current.clicks).toBe(0);
    expect(summary.gsc.current.ctr).toBeNull();
    expect(await getPageMetrics(a, resolveWindows("2026-08-30", "28d"))).toHaveLength(0);
    expect(await getQueryMetrics(a, resolveWindows("2026-08-30", "28d"))).toHaveLength(0);
  });
});
