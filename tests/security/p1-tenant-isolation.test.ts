import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { getDataHealth } from "@/server/services/data-health";
import { listSitemaps, syncSitemap, removeSitemap } from "@/server/services/sitemap";
import {
  getPageDetail,
  getPageMetrics,
  getQueryMetrics,
  getWebsiteSummary,
} from "@/server/services/metrics";
import { listSignals, setSignalStatus, SignalError } from "@/server/services/signals";
import { resolveWindows } from "@/lib/metrics/compare";

/**
 * P1 tenant isolation — release blocking.
 *
 * "Any successful cross-tenant access = P1 FAIL." The criteria name eleven entity
 * types explicitly, and each gets a case here: it is not enough that the guards are
 * correct in general, because every new entity is a new chance to forget the scope.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & {
  connectionId: string;
  pageId: string;
  queryId: string;
  snapshotId: string;
  syncRunId: string;
  sitemapId: string;
  signalId: string;
  evidenceId: string;
};

async function makeTenant(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `p1iso-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `P1 Iso ${label}`, slug: `p1iso-${label}-${suffix}` },
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

  const connection = await prisma.connection.create({
    data: {
      websiteId: website.id,
      workspaceId: workspace.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      status: "CONNECTED",
      externalPropertyName: `${label} property`,
      latestDataDate: new Date("2026-08-30"),
      lastSyncedAt: new Date(),
    },
  });

  // A credential exists so the isolation check covers stored secrets too.
  await prisma.credential.create({
    data: {
      connectionId: connection.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      encryptedPayload: `v1.aaa.bbb.${label}-ciphertext`,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    },
  });

  const snapshot = await prisma.sourceSnapshot.create({
    data: {
      websiteId: website.id,
      connectionId: connection.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      metadataJson: { origin: label },
    },
  });

  const syncRun = await prisma.syncRun.create({
    data: {
      websiteId: website.id,
      connectionId: connection.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      syncType: "GSC_METRICS",
      status: "SUCCEEDED",
      idempotencyKey: `${label}-${suffix}`,
    },
  });

  const page = await prisma.page.create({
    data: {
      websiteId: website.id,
      url: `https://${website.normalizedDomain}/secret-${label}`,
      normalizedUrl: `https://${website.normalizedDomain}/secret-${label}`,
      path: `/secret-${label}`,
      hostname: website.normalizedDomain,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });

  const query = await prisma.query.create({
    data: {
      websiteId: website.id,
      query: `${label} confidential query`,
      normalizedQuery: `${label} confidential query`,
    },
  });

  await prisma.gscMetricDaily.create({
    data: {
      websiteId: website.id,
      pageId: page.id,
      queryId: query.id,
      date: new Date("2026-08-30"),
      clicks: 999,
      impressions: 9999,
      ctr: 999 / 9999,
      position: 3,
      sourceConnectionId: connection.id,
      sourceSnapshotId: snapshot.id,
    },
  });

  await prisma.ga4LandingPageMetricDaily.create({
    data: {
      websiteId: website.id,
      pageId: page.id,
      date: new Date("2026-08-30"),
      sessions: 555,
      sourceConnectionId: connection.id,
    },
  });

  const sitemap = await prisma.sitemap.create({
    data: {
      websiteId: website.id,
      url: `https://${website.normalizedDomain}/sitemap.xml`,
      fetchStatus: "SUCCEEDED",
      urlCount: 42,
    },
  });

  const signal = await prisma.signal.create({
    data: {
      websiteId: website.id,
      type: "TRAFFIC_DECLINE",
      pageId: page.id,
      currentPeriodStart: new Date("2026-08-03"),
      currentPeriodEnd: new Date("2026-08-30"),
      comparisonPeriodStart: new Date("2026-07-06"),
      comparisonPeriodEnd: new Date("2026-08-02"),
      scoringModelVersion: "signals-v1",
      headline: `${label} confidential signal`,
    },
  });

  const evidence = await prisma.signalEvidence.create({
    data: {
      signalId: signal.id,
      evidenceType: "METRIC_COMPARISON",
      sourceEntityType: "Page",
      sourceEntityId: page.id,
      metricKey: "clicks",
      currentValue: 999,
      previousValue: 1999,
    },
  });

  return {
    user,
    membership,
    organization,
    workspace,
    website,
    connectionId: connection.id,
    pageId: page.id,
    queryId: query.id,
    snapshotId: snapshot.id,
    syncRunId: syncRun.id,
    sitemapId: sitemap.id,
    signalId: signal.id,
    evidenceId: evidence.id,
  };
}

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  a = await makeTenant("a");
  b = await makeTenant("b");
});

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

/**
 * The eleven entity types the criteria list, each asked the same question: holding
 * a valid session for tenant A, can anything belonging to tenant B be reached?
 */
describe("tenant A cannot reach tenant B", () => {
  it("Connection", async () => {
    const found = await prisma.connection.findFirst({
      where: { id: b.connectionId, ...websiteScope(a) },
    });
    expect(found).toBeNull();

    const health = await getDataHealth(a);
    expect(health.some((source) => source.propertyName === "b property")).toBe(false);
  });

  it("Credential", async () => {
    // Stored secrets must not be reachable through the scoped chain at all.
    const found = await prisma.credential.findFirst({
      where: {
        connection: { website: { workspace: { organizationId: a.organization.id } } },
        encryptedPayload: { contains: "b-ciphertext" },
      },
    });
    expect(found).toBeNull();
  });

  it("Page", async () => {
    const windows = resolveWindows("2026-08-30", "28d");

    expect(await prisma.page.findFirst({ where: { id: b.pageId, ...websiteScope(a) } })).toBeNull();
    expect(await getPageDetail(a, b.pageId, windows)).toBeNull();

    const pages = await getPageMetrics(a, windows);
    expect(pages.some((page) => page.path.includes("secret-b"))).toBe(false);
  });

  it("Query", async () => {
    const windows = resolveWindows("2026-08-30", "28d");

    expect(
      await prisma.query.findFirst({ where: { id: b.queryId, ...websiteScope(a) } }),
    ).toBeNull();

    const queries = await getQueryMetrics(a, windows);
    expect(queries.some((query) => query.query.includes("b confidential"))).toBe(false);
  });

  it("GscMetricDaily", async () => {
    const summary = await getWebsiteSummary(a, "90d");

    // A's own row is 999 clicks; B's is also 999. If scoping failed the total
    // would be 1998, so the assertion is on the exact figure.
    expect(summary.gsc.current.clicks).toBe(999);
    expect(summary.gsc.current.impressions).toBe(9999);
  });

  it("Ga4LandingPageMetricDaily", async () => {
    const summary = await getWebsiteSummary(a, "90d");
    expect(summary.ga4.current.sessions).toBe(555);
  });

  it("Sitemap", async () => {
    const sitemaps = await listSitemaps(a);
    expect(sitemaps.map((sitemap) => sitemap.id)).not.toContain(b.sitemapId);

    // Acting on another tenant's sitemap must fail rather than fetch it.
    await expect(syncSitemap(a, b.sitemapId)).rejects.toThrow();

    await removeSitemap(a, b.sitemapId);
    expect(await prisma.sitemap.count({ where: { id: b.sitemapId } })).toBe(1);
  });

  it("SourceSnapshot", async () => {
    const found = await prisma.sourceSnapshot.findFirst({
      where: { id: b.snapshotId, ...websiteScope(a) },
    });
    expect(found).toBeNull();
  });

  it("SyncRun", async () => {
    const found = await prisma.syncRun.findFirst({
      where: { id: b.syncRunId, ...websiteScope(a) },
    });
    expect(found).toBeNull();
  });

  it("Signal", async () => {
    const signals = await listSignals(a);
    expect(signals.map((signal) => signal.id)).not.toContain(b.signalId);
    expect(signals.some((signal) => signal.headline.includes("b confidential"))).toBe(false);

    await expect(setSignalStatus(a, b.signalId, "DISMISSED")).rejects.toBeInstanceOf(
      SignalError,
    );

    const unchanged = await prisma.signal.findUnique({ where: { id: b.signalId } });
    expect(unchanged?.status).toBe("DETECTED");
  });

  it("SignalEvidence", async () => {
    const signals = await listSignals(a);
    const evidenceIds = signals.flatMap((signal) =>
      signal.evidence.map((entry) => entry.id),
    );
    expect(evidenceIds).not.toContain(b.evidenceId);

    // Evidence is only reachable through its signal, which is scoped.
    const found = await prisma.signalEvidence.findFirst({
      where: { id: b.evidenceId, signal: websiteScope(a) },
    });
    expect(found).toBeNull();
  });
});

describe("a tenant sees its own data", () => {
  it("returns tenant A's rows for tenant A", async () => {
    const windows = resolveWindows("2026-08-30", "28d");

    // The mirror of every assertion above: scoping that returned nothing at all
    // would pass the isolation tests while breaking the product.
    expect((await getPageMetrics(a, windows)).some((page) => page.path.includes("secret-a"))).toBe(
      true,
    );
    expect(
      (await getQueryMetrics(a, windows)).some((query) =>
        query.query.includes("a confidential"),
      ),
    ).toBe(true);
    expect((await listSignals(a)).some((signal) => signal.id === a.signalId)).toBe(true);
    expect((await listSitemaps(a)).some((sitemap) => sitemap.id === a.sitemapId)).toBe(true);
    expect(await getPageDetail(a, a.pageId, windows)).not.toBeNull();
  });
});
