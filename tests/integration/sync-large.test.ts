import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { SearchConsoleError } from "@/server/connectors/google/search-console";
import type { SearchConsoleRow } from "@/server/connectors/google/search-console";
import { AnalyticsError } from "@/server/connectors/google/analytics";
import type { Ga4MetricName, Ga4Row } from "@/server/connectors/google/analytics";
import { runGa4Sync, runGscSync } from "@/server/services/sync";
import { shiftDate } from "@/lib/sync/windows";
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

/**
 * The dates a request covers, so a fixture can answer the question it was
 * asked rather than the same answer to every question.
 *
 * The tests below that are about windowing depend on this: a window is only
 * meaningful if the fixture returns that window's days.
 */
function daysIn(params: { startDate: string; endDate: string }): string[] {
  const days: string[] = [];
  for (let day = params.startDate; day <= params.endDate; day = shiftDate(day, 1)) days.push(day);
  return days;
}

/** The seven days the fixtures cover, given NOW and the three-day lag. */
const PERIOD = [
  "2026-08-24",
  "2026-08-25",
  "2026-08-26",
  "2026-08-27",
  "2026-08-28",
  "2026-08-29",
  "2026-08-30",
];

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
  it("writes each page as it arrives and keeps none of them", async () => {
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
        return { availableMetrics: GA4_METRICS, truncated: false };
      },
    });

    // The whole period fits one window, so the property is asked once and every
    // page it hands back is consumed as it arrives.
    expect(handedOut).toBe(PAGES);
    expect(outcome.received).toBe(PAGES * SIZE);
    expect(outcome.written).toBe(PAGES * SIZE);
    expect(outcome.status).toBe("SUCCEEDED");

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

    // GA4 writes a window only once the whole window has been read, because
    // the spellings of one page can be spread across its pages and only the
    // complete window can say what the page's day added up to. A read that
    // fails midway therefore leaves nothing behind for GA4 — unlike Search
    // Console, which writes each chunk — and the retry reads the window again.
    expect(
      await prisma.ga4LandingPageMetricDaily.count({ where: { websiteId: tenant.website.id } }),
    ).toBe(0);

    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: tenant.website.id, provider: "GOOGLE_ANALYTICS" },
    });
    expect(connection.latestDataDate).toBeNull();
    expect(connection.lastSyncedAt).toBeNull();
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

    // A hundred rows, and the record of them is a few hundred bytes: counts,
    // dates and flags. What matters is that it is bounded by the length of the
    // period rather than by the number of rows, and that no row is in it.
    const stored = JSON.stringify(snapshot.metadataJson);
    expect(stored.length).toBeLessThan(400);
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

describe("reading a period in date windows", () => {
  it("asks a week in halves when the week is too big, and still completes it", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;
    const accepted: string[] = [];

    const outcome = await runGscSync(tenant, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      pages: async (params, onPage) => {
        const days = daysIn(params);

        // A busy property: more than three days at a time is more than it will
        // return. Nothing is handed over for a question that big, which is the
        // case that used to leave the sync PARTIAL forever.
        if (days.length > 3) return { truncated: true };

        for (const day of days) await onPage(gscPage(host, 0, 10, day));
        accepted.push(...days);
        return { truncated: false };
      },
    });

    // The week was cut down to pieces the property would answer, and between
    // them they are the week: every day once, no day twice.
    expect([...accepted].sort()).toEqual(PERIOD);
    expect(new Set(accepted).size).toBe(PERIOD.length);

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(70);
    expect(await prisma.gscMetricDaily.count({ where: { websiteId: tenant.website.id } })).toBe(70);

    // The whole period really was read, so the data really is as fresh as the
    // connection now claims.
    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: tenant.website.id, provider: "GOOGLE_SEARCH_CONSOLE" },
    });
    expect(connection.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
    expect(connection.lastSyncedAt).not.toBeNull();

    const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({
      where: { websiteId: tenant.website.id },
    });
    expect(snapshot.metadataJson).toMatchObject({
      complete: true,
      requestedStart: "2026-08-24",
      requestedEnd: "2026-08-30",
      windows: 3,
      windowsCompleted: 3,
    });
  }, 240_000);

  it("keeps a day it cannot finish, says which, and calls nothing fresh", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;
    const asked: string[] = [];

    const outcome = await runGa4Sync(tenant, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      pages: async (params, onPage) => {
        asked.push(`${params.startDate}..${params.endDate}`);
        for (const day of daysIn(params)) await onPage(ga4Page(host, 0, 5, day), GA4_METRICS);
        // However narrow the question, this property has more than it will give.
        return { availableMetrics: GA4_METRICS, truncated: true };
      },
    });

    // Halved until single days were left: seven days means six splits and
    // thirteen questions, and then there is nothing smaller to ask.
    expect(asked).toHaveLength(13);
    const singleDays = asked.filter((range) => {
      const [start, end] = range.split("..");
      return start === end;
    });
    expect(singleDays).toHaveLength(7);

    expect(outcome.status).toBe("PARTIAL");

    // What each day did give is kept. Those rows are real rows for real dates
    // and nothing better is coming for them, so they are not thrown away and
    // they are not counted twice either.
    expect(outcome.received).toBe(35);
    expect(outcome.written).toBe(35);
    expect(
      await prisma.ga4LandingPageMetricDaily.count({ where: { websiteId: tenant.website.id } }),
    ).toBe(35);

    // But no part of the period was read completely, so none of it is fresh.
    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: tenant.website.id, provider: "GOOGLE_ANALYTICS" },
    });
    expect(connection.lastSyncedAt).toBeNull();
    expect(connection.latestDataDate).toBeNull();

    // And the record says exactly which dates could not be finished, so this is
    // diagnosable without going back to the provider.
    const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({
      where: { websiteId: tenant.website.id },
    });
    expect(snapshot.metadataJson).toMatchObject({
      complete: false,
      windows: 7,
      windowsCompleted: 0,
    });

    const metadata = snapshot.metadataJson as unknown as {
      incompleteWindows: { start: string; end: string; code: string | null }[];
    };
    expect(metadata.incompleteWindows.map((entry) => entry.start)).toEqual(PERIOD);
    expect(
      metadata.incompleteWindows.every((entry) => entry.code === "day_exceeds_provider_limit"),
    ).toBe(true);
  }, 240_000);

  it("gives the same checksum however the period was divided", async () => {
    const host = tenant.website.normalizedDomain;

    const checksumFor = async (windowDays: number): Promise<string> => {
      await clearMetrics();
      await runGscSync(tenant, {
        now: NOW,
        days: 7,
        accessTokenFor: TOKEN,
        windowDays,
        pages: async (params, onPage) => {
          for (const day of daysIn(params)) await onPage(gscPage(host, 0, 8, day));
          return { truncated: false };
        },
      });

      const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({
        where: { websiteId: tenant.website.id },
      });
      return snapshot.checksum ?? "";
    };

    // One question for the week against one question a day. The same rows
    // either way, so the evidence of them must be the same too — otherwise no
    // two runs could ever be compared once a window happened to split.
    const asOneWeek = await checksumFor(7);
    const asSevenDays = await checksumFor(1);

    expect(asOneWeek).toMatch(/^[0-9a-f]{64}$/);
    expect(asSevenDays).toBe(asOneWeek);
  }, 240_000);

  it("reads a long period one window at a time, never two at once", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;
    const windowStarts: string[] = [];
    let inFlight = 0;
    let peak = 0;

    const outcome = await runGscSync(tenant, {
      now: NOW,
      days: 90,
      accessTokenFor: TOKEN,
      pages: async (params, onPage) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        windowStarts.push(params.startDate);

        for (const day of daysIn(params)) await onPage(gscPage(host, 0, 2, day));

        inFlight -= 1;
        return { truncated: false };
      },
    });

    expect(outcome.status).toBe("SUCCEEDED");

    // Ninety days in sevens, asked strictly in sequence. Nothing accumulates
    // across windows, which is the whole point: memory is one window's pages.
    expect(windowStarts).toHaveLength(13);
    expect(windowStarts[0]).toBe("2026-06-02");
    expect(windowStarts).toEqual([...windowStarts].sort());
    expect(peak).toBe(1);

    expect(outcome.received).toBe(180);
    expect(await prisma.gscMetricDaily.count({ where: { websiteId: tenant.website.id } })).toBe(
      180,
    );
  }, 300_000);

  it("stops at its ceiling on provider requests rather than asking forever", async () => {
    await clearMetrics();
    const host = tenant.website.normalizedDomain;

    const outcome = await runGscSync(tenant, {
      now: NOW,
      days: 90,
      accessTokenFor: TOKEN,
      maxRequests: 4,
      pages: async (params, onPage) => {
        for (const day of daysIn(params)) await onPage(gscPage(host, 0, 2, day));
        return { truncated: false };
      },
    });

    expect(outcome.status).toBe("PARTIAL");

    const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({
      where: { websiteId: tenant.website.id },
    });
    expect(snapshot.metadataJson).toMatchObject({
      complete: false,
      code: "window_budget_exhausted",
    });

    const metadata = snapshot.metadataJson as unknown as {
      incompleteWindows: { code: string | null }[];
    };
    // The windows that were never reached say so, rather than looking like
    // windows that came back empty.
    expect(metadata.incompleteWindows.every((entry) => entry.code === "not_attempted")).toBe(true);

    // The days that were read were read completely, and are in the database.
    // The period was not, so nothing is fresh.
    expect(
      await prisma.gscMetricDaily.count({ where: { websiteId: tenant.website.id } }),
    ).toBeGreaterThan(0);
    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: tenant.website.id, provider: "GOOGLE_SEARCH_CONSOLE" },
    });
    expect(connection.latestDataDate).toBeNull();
  }, 240_000);
});
