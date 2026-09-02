import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  KeywordError,
  countKeywords,
  createKeyword,
  getKeyword,
  getKeywordCounts,
  listKeywords,
  updateKeyword,
} from "@/server/services/keyword";

/**
 * Keyword reads.
 *
 * The rule under test throughout: unavailable metrics remain null. A zero in a
 * volume column is a claim that nobody searched for something, and P2 must only
 * make that claim when a provider actually did.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `kw-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Keyword ${label}`, slug: `kw-${label}-${suffix}` },
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
      primaryLanguage: "en",
      primaryMarket: "PH",
    },
  });

  return { user, membership, organization, workspace, website };
}

async function seedKeyword(
  context: TenantContext,
  text: string,
  options: {
    metrics?: { provider: "SEMRUSH" | "AHREFS"; date: string; volume?: number | null; kd?: number | null }[];
    rankings?: { provider: "SEMRUSH" | "AHREFS"; date: string; position: number; url?: string }[];
  } = {},
) {
  const keyword = await prisma.keyword.create({
    data: {
      websiteId: context.website.id,
      keyword: text,
      normalizedKeyword: text.toLowerCase(),
      locale: "en-PH",
      language: "en",
      market: "PH",
    },
  });

  for (const metric of options.metrics ?? []) {
    await prisma.keywordMetricsSnapshot.create({
      data: {
        websiteId: context.website.id,
        keywordId: keyword.id,
        capturedAt: new Date(`${metric.date}T00:00:00.000Z`),
        searchVolume: metric.volume ?? null,
        keywordDifficulty: metric.kd ?? null,
        sourceProvider: metric.provider,
      },
    });
  }

  for (const ranking of options.rankings ?? []) {
    await prisma.rankingSnapshot.create({
      data: {
        websiteId: context.website.id,
        keywordId: keyword.id,
        capturedAt: new Date(`${ranking.date}T00:00:00.000Z`),
        position: ranking.position,
        rankingUrl: ranking.url ?? null,
        sourceProvider: ranking.provider,
      },
    });
  }

  return keyword;
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

describe("listing keywords", () => {
  it("shows the latest reading and names who produced it", async () => {
    const context = await makeContext("latest");

    await seedKeyword(context, "payroll software", {
      metrics: [
        { provider: "SEMRUSH", date: "2026-08-01", volume: 2400, kd: 51 },
        { provider: "AHREFS", date: "2026-08-30", volume: 1900, kd: 38 },
      ],
      rankings: [{ provider: "AHREFS", date: "2026-08-30", position: 9 }],
    });

    const [row] = await listKeywords(context);

    expect(row?.searchVolume).toBe(1900);
    expect(row?.searchVolumeProvider).toBe("AHREFS");
    expect(row?.keywordDifficulty).toBe(38);
    expect(row?.position).toBe(9);

    // Not averaged, and not silently one vendor's number wearing no label.
    expect(row?.searchVolume).not.toBe(2150);
  });

  it("flags a material disagreement between providers", async () => {
    const context = await makeContext("disagree");

    await seedKeyword(context, "big gap", {
      metrics: [
        { provider: "SEMRUSH", date: "2026-08-30", volume: 2400 },
        { provider: "AHREFS", date: "2026-08-30", volume: 900 },
      ],
    });
    await seedKeyword(context, "small gap", {
      metrics: [
        { provider: "SEMRUSH", date: "2026-08-30", volume: 2400 },
        { provider: "AHREFS", date: "2026-08-30", volume: 2200 },
      ],
    });

    const rows = await listKeywords(context);
    const byKeyword = new Map(rows.map((row) => [row.normalizedKeyword, row]));

    expect(byKeyword.get("big gap")?.volumeDisagreement).toBe(true);
    expect(byKeyword.get("small gap")?.volumeDisagreement).toBe(false);
  });

  it("leaves an unmeasured keyword null rather than zero", async () => {
    const context = await makeContext("nulls");
    await seedKeyword(context, "never measured");

    const [row] = await listKeywords(context);

    // "No demand" and "we have not measured the demand" are different facts, and
    // only one of them is a reason not to work on something.
    expect(row?.searchVolume).toBeNull();
    expect(row?.keywordDifficulty).toBeNull();
    expect(row?.position).toBeNull();
    expect(row?.searchVolumeProvider).toBeNull();
    expect(row?.volumeDisagreement).toBe(false);
  });

  it("keeps a null volume distinct from a measured zero", async () => {
    const context = await makeContext("zero");

    await seedKeyword(context, "measured zero", {
      metrics: [{ provider: "SEMRUSH", date: "2026-08-30", volume: 0 }],
    });
    await seedKeyword(context, "unmeasured", {
      metrics: [{ provider: "SEMRUSH", date: "2026-08-30", volume: null }],
    });

    const rows = await listKeywords(context);
    const byKeyword = new Map(rows.map((row) => [row.normalizedKeyword, row]));

    expect(byKeyword.get("measured zero")?.searchVolume).toBe(0);
    expect(byKeyword.get("unmeasured")?.searchVolume).toBeNull();
  });

  it("searches the normalized form", async () => {
    const context = await makeContext("search");
    await seedKeyword(context, "payroll software philippines");
    await seedKeyword(context, "hr software");

    const results = await listKeywords(context, { search: "PAYROLL" });

    expect(results).toHaveLength(1);
    expect(results[0]?.normalizedKeyword).toBe("payroll software philippines");
    expect(await countKeywords(context)).toBe(2);
  });

  it("filters to keywords a given provider has reported on", async () => {
    const context = await makeContext("byprovider");

    await seedKeyword(context, "semrush only", {
      metrics: [{ provider: "SEMRUSH", date: "2026-08-30", volume: 100 }],
    });
    await seedKeyword(context, "ahrefs only", {
      metrics: [{ provider: "AHREFS", date: "2026-08-30", volume: 200 }],
    });

    const ahrefs = await listKeywords(context, { provider: "AHREFS" });

    expect(ahrefs).toHaveLength(1);
    expect(ahrefs[0]?.normalizedKeyword).toBe("ahrefs only");
  });

  it("does not list another tenant's keywords", async () => {
    const a = await makeContext("iso-a");
    const b = await makeContext("iso-b");

    await seedKeyword(b, "confidential keyword", {
      metrics: [{ provider: "SEMRUSH", date: "2026-08-30", volume: 9999 }],
    });

    expect(await listKeywords(a)).toHaveLength(0);
    expect(await countKeywords(a)).toBe(0);
  });
});

describe("keyword detail", () => {
  it("keeps every provider's reading, not only the displayed one", async () => {
    const context = await makeContext("detail");

    const keyword = await seedKeyword(context, "payroll software", {
      metrics: [
        { provider: "SEMRUSH", date: "2026-08-30", volume: 2400, kd: 51 },
        { provider: "AHREFS", date: "2026-08-30", volume: 1900, kd: 38 },
      ],
    });

    const detail = await getKeyword(context, keyword.id);

    expect(detail?.metrics).toHaveLength(2);
    expect(detail?.metrics.map((reading) => reading.provider).sort()).toEqual([
      "AHREFS",
      "SEMRUSH",
    ]);
    // The disagreement is visible rather than resolved away.
    expect(detail?.metrics.map((reading) => reading.searchVolume).sort()).toEqual([1900, 2400]);
  });

  it("preserves history rather than overwriting it", async () => {
    const context = await makeContext("history");

    const keyword = await seedKeyword(context, "seasonal", {
      metrics: [
        { provider: "SEMRUSH", date: "2026-06-30", volume: 800 },
        { provider: "SEMRUSH", date: "2026-07-30", volume: 1600 },
        { provider: "SEMRUSH", date: "2026-08-30", volume: 3200 },
      ],
    });

    const detail = await getKeyword(context, keyword.id);

    expect(detail?.metricHistory).toHaveLength(3);
    expect(detail?.metricHistory[0]?.searchVolume).toBe(3200);
    // The current reading is the newest, and the older ones are still there to
    // explain why something was prioritised last quarter.
    expect(detail?.row.searchVolume).toBe(3200);
  });

  it("joins Search Console evidence for the same string", async () => {
    const context = await makeContext("firstparty");
    const host = context.website.normalizedDomain;

    const keyword = await seedKeyword(context, "payroll software", {
      metrics: [{ provider: "SEMRUSH", date: "2026-08-30", volume: 2400 }],
    });

    const connection = await prisma.connection.create({
      data: {
        websiteId: context.website.id,
        workspaceId: context.workspace.id,
        provider: "GOOGLE_SEARCH_CONSOLE",
        status: "CONNECTED",
      },
    });
    const page = await prisma.page.create({
      data: {
        websiteId: context.website.id,
        url: `https://${host}/payroll/`,
        normalizedUrl: `https://${host}/payroll`,
        path: "/payroll",
        hostname: host,
        protocol: "https",
        sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
      },
    });
    // The same string Search Console reported — the join that makes P2 work.
    const query = await prisma.query.create({
      data: {
        websiteId: context.website.id,
        query: "Payroll Software",
        normalizedQuery: "payroll software",
      },
    });

    await prisma.gscMetricDaily.create({
      data: {
        websiteId: context.website.id,
        pageId: page.id,
        queryId: query.id,
        date: new Date(),
        clicks: 40,
        impressions: 1000,
        ctr: 0.04,
        position: 8,
        sourceConnectionId: connection.id,
      },
    });

    const detail = await getKeyword(context, keyword.id);

    expect(detail?.firstParty?.clicks).toBe(40);
    expect(detail?.firstParty?.impressions).toBe(1000);
    // SUM(clicks) / SUM(impressions), never an average of row CTRs.
    expect(detail?.firstParty?.ctr).toBeCloseTo(0.04);
  });

  it("returns null first-party evidence when Search Console has never seen it", async () => {
    const context = await makeContext("noevidence");
    const keyword = await seedKeyword(context, "unsearched phrase");

    const detail = await getKeyword(context, keyword.id);

    // Null, not zero clicks: we have not measured it, which is different from
    // having measured nothing.
    expect(detail?.firstParty).toBeNull();
  });

  it("does not return another tenant's keyword", async () => {
    const a = await makeContext("d-iso-a");
    const b = await makeContext("d-iso-b");

    const keyword = await seedKeyword(b, "theirs");

    expect(await getKeyword(a, keyword.id)).toBeNull();
  });
});

describe("human judgement", () => {
  it("marks an intent a person set as theirs", async () => {
    const context = await makeContext("intent");
    const keyword = await seedKeyword(context, "payroll software");

    const updated = await updateKeyword(context, keyword.id, { intent: "TRANSACTIONAL" });

    expect(updated.intent).toBe("TRANSACTIONAL");
    // This is what stops the next import overwriting it.
    expect(updated.intentProvenance).toBe("USER_PROVIDED");
  });

  it("records the change in the audit trail", async () => {
    const context = await makeContext("audited");
    const keyword = await seedKeyword(context, "audited keyword");

    await updateKeyword(context, keyword.id, { businessRelevance: 5 });

    const event = await prisma.auditEvent.findFirst({
      where: { entityType: "Keyword", entityId: keyword.id },
    });

    expect(event?.action).toBe("UPDATE");
    expect(JSON.stringify(event?.afterSnapshotJson)).toContain("5");
  });

  it("refuses a relevance outside the scale", async () => {
    const context = await makeContext("scale");
    const keyword = await seedKeyword(context, "scale test");

    await expect(
      updateKeyword(context, keyword.id, { businessRelevance: 9 }),
    ).rejects.toBeInstanceOf(KeywordError);
  });

  it("refuses to update another tenant's keyword", async () => {
    const a = await makeContext("u-iso-a");
    const b = await makeContext("u-iso-b");
    const keyword = await seedKeyword(b, "theirs");

    await expect(
      updateKeyword(a, keyword.id, { intent: "COMMERCIAL" }),
    ).rejects.toBeInstanceOf(KeywordError);

    const unchanged = await prisma.keyword.findUniqueOrThrow({ where: { id: keyword.id } });
    expect(unchanged.intent).toBe("UNKNOWN");
  });

  it("adds a keyword by hand, with no invented metrics", async () => {
    const context = await makeContext("manual");

    const created = await createKeyword(context, { keyword: "  Payroll Outsourcing  " });

    expect(created.normalizedKeyword).toBe("payroll outsourcing");
    expect(created.market).toBe("PH");
    expect(created.intentProvenance).toBe("UNKNOWN");

    // A keyword the business cares about with no demand data is a legitimate
    // state — and precisely the gap P2 exists to surface.
    const [row] = await listKeywords(context);
    expect(row?.searchVolume).toBeNull();
  });

  it("refuses a duplicate in the same market", async () => {
    const context = await makeContext("dupe");
    await createKeyword(context, { keyword: "payroll software" });

    await expect(
      createKeyword(context, { keyword: "Payroll  Software" }),
    ).rejects.toBeInstanceOf(KeywordError);
  });
});

describe("counts", () => {
  it("reports the states that need attention", async () => {
    const context = await makeContext("counts");

    await seedKeyword(context, "complete", {
      metrics: [{ provider: "SEMRUSH", date: "2026-08-30", volume: 100 }],
      rankings: [{ provider: "SEMRUSH", date: "2026-08-30", position: 4 }],
    });
    await seedKeyword(context, "no volume", {
      rankings: [{ provider: "SEMRUSH", date: "2026-08-30", position: 12 }],
    });
    await seedKeyword(context, "nothing at all");

    const counts = await getKeywordCounts(context);

    expect(counts.total).toBe(3);
    expect(counts.withoutVolume).toBe(2);
    expect(counts.withoutRanking).toBe(1);
    expect(counts.unknownIntent).toBe(3);
  });
});
