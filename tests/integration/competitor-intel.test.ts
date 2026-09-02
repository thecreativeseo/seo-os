import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  THIRD_PARTY_NOTICE,
  getCompetitorSummaries,
  getKeywordCompetitors,
  getTopicCompetitorOverlap,
  listCompetitorGaps,
} from "@/server/services/competitor-intel";
import { createTopic, mapKeyword } from "@/server/services/topic";
import { assignOwnership } from "@/server/services/ownership";

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `ci-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `CI ${label}`, slug: `ci-${label}-${suffix}` },
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

const makeCompetitor = (context: TenantContext, name: string, domain: string) =>
  prisma.competitor.create({
    data: {
      websiteId: context.website.id,
      name,
      domain,
      normalizedDomain: domain,
    },
  });

const makeKeyword = (context: TenantContext, text: string) =>
  prisma.keyword.create({
    data: {
      websiteId: context.website.id,
      keyword: text,
      normalizedKeyword: text.toLowerCase(),
      locale: "en-PH",
      language: "en",
      market: "PH",
    },
  });

function day(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}

const ourRank = (context: TenantContext, keywordId: string, date: string, position: number) =>
  prisma.rankingSnapshot.create({
    data: {
      websiteId: context.website.id,
      keywordId,
      capturedAt: day(date),
      position,
      sourceProvider: "SEMRUSH",
    },
  });

const theirRank = (
  context: TenantContext,
  competitorId: string,
  keywordId: string,
  date: string,
  position: number,
  provider: "SEMRUSH" | "AHREFS" = "SEMRUSH",
) =>
  prisma.competitorKeywordSnapshot.create({
    data: {
      websiteId: context.website.id,
      competitorId,
      keywordId,
      capturedAt: day(date),
      position,
      rankingUrl: "https://rival.example.com/page",
      sourceProvider: provider,
    },
  });

const volume = (context: TenantContext, keywordId: string, date: string, value: number) =>
  prisma.keywordMetricsSnapshot.create({
    data: {
      websiteId: context.website.id,
      keywordId,
      capturedAt: day(date),
      searchVolume: value,
      sourceProvider: "SEMRUSH",
    },
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

describe("summaries", () => {
  it("counts shared keywords and theirs alone", async () => {
    const context = await makeContext("summary");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");

    const shared = await makeKeyword(context, "payroll software");
    const theirsOnly = await makeKeyword(context, "hr outsourcing");

    await ourRank(context, shared.id, "2026-08-30", 8);
    await theirRank(context, rival.id, shared.id, "2026-08-30", 3);
    await theirRank(context, rival.id, theirsOnly.id, "2026-08-30", 5);

    const [summary] = await getCompetitorSummaries(context);

    expect(summary?.sharedKeywords).toBe(1);
    expect(summary?.theirKeywordsOnly).toBe(1);
    expect(summary?.aheadOfUs).toBe(1);
    expect(summary?.behindUs).toBe(0);
  });

  it("only compares positions captured on the same day", async () => {
    // Comparing our August position to their June one produces a number that
    // looks like a comparison and is not one: the SERP moved in between.
    const context = await makeContext("sameday");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");
    const keyword = await makeKeyword(context, "payroll software");

    await ourRank(context, keyword.id, "2026-06-01", 20);
    await theirRank(context, rival.id, keyword.id, "2026-08-30", 3);

    const [summary] = await getCompetitorSummaries(context);

    expect(summary?.aheadOfUs).toBe(0);
    expect(summary?.behindUs).toBe(0);
    // Still counted as a keyword they rank for and we do not, on that date.
    expect(summary?.theirKeywordsOnly).toBe(1);
  });

  it("lists a competitor with no evidence rather than hiding it", async () => {
    // A competitor somebody added and no provider has data for is a real state,
    // and showing zero is more useful than showing nothing.
    const context = await makeContext("empty");
    await makeCompetitor(context, "Unmeasured", "unmeasured.example.com");

    const [summary] = await getCompetitorSummaries(context);

    expect(summary?.competitor.name).toBe("Unmeasured");
    expect(summary?.sharedKeywords).toBe(0);
    expect(summary?.latestCapturedAt).toBeNull();
  });

  it("does not summarise another tenant's competitors", async () => {
    const a = await makeContext("s-iso-a");
    const b = await makeContext("s-iso-b");
    await makeCompetitor(b, "Theirs", "theirs.example.com");

    expect(await getCompetitorSummaries(a)).toHaveLength(0);
  });
});

describe("gaps", () => {
  it("separates not ranking at all from ranking behind them", async () => {
    const context = await makeContext("gaps");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");

    const absent = await makeKeyword(context, "payroll outsourcing");
    const behind = await makeKeyword(context, "payroll software");

    await theirRank(context, rival.id, absent.id, "2026-08-30", 4);
    await theirRank(context, rival.id, behind.id, "2026-08-30", 3);
    await ourRank(context, behind.id, "2026-08-30", 14);

    await volume(context, absent.id, "2026-08-30", 900);
    await volume(context, behind.id, "2026-08-30", 2400);

    const gaps = await listCompetitorGaps(context);
    const byKeyword = new Map(gaps.map((gap) => [gap.keyword, gap]));

    // The two call for different work, so they are kept apart.
    expect(byKeyword.get("payroll outsourcing")?.kind).toBe("no_ranking");
    expect(byKeyword.get("payroll software")?.kind).toBe("outranked");
    expect(byKeyword.get("payroll software")?.ourPosition).toBe(14);
  });

  it("ignores a competitor ranking beyond the depth that matters", async () => {
    const context = await makeContext("depth");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");
    const keyword = await makeKeyword(context, "obscure phrase");

    await theirRank(context, rival.id, keyword.id, "2026-08-30", 47);

    expect(await listCompetitorGaps(context)).toHaveLength(0);
  });

  it("does not call it a gap when we already rank above them", async () => {
    const context = await makeContext("winning");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");
    const keyword = await makeKeyword(context, "payroll software");

    await theirRank(context, rival.id, keyword.id, "2026-08-30", 6);
    await ourRank(context, keyword.id, "2026-08-30", 2);

    expect(await listCompetitorGaps(context)).toHaveLength(0);
  });

  it("reports whether a page already owns the keyword", async () => {
    const context = await makeContext("owned");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");
    const keyword = await makeKeyword(context, "payroll software");
    const host = context.website.normalizedDomain;

    const page = await prisma.page.create({
      data: {
        websiteId: context.website.id,
        url: `https://${host}/payroll`,
        normalizedUrl: `https://${host}/payroll`,
        path: "/payroll",
        hostname: host,
        protocol: "https",
        sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
      },
    });

    await assignOwnership(context, { keywordId: keyword.id, pageId: page.id });
    await theirRank(context, rival.id, keyword.id, "2026-08-30", 4);

    const [gap] = await listCompetitorGaps(context);

    // A gap on a keyword nobody owns needs a page; a gap on one that has an
    // owner needs that page to improve. Different work, so the fact is carried.
    expect(gap?.hasOwningPage).toBe(true);
  });

  it("orders by demand so the biggest gaps come first", async () => {
    const context = await makeContext("ordered");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");

    const small = await makeKeyword(context, "small keyword");
    const large = await makeKeyword(context, "large keyword");

    await theirRank(context, rival.id, small.id, "2026-08-30", 5);
    await theirRank(context, rival.id, large.id, "2026-08-30", 5);
    await volume(context, small.id, "2026-08-30", 100);
    await volume(context, large.id, "2026-08-30", 9000);

    const gaps = await listCompetitorGaps(context);

    expect(gaps[0]?.keyword).toBe("large keyword");
  });

  it("does not return another tenant's gaps", async () => {
    const a = await makeContext("g-iso-a");
    const b = await makeContext("g-iso-b");
    const rival = await makeCompetitor(b, "Rival", "rival.example.com");
    const keyword = await makeKeyword(b, "their keyword");

    await theirRank(b, rival.id, keyword.id, "2026-08-30", 2);

    expect(await listCompetitorGaps(a)).toHaveLength(0);
  });
});

/**
 * The spec's rule: do not present third-party estimates as first-party truth.
 * Attribution is carried on the data rather than left to a component to remember.
 */
describe("attribution", () => {
  it("labels every competitor figure with who measured it and when", async () => {
    const context = await makeContext("attrib");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");
    const keyword = await makeKeyword(context, "payroll software");

    await theirRank(context, rival.id, keyword.id, "2026-08-30", 3, "AHREFS");

    const [gap] = await listCompetitorGaps(context);
    const [competitor] = await getKeywordCompetitors(context, keyword.id);

    for (const attribution of [gap?.attribution, competitor?.attribution]) {
      expect(attribution?.firstParty).toBe(false);
      expect(attribution?.provider).toBe("AHREFS");
      expect(attribution?.capturedAt.toISOString().slice(0, 10)).toBe("2026-08-30");
    }
  });

  it("says plainly what the figures are", () => {
    expect(THIRD_PARTY_NOTICE).toMatch(/third-party/i);
    expect(THIRD_PARTY_NOTICE).toMatch(/not what this website measured/i);
  });

  it("computes no share, index or estimated traffic", async () => {
    // Those numbers are the easiest thing in SEO to generate and the hardest to
    // defend. Nothing here produces one, and this asserts the shape stays that
    // way as fields are added.
    const context = await makeContext("noshare");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");
    const keyword = await makeKeyword(context, "payroll software");
    await theirRank(context, rival.id, keyword.id, "2026-08-30", 3);

    const [summary] = await getCompetitorSummaries(context);
    const gaps = await listCompetitorGaps(context);
    const fields = [...Object.keys(summary ?? {}), ...Object.keys(gaps[0] ?? {})]
      .join(" ")
      .toLowerCase();

    // The modelled figures, not the word "shared" — sharedKeywords is a count of
    // rows we hold, which is exactly the kind of number that is defensible.
    for (const forbidden of [
      "shareofvoice",
      "marketshare",
      "trafficshare",
      "visibilityindex",
      "visibilityscore",
      "estimatedtraffic",
      "trafficestimate",
    ]) {
      expect(fields).not.toContain(forbidden);
    }

    // What is present is countable.
    expect(fields).toContain("sharedkeywords");
    expect(fields).toContain("aheadofus");
  });
});

describe("topic overlap", () => {
  it("counts competitor coverage against an authored topic", async () => {
    const context = await makeContext("topicoverlap");
    const rival = await makeCompetitor(context, "Rival", "rival.example.com");
    const topic = await createTopic(context, { name: "Payroll" });

    const covered = await makeKeyword(context, "payroll software");
    const gap = await makeKeyword(context, "payroll outsourcing");

    await mapKeyword(context, topic.id, covered.id);
    await mapKeyword(context, topic.id, gap.id);

    await ourRank(context, covered.id, "2026-08-30", 6);
    await theirRank(context, rival.id, covered.id, "2026-08-30", 3);
    await theirRank(context, rival.id, gap.id, "2026-08-30", 4);

    const [overlap] = await getTopicCompetitorOverlap(context);

    expect(overlap?.topicName).toBe("Payroll");
    expect(overlap?.keywordsInTopic).toBe(2);
    expect(overlap?.keywordsCompetitorsRankFor).toBe(2);
    expect(overlap?.keywordsWeRankFor).toBe(1);
  });
});
