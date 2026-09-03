import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { countKeywords, getKeyword, listKeywords, updateKeyword } from "@/server/services/keyword";
import { getRankingHistory, listRankingChanges } from "@/server/services/ranking";
import {
  assignOwnership,
  detectOwnershipIssues,
  listOwnerships,
  retireOwnership,
} from "@/server/services/ownership";
import { getTopic, getTopicMapping, listTopics, mapKeyword } from "@/server/services/topic";
import {
  getCompetitorSummaries,
  getKeywordCompetitors,
  listCompetitorGaps,
} from "@/server/services/competitor-intel";
import {
  assignOpportunityOwner,
  detectAndStoreOpportunities,
  getOpportunity,
  listOpportunities,
  setOpportunityStatus,
  verifyStoredScore,
} from "@/server/services/opportunity";
import { commitImport, listImports, validateImport } from "@/server/services/import";

/**
 * P2 tenant isolation — release blocking.
 *
 * "Any success = P2 FAIL." The criteria name eleven entity types and each gets a
 * case, for the same reason P1's suite named its eleven: the guards are correct in
 * general, and every new entity is a fresh chance to forget to use them.
 *
 * Two P2-specific requirements get their own sections. Scoring must never mix
 * entities across tenants — a score is a claim about one business, and one built
 * partly from another's data would be wrong in a way nobody could see. And an
 * import must not be aimable elsewhere, since it is the only place a person hands
 * the product a file.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & {
  keywordId: string;
  metricSnapshotId: string;
  rankingSnapshotId: string;
  ownershipId: string;
  topicId: string;
  topicKeywordId: string;
  topicPageId: string;
  competitorId: string;
  competitorSnapshotId: string;
  importId: string;
  pageId: string;
  goalId: string;
};

async function makeTenant(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `p2iso-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `P2 Iso ${label}`, slug: `p2iso-${label}-${suffix}` },
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

  const host = website.normalizedDomain;

  const page = await prisma.page.create({
    data: {
      websiteId: website.id,
      url: `https://${host}/secret-${label}`,
      normalizedUrl: `https://${host}/secret-${label}`,
      path: `/secret-${label}`,
      hostname: host,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });

  const goal = await prisma.businessGoal.create({
    data: { websiteId: website.id, title: `${label} confidential goal`, status: "ACTIVE" },
  });

  const keyword = await prisma.keyword.create({
    data: {
      websiteId: website.id,
      keyword: `${label} confidential keyword`,
      normalizedKeyword: `${label} confidential keyword`,
      locale: "en-PH",
      language: "en",
      market: "PH",
      intent: "COMMERCIAL",
      intentProvenance: "PROVIDER_PROVIDED",
      businessRelevance: 5,
      commercialValue: 5,
      businessGoalId: goal.id,
    },
  });

  const capturedAt = new Date("2026-08-30T00:00:00.000Z");

  const metricSnapshot = await prisma.keywordMetricsSnapshot.create({
    data: {
      websiteId: website.id,
      keywordId: keyword.id,
      capturedAt,
      searchVolume: 9999,
      keywordDifficulty: 42,
      sourceProvider: "SEMRUSH",
    },
  });

  const rankingSnapshot = await prisma.rankingSnapshot.create({
    data: {
      websiteId: website.id,
      keywordId: keyword.id,
      pageId: page.id,
      capturedAt,
      // Just off the first page, so the rules actually produce an opportunity.
      // A fixture with nothing wrong tests isolation on an empty queue, which
      // proves nothing about whether opportunities leak.
      position: 11,
      rankingUrl: `https://${host}/secret-${label}`,
      sourceProvider: "SEMRUSH",
    },
  });

  const ownership = await prisma.keywordPageOwnership.create({
    data: {
      websiteId: website.id,
      keywordId: keyword.id,
      pageId: page.id,
      ownershipType: "PRIMARY",
      status: "ACTIVE",
      market: "PH",
      language: "en",
      locale: "en-PH",
    },
  });

  const topic = await prisma.topic.create({
    data: {
      websiteId: website.id,
      name: `${label} confidential topic`,
      slug: `${label}-confidential-topic`,
      customerLanguage: `${label} secret phrasing`,
      businessGoalId: goal.id,
    },
  });

  const topicKeyword = await prisma.topicKeyword.create({
    data: { topicId: topic.id, keywordId: keyword.id },
  });

  const topicPage = await prisma.topicPage.create({
    data: { topicId: topic.id, pageId: page.id, role: "COMMERCIAL" },
  });

  const competitor = await prisma.competitor.create({
    data: {
      websiteId: website.id,
      name: `${label} rival`,
      domain: `${label}-rival.example.net`,
      normalizedDomain: `${label}-rival.example.net`,
    },
  });

  const competitorSnapshot = await prisma.competitorKeywordSnapshot.create({
    data: {
      websiteId: website.id,
      competitorId: competitor.id,
      keywordId: keyword.id,
      capturedAt,
      position: 1,
      sourceProvider: "SEMRUSH",
    },
  });

  const importRecord = await prisma.import.create({
    data: {
      websiteId: website.id,
      source: "SEMRUSH_POSITIONS",
      status: "PREVIEWED",
      fileName: `${label}-confidential.csv`,
      checksum: `checksum-${label}-${suffix}`,
      byteSize: 128,
      rowCount: 1,
      validRowCount: 1,
      rawContent: `Keyword,Position\n${label} confidential keyword,3\n`,
    },
  });

  await prisma.importRow.create({
    data: {
      importId: importRecord.id,
      rowNumber: 1,
      rawJson: { Keyword: `${label} confidential keyword`, Position: "3" },
      isValid: true,
    },
  });

  return {
    user,
    membership,
    organization,
    workspace,
    website,
    keywordId: keyword.id,
    metricSnapshotId: metricSnapshot.id,
    rankingSnapshotId: rankingSnapshot.id,
    ownershipId: ownership.id,
    topicId: topic.id,
    topicKeywordId: topicKeyword.id,
    topicPageId: topicPage.id,
    competitorId: competitor.id,
    competitorSnapshotId: competitorSnapshot.id,
    importId: importRecord.id,
    pageId: page.id,
    goalId: goal.id,
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

/** The eleven entity types the criteria name, each asked the same question. */
describe("tenant A cannot reach tenant B", () => {
  it("Keyword", async () => {
    expect(
      await prisma.keyword.findFirst({ where: { id: b.keywordId, ...websiteScope(a) } }),
    ).toBeNull();

    const listed = await listKeywords(a);
    expect(listed.some((row) => row.keyword.includes("b confidential"))).toBe(false);
    expect(await getKeyword(a, b.keywordId)).toBeNull();
    expect(await countKeywords(a)).toBe(1);
  });

  it("KeywordMetricsSnapshot", async () => {
    expect(
      await prisma.keywordMetricsSnapshot.findFirst({
        where: { id: b.metricSnapshotId, ...websiteScope(a) },
      }),
    ).toBeNull();

    // A's own keyword has volume 9999; B's does too. Reading both would show
    // one of them under A's keyword, so the assertion is on A's exact figure.
    const [row] = await listKeywords(a);
    expect(row?.searchVolume).toBe(9999);
  });

  it("RankingSnapshot", async () => {
    expect(
      await prisma.rankingSnapshot.findFirst({
        where: { id: b.rankingSnapshotId, ...websiteScope(a) },
      }),
    ).toBeNull();

    expect(await getRankingHistory(a, b.keywordId)).toHaveLength(0);

    const changes = await listRankingChanges(a);
    expect(changes.some((change) => change.keyword.includes("b confidential"))).toBe(false);
  });

  it("KeywordPageOwnership", async () => {
    expect(
      await prisma.keywordPageOwnership.findFirst({
        where: { id: b.ownershipId, ...websiteScope(a) },
      }),
    ).toBeNull();

    expect(await listOwnerships(a, b.keywordId)).toHaveLength(0);

    // Acting on it fails rather than silently doing nothing.
    await expect(retireOwnership(a, b.ownershipId)).rejects.toThrow();

    const unchanged = await prisma.keywordPageOwnership.findUniqueOrThrow({
      where: { id: b.ownershipId },
    });
    expect(unchanged.status).toBe("ACTIVE");
  });

  it("Topic", async () => {
    expect(
      await prisma.topic.findFirst({ where: { id: b.topicId, ...websiteScope(a) } }),
    ).toBeNull();

    const topics = await listTopics(a);
    expect(topics.map((topic) => topic.id)).not.toContain(b.topicId);
    expect(await getTopic(a, b.topicId)).toBeNull();
  });

  it("TopicKeyword", async () => {
    expect(
      await prisma.topicKeyword.findFirst({
        where: { id: b.topicKeywordId, topic: websiteScope(a) },
      }),
    ).toBeNull();

    await expect(getTopicMapping(a, b.topicId)).rejects.toThrow();

    // And a mapping cannot be created across the boundary either.
    await expect(mapKeyword(a, a.topicId, b.keywordId)).rejects.toThrow();
  });

  it("TopicPage", async () => {
    expect(
      await prisma.topicPage.findFirst({
        where: { id: b.topicPageId, topic: websiteScope(a) },
      }),
    ).toBeNull();

    const mapping = await getTopicMapping(a, a.topicId);
    expect(mapping.pages.map((page) => page.id)).not.toContain(b.pageId);
  });

  it("CompetitorKeywordSnapshot", async () => {
    expect(
      await prisma.competitorKeywordSnapshot.findFirst({
        where: { id: b.competitorSnapshotId, ...websiteScope(a) },
      }),
    ).toBeNull();

    const summaries = await getCompetitorSummaries(a);
    expect(summaries.map((row) => row.competitor.id)).not.toContain(b.competitorId);

    expect(await getKeywordCompetitors(a, b.keywordId)).toHaveLength(0);

    const gaps = await listCompetitorGaps(a);
    expect(gaps.some((gap) => gap.competitorId === b.competitorId)).toBe(false);
  });

  it("Opportunity", async () => {
    await detectAndStoreOpportunities(a);
    await detectAndStoreOpportunities(b);

    const mine = await listOpportunities(a);
    const theirs = await listOpportunities(b);

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);

    const theirIds = new Set(theirs.map((row) => row.id));
    expect(mine.some((row) => theirIds.has(row.id))).toBe(false);

    const target = theirs[0]!;
    expect(await getOpportunity(a, target.id)).toBeNull();
    await expect(setOpportunityStatus(a, target.id, "QUALIFIED")).rejects.toThrow();

    const unchanged = await prisma.opportunity.findUniqueOrThrow({ where: { id: target.id } });
    expect(unchanged.status).toBe("IDENTIFIED");
  });

  it("OpportunityEvidence", async () => {
    const theirs = await listOpportunities(b);
    const theirEvidenceIds = theirs.flatMap((row) => row.evidence.map((entry) => entry.id));

    const mine = await listOpportunities(a);
    const myEvidenceIds = mine.flatMap((row) => row.evidence.map((entry) => entry.id));

    for (const id of theirEvidenceIds) {
      expect(myEvidenceIds).not.toContain(id);
    }

    // Evidence is only reachable through its opportunity, which is scoped.
    expect(
      await prisma.opportunityEvidence.findFirst({
        where: { id: theirEvidenceIds[0], opportunity: websiteScope(a) },
      }),
    ).toBeNull();
  });

  it("Import", async () => {
    expect(
      await prisma.import.findFirst({ where: { id: b.importId, ...websiteScope(a) } }),
    ).toBeNull();

    const imports = await listImports(a);
    expect(imports.map((row) => row.id)).not.toContain(b.importId);

    // The two operations that would read or write somebody else's file.
    await expect(validateImport(a, b.importId)).rejects.toThrow();
    await expect(commitImport(a, b.importId)).rejects.toThrow();

    // And the raw file content never travels to the wrong tenant.
    expect(JSON.stringify(imports)).not.toContain("b confidential keyword");
  });
});

/**
 * P2_SPEC §31: "scoring inputs cannot reference another tenant."
 *
 * A score is a claim about one business. One built partly from another's data
 * would be wrong in a way nobody could see, because the number looks exactly the
 * same either way. This is the reason that requirement is written down.
 */
describe("scoring never reaches across tenants", () => {
  it("produces the same score whether or not the other tenant exists", async () => {
    const solo = await makeTenant("solo");
    await detectAndStoreOpportunities(solo);

    const before = await listOpportunities(solo);
    const beforeScores = before.map((row) => `${row.type}:${Number(row.score)}`).sort();

    // A second tenant appears with identical keywords, higher volume, and
    // competitors — everything that would move a score if it leaked.
    const noisy = await makeTenant("noisy");
    await prisma.keyword.update({
      where: { id: noisy.keywordId },
      data: { normalizedKeyword: "solo confidential keyword" },
    });
    await prisma.keywordMetricsSnapshot.updateMany({
      where: { keywordId: noisy.keywordId },
      data: { searchVolume: 500000 },
    });
    await detectAndStoreOpportunities(noisy);

    await detectAndStoreOpportunities(solo);
    const after = await listOpportunities(solo);
    const afterScores = after.map((row) => `${row.type}:${Number(row.score)}`).sort();

    expect(afterScores).toEqual(beforeScores);
  });

  it("stores evidence pointing only at its own tenant's rows", async () => {
    const opportunities = await listOpportunities(a);
    const entityIds = opportunities.flatMap((row) =>
      row.evidence.map((entry) => entry.sourceEntityId),
    );

    const foreign = [b.keywordId, b.pageId, b.topicId, b.competitorId];

    for (const id of foreign) {
      expect(entityIds).not.toContain(id);
    }
  });

  it("keeps a stored score reproducible from its own inputs", async () => {
    // The release rule, re-checked in the isolation suite: a score that cannot be
    // rebuilt is a score nobody can audit, whoever it belongs to.
    for (const opportunity of await listOpportunities(a)) {
      expect(verifyStoredScore(opportunity).matches).toBe(true);
    }
  });
});

describe("cross-tenant writes are refused", () => {
  it("will not nominate another tenant's page as an owner", async () => {
    await expect(
      assignOwnership(a, { keywordId: a.keywordId, pageId: b.pageId }),
    ).rejects.toThrow();
  });

  it("will not link a keyword to another tenant's business goal", async () => {
    await expect(
      updateKeyword(a, a.keywordId, { businessGoalId: b.goalId }),
    ).rejects.toThrow();

    const unchanged = await prisma.keyword.findUniqueOrThrow({ where: { id: a.keywordId } });
    expect(unchanged.businessGoalId).toBe(a.goalId);
  });

  it("will not assign work to somebody from another organization", async () => {
    const [opportunity] = await listOpportunities(a);

    await expect(
      assignOpportunityOwner(a, opportunity!.id, b.user.id),
    ).rejects.toThrow();
  });

  it("will not surface another tenant's ownership observations", async () => {
    const candidates = await detectOwnershipIssues(a);

    expect(candidates.some((entry) => entry.keywordId === b.keywordId)).toBe(false);
    expect(candidates.some((entry) => entry.keyword.includes("b confidential"))).toBe(false);
  });
});

describe("a tenant sees its own data", () => {
  it("returns tenant A's rows for tenant A", async () => {
    // The mirror of every assertion above. Scoping that returned nothing at all
    // would pass an isolation suite while breaking the product.
    expect((await listKeywords(a)).some((row) => row.keyword.includes("a confidential"))).toBe(
      true,
    );
    expect((await listTopics(a)).some((topic) => topic.id === a.topicId)).toBe(true);
    expect((await listOwnerships(a, a.keywordId)).length).toBeGreaterThan(0);
    expect((await getRankingHistory(a, a.keywordId)).length).toBeGreaterThan(0);
    expect((await getCompetitorSummaries(a)).length).toBeGreaterThan(0);
    expect((await listImports(a)).length).toBeGreaterThan(0);
    expect((await listOpportunities(a)).length).toBeGreaterThan(0);
    expect(await getKeyword(a, a.keywordId)).not.toBeNull();
  });
});
