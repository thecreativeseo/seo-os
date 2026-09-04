import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { resetProvider } from "@/server/ai/registry";
import { DemoSeedError, seedP3Demo, type P3DemoResult, type P3DemoTargets } from "@/server/demo/p3";

/**
 * P3 Demo Mode (docs/P3_SPEC.md §33; P3_ACCEPTANCE_CRITERIA "Demo Mode").
 *
 * The seed is run against a throwaway demo tenant built here, not against the
 * shared demo website, so the test proves the mechanism rather than the state of
 * one database. What it holds: the five stories land with the counts the
 * blueprint asks for; every AI run is recorded against the stub, never a
 * vendor; the rule-constrained recommendation is really blocked; and the seed
 * refuses a website that is not a demo, or whose domain is a real workspace's.
 *
 * A seed run is five real diagnoses plus decisions - seconds, not milliseconds -
 * so the read-only assertions share one seeded tenant rather than each paying
 * for their own.
 */

/** Five diagnoses and five decisions through the real pipeline take a while. */
const SEED_TIMEOUT = 120_000;

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = { context: TenantContext; targets: P3DemoTargets };

async function makeDemoTenant(
  label: string,
  options: { isDemo?: boolean; domain?: string } = {},
): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `p3d-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `P3 demo ${label}`, slug: `p3d-${label}-${suffix}` },
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

  const host = options.domain ?? `${label}-${suffix}.demo.example`;

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: host,
      normalizedDomain: host,
      primaryLanguage: "en",
      primaryMarket: "GB",
      isDemo: options.isDemo ?? true,
    },
  });

  const context: TenantContext = { user, membership, organization, workspace, website };

  const paths = {
    commercial: "/product/cohort-reports",
    guide: "/blog/cohort-analysis-guide",
    pricing: "/pricing",
    compare: "/compare/mixpanel-alternative",
    thin: "/security",
  } as const;

  const pageIds: Record<string, string> = {};
  for (const [story, path] of Object.entries(paths)) {
    const page = await prisma.page.create({
      data: {
        websiteId: website.id,
        url: `https://${host}${path}`,
        normalizedUrl: `https://${host}${path}`,
        path,
        hostname: host,
        protocol: "https",
        sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
      },
    });
    pageIds[story] = page.id;
  }

  // The ownership-conflict story: a commercial keyword owned by the product
  // page and ranking on the guide.
  const keyword = await prisma.keyword.create({
    data: {
      websiteId: website.id,
      keyword: "cohort analysis tool",
      normalizedKeyword: "cohort analysis tool",
      locale: "en-GB",
      language: "en",
      market: "GB",
      intent: "COMMERCIAL",
    },
  });

  await prisma.keywordPageOwnership.create({
    data: {
      websiteId: website.id,
      keywordId: keyword.id,
      pageId: pageIds.commercial!,
      ownershipType: "PRIMARY",
      status: "ACTIVE",
    },
  });

  await prisma.rankingSnapshot.create({
    data: {
      websiteId: website.id,
      keywordId: keyword.id,
      pageId: pageIds.guide!,
      capturedAt: new Date(new Date().toISOString().slice(0, 10)),
      position: 9,
      rankingUrl: `https://${host}${paths.guide}`,
      rankingType: "ORGANIC",
      sourceProvider: "SEMRUSH",
    },
  });

  await prisma.businessGoal.create({
    data: {
      websiteId: website.id,
      title: "Generate demos",
      status: "ACTIVE",
      businessObjective: "More demo requests from organic",
      primaryMetric: "demo_requests",
    },
  });

  const businessContext = await prisma.businessContext.create({ data: { websiteId: website.id } });
  await prisma.businessContextVersion.create({
    data: {
      businessContextId: businessContext.id,
      versionNumber: 1,
      status: "APPROVED",
      companySummary: "A product analytics company, invented for the walkthrough.",
      primaryMarket: "GB",
      createdByUserId: user.id,
      approvedByUserId: user.id,
      approvedAt: new Date(),
    },
  });

  const rule = await prisma.seoRule.create({
    data: {
      websiteId: website.id,
      category: "Publishing",
      rule: "Pricing figures require finance approval before publication.",
      severity: "BLOCKING",
      appliesTo: "Pricing and comparison pages",
      active: true,
    },
  });

  // Measurements for every page but the thin one.
  const connection = await prisma.connection.create({
    data: {
      workspaceId: workspace.id,
      websiteId: website.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      status: "CONNECTED",
      connectedAt: new Date(),
    },
  });

  const query = await prisma.query.create({
    data: {
      websiteId: website.id,
      query: "cohort analysis tool",
      normalizedQuery: "cohort analysis tool",
    },
  });

  const today = new Date();
  const days = Array.from({ length: 40 }, (_, index) => {
    const date = new Date(today);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (index + 1));
    return date;
  });

  for (const story of ["commercial", "guide", "pricing", "compare"] as const) {
    await prisma.gscMetricDaily.createMany({
      data: days.map((date, index) => ({
        websiteId: website.id,
        pageId: pageIds[story]!,
        queryId: query.id,
        date,
        // The commercial page declines; the others hold.
        clicks: story === "commercial" ? (index < 20 ? 6 : 10) : 8,
        impressions: 400,
        position: 6.5,
        sourceConnectionId: connection.id,
      })),
    });
  }

  return {
    context,
    targets: {
      commercial: pageIds.commercial!,
      guide: pageIds.guide!,
      pricing: pageIds.pricing!,
      compare: pageIds.compare!,
      thin: pageIds.thin!,
      blockingRuleId: rule.id,
    },
  };
}

afterEach(() => {
  resetProvider();
});

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
      await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
    });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("a seeded demo tenant", () => {
  let fixture: Fixture;
  let result: P3DemoResult;

  beforeAll(async () => {
    fixture = await makeDemoTenant("stories");
    result = await seedP3Demo(fixture.context, fixture.targets);
  }, SEED_TIMEOUT);

  it("lands the five stories with the counts the blueprint asks for", () => {
    expect(result.diagnoses).toBe(5);
    expect(result.findings).toBeGreaterThanOrEqual(10);
    expect(result.findings).toBeLessThanOrEqual(15);
    expect(result.recommendations).toBeGreaterThanOrEqual(5);
    expect(result.recommendations).toBeLessThanOrEqual(8);
    expect(result.decisions).toBeGreaterThanOrEqual(3);
    // The rule-constrained story.
    expect(result.blocked).toBe(1);
    // The insufficient-evidence story and the guide's request for content.
    expect(result.needsEvidence).toBeGreaterThanOrEqual(2);
  });

  it("records every AI run against the stub, never a vendor", async () => {
    const runs = await prisma.aiRun.findMany({ where: { websiteId: fixture.context.website.id } });

    expect(runs.length).toBe(5);
    expect(runs.every((run) => run.provider === "stub" && run.status === "SUCCEEDED")).toBe(true);
  });

  it("produces findings whose citations were genuinely assembled", async () => {
    // The flagship finding cites real records: ownership, ranking, search data.
    const conflict = await prisma.diagnosisFinding.findFirstOrThrow({
      where: {
        diagnosis: { websiteId: fixture.context.website.id },
        category: "KEYWORD_OWNERSHIP_CONFLICT",
      },
      include: { evidence: true },
    });

    expect(conflict.verdict).toBe("STRONGLY_SUPPORTED");
    expect(conflict.downgradedFrom).toBeNull();
    expect(conflict.supportingEvidenceCount).toBeGreaterThan(0);
    for (const link of conflict.evidence) {
      // Every cited id is one the package held and resolved under this tenant.
      const ref = await prisma.evidenceRef.findFirst({
        where: {
          evidenceId: link.evidenceId,
          package: { websiteId: fixture.context.website.id },
        },
      });
      expect(ref).not.toBeNull();
    }

    // And the insufficient-evidence story says so rather than guessing.
    const insufficient = await prisma.diagnosisFinding.findFirstOrThrow({
      where: {
        diagnosis: { websiteId: fixture.context.website.id },
        category: "INSUFFICIENT_EVIDENCE",
      },
    });
    expect(insufficient.verdict).toBe("UNKNOWN");
    expect(Array.isArray(insufficient.missingEvidenceJson)).toBe(true);
  });

  it("blocks the pricing recommendation on the finance rule, awaiting an override", async () => {
    const blocked = await prisma.recommendation.findFirstOrThrow({
      where: { websiteId: fixture.context.website.id, blockedByRuleId: { not: null } },
      include: { blockedByRule: true, page: { select: { path: true } } },
    });

    expect(blocked.page?.path).toBe("/pricing");
    expect(blocked.blockedByRule?.id).toBe(fixture.targets.blockingRuleId);
    expect(blocked.blockedReason).toContain("finance approval");
    // Left for a person: the override is the demo moment, not something seeded.
    expect(blocked.status).toBe("AWAITING_REVIEW");
    expect(await prisma.decision.count({ where: { recommendationId: blocked.id } })).toBe(0);
  });

  it("records decisions by the demo owner, with one diagnosis fully reviewed", async () => {
    const decisions = await prisma.decision.findMany({
      where: { websiteId: fixture.context.website.id },
    });

    expect(decisions.every((d) => d.decidedByUserId === fixture.context.user.id)).toBe(true);
    expect(new Set(decisions.map((d) => d.decision))).toEqual(
      new Set(["APPROVED", "REJECTED", "MODIFIED", "NEEDS_EVIDENCE"]),
    );
    // The flagship diagnosis had both of its recommendations decided.
    expect(result.reviewed).toBeGreaterThanOrEqual(1);
  });
});

describe("running the seed again", () => {
  it(
    "is repeatable without duplicating anything",
    async () => {
      const { context, targets } = await makeDemoTenant("again");
      const first = await seedP3Demo(context, targets);
      const second = await seedP3Demo(context, targets);

      expect(second).toEqual(first);
      expect(await prisma.diagnosis.count({ where: { websiteId: context.website.id } })).toBe(5);
    },
    SEED_TIMEOUT,
  );
});

describe("what the seed refuses", () => {
  it("refuses a website that is not flagged as a demo", async () => {
    const { context, targets } = await makeDemoTenant("real", { isDemo: false });

    await expect(seedP3Demo(context, targets)).rejects.toMatchObject({ code: "not_demo" });
    expect(await prisma.diagnosis.count({ where: { websiteId: context.website.id } })).toBe(0);
  });

  it("refuses the real workspace's domain even if it were flagged", async () => {
    // The check the spec singles out: never synthetic P3 records in thecreativeseo.com.
    const { context, targets } = await makeDemoTenant("protected", {
      isDemo: true,
      domain: "thecreativeseo.com",
    });

    const error = await seedP3Demo(context, targets).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DemoSeedError);
    expect((error as DemoSeedError).code).toBe("protected");
    expect(await prisma.aiRun.count({ where: { websiteId: context.website.id } })).toBe(0);
  });
});
