import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { detectAndStoreSignals } from "@/server/services/signals";
import { registerOrganizations } from "../helpers/teardown";

/**
 * Storing a production-scale signal score (P1 signal score overflow).
 *
 * On the eleventh of September the first complete dataset for a busy property
 * produced a CTR-opportunity score of 188,993 — clicks the page could have
 * earned at its position band's median CTR — and Postgres refused to store it
 * in a DECIMAL(9,4) column. Because detection runs after a sync has finished,
 * the finished sync job was retried three times for a number that was never
 * anything but correct.
 *
 * These tests build the same shape from Search Console rows and run the real
 * detection path against the real database: a page with millions of
 * impressions and a CTR far below its band. The score must be stored exactly,
 * the run must not fail, and running it again must change nothing.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const NOW = new Date("2026-09-02T09:00:00Z");
/** Newest metric date, which anchors the 28-day windows. */
const LATEST = "2026-08-30";

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
}, 60_000);

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `score-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Score ${label}`, slug: `score-${label}-${suffix}` },
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

/** One page, one query, one row in each window, at a fixed position. */
async function seedPage(
  context: TenantContext,
  path: string,
  metrics: { clicks: number; impressions: number; previousClicks?: number; position?: number },
) {
  const connection = await prisma.connection.upsert({
    where: {
      websiteId_provider: { websiteId: context.website.id, provider: "GOOGLE_SEARCH_CONSOLE" },
    },
    update: {},
    create: {
      websiteId: context.website.id,
      workspaceId: context.workspace.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      status: "CONNECTED",
    },
  });

  const page = await prisma.page.create({
    data: {
      websiteId: context.website.id,
      url: `https://${context.website.normalizedDomain}${path}`,
      normalizedUrl: `https://${context.website.normalizedDomain}${path}`,
      path,
      hostname: context.website.normalizedDomain,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });

  const query = await prisma.query.create({
    data: {
      websiteId: context.website.id,
      query: `query for ${path}`,
      normalizedQuery: `query for ${path}`,
    },
  });

  const position = metrics.position ?? 3;
  const previousClicks = metrics.previousClicks ?? metrics.clicks;

  await prisma.gscMetricDaily.createMany({
    data: [
      {
        websiteId: context.website.id,
        pageId: page.id,
        queryId: query.id,
        date: new Date(LATEST),
        clicks: metrics.clicks,
        impressions: metrics.impressions,
        ctr: metrics.clicks / metrics.impressions,
        position,
        sourceConnectionId: connection.id,
      },
      {
        websiteId: context.website.id,
        pageId: page.id,
        queryId: query.id,
        date: new Date("2026-07-20"),
        clicks: previousClicks,
        impressions: metrics.impressions,
        ctr: previousClicks / metrics.impressions,
        position,
        sourceConnectionId: connection.id,
      },
    ],
  });

  return page;
}

/**
 * The production shape: three well-performing pages set the band's median CTR,
 * and one page with millions of impressions sits far below it. The headroom
 * score is impressions times the CTR gap, which is comfortably past the old
 * column's ceiling.
 */
async function seedOverflowShape(context: TenantContext) {
  for (const path of ["/a", "/b", "/c"]) {
    await seedPage(context, path, { clicks: 100, impressions: 1_000, position: 3 });
  }
  return seedPage(context, "/giant", { clicks: 1_000, impressions: 3_000_000, position: 3 });
}

describe("a score past the old column's ceiling", () => {
  it("is stored exactly, and detection completes", async () => {
    const context = await makeContext("overflow");
    const giant = await seedOverflowShape(context);

    // Before the column was widened this rejected the INSERT with SQLSTATE 22003.
    await expect(detectAndStoreSignals(context, { now: NOW })).resolves.toBeDefined();

    const signal = await prisma.signal.findFirst({
      where: { websiteId: context.website.id, type: "CTR_OPPORTUNITY", pageId: giant.id },
    });

    expect(signal).not.toBeNull();
    expect(signal!.score).not.toBeNull();
    const score = Number(signal!.score);
    // Past 99,999.9999 by construction, finite, and an integer as the rule rounds it.
    expect(score).toBeGreaterThan(99_999.9999);
    expect(Number.isFinite(score)).toBe(true);
    expect(Number.isInteger(score)).toBe(true);
  }, 120_000);

  it("runs again to the same signal with the same score, not a second one", async () => {
    const context = await makeContext("replay");
    const giant = await seedOverflowShape(context);

    const evidenceFor = () =>
      prisma.signalEvidence.count({ where: { signal: { websiteId: context.website.id } } });

    const firstRun = await detectAndStoreSignals(context, { now: NOW });
    const first = await prisma.signal.findMany({ where: { websiteId: context.website.id } });
    const evidence = await evidenceFor();

    const secondRun = await detectAndStoreSignals(context, { now: NOW });
    const thirdRun = await detectAndStoreSignals(context, { now: NOW });
    const third = await prisma.signal.findMany({ where: { websiteId: context.website.id } });

    // Same count, same ids, same scores, same evidence rows, nothing resolved:
    // a retry of the surrounding job would now be harmless.
    expect(secondRun.detected).toBe(firstRun.detected);
    expect(thirdRun.detected).toBe(firstRun.detected);
    expect(thirdRun.resolved).toBe(0);
    expect(third.map((entry) => entry.id).sort()).toEqual(first.map((entry) => entry.id).sort());
    const before = first.find((entry) => entry.pageId === giant.id)!;
    const after = third.find((entry) => entry.pageId === giant.id)!;
    expect(String(after.score)).toBe(String(before.score));
    expect(after.status).toBe("DETECTED");
    expect(await evidenceFor()).toBe(evidence);
  }, 120_000);
});

describe("what does not change", () => {
  it("stores a normal-range score exactly as the rule computed it", async () => {
    const context = await makeContext("normal");
    // A clear decline: 6,000 clicks to 1,399, which the rule scores by its
    // absolute size, 4,601 — the same magnitude seen in production.
    const page = await seedPage(context, "/decline", {
      clicks: 1_399,
      previousClicks: 6_000,
      impressions: 200_000,
      position: 8,
    });

    await detectAndStoreSignals(context, { now: NOW });

    const signal = await prisma.signal.findFirst({
      where: { websiteId: context.website.id, type: "TRAFFIC_DECLINE", pageId: page.id },
    });
    expect(signal).not.toBeNull();
    expect(String(signal!.score)).toBe("4601");
  }, 120_000);

  it("keeps the ordering that scores exist for", async () => {
    const context = await makeContext("order");
    await seedOverflowShape(context);
    await seedPage(context, "/small-decline", {
      clicks: 400,
      previousClicks: 1_000,
      impressions: 50_000,
      position: 8,
    });

    await detectAndStoreSignals(context, { now: NOW });

    const signals = await prisma.signal.findMany({
      where: { websiteId: context.website.id },
      orderBy: [{ severity: "desc" }, { score: "desc" }],
    });
    // Descending by score within a severity, with the huge score first among
    // its peers — the column ordering the list relies on still holds.
    const scores = signals.map((entry) => Number(entry.score));
    for (let index = 1; index < signals.length; index += 1) {
      if (signals[index - 1]!.severity === signals[index]!.severity) {
        expect(scores[index - 1]!).toBeGreaterThanOrEqual(scores[index]!);
      }
    }
  }, 120_000);

  it("is invisible to another tenant", async () => {
    const mine = await makeContext("mine");
    const theirs = await makeContext("theirs");
    await seedOverflowShape(mine);

    await detectAndStoreSignals(mine, { now: NOW });

    expect(await prisma.signal.count({ where: { websiteId: theirs.website.id } })).toBe(0);
    await detectAndStoreSignals(theirs, { now: NOW });
    expect(
      await prisma.signal.count({ where: { websiteId: theirs.website.id, type: "CTR_OPPORTUNITY" } }),
    ).toBe(0);
    const stored = await prisma.signal.findMany({ where: { websiteId: mine.website.id } });
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((entry) => entry.websiteId === mine.website.id)).toBe(true);
  }, 120_000);
});
