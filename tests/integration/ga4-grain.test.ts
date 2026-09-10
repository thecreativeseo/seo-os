import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import type { Ga4MetricName, Ga4Result, Ga4Row } from "@/server/connectors/google/analytics";
import { RetryableJobError, runConnectionSync } from "@/server/jobs/definitions";
import { runGa4Sync } from "@/server/services/sync";
import { registerOrganizations } from "../helpers/teardown";

/**
 * GA4 landing pages that are one page (P1 GA4 normalized-grain reliability).
 *
 * GA4 is asked for the landing page with its query string, so a page reached
 * through a campaign link and the same page reached directly are two rows.
 * SEO OS stores landing-page metrics per page per day, so they are one row —
 * and Postgres refuses an INSERT that names one row twice. These tests run
 * the real ingest with rows that collide, across provider pages and write
 * chunks, and check what is stored and what happens when it runs again.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const NOW = new Date("2026-09-02T09:00:00Z");
const TOKEN = async () => "test-access-token";
const GA4 = "GOOGLE_ANALYTICS";
const noDetect = async () => undefined;

const ALL: Ga4MetricName[] = [
  "sessions",
  "engagedSessions",
  "totalUsers",
  "newUsers",
  "keyEvents",
  "totalRevenue",
];

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
    data: { authUserId: crypto.randomUUID(), email: `g4grain-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `GA4 grain ${label}`, slug: `g4grain-${label}-${suffix}` },
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

async function connect(context: TenantContext) {
  return prisma.connection.create({
    data: {
      websiteId: context.website.id,
      workspaceId: context.workspace.id,
      provider: GA4,
      status: "CONNECTED",
      externalPropertyId: "properties/123456",
      externalPropertyName: "Test property",
    },
  });
}

function row(
  landingPage: string,
  metrics: Partial<Record<Ga4MetricName, number>>,
  date = "2026-08-30",
): Ga4Row {
  return { date, landingPage, metrics };
}

function result(rows: Ga4Row[], availableMetrics: Ga4MetricName[] = ALL): Ga4Result {
  return { rows, availableMetrics, truncated: false };
}

async function stored(websiteId: string) {
  const rows = await prisma.ga4LandingPageMetricDaily.findMany({
    where: { websiteId },
    include: { page: { select: { normalizedUrl: true } } },
    orderBy: [{ date: "asc" }, { sessions: "desc" }],
  });
  return rows.map((entry) => ({
    date: entry.date.toISOString().slice(0, 10),
    page: entry.page.normalizedUrl.replace(/^https:\/\/[^/]+/, ""),
    sessions: entry.sessions,
    engagedSessions: entry.engagedSessions,
    users: entry.users,
    newUsers: entry.newUsers,
    keyEvents: entry.keyEvents,
    revenue: entry.revenue === null ? null : Number(entry.revenue),
  }));
}

describe("spellings of one landing page", () => {
  it("stores one row, with counts added and people left unknown", async () => {
    const context = await makeTenant("shape");
    const connection = await connect(context);

    const outcome = await runGa4Sync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        result([
          row("/careers", {
            sessions: 30,
            engagedSessions: 20,
            totalUsers: 28,
            newUsers: 15,
            keyEvents: 2,
            totalRevenue: 10,
          }),
          row("/careers/", {
            sessions: 6,
            engagedSessions: 4,
            totalUsers: 6,
            newUsers: 2,
            keyEvents: 0,
            totalRevenue: 0,
          }),
          row("/careers/index.html", {
            sessions: 1,
            engagedSessions: 0,
            totalUsers: 1,
            newUsers: 1,
            keyEvents: 0,
            totalRevenue: 0,
          }),
          row("/careers?utm_source=newsletter", {
            sessions: 3,
            engagedSessions: 1,
            totalUsers: 3,
            newUsers: 2,
            keyEvents: 1,
            totalRevenue: 2.5,
          }),
        ]),
    });

    // Before this change the statement was refused and the run failed.
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(4);
    expect(outcome.written).toBe(1);

    const rows = await stored(context.website.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      date: "2026-08-30",
      page: "/careers",
      sessions: 40,
      engagedSessions: 25,
      keyEvents: 3,
      revenue: 12.5,
      // Four rows counted people who may overlap. No number is honest here.
      users: null,
      newUsers: null,
    });

    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
  }, 120_000);

  it("keeps a content-selecting parameter as its own page, with its own people", async () => {
    const context = await makeTenant("param");
    await connect(context);

    await runGa4Sync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        result([
          row("/careers", { sessions: 30, totalUsers: 28, newUsers: 15 }),
          row("/careers?p=2", { sessions: 4, totalUsers: 4, newUsers: 1 }),
        ]),
    });

    const rows = await stored(context.website.id);
    expect(rows).toHaveLength(2);
    // Neither collapsed, so both keep GA4's own distinct counts.
    expect(rows.map((entry) => entry.users).sort()).toEqual([28, 4].sort());
  }, 120_000);

  it("leaves a metric the property cannot report as null after collapsing", async () => {
    const context = await makeTenant("coreonly");
    await connect(context);

    await runGa4Sync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        result(
          [
            row("/pricing", { sessions: 30, engagedSessions: 10, totalUsers: 28, newUsers: 15 }),
            row("/pricing/", { sessions: 2, engagedSessions: 0, totalUsers: 2, newUsers: 2 }),
          ],
          ["sessions", "engagedSessions", "totalUsers", "newUsers"],
        ),
    });

    const [entry] = await stored(context.website.id);
    expect(entry).toMatchObject({
      sessions: 32,
      engagedSessions: 10,
      keyEvents: null,
      revenue: null,
    });
  }, 120_000);
});

describe("across provider pages and write chunks", () => {
  it("still stores one measurement when the spellings arrive in different chunks", async () => {
    const context = await makeTenant("chunks");
    await connect(context);

    // Three provider pages, ingested two rows at a time, with /careers
    // spellings spread across all of them. Per-chunk collapsing would have
    // let the last chunk replace the first.
    const pages: Ga4Row[][] = [
      [
        row("/about", { sessions: 5, totalUsers: 5 }),
        row("/careers", { sessions: 30, totalUsers: 28 }),
      ],
      [
        row("/careers/", { sessions: 6, totalUsers: 6 }),
        row("/pricing", { sessions: 9, totalUsers: 9 }),
      ],
      [
        row("/careers?utm_source=x", { sessions: 3, totalUsers: 3 }),
        row("/team", { sessions: 1, totalUsers: 1 }),
      ],
    ];

    const outcome = await runGa4Sync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      ingestChunk: 1,
      pages: async (_params, onPage) => {
        for (const page of pages) await onPage(page, ALL);
        return { availableMetrics: ALL, truncated: false };
      },
    });

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(6);
    expect(outcome.written).toBe(4);

    const rows = await stored(context.website.id);
    const careers = rows.find((entry) => entry.page === "/careers")!;
    expect(careers).toMatchObject({ sessions: 39, users: null });
    expect(rows.find((entry) => entry.page === "/about")).toMatchObject({ sessions: 5, users: 5 });
  }, 120_000);

  it("stores the same measurement whatever order the provider sent the spellings", async () => {
    const a = await makeTenant("order-a");
    await connect(a);
    const b = await makeTenant("order-b");
    await connect(b);

    const rows = [
      row("/x", {
        sessions: 30,
        engagedSessions: 20,
        totalUsers: 28,
        newUsers: 15,
        keyEvents: 2,
        totalRevenue: 0.1,
      }),
      row("/x/", {
        sessions: 10,
        engagedSessions: 5,
        totalUsers: 9,
        newUsers: 5,
        keyEvents: 1,
        totalRevenue: 0.2,
      }),
      row("/x?fbclid=1", {
        sessions: 1,
        engagedSessions: 1,
        totalUsers: 1,
        newUsers: 0,
        keyEvents: 0,
        totalRevenue: 0.3,
      }),
    ];

    await runGa4Sync(a, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => result(rows),
    });
    await runGa4Sync(b, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => result([...rows].reverse()),
    });

    const [first] = await stored(a.website.id);
    const [second] = await stored(b.website.id);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ sessions: 41, engagedSessions: 26, keyEvents: 3, users: null });
    expect(first!.revenue).toBeCloseTo(0.6, 4);
  }, 120_000);

  it("holds a window by page and day rather than by row", async () => {
    const context = await makeTenant("large");
    await connect(context);

    // Twelve thousand rows over three provider pages: forty pages, each in
    // a hundred spellings. Only forty rows exist afterwards.
    const spellings = (index: number) => `/p-${index % 40}?utm_content=${index}`;
    const outcome = await runGa4Sync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      pages: async (_params, onPage) => {
        for (let page = 0; page < 3; page += 1) {
          const batch = Array.from({ length: 4_000 }, (_, i) =>
            row(spellings(page * 4_000 + i), { sessions: 1, totalUsers: 1 }),
          );
          await onPage(batch, ALL);
        }
        return { availableMetrics: ALL, truncated: false };
      },
    });

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(12_000);
    expect(outcome.written).toBe(40);

    const rows = await stored(context.website.id);
    expect(rows).toHaveLength(40);
    expect(rows.every((entry) => entry.sessions === 300 && entry.users === null)).toBe(true);
  }, 180_000);
});

describe("running it again", () => {
  it("replays to the same stored values, never doubled", async () => {
    const context = await makeTenant("replay");
    const connection = await connect(context);
    const source = async () =>
      result([
        row("/a", { sessions: 30, totalUsers: 28, keyEvents: 2, totalRevenue: 10 }),
        row("/a/", { sessions: 10, totalUsers: 9, keyEvents: 1, totalRevenue: 2.5 }),
      ]);

    await runGa4Sync(context, { now: NOW, days: 7, accessTokenFor: TOKEN, source });
    const first = await stored(context.website.id);

    await prisma.syncRun.deleteMany({ where: { connectionId: connection.id } });
    await runGa4Sync(context, { now: NOW, days: 7, accessTokenFor: TOKEN, source });
    const second = await stored(context.website.id);

    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ sessions: 40, keyEvents: 3, revenue: 12.5, users: null });
  }, 120_000);

  it("after a failed attempt, the retry replaces rather than adds, and freshness waits", async () => {
    const context = await makeTenant("retry");
    const connection = await connect(context);
    const ga4 = {
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        result([
          row("/a", { sessions: 30, totalUsers: 28 }),
          row("/a?utm_source=x", { sessions: 10, totalUsers: 9 }),
        ]),
    };

    // Rows are written, then finalisation is refused by the database: an
    // actor the audit trail cannot name. Deterministic partial writes exist.
    await expect(
      runConnectionSync(
        { websiteId: context.website.id, provider: GA4 },
        {
          now: NOW,
          ga4,
          contextFor: async () => ({
            context: { ...context, user: { ...context.user, id: crypto.randomUUID() } },
            actor: "requester",
          }),
        },
      ),
    ).rejects.toBeInstanceOf(RetryableJobError);

    const afterFailure = await stored(context.website.id);
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]).toMatchObject({ sessions: 40, users: null });

    const before = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(before.lastSyncedAt).toBeNull();
    expect(before.latestDataDate).toBeNull();

    const retried = await runConnectionSync(
      { websiteId: context.website.id, provider: GA4 },
      { now: NOW, ga4, detect: noDetect },
    );
    expect(retried.status).toBe("done");

    const afterRetry = await stored(context.website.id);
    expect(afterRetry).toEqual(afterFailure);
    expect(await prisma.syncRun.count({ where: { connectionId: connection.id } })).toBe(1);

    const after = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after.lastSyncedAt).not.toBeNull();
    expect(after.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
  }, 120_000);
});

describe("a day GA4 will not give in full", () => {
  it("is stored as far as it went, and the run is PARTIAL with no freshness", async () => {
    const context = await makeTenant("truncated");
    const connection = await connect(context);

    const outcome = await runGa4Sync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      pages: async (params, onPage) => {
        // Every question, however narrow, gets some rows and "there is more".
        await onPage([row("/a", { sessions: 1, totalUsers: 1 }, params.startDate)], ALL);
        return { availableMetrics: ALL, truncated: true };
      },
    });

    expect(outcome.status).toBe("PARTIAL");

    // What the days did give is kept, and the record says the period is not
    // complete — the difference between "we have this" and "this is all".
    expect(
      await prisma.ga4LandingPageMetricDaily.count({ where: { websiteId: context.website.id } }),
    ).toBe(7);
    const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({
      where: { websiteId: context.website.id },
    });
    expect(snapshot.metadataJson).toMatchObject({
      complete: false,
      windows: 7,
      windowsCompleted: 0,
    });

    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.lastSyncedAt).toBeNull();
    expect(refreshed.latestDataDate).toBeNull();
  }, 180_000);
});
