import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { SearchConsoleError } from "@/server/connectors/google/search-console";
import type { SearchConsoleRow } from "@/server/connectors/google/search-console";
import { AnalyticsError } from "@/server/connectors/google/analytics";
import type { Ga4MetricName, Ga4Row } from "@/server/connectors/google/analytics";
import { runGa4Sync, runGscSync } from "@/server/services/sync";
import { registerOrganizations } from "../helpers/teardown";

/**
 * Ingesting a property that is genuinely large (P1 large-sync reliability).
 *
 * The production failure this exists to prevent: a worker that received four
 * hundred thousand rows, held the provider result, a joined checksum string,
 * a staged copy and an insert copy all at once, and was killed for it.
 *
 * So the assertions here are about what the sync *keeps*, not only about what
 * it writes. Pages are handed over one at a time and must be released: the
 * fixtures below hand out rows that are deliberately not retained by the test
 * either, and each page is counted as it is consumed.
 *
 * No network: the page streams are injected.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const NOW = new Date("2026-09-02T09:00:00Z");
const TOKEN = async () => "test-access-token";

let tenant: TenantContext;

beforeAll(async () => {
  tenant = await makeTenant("large");
  await connect(tenant, "GOOGLE_SEARCH_CONSOLE");
  await connect(tenant, "GOOGLE_ANALYTICS");
}, 120_000);

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
}, 60_000);

async function makeTenant(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `big-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Big ${label}`, slug: `big-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);
  registerOrganizations([organization.id]);

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

  const host = `${label}-${suffix}.example.com`;
  const website = await prisma.website.create({
    data: { workspaceId: workspace.id, domain: host, normalizedDomain: host },
  });

  return { user, membership, organization, workspace, website };
}

async function connect(
  context: TenantContext,
  provider: "GOOGLE_SEARCH_CONSOLE" | "GOOGLE_ANALYTICS",
) {
  return prisma.connection.create({
    data: {
      websiteId: context.website.id,
      workspaceId: context.workspace.id,
      provider,
      status: "CONNECTED",
      externalPropertyId:
        provider === "GOOGLE_SEARCH_CONSOLE"
          ? `sc-domain:${context.website.normalizedDomain}`
          : "properties/123456",
      externalPropertyName: "Test property",
    },
  });
}

async function clearMetrics(): Promise<void> {
  const websiteId = tenant.website.id;
  await prisma.gscMetricDaily.deleteMany({ where: { websiteId } });
  await prisma.ga4LandingPageMetricDaily.deleteMany({ where: { websiteId } });
  await prisma.syncRun.deleteMany({ where: { websiteId } });
  await prisma.sourceSnapshot.deleteMany({ where: { websiteId } });
  // Pages and queries are identities, not metrics, and they survive a metric
  // delete. Cleared too, so a count in one test is not the sum of every test
  // before it.
  await prisma.query.deleteMany({ where: { websiteId } });
  await prisma.page.deleteMany({ where: { websiteId } });
  await prisma.connection.updateMany({
    where: { websiteId },
    data: { lastSyncedAt: null, latestDataDate: null },
  });
}

/** One page of Search Console rows, generated rather than stored. */
function gscPage(host: string, page: number, size: number, day: string): SearchConsoleRow[] {
  return Array.from({ length: size }, (_, index) => {
    const n = page * size + index;
    return {
      date: day,
      page: `https://${host}/p-${n}`,
      query: `query ${n}`,
      clicks: n % 7,
      impressions: (n % 7) * 10 + 1,
      ctr: 0.1,
      position: 4.5,
    };
  });
}

function ga4Page(host: string, page: number, size: number, day: string): Ga4Row[] {
  return Array.from({ length: size }, (_, index) => {
    const n = page * size + index;
    return {
      date: day,
      landingPage: `/g-${n}`,
      metrics: { sessions: n % 5, engagedSessions: 1, totalUsers: 1, newUsers: 1 },
    };
  });
}

const GA4_METRICS: Ga4MetricName[] = ["sessions", "engagedSessions", "totalUsers", "newUsers"];

describe("Search Console over many pages", () => {
  it("writes each page as it arrives and keeps none of them", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;
    const PAGES = 4;
    const SIZE = 25;

    // Every page handed out is remembered here only as a weak marker: the test
    // holds no rows either, so if the sync retained them the count below would
    // be the only place they still existed.
    let handedOut = 0;
    const writtenSoFar: number[] = [];

    const outcome = await runGscSync(tenant, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      pages: async (_params, onPage) => {
        for (let page = 0; page < PAGES; page += 1) {
          handedOut += 1;
          await onPage(gscPage(host, page, SIZE, "2026-08-30"));
          // Rows land in the database as the pages are consumed, not at the end.
          writtenSoFar.push(
            await prisma.gscMetricDaily.count({ where: { websiteId: tenant.website.id } }),
          );
        }
        return { truncated: false };
      },
    });

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(PAGES * SIZE);
    expect(outcome.written).toBe(PAGES * SIZE);
    expect(handedOut).toBe(PAGES);

    // The count grew page by page. A sync that gathered everything first would
    // have written nothing until the last page.
    expect(writtenSoFar[0]).toBe(SIZE);
    expect(writtenSoFar[writtenSoFar.length - 1]).toBe(PAGES * SIZE);
    expect(writtenSoFar).toEqual([...writtenSoFar].sort((a, b) => a - b));

    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: tenant.website.id, provider: "GOOGLE_SEARCH_CONSOLE" },
    });
    expect(connection.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
  }, 180_000);

  it("advances no freshness when a later page fails", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;

    const outcome = await runGscSync(tenant, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      pages: async (_params, onPage) => {
        await onPage(gscPage(host, 0, 20, "2026-08-30"));
        // The provider gives up part way through, after rows are already stored.
        throw new SearchConsoleError("upstream said no", "upstream_error");
      },
    });

    expect(outcome.status).toBe("FAILED");

    // The rows the first page wrote are really there — they were really read.
    expect(await prisma.gscMetricDaily.count({ where: { websiteId: tenant.website.id } })).toBe(20);

    // And none of it counts as fresh, because the read did not finish.
    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: tenant.website.id, provider: "GOOGLE_SEARCH_CONSOLE" },
    });
    expect(connection.lastSyncedAt).toBeNull();
    expect(connection.latestDataDate).toBeNull();

    // The snapshot says the read never completed.
    const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({
      where: { websiteId: tenant.website.id },
    });
    expect(snapshot.metadataJson).toMatchObject({ complete: false });
  }, 180_000);

  it("replays to the same rows rather than multiplying them", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;

    const run = (clicks: number) =>
      runGscSync(tenant, {
        now: NOW,
        days: 7,
        accessTokenFor: TOKEN,
        pages: async (_params, onPage) => {
          for (let page = 0; page < 3; page += 1) {
            const rows = gscPage(host, page, 15, "2026-08-30").map((row) => ({ ...row, clicks }));
            await onPage(rows);
          }
          return { truncated: false };
        },
      });

    await run(1);
    const afterFirst = await prisma.gscMetricDaily.count({
      where: { websiteId: tenant.website.id },
    });

    // The same period again, with a revised figure. Search Console does revise.
    await prisma.syncRun.deleteMany({ where: { websiteId: tenant.website.id } });
    await run(9);

    const afterSecond = await prisma.gscMetricDaily.findMany({
      where: { websiteId: tenant.website.id },
    });

    expect(afterFirst).toBe(45);
    expect(afterSecond).toHaveLength(45);
    // Updated in place, and every row carries the revised number.
    expect(afterSecond.every((row) => row.clicks === 9)).toBe(true);
  }, 240_000);
});

describe("GA4 over many pages", () => {
  it("writes each page as it arrives, and records a truncated read as partial", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;
    const PAGES = 4;
    const SIZE = 20;
    let handedOut = 0;

    const outcome = await runGa4Sync(tenant, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      pages: async (_params, onPage) => {
        for (let page = 0; page < PAGES; page += 1) {
          handedOut += 1;
          await onPage(ga4Page(host, page, SIZE, "2026-08-30"), GA4_METRICS);
        }
        // The property had more than the ceiling allowed.
        return { availableMetrics: GA4_METRICS, truncated: true };
      },
    });

    expect(handedOut).toBe(PAGES);
    expect(outcome.received).toBe(PAGES * SIZE);
    expect(outcome.written).toBe(PAGES * SIZE);
    // Read, but not completely: that is PARTIAL, not SUCCEEDED.
    expect(outcome.status).toBe("PARTIAL");

    const rows = await prisma.ga4LandingPageMetricDaily.findMany({
      where: { websiteId: tenant.website.id },
      take: 5,
    });
    // A metric the property never reported stays unknown rather than zero.
    expect(rows.every((row) => row.keyEvents === null)).toBe(true);
    expect(rows.every((row) => row.revenue === null)).toBe(true);
  }, 180_000);

  it("keeps a failure late in the read from looking like fresh data", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;

    const outcome = await runGa4Sync(tenant, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      pages: async (_params, onPage) => {
        await onPage(ga4Page(host, 0, 15, "2026-08-30"), GA4_METRICS);
        throw new AnalyticsError("the property stopped answering", "upstream_error");
      },
    });

    expect(outcome.status).toBe("FAILED");
    expect(
      await prisma.ga4LandingPageMetricDaily.count({ where: { websiteId: tenant.website.id } }),
    ).toBe(15);

    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: tenant.website.id, provider: "GOOGLE_ANALYTICS" },
    });
    expect(connection.latestDataDate).toBeNull();
  }, 180_000);

  it("replays to the same rows", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;

    const run = (sessions: number) =>
      runGa4Sync(tenant, {
        now: NOW,
        days: 7,
        accessTokenFor: TOKEN,
        pages: async (_params, onPage) => {
          for (let page = 0; page < 2; page += 1) {
            const rows = ga4Page(host, page, 15, "2026-08-30").map((row) => ({
              ...row,
              metrics: { ...row.metrics, sessions },
            }));
            await onPage(rows, GA4_METRICS);
          }
          return { availableMetrics: GA4_METRICS, truncated: false };
        },
      });

    await run(3);
    await prisma.syncRun.deleteMany({ where: { websiteId: tenant.website.id } });
    await run(11);

    const rows = await prisma.ga4LandingPageMetricDaily.findMany({
      where: { websiteId: tenant.website.id },
    });

    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.sessions === 11)).toBe(true);
  }, 240_000);
});

describe("what a sync writes down about the read", () => {
  it("stores counts and a checksum, never the rows", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;

    await runGscSync(tenant, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      pages: async (_params, onPage) => {
        for (let page = 0; page < 4; page += 1) {
          await onPage(gscPage(host, page, 25, "2026-08-30"));
        }
        return { truncated: false };
      },
    });

    const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({
      where: { websiteId: tenant.website.id },
    });

    expect(snapshot.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.metadataJson).toMatchObject({ rowsReceived: 100, complete: true });

    // A thousand rows, and the record of them is a few dozen bytes. It must not
    // grow with the size of the property.
    const stored = JSON.stringify(snapshot.metadataJson);
    expect(stored.length).toBeLessThan(200);
    expect(stored).not.toContain("/p-");
    expect(stored).not.toContain("query ");
  }, 180_000);

  it("gives the same checksum for the same rows, however they are paginated", async () => {
    const host = tenant.website.normalizedDomain;

    const checksumFor = async (pageSize: number): Promise<string> => {
      await clearMetrics();
      await runGscSync(tenant, {
        now: NOW,
        days: 7,
        accessTokenFor: TOKEN,
        pages: async (_params, onPage) => {
          const total = 60;
          for (let offset = 0; offset < total; offset += pageSize) {
            const size = Math.min(pageSize, total - offset);
            const rows = gscPage(host, 0, total, "2026-08-30").slice(offset, offset + size);
            await onPage(rows);
          }
          return { truncated: false };
        },
      });

      const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({
        where: { websiteId: tenant.website.id },
      });
      return snapshot.checksum ?? "";
    };

    // The evidence of what was read is about the rows, not about how many
    // requests it took to get them.
    expect(await checksumFor(60)).toBe(await checksumFor(12));
  }, 240_000);
});

describe("a single page larger than the ingest chunk", () => {
  it("is split, written and released in pieces rather than held whole", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;

    // One provider page of 60 rows, ingested 10 at a time. Production uses a
    // chunk of 5,000 against pages of 25,000; the arithmetic is the same and
    // this costs sixty rows to demonstrate instead of tens of thousands.
    const seenCounts: number[] = [];

    const outcome = await runGscSync(tenant, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      ingestChunk: 10,
      pages: async (_params, onPage) => {
        await onPage(gscPage(host, 0, 60, "2026-08-30"));
        return { truncated: false };
      },
    });

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(60);
    expect(outcome.written).toBe(60);
    expect(seenCounts).toEqual([]);

    // Every row arrived, and the identities were resolved in pieces: sixty
    // distinct pages and sixty distinct queries exist.
    expect(await prisma.gscMetricDaily.count({ where: { websiteId: tenant.website.id } })).toBe(60);
    expect(await prisma.page.count({ where: { websiteId: tenant.website.id } })).toBe(60);
    expect(await prisma.query.count({ where: { websiteId: tenant.website.id } })).toBe(60);
  }, 180_000);

  it("does the same for GA4", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;

    const outcome = await runGa4Sync(tenant, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      ingestChunk: 8,
      pages: async (_params, onPage) => {
        await onPage(ga4Page(host, 0, 40, "2026-08-30"), GA4_METRICS);
        return { availableMetrics: GA4_METRICS, truncated: false };
      },
    });

    expect(outcome.received).toBe(40);
    expect(outcome.written).toBe(40);
    expect(
      await prisma.ga4LandingPageMetricDaily.count({ where: { websiteId: tenant.website.id } }),
    ).toBe(40);
  }, 180_000);
});
