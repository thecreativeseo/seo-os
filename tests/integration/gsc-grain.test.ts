import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import type { SearchAnalyticsResult } from "@/server/connectors/google/search-console";
import { RetryableJobError, runConnectionSync } from "@/server/jobs/definitions";
import { runGscSync } from "@/server/services/sync";
import { registerOrganizations } from "../helpers/teardown";

/**
 * The confirmed production shape (P1 GSC normalized-grain aggregation).
 *
 * Search Console reported the same page under several spellings, SEO OS
 * folded the spellings into one page, and the one page then appeared twice in
 * a single INSERT — which Postgres refuses with SQLSTATE 21000. These tests
 * feed the writer exactly that: raw rows that differ as strings and are the
 * same measurement, and check what ends up stored, once, and what happens
 * when the same sync runs again.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const NOW = new Date("2026-09-02T09:00:00Z");
const TOKEN = async () => "test-access-token";
const GSC = "GOOGLE_SEARCH_CONSOLE";
const noDetect = async () => undefined;

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
    data: { authUserId: crypto.randomUUID(), email: `grain-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Grain ${label}`, slug: `grain-${label}-${suffix}` },
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
      provider: GSC,
      status: "CONNECTED",
      externalPropertyId: `sc-domain:${context.website.normalizedDomain}`,
      externalPropertyName: "Test property",
    },
  });
}

type Raw = {
  date?: string;
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
};

/** Rows as the provider would send them: raw strings, its own CTR, its own rank. */
function payload(rows: Raw[]): SearchAnalyticsResult {
  return {
    rows: rows.map((row) => ({
      date: row.date ?? "2026-08-30",
      page: row.page,
      query: row.query,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.impressions === 0 ? 0 : row.clicks / row.impressions,
      position: row.position,
    })),
    truncated: false,
  };
}

async function storedRows(websiteId: string) {
  const rows = await prisma.gscMetricDaily.findMany({
    where: { websiteId },
    include: {
      page: { select: { normalizedUrl: true } },
      queryEntity: { select: { normalizedQuery: true } },
    },
    orderBy: [{ date: "asc" }, { clicks: "desc" }],
  });
  return rows.map((row) => ({
    date: row.date.toISOString().slice(0, 10),
    page: row.page.normalizedUrl,
    query: row.queryEntity.normalizedQuery,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr === null ? null : Number(row.ctr),
    position: row.position === null ? null : Number(row.position),
  }));
}

describe("the confirmed production shape", () => {
  it("stores the spellings of one page and one query as one measurement", async () => {
    const context = await makeTenant("shape");
    const connection = await connect(context);
    const host = context.website.normalizedDomain;

    const outcome = await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      // Four spellings the normalizer folds: canonical, trailing slash, http,
      // and a tracking parameter. Two query spellings it folds: a run of
      // spaces, and a capital letter Search Console would not normally send
      // but the folding handles anyway.
      source: async () =>
        payload([
          {
            page: `https://${host}/careers`,
            query: "sprout careers",
            clicks: 3,
            impressions: 100,
            position: 4,
          },
          {
            page: `https://${host}/careers/`,
            query: "sprout  careers",
            clicks: 2,
            impressions: 50,
            position: 10,
          },
          {
            page: `http://${host}/careers`,
            query: "Sprout careers",
            clicks: 1,
            impressions: 10,
            position: 6,
          },
          {
            page: `https://${host}/careers?utm_source=newsletter`,
            query: "sprout careers",
            clicks: 0,
            impressions: 40,
            position: 8,
          },
        ]),
    });

    // Before this change the statement was refused and the run failed.
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(4);
    // Four rows placed; one row stored.
    expect(outcome.written).toBe(1);

    const rows = await storedRows(context.website.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      page: `https://${host}/careers`,
      query: "sprout careers",
      clicks: 6,
      impressions: 200,
    });
    // 6 / 200, from the whole, at the column's six decimals.
    expect(rows[0]!.ctr).toBeCloseTo(0.03, 6);
    // (4·100 + 10·50 + 6·10 + 8·40) / 200 = 1280 / 200 = 6.4, at the column's
    // three decimals.
    expect(rows[0]!.position).toBeCloseTo(6.4, 3);

    // Freshness advanced, because the whole period completed.
    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.lastSyncedAt).not.toBeNull();
    expect(refreshed.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
  }, 120_000);

  it("matches the example in the brief exactly", async () => {
    const context = await makeTenant("example");
    await connect(context);
    const host = context.website.normalizedDomain;

    await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        payload([
          { page: `https://${host}/a`, query: "q", clicks: 3, impressions: 100, position: 4 },
          { page: `https://${host}/a/`, query: "q", clicks: 2, impressions: 50, position: 10 },
        ]),
    });

    const [row] = await storedRows(context.website.id);
    expect(row).toMatchObject({ clicks: 5, impressions: 150 });
    expect(row!.ctr).toBeCloseTo(5 / 150, 6);
    expect(row!.position).toBeCloseTo((4 * 100 + 10 * 50) / 150, 3);
  }, 120_000);

  it("keeps genuinely different pages and queries apart", async () => {
    const context = await makeTenant("apart");
    await connect(context);
    const host = context.website.normalizedDomain;

    await runGscSync(context, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        payload([
          {
            page: `https://${host}/careers`,
            query: "sprout careers",
            clicks: 3,
            impressions: 100,
            position: 4,
          },
          // A content-selecting parameter is a different page.
          {
            page: `https://${host}/careers?p=2`,
            query: "sprout careers",
            clicks: 1,
            impressions: 20,
            position: 9,
          },
          // A different query is a different row.
          {
            page: `https://${host}/careers`,
            query: "sprout jobs",
            clicks: 2,
            impressions: 30,
            position: 5,
          },
          // A different day is a different row.
          {
            date: "2026-08-29",
            page: `https://${host}/careers`,
            query: "sprout careers",
            clicks: 4,
            impressions: 80,
            position: 3,
          },
        ]),
    });

    const rows = await storedRows(context.website.id);
    expect(rows).toHaveLength(4);
    // None of them was summed with a neighbour.
    expect(rows.map((row) => row.clicks).sort()).toEqual([1, 2, 3, 4]);
  }, 120_000);

  it("stores the same measurement whatever order the provider sent the spellings", async () => {
    const forward = await makeTenant("order-a");
    await connect(forward);
    const backward = await makeTenant("order-b");
    await connect(backward);

    const rowsFor = (host: string): Raw[] => [
      { page: `https://${host}/x`, query: "q", clicks: 3, impressions: 100, position: 4 },
      { page: `https://${host}/x/`, query: "q", clicks: 8, impressions: 333, position: 2.7 },
      { page: `http://${host}/x`, query: "q", clicks: 2, impressions: 50, position: 10 },
      {
        page: `https://${host}/x?fbclid=1`,
        query: "q ",
        clicks: 1,
        impressions: 1,
        position: 99.9,
      },
    ];

    await runGscSync(forward, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => payload(rowsFor(forward.website.normalizedDomain)),
    });
    await runGscSync(backward, {
      now: NOW,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () => payload(rowsFor(backward.website.normalizedDomain).reverse()),
    });

    const [a] = await storedRows(forward.website.id);
    const [b] = await storedRows(backward.website.id);
    expect({ ...a, page: "" }).toEqual({ ...b, page: "" });
    expect(a).toMatchObject({ clicks: 14, impressions: 484 });
  }, 120_000);
});

describe("running the same sync again", () => {
  it("replays to the same stored values, never doubled", async () => {
    const context = await makeTenant("replay");
    const connection = await connect(context);
    const host = context.website.normalizedDomain;
    const source = async () =>
      payload([
        { page: `https://${host}/a`, query: "q", clicks: 3, impressions: 100, position: 4 },
        { page: `https://${host}/a/`, query: "q", clicks: 2, impressions: 50, position: 10 },
      ]);

    await runGscSync(context, { now: NOW, days: 7, accessTokenFor: TOKEN, source });
    const first = await storedRows(context.website.id);

    // A completed period is reused rather than re-read, so clear the run to
    // force a genuine second read of the same data.
    await prisma.syncRun.deleteMany({ where: { connectionId: connection.id } });
    await runGscSync(context, { now: NOW, days: 7, accessTokenFor: TOKEN, source });
    const second = await storedRows(context.website.id);

    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ clicks: 5, impressions: 150 });
  }, 120_000);

  it("after a failed attempt, the retry replaces rather than adds", async () => {
    const context = await makeTenant("retry");
    const connection = await connect(context);
    const host = context.website.normalizedDomain;
    const gsc = {
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        payload([
          { page: `https://${host}/a`, query: "q", clicks: 3, impressions: 100, position: 4 },
          { page: `https://${host}/a/`, query: "q", clicks: 2, impressions: 50, position: 10 },
        ]),
    };

    // The rows are written, then finalisation is refused by the database:
    // an actor the audit trail cannot name. Partial, deterministic writes exist.
    await expect(
      runConnectionSync(
        { websiteId: context.website.id, provider: GSC },
        {
          now: NOW,
          gsc,
          contextFor: async () => ({
            context: { ...context, user: { ...context.user, id: crypto.randomUUID() } },
            actor: "requester",
          }),
        },
      ),
    ).rejects.toBeInstanceOf(RetryableJobError);

    const afterFailure = await storedRows(context.website.id);
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]).toMatchObject({ clicks: 5, impressions: 150 });

    // Freshness did not move on a failure.
    const before = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(before.lastSyncedAt).toBeNull();
    expect(before.latestDataDate).toBeNull();

    // The retry reads the same rows and upserts the same measurement.
    const retried = await runConnectionSync(
      { websiteId: context.website.id, provider: GSC },
      { now: NOW, gsc, detect: noDetect },
    );
    expect(retried.status).toBe("done");

    const afterRetry = await storedRows(context.website.id);
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0]).toMatchObject({ clicks: 5, impressions: 150 });
    expect(afterRetry).toEqual(afterFailure);

    // Only now.
    const after = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after.lastSyncedAt).not.toBeNull();
    expect(after.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
    expect(await prisma.syncRun.count({ where: { connectionId: connection.id } })).toBe(1);
  }, 120_000);
});
