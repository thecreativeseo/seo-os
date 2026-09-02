import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import {
  detectAndStoreSignals,
  getSignalCounts,
  listSignals,
  setSignalStatus,
  SignalError,
} from "@/server/services/signals";
import { CAUSAL_VOCABULARY, PRESCRIPTIVE_VOCABULARY } from "@/lib/signals/templates";
import type { TenantContext } from "@/server/auth/guards";

const organizationIds: string[] = [];
const userIds: string[] = [];

/** A fixed "now" so freshness never depends on when the suite runs. */
const NOW = new Date("2026-09-02T09:00:00Z");
const LATEST = "2026-08-30";

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `sig-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Signals ${label}`, slug: `sig-${label}-${suffix}` },
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

/**
 * Seeds a page with a given click total in each window, spread over the days so
 * the aggregation layer has something realistic to sum.
 */
async function seedPage(
  context: TenantContext,
  path: string,
  options: { currentClicks: number; previousClicks: number; impressions?: number; position?: number },
) {
  const connection = await prisma.connection.upsert({
    where: {
      websiteId_provider: {
        websiteId: context.website.id,
        provider: "GOOGLE_SEARCH_CONSOLE",
      },
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

  const impressions = options.impressions ?? Math.max(options.currentClicks * 20, 100);
  const position = options.position ?? 5;

  await prisma.gscMetricDaily.createMany({
    data: [
      {
        websiteId: context.website.id,
        pageId: page.id,
        queryId: query.id,
        date: new Date(LATEST),
        clicks: options.currentClicks,
        impressions,
        ctr: options.currentClicks / impressions,
        position,
        sourceConnectionId: connection.id,
      },
      {
        websiteId: context.website.id,
        pageId: page.id,
        queryId: query.id,
        // Inside the previous 28-day window.
        date: new Date("2026-07-20"),
        clicks: options.previousClicks,
        impressions,
        ctr: options.previousClicks / impressions,
        position,
        sourceConnectionId: connection.id,
      },
    ],
  });

  return { page, query };
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

describe("detection and persistence", () => {
  it("stores a decline with its evidence", async () => {
    const context = await makeContext("decline");
    await seedPage(context, "/payroll-software", { currentClicks: 920, previousClicks: 1240 });

    await detectAndStoreSignals(context, { now: NOW });

    const signals = await listSignals(context);
    const decline = signals.find((signal) => signal.type === "TRAFFIC_DECLINE")!;

    expect(decline).toBeDefined();
    expect(decline.page?.path).toBe("/payroll-software");
    expect(decline.severity).toBe("MEDIUM");
    expect(decline.scoringModelVersion).toBe("signals-v1");
    expect(decline.currentPeriodStart.toISOString().slice(0, 10)).toBe("2026-08-03");
    expect(decline.comparisonPeriodStart.toISOString().slice(0, 10)).toBe("2026-07-06");

    // Every signal must be explainable from persisted numbers.
    const clicks = decline.evidence.find((entry) => entry.metricKey === "clicks")!;
    expect(Number(clicks.currentValue)).toBe(920);
    expect(Number(clicks.previousValue)).toBe(1240);
  });

  it("does not duplicate on a repeated run", async () => {
    const context = await makeContext("idempotent");
    await seedPage(context, "/a", { currentClicks: 100, previousClicks: 400 });

    await detectAndStoreSignals(context, { now: NOW });
    const first = await listSignals(context);

    await detectAndStoreSignals(context, { now: NOW });
    const second = await listSignals(context);

    expect(second).toHaveLength(first.length);
    expect(second.map((signal) => signal.id).sort()).toEqual(
      first.map((signal) => signal.id).sort(),
    );
  });

  it("does not duplicate a signal that has no page and no query", async () => {
    // The case Postgres would allow by default: NULL != NULL, so a freshness risk
    // would insert a fresh row on every run and the Attention list would grow
    // without bound.
    const context = await makeContext("freshdupe");
    await seedPage(context, "/a", { currentClicks: 100, previousClicks: 100 });

    // Data is far behind, so a freshness risk is detected.
    const stale = new Date("2026-09-20T09:00:00Z");
    await detectAndStoreSignals(context, { now: stale });
    await detectAndStoreSignals(context, { now: stale });
    await detectAndStoreSignals(context, { now: stale });

    const risks = await prisma.signal.findMany({
      where: { websiteId: context.website.id, type: "DATA_FRESHNESS_RISK" },
    });

    expect(risks).toHaveLength(1);
  });

  it("replaces evidence rather than accumulating it", async () => {
    const context = await makeContext("evidence");
    await seedPage(context, "/a", { currentClicks: 100, previousClicks: 400 });

    await detectAndStoreSignals(context, { now: NOW });
    await detectAndStoreSignals(context, { now: NOW });

    const signal = (await listSignals(context)).find(
      (entry) => entry.type === "TRAFFIC_DECLINE",
    )!;

    // Three metric keys, not six.
    expect(signal.evidence).toHaveLength(3);
  });

  it("resolves a signal that no longer holds instead of deleting it", async () => {
    const context = await makeContext("resolve");
    const { page } = await seedPage(context, "/a", { currentClicks: 100, previousClicks: 400 });

    await detectAndStoreSignals(context, { now: NOW });
    expect(
      (await listSignals(context, { status: "DETECTED" })).some(
        (signal) => signal.type === "TRAFFIC_DECLINE",
      ),
    ).toBe(true);

    // Traffic recovers.
    await prisma.gscMetricDaily.updateMany({
      where: { pageId: page.id, date: new Date(LATEST) },
      data: { clicks: 400 },
    });

    const result = await detectAndStoreSignals(context, { now: NOW });
    expect(result.resolved).toBeGreaterThan(0);

    const resolved = await prisma.signal.findMany({
      where: { websiteId: context.website.id, type: "TRAFFIC_DECLINE" },
    });

    // Still on the record, marked resolved.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.status).toBe("RESOLVED");
    expect(resolved[0]?.resolvedAt).not.toBeNull();
  });

  it("keeps a human decision when detection runs again", async () => {
    const context = await makeContext("decision");
    await seedPage(context, "/a", { currentClicks: 100, previousClicks: 400 });

    await detectAndStoreSignals(context, { now: NOW });
    const signal = (await listSignals(context)).find(
      (entry) => entry.type === "TRAFFIC_DECLINE",
    )!;

    await setSignalStatus(context, signal.id, "DISMISSED");
    await detectAndStoreSignals(context, { now: NOW });

    const after = await prisma.signal.findUnique({ where: { id: signal.id } });
    // Re-running detection must not quietly undo someone's judgement.
    expect(after?.status).toBe("DISMISSED");
  });
});

describe("language", () => {
  it("never claims a cause or prescribes an action", async () => {
    const context = await makeContext("language");
    await seedPage(context, "/down", { currentClicks: 100, previousClicks: 500 });
    await seedPage(context, "/up", { currentClicks: 500, previousClicks: 100 });

    await detectAndStoreSignals(context, { now: NOW });

    for (const signal of await listSignals(context)) {
      expect(signal.headline).not.toMatch(CAUSAL_VOCABULARY);
      expect(signal.summary ?? "").not.toMatch(CAUSAL_VOCABULARY);
      expect(signal.headline).not.toMatch(PRESCRIPTIVE_VOCABULARY);
      expect(signal.summary ?? "").not.toMatch(PRESCRIPTIVE_VOCABULARY);
    }
  });
});

describe("review", () => {
  it("counts detected signals by type", async () => {
    const context = await makeContext("counts");
    await seedPage(context, "/a", { currentClicks: 100, previousClicks: 400 });

    await detectAndStoreSignals(context, { now: NOW });
    const counts = await getSignalCounts(context);

    expect(counts.TRAFFIC_DECLINE).toBeGreaterThan(0);
  });

  it("refuses to change another tenant's signal", async () => {
    const a = await makeContext("iso-a");
    const b = await makeContext("iso-b");
    await seedPage(b, "/a", { currentClicks: 100, previousClicks: 400 });

    await detectAndStoreSignals(b, { now: NOW });
    const signalB = (await listSignals(b))[0]!;

    await expect(setSignalStatus(a, signalB.id, "DISMISSED")).rejects.toBeInstanceOf(
      SignalError,
    );

    const unchanged = await prisma.signal.findUnique({ where: { id: signalB.id } });
    expect(unchanged?.status).toBe("DETECTED");
  });

  it("does not list another tenant's signals", async () => {
    const a = await makeContext("iso-list-a");
    const b = await makeContext("iso-list-b");
    await seedPage(b, "/secret", { currentClicks: 100, previousClicks: 400 });

    await detectAndStoreSignals(b, { now: NOW });

    expect(await listSignals(a)).toHaveLength(0);
    expect(await getSignalCounts(a)).toEqual({});
  });
});
