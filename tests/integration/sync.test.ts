import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  idempotencyKeyFor,
  resolveSyncWindow,
  runGa4Sync,
  runGscSync,
  SyncError,
} from "@/server/services/sync";
import { getDataHealth } from "@/server/services/data-health";
import { SearchConsoleError } from "@/server/connectors/google/search-console";
import type { SearchAnalyticsResult } from "@/server/connectors/google/search-console";
import type { Ga4Result } from "@/server/connectors/google/analytics";

/**
 * The sync lifecycle, driven end to end with recorded provider payloads.
 *
 * No network: the connectors are injected. That is deliberate rather than merely
 * convenient — the acceptance criteria for sync are about SyncRun state, idempotency
 * and freshness honesty, and none of those should need a live Google account to
 * prove.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const NOW = new Date("2026-09-02T09:00:00Z");
const TOKEN = async () => "test-access-token";

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `sync-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Sync ${label}`, slug: `sync-${label}-${suffix}` },
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

function gscPayload(
  host: string,
  rows: { date: string; path: string; query: string; clicks: number; impressions: number }[],
): SearchAnalyticsResult {
  return {
    rows: rows.map((row) => ({
      date: row.date,
      page: `https://${host}${row.path}`,
      query: row.query,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.impressions === 0 ? 0 : row.clicks / row.impressions,
      position: 4.5,
    })),
    truncated: false,
  };
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

describe("Search Console sync", () => {
  it("records a run, writes rows, and advances freshness", async () => {
    const context = await makeContext("gsc");
    const connection = await connect(context, "GOOGLE_SEARCH_CONSOLE");
    const host = context.website.normalizedDomain;

    const outcome = await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        gscPayload(host, [
          {
            date: "2026-08-29",
            path: "/pricing",
            query: "seo pricing",
            clicks: 10,
            impressions: 200,
          },
          {
            date: "2026-08-30",
            path: "/pricing",
            query: "seo pricing",
            clicks: 12,
            impressions: 220,
          },
          {
            date: "2026-08-30",
            path: "/blog/audit",
            query: "seo audit",
            clicks: 4,
            impressions: 90,
          },
        ]),
    });

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(3);
    expect(outcome.written).toBe(3);
    expect(outcome.skipped).toBe(0);

    // The period is on the run, not implied by when it happened.
    expect(outcome.run.periodStart?.toISOString().slice(0, 10)).toBe("2026-08-24");
    expect(outcome.run.periodEnd?.toISOString().slice(0, 10)).toBe("2026-08-30");
    expect(outcome.run.startedAt).not.toBeNull();
    expect(outcome.run.finishedAt).not.toBeNull();
    expect(outcome.run.idempotencyKey).toContain("GSC_METRICS");

    expect(await prisma.page.count({ where: { websiteId: context.website.id } })).toBe(2);
    expect(await prisma.query.count({ where: { websiteId: context.website.id } })).toBe(2);
    expect(await prisma.gscMetricDaily.count({ where: { websiteId: context.website.id } })).toBe(3);

    // A snapshot records what arrived. Counts and periods only — never a token.
    const snapshot = await prisma.sourceSnapshot.findFirst({
      where: { websiteId: context.website.id },
    });
    expect(snapshot?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(snapshot?.metadataJson)).not.toContain("test-access-token");

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(refreshed.lastSyncedAt).not.toBeNull();
    expect(refreshed.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
  });

  it("does not refetch a period that already succeeded", async () => {
    const context = await makeContext("reuse");
    await connect(context, "GOOGLE_SEARCH_CONSOLE");
    const host = context.website.normalizedDomain;

    let calls = 0;
    const source = async () => {
      calls += 1;
      return gscPayload(host, [
        { date: "2026-08-30", path: "/a", query: "alpha", clicks: 5, impressions: 100 },
      ]);
    };

    await runGscSync(context, { now: NOW, days: 7, accessTokenFor: TOKEN, source });
    const second = await runGscSync(context, { now: NOW, days: 7, accessTokenFor: TOKEN, source });

    expect(calls).toBe(1);
    expect(second.reused).toBe(true);
    expect(second.status).toBe("SUCCEEDED");
    expect(await prisma.syncRun.count({ where: { websiteId: context.website.id } })).toBe(1);
  });

  it("a retry updates rows in place rather than duplicating them", async () => {
    const context = await makeContext("retry");
    await connect(context, "GOOGLE_SEARCH_CONSOLE");
    const host = context.website.normalizedDomain;

    // The first attempt fails partway through the provider call.
    const failed = await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => {
        throw new SearchConsoleError("upstream said no", "upstream_error");
      },
    });
    expect(failed.status).toBe("FAILED");

    // The retry reads the same period and gets a provisional figure.
    await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        gscPayload(host, [
          {
            date: "2026-08-30",
            path: "/pricing",
            query: "seo pricing",
            clicks: 9,
            impressions: 180,
          },
        ]),
    });

    // And a third read of the same period returns the revised, final figure.
    const run = await prisma.syncRun.findFirstOrThrow({
      where: { websiteId: context.website.id },
    });
    await prisma.syncRun.update({ where: { id: run.id }, data: { status: "PARTIAL" } });

    await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        gscPayload(host, [
          {
            date: "2026-08-30",
            path: "/pricing",
            query: "seo pricing",
            clicks: 12,
            impressions: 240,
          },
        ]),
    });

    const rows = await prisma.gscMetricDaily.findMany({
      where: { websiteId: context.website.id },
    });

    // One row for the grain, carrying the revised number — not two rows, and not
    // the stale first number frozen in place.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clicks).toBe(12);
    expect(rows[0]!.impressions).toBe(240);

    // Still one run row for the period: a retry is the same run, tried again.
    expect(await prisma.syncRun.count({ where: { websiteId: context.website.id } })).toBe(1);
  });

  it("a failed sync does not make the data look fresh", async () => {
    const context = await makeContext("stale");
    const connection = await connect(context, "GOOGLE_SEARCH_CONSOLE");

    const outcome = await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => {
        throw new SearchConsoleError("boom", "rate_limited");
      },
    });

    expect(outcome.status).toBe("FAILED");

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(refreshed.lastSyncedAt).toBeNull();
    expect(refreshed.latestDataDate).toBeNull();
  });

  it("stores an error code of ours, never the provider's message", async () => {
    const context = await makeContext("redact");
    await connect(context, "GOOGLE_SEARCH_CONSOLE");

    const outcome = await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => {
        throw new SearchConsoleError(
          "Request had invalid authentication credentials. Bearer token ya29.SECRET expired.",
          "permission_denied",
        );
      },
    });

    expect(outcome.run.errorCode).toBe("permission_denied");
    expect(outcome.run.errorSummary).toBe(
      "The authorisation does not permit reading this property.",
    );
    expect(outcome.run.errorSummary).not.toContain("ya29");
    expect(outcome.run.errorSummary).not.toContain("Bearer");
  });

  it("counts a row it cannot place rather than storing it against a guess", async () => {
    const context = await makeContext("skip");
    await connect(context, "GOOGLE_SEARCH_CONSOLE");
    const host = context.website.normalizedDomain;

    const outcome = await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => ({
        rows: [
          {
            date: "2026-08-30",
            page: `https://${host}/ok`,
            query: "fine",
            clicks: 1,
            impressions: 10,
            ctr: 0.1,
            position: 3,
          },
          {
            date: "2026-08-30",
            // Search Console reports app properties this way; it is a real page
            // identity, but not a web URL this website can own.
            page: "android-app://com.example.app/home",
            query: "broken",
            clicks: 9,
            impressions: 99,
            ctr: 0.09,
            position: 8,
          },
        ],
        truncated: false,
      }),
    });

    expect(outcome.received).toBe(2);
    expect(outcome.written).toBe(1);
    expect(outcome.skipped).toBe(1);
    // Read but not fully stored, and the run says so.
    expect(outcome.status).toBe("PARTIAL");
  });

  it("refuses to sync a connection with no property selected", async () => {
    const context = await makeContext("noprop");
    await prisma.connection.create({
      data: {
        websiteId: context.website.id,
        workspaceId: context.workspace.id,
        provider: "GOOGLE_SEARCH_CONSOLE",
        status: "CONNECTING",
      },
    });

    await expect(
      runGscSync(context, {
        now: NOW,
        accessTokenFor: TOKEN,
        source: async () => gscPayload("x", []),
      }),
    ).rejects.toBeInstanceOf(SyncError);
  });
});

describe("GA4 sync", () => {
  function ga4Payload(
    rows: { date: string; landingPage: string; metrics: Record<string, number> }[],
    availableMetrics: Ga4Result["availableMetrics"],
  ): Ga4Result {
    return { rows, availableMetrics, truncated: false };
  }

  it("maps landing pages onto existing Pages instead of duplicating them", async () => {
    const context = await makeContext("ga4map");
    await connect(context, "GOOGLE_SEARCH_CONSOLE");
    await connect(context, "GOOGLE_ANALYTICS");
    const host = context.website.normalizedDomain;

    await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        gscPayload(host, [
          {
            date: "2026-08-30",
            path: "/pricing",
            query: "seo pricing",
            clicks: 10,
            impressions: 200,
          },
        ]),
    });

    await runGa4Sync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        ga4Payload(
          [
            {
              date: "2026-08-30",
              landingPage: "/pricing",
              metrics: { sessions: 40, engagedSessions: 25, totalUsers: 35, newUsers: 20 },
            },
          ],
          ["sessions", "engagedSessions", "totalUsers", "newUsers"],
        ),
    });

    // The same page, seen by two sources — not two rows.
    const pages = await prisma.page.findMany({ where: { websiteId: context.website.id } });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.sourceFirstSeen).toBe("GOOGLE_SEARCH_CONSOLE");

    const metrics = await prisma.ga4LandingPageMetricDaily.findMany({
      where: { websiteId: context.website.id },
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.sessions).toBe(40);
    expect(metrics[0]!.pageId).toBe(pages[0]!.id);
  });

  it("leaves a metric the property cannot report as null", async () => {
    const context = await makeContext("ga4null");
    await connect(context, "GOOGLE_ANALYTICS");

    await runGa4Sync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        ga4Payload(
          [
            {
              date: "2026-08-30",
              landingPage: "/pricing",
              // A property with no ecommerce and no key events reports neither.
              metrics: { sessions: 40, engagedSessions: 0, totalUsers: 35, newUsers: 20 },
            },
          ],
          ["sessions", "engagedSessions", "totalUsers", "newUsers"],
        ),
    });

    const row = await prisma.ga4LandingPageMetricDaily.findFirstOrThrow({
      where: { websiteId: context.website.id },
    });

    // Never invented: unmeasured is null, and a measured zero stays zero. Storing
    // 0 for revenue here would be a business fact nobody reported.
    expect(row.keyEvents).toBeNull();
    expect(row.revenue).toBeNull();
    expect(row.engagedSessions).toBe(0);
    expect(row.sessions).toBe(40);
  });

  it("skips GA4's unattributed placeholders", async () => {
    const context = await makeContext("ga4skip");
    await connect(context, "GOOGLE_ANALYTICS");

    const outcome = await runGa4Sync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        ga4Payload(
          [
            { date: "2026-08-30", landingPage: "/real", metrics: { sessions: 12 } },
            { date: "2026-08-30", landingPage: "(not set)", metrics: { sessions: 300 } },
            { date: "2026-08-30", landingPage: "(other)", metrics: { sessions: 90 } },
          ],
          ["sessions", "engagedSessions", "totalUsers", "newUsers"],
        ),
    });

    expect(outcome.received).toBe(3);
    expect(outcome.written).toBe(1);
    expect(outcome.skipped).toBe(2);

    // The 390 unattributed sessions are not silently folded into a real page.
    const rows = await prisma.ga4LandingPageMetricDaily.findMany({
      where: { websiteId: context.website.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessions).toBe(12);
  });
});

describe("sync lifecycle and stale-run recovery", () => {
  it("leaves a caught provider error as FAILED with a finishedAt, never RUNNING", async () => {
    const context = await makeContext("failfin");
    await connect(context, "GOOGLE_SEARCH_CONSOLE");

    const outcome = await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => {
        throw new SearchConsoleError("boom", "rate_limited");
      },
    });

    expect(outcome.status).toBe("FAILED");
    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: outcome.run.id } });
    expect(run.status).toBe("FAILED");
    expect(run.finishedAt).not.toBeNull();
  });

  it("recovers a stale RUNNING run to FAILED and lets the new run proceed", async () => {
    const context = await makeContext("stalerec");
    const connection = await connect(context, "GOOGLE_SEARCH_CONSOLE");
    const host = context.website.normalizedDomain;

    // An orphan a dead process left behind: RUNNING, well past the threshold, for
    // the exact period the next sync will target.
    const window = resolveSyncWindow({ latestDataDate: null }, { now: NOW, days: 7 });
    const key = idempotencyKeyFor("GSC_METRICS", window);
    const orphan = await prisma.syncRun.create({
      data: {
        websiteId: context.website.id,
        connectionId: connection.id,
        provider: "GOOGLE_SEARCH_CONSOLE",
        syncType: "GSC_METRICS",
        status: "RUNNING",
        startedAt: new Date(NOW.getTime() - 30 * 60_000),
        idempotencyKey: key,
        periodStart: new Date(`${window.startDate}T00:00:00.000Z`),
        periodEnd: new Date(`${window.endDate}T00:00:00.000Z`),
      },
    });

    const outcome = await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        gscPayload(host, [
          { date: window.endDate, path: "/a", query: "alpha", clicks: 3, impressions: 30 },
        ]),
    });

    expect(["SUCCEEDED", "PARTIAL"]).toContain(outcome.status);

    // The orphan is preserved as a recovered failure, not silently overwritten.
    const recovered = await prisma.syncRun.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(recovered.status).toBe("FAILED");
    expect(recovered.errorCode).toBe("stale_run_recovered");
    expect(recovered.finishedAt).not.toBeNull();

    // Two rows: the archived orphan and the fresh attempt.
    expect(await prisma.syncRun.count({ where: { connectionId: connection.id } })).toBe(2);
  });

  it("protects a genuinely active RUNNING run from recovery", async () => {
    const context = await makeContext("active");
    const connection = await connect(context, "GOOGLE_SEARCH_CONSOLE");

    const window = resolveSyncWindow({ latestDataDate: null }, { now: NOW, days: 7 });
    const key = idempotencyKeyFor("GSC_METRICS", window);
    const active = await prisma.syncRun.create({
      data: {
        websiteId: context.website.id,
        connectionId: connection.id,
        provider: "GOOGLE_SEARCH_CONSOLE",
        syncType: "GSC_METRICS",
        status: "RUNNING",
        // One minute ago: well inside the staleness threshold.
        startedAt: new Date(NOW.getTime() - 60_000),
        idempotencyKey: key,
        periodStart: new Date(`${window.startDate}T00:00:00.000Z`),
        periodEnd: new Date(`${window.endDate}T00:00:00.000Z`),
      },
    });

    await expect(
      runGscSync(context, {
        now: NOW,
        days: 7,
        accessTokenFor: TOKEN,
        source: async () => gscPayload(context.website.normalizedDomain, []),
      }),
    ).rejects.toBeInstanceOf(SyncError);

    const still = await prisma.syncRun.findUniqueOrThrow({ where: { id: active.id } });
    expect(still.status).toBe("RUNNING");
  });

  it("shows a previous success and a later failure as separate facts", async () => {
    const context = await makeContext("prevsucc");
    const connection = await connect(context, "GOOGLE_SEARCH_CONSOLE");
    const host = context.website.normalizedDomain;

    const EARLY = new Date("2026-08-20T09:00:00Z");
    await runGscSync(context, {
      now: EARLY,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        gscPayload(host, [
          { date: "2026-08-18", path: "/a", query: "alpha", clicks: 4, impressions: 40 },
        ]),
    });
    const afterSuccess = await prisma.connection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(afterSuccess.latestDataDate).not.toBeNull();

    const LATE = new Date("2026-08-27T09:00:00Z");
    const failed = await runGscSync(context, {
      now: LATE,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => {
        throw new SearchConsoleError("boom", "rate_limited");
      },
    });
    expect(failed.status).toBe("FAILED");

    const health = await getDataHealth(context, LATE);
    const gsc = health.find((s) => s.provider === "GOOGLE_SEARCH_CONSOLE");
    expect(gsc).toBeDefined();
    // Known-good freshness is preserved even though the newest attempt failed.
    expect(gsc!.latestDataDate).not.toBeNull();
    expect(gsc!.attempt.state).toBe("failed");
  });

  it("never presents rows from an interrupted run as fresh data", async () => {
    const context = await makeContext("orphanrows");
    const connection = await connect(context, "GOOGLE_SEARCH_CONSOLE");
    const host = context.website.normalizedDomain;

    // A completed sync writes real rows the honest way…
    await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        gscPayload(host, [
          { date: "2026-08-30", path: "/x", query: "q", clicks: 2, impressions: 20 },
        ]),
    });

    // …then we reproduce the production orphan exactly: the metric rows are
    // committed, but freshness never advanced and the run is stuck RUNNING.
    await prisma.connection.update({
      where: { id: connection.id },
      data: { lastSyncedAt: null, latestDataDate: null },
    });
    const run = await prisma.syncRun.findFirstOrThrow({
      where: { connectionId: connection.id },
    });
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        finishedAt: null,
        recordsWritten: 0,
        startedAt: new Date(NOW.getTime() - 30 * 60_000),
      },
    });

    const health = await getDataHealth(context, NOW);
    const gsc = health.find((s) => s.provider === "GOOGLE_SEARCH_CONSOLE");
    expect(gsc).toBeDefined();
    // Rows really exist, and are honestly counted as coverage…
    expect(gsc!.rowCount).toBeGreaterThan(0);
    // …but there is no successful dataset, and the attempt is an interrupted orphan.
    expect(gsc!.latestDataDate).toBeNull();
    expect(gsc!.attempt.state).toBe("stale");
  });
});
