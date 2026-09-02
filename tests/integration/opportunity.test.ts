import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  OpportunityError,
  assignOpportunityOwner,
  detectAndStoreOpportunities,
  getNextBestStep,
  getOpportunity,
  getOpportunityCounts,
  listOpportunities,
  setOpportunityStatus,
  verifyStoredScore,
} from "@/server/services/opportunity";
import { assignOwnership } from "@/server/services/ownership";
import { KeywordError, updateKeyword } from "@/server/services/keyword";

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `opp-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Opp ${label}`, slug: `opp-${label}-${suffix}` },
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

const makePage = (context: TenantContext, path: string) =>
  prisma.page.create({
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

const makeKeyword = (
  context: TenantContext,
  text: string,
  extra: { intent?: "COMMERCIAL" | "INFORMATIONAL"; relevance?: number } = {},
) =>
  prisma.keyword.create({
    data: {
      websiteId: context.website.id,
      keyword: text,
      normalizedKeyword: text.toLowerCase(),
      locale: "en-PH",
      language: "en",
      market: "PH",
      intent: extra.intent ?? "COMMERCIAL",
      intentProvenance: "PROVIDER_PROVIDED",
      businessRelevance: extra.relevance ?? 4,
    },
  });

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

const addVolume = (context: TenantContext, keywordId: string, value: number) =>
  prisma.keywordMetricsSnapshot.create({
    data: {
      websiteId: context.website.id,
      keywordId,
      capturedAt: daysAgo(2),
      searchVolume: value,
      sourceProvider: "SEMRUSH",
    },
  });

const addRanking = (
  context: TenantContext,
  keywordId: string,
  position: number,
  pageId: string | null,
) =>
  prisma.rankingSnapshot.create({
    data: {
      websiteId: context.website.id,
      keywordId,
      capturedAt: daysAgo(2),
      position,
      pageId,
      sourceProvider: "SEMRUSH",
    },
  });

/** A keyword that ranks just off page one, on a page nominated to own it. */
async function seedCommercialRanking(context: TenantContext) {
  const page = await makePage(context, "/payroll-software");
  const keyword = await makeKeyword(context, "payroll software philippines");

  await addVolume(context, keyword.id, 2400);
  await addRanking(context, keyword.id, 11, page.id);
  await assignOwnership(context, { keywordId: keyword.id, pageId: page.id });

  return { page, keyword };
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

describe("detection", () => {
  it("stores an opportunity with its evidence and breakdown", async () => {
    const context = await makeContext("detect");
    await seedCommercialRanking(context);

    const summary = await detectAndStoreOpportunities(context);

    expect(summary.created).toBeGreaterThan(0);

    const [opportunity] = await listOpportunities(context);

    expect(opportunity?.type).toBe("COMMERCIAL_RANKING");
    expect(opportunity?.status).toBe("IDENTIFIED");
    expect(opportunity?.evidence.length).toBeGreaterThan(0);
    expect(opportunity?.scoringModelVersion).toBe("opportunity-scoring-v1");
  });

  /**
   * The release rule, made executable. If this fails, the queue holds a number
   * nobody can reproduce, which is a P2 FAIL by definition.
   */
  it("stores a score that can be rebuilt from the record alone", async () => {
    const context = await makeContext("reproducible");
    await seedCommercialRanking(context);
    await detectAndStoreOpportunities(context);

    const [stored] = await listOpportunities(context);
    const verification = verifyStoredScore(stored!);

    expect(verification.stored).not.toBeNull();
    expect(verification.recomputed).toBe(verification.stored);
    expect(verification.matches).toBe(true);
  });

  it("stores a reason beside every criterion", async () => {
    const context = await makeContext("basis");
    await seedCommercialRanking(context);
    await detectAndStoreOpportunities(context);

    const [stored] = await listOpportunities(context);
    const inputs = stored!.scoreInputsJson as {
      subScores: { key: string; score: number; basis: string }[];
    };

    expect(inputs.subScores).toHaveLength(8);
    for (const subScore of inputs.subScores) {
      expect(subScore.basis.length).toBeGreaterThan(0);
    }
  });

  it("updates rather than duplicating on a second run", async () => {
    const context = await makeContext("rerun");
    await seedCommercialRanking(context);

    const first = await detectAndStoreOpportunities(context);
    const second = await detectAndStoreOpportunities(context);

    expect(second.created).toBe(0);
    expect(second.updated).toBe(first.created);
    expect(await prisma.opportunity.count({ where: { websiteId: context.website.id } })).toBe(
      first.created,
    );
  });

  it("does not duplicate an opportunity whose keyword and page are both null", async () => {
    // The NULLS NOT DISTINCT case. Under Postgres's default, a topic gap with no
    // keyword and no page would insert a fresh copy on every run.
    const context = await makeContext("nulls");
    const topic = await prisma.topic.create({
      data: { websiteId: context.website.id, name: "Payroll", slug: "payroll" },
    });

    for (let index = 0; index < 4; index += 1) {
      const keyword = await makeKeyword(context, `payroll keyword ${index}`);
      await addVolume(context, keyword.id, 500);
      await prisma.topicKeyword.create({
        data: { topicId: topic.id, keywordId: keyword.id },
      });
    }

    await detectAndStoreOpportunities(context);
    await detectAndStoreOpportunities(context);

    const gaps = await prisma.opportunity.findMany({
      where: { websiteId: context.website.id, type: "TOPIC_GAP" },
    });

    expect(gaps).toHaveLength(1);
  });

  it("refreshes evidence rather than accumulating it", async () => {
    const context = await makeContext("evidence");
    await seedCommercialRanking(context);

    await detectAndStoreOpportunities(context);
    const before = await prisma.opportunityEvidence.count();
    await detectAndStoreOpportunities(context);
    const after = await prisma.opportunityEvidence.count();

    expect(after).toBe(before);
  });
});

/**
 * Re-detection may change what we know. It may not overrule what somebody
 * decided.
 */
describe("a person's judgement survives", () => {
  it("keeps a declined opportunity declined", async () => {
    const context = await makeContext("declined");
    await seedCommercialRanking(context);
    await detectAndStoreOpportunities(context);

    const [opportunity] = await listOpportunities(context);
    await setOpportunityStatus(context, opportunity!.id, "DECLINED");

    const summary = await detectAndStoreOpportunities(context);

    expect(summary.preserved).toBeGreaterThan(0);

    const after = await getOpportunity(context, opportunity!.id);
    expect(after?.status).toBe("DECLINED");
  });

  it("keeps a qualified opportunity qualified while refreshing its score", async () => {
    const context = await makeContext("qualified");
    const { keyword } = await seedCommercialRanking(context);
    await detectAndStoreOpportunities(context);

    const [opportunity] = await listOpportunities(context);
    await setOpportunityStatus(context, opportunity!.id, "QUALIFIED");

    // The world changes: demand grows.
    await prisma.keywordMetricsSnapshot.create({
      data: {
        websiteId: context.website.id,
        keywordId: keyword.id,
        capturedAt: daysAgo(1),
        searchVolume: 12000,
        sourceProvider: "SEMRUSH",
      },
    });

    await detectAndStoreOpportunities(context);

    const after = await getOpportunity(context, opportunity!.id);

    expect(after?.status).toBe("QUALIFIED");
    // Fresh evidence, same decision.
    expect(Number(after?.score)).toBeGreaterThan(Number(opportunity?.score));
  });
});

describe("status transitions", () => {
  it("walks the intended path", async () => {
    const context = await makeContext("transitions");
    await seedCommercialRanking(context);
    await detectAndStoreOpportunities(context);

    const [opportunity] = await listOpportunities(context);

    const qualified = await setOpportunityStatus(context, opportunity!.id, "QUALIFIED");
    expect(qualified.qualifiedAt).not.toBeNull();

    const scheduled = await setOpportunityStatus(context, opportunity!.id, "SCHEDULED");
    expect(scheduled.scheduledAt).not.toBeNull();

    await setOpportunityStatus(context, opportunity!.id, "IN_PROGRESS");
    const completed = await setOpportunityStatus(context, opportunity!.id, "COMPLETED");

    expect(completed.status).toBe("COMPLETED");
    expect(completed.closedAt).not.toBeNull();
  });

  it("refuses a transition that skips the work", async () => {
    const context = await makeContext("skip");
    await seedCommercialRanking(context);
    await detectAndStoreOpportunities(context);

    const [opportunity] = await listOpportunities(context);

    await expect(
      setOpportunityStatus(context, opportunity!.id, "COMPLETED"),
    ).rejects.toBeInstanceOf(OpportunityError);
  });

  it("records who changed it and to what", async () => {
    const context = await makeContext("audited");
    await seedCommercialRanking(context);
    await detectAndStoreOpportunities(context);

    const [opportunity] = await listOpportunities(context);
    await setOpportunityStatus(context, opportunity!.id, "QUALIFIED");

    const event = await prisma.auditEvent.findFirst({
      where: { entityType: "Opportunity", entityId: opportunity!.id },
    });

    expect(event?.action).toBe("QUALIFY");
    expect(event?.actorUserId).toBe(context.user.id);
  });

  it("refuses to change another tenant's opportunity", async () => {
    const a = await makeContext("t-iso-a");
    const b = await makeContext("t-iso-b");
    await seedCommercialRanking(b);
    await detectAndStoreOpportunities(b);

    const [theirs] = await listOpportunities(b);

    await expect(
      setOpportunityStatus(a, theirs!.id, "QUALIFIED"),
    ).rejects.toBeInstanceOf(OpportunityError);

    const unchanged = await getOpportunity(b, theirs!.id);
    expect(unchanged?.status).toBe("IDENTIFIED");
  });
});

describe("ownership of the work", () => {
  it("assigns a member of this organization", async () => {
    const context = await makeContext("assign");
    await seedCommercialRanking(context);
    await detectAndStoreOpportunities(context);

    const [opportunity] = await listOpportunities(context);
    const assigned = await assignOpportunityOwner(context, opportunity!.id, context.user.id);

    expect(assigned.ownerUserId).toBe(context.user.id);
  });

  it("refuses somebody from another organization", async () => {
    // The guard exists precisely to stop work being assigned to a user id that
    // was guessed or pasted from elsewhere.
    const a = await makeContext("own-a");
    const b = await makeContext("own-b");
    await seedCommercialRanking(a);
    await detectAndStoreOpportunities(a);

    const [opportunity] = await listOpportunities(a);

    await expect(
      assignOpportunityOwner(a, opportunity!.id, b.user.id),
    ).rejects.toBeInstanceOf(OpportunityError);
  });
});

describe("the queue", () => {
  it("orders by score and filters without leaking", async () => {
    const context = await makeContext("queue");
    await seedCommercialRanking(context);

    const weak = await makeKeyword(context, "weak keyword", { relevance: 0 });
    await addVolume(context, weak.id, 120);

    await detectAndStoreOpportunities(context);

    const all = await listOpportunities(context);
    for (let index = 1; index < all.length; index += 1) {
      expect(Number(all[index - 1]!.score)).toBeGreaterThanOrEqual(Number(all[index]!.score));
    }

    const filtered = await listOpportunities(context, { type: "COMMERCIAL_RANKING" });
    expect(filtered.every((row) => row.type === "COMMERCIAL_RANKING")).toBe(true);
  });

  it("counts by type and priority", async () => {
    const context = await makeContext("counts");
    await seedCommercialRanking(context);
    await detectAndStoreOpportunities(context);

    const counts = await getOpportunityCounts(context);

    expect(counts.total).toBeGreaterThan(0);
    expect(Object.keys(counts.byType).length).toBeGreaterThan(0);
  });

  it("prefers a qualified opportunity for the next best step", async () => {
    const context = await makeContext("next");
    await seedCommercialRanking(context);

    const lower = await makeKeyword(context, "lower value keyword", { relevance: 1 });
    await addVolume(context, lower.id, 150);

    await detectAndStoreOpportunities(context);

    const all = await listOpportunities(context);
    const lowest = all[all.length - 1]!;

    // Something a person has looked at outranks a higher raw score nobody has.
    await setOpportunityStatus(context, lowest.id, "QUALIFIED");

    expect((await getNextBestStep(context))?.id).toBe(lowest.id);
  });

  it("does not list another tenant's opportunities", async () => {
    const a = await makeContext("q-iso-a");
    const b = await makeContext("q-iso-b");
    await seedCommercialRanking(b);
    await detectAndStoreOpportunities(b);

    expect(await listOpportunities(a)).toHaveLength(0);
    expect((await getOpportunityCounts(a)).total).toBe(0);
    expect(await getNextBestStep(a)).toBeNull();
  });
});

/**
 * A P1 signal becoming a P2 opportunity crosses the boundary between two
 * identities that look alike and are not: a Query is what Search Console
 * reported, a Keyword is what a provider measures. Opportunity.keywordId points
 * at the second.
 */
describe("signals promoted to opportunities", () => {
  async function seedCtrSignal(context: TenantContext, options: { withKeyword: boolean }) {
    const page = await makePage(context, "/pricing");
    const connection = await prisma.connection.create({
      data: {
        websiteId: context.website.id,
        workspaceId: context.workspace.id,
        provider: "GOOGLE_SEARCH_CONSOLE",
        status: "CONNECTED",
      },
    });

    const query = await prisma.query.create({
      data: {
        websiteId: context.website.id,
        query: "Payroll Software",
        normalizedQuery: "payroll software",
      },
    });

    if (options.withKeyword) {
      await makeKeyword(context, "payroll software");
    }

    await prisma.gscMetricDaily.create({
      data: {
        websiteId: context.website.id,
        pageId: page.id,
        queryId: query.id,
        date: daysAgo(3),
        clicks: 4,
        impressions: 12000,
        ctr: 0.00033,
        position: 8,
        sourceConnectionId: connection.id,
      },
    });

    const signal = await prisma.signal.create({
      data: {
        websiteId: context.website.id,
        type: "CTR_OPPORTUNITY",
        status: "DETECTED",
        pageId: page.id,
        queryId: query.id,
        currentPeriodStart: daysAgo(28),
        currentPeriodEnd: daysAgo(1),
        comparisonPeriodStart: daysAgo(56),
        comparisonPeriodEnd: daysAgo(29),
        scoringModelVersion: "signals-v1",
        headline: "Click-through rate below others at this position",
      },
    });

    await prisma.signalEvidence.createMany({
      data: [
        {
          signalId: signal.id,
          evidenceType: "METRIC_COMPARISON",
          sourceEntityType: "Page",
          sourceEntityId: page.id,
          metricKey: "impressions",
          currentValue: 12000,
        },
        {
          signalId: signal.id,
          evidenceType: "METRIC_COMPARISON",
          sourceEntityType: "Page",
          sourceEntityId: page.id,
          metricKey: "ctr",
          currentValue: 0.00033,
        },
      ],
    });

    return { page, query, signal };
  }

  it("promotes a CTR signal whose query has no matching keyword", async () => {
    // The failing case: a Query id in a column that is a foreign key to Keyword
    // is either a constraint violation or a link to the wrong row.
    const context = await makeContext("ctr-noky");
    const { signal } = await seedCtrSignal(context, { withKeyword: false });

    await detectAndStoreOpportunities(context);

    const [opportunity] = await listOpportunities(context, { type: "CTR" });

    expect(opportunity).toBeDefined();
    expect(opportunity?.sourceSignalId).toBe(signal.id);
    // No keyword exists for that string, so the link is honestly absent.
    expect(opportunity?.keywordId).toBeNull();
  });

  it("links the keyword when one exists for the same string", async () => {
    // The payoff of sharing one text-folding rule between queries and keywords.
    const context = await makeContext("ctr-ky");
    await seedCtrSignal(context, { withKeyword: true });

    await detectAndStoreOpportunities(context);

    const [opportunity] = await listOpportunities(context, { type: "CTR" });
    const keyword = await prisma.keyword.findFirstOrThrow({
      where: { websiteId: context.website.id, normalizedKeyword: "payroll software" },
    });

    expect(opportunity?.keywordId).toBe(keyword.id);
    expect(opportunity?.keyword?.keyword).toBe("payroll software");
  });
});

/**
 * Business goal linkage.
 *
 * The scoring model weights business relevance at 3 — the joint heaviest. Without
 * a stated link that weight rests on nothing and the queue ranks work in a vacuum.
 * The link is always stated by a person: a keyword is not evidence of a business
 * intention, and guessing would put weight on the score nobody put there.
 */
describe("business goals", () => {
  const makeGoal = (context: TenantContext, title: string) =>
    prisma.businessGoal.create({
      data: { websiteId: context.website.id, title, status: "ACTIVE" },
    });

  it("carries a keyword's goal onto its opportunity", async () => {
    const context = await makeContext("goal-kw");
    const goal = await makeGoal(context, "Generate demo requests");
    const { keyword } = await seedCommercialRanking(context);

    await prisma.keyword.update({
      where: { id: keyword.id },
      data: { businessGoalId: goal.id },
    });

    await detectAndStoreOpportunities(context);
    const [opportunity] = await listOpportunities(context);

    expect(opportunity?.businessGoalId).toBe(goal.id);
    expect(opportunity?.businessGoal?.title).toBe("Generate demo requests");
  });

  it("falls back to the topic's goal when the keyword has none", async () => {
    const context = await makeContext("goal-topic");
    const goal = await makeGoal(context, "Own payroll as a subject");
    const { keyword } = await seedCommercialRanking(context);

    const topic = await prisma.topic.create({
      data: {
        websiteId: context.website.id,
        name: "Payroll",
        slug: "payroll",
        businessGoalId: goal.id,
      },
    });
    await prisma.topicKeyword.create({
      data: { topicId: topic.id, keywordId: keyword.id },
    });

    await detectAndStoreOpportunities(context);
    const [opportunity] = await listOpportunities(context);

    expect(opportunity?.businessGoalId).toBe(goal.id);
  });

  it("prefers the keyword's own goal over its topic's", async () => {
    // The more specific statement wins: somebody made it deliberately about
    // this keyword.
    const context = await makeContext("goal-precedence");
    const specific = await makeGoal(context, "Specific");
    const general = await makeGoal(context, "General");
    const { keyword } = await seedCommercialRanking(context);

    const topic = await prisma.topic.create({
      data: {
        websiteId: context.website.id,
        name: "Payroll",
        slug: "payroll",
        businessGoalId: general.id,
      },
    });
    await prisma.topicKeyword.create({
      data: { topicId: topic.id, keywordId: keyword.id },
    });
    await prisma.keyword.update({
      where: { id: keyword.id },
      data: { businessGoalId: specific.id },
    });

    await detectAndStoreOpportunities(context);
    const [opportunity] = await listOpportunities(context);

    expect(opportunity?.businessGoal?.title).toBe("Specific");
  });

  it("raises the score when work serves a stated goal", async () => {
    const unlinked = await makeContext("goal-unlinked");
    await seedCommercialRanking(unlinked);
    await detectAndStoreOpportunities(unlinked);
    const [without] = await listOpportunities(unlinked);

    const linked = await makeContext("goal-linked");
    const goal = await makeGoal(linked, "Generate demo requests");
    const { keyword } = await seedCommercialRanking(linked);
    await prisma.keyword.update({
      where: { id: keyword.id },
      data: { businessGoalId: goal.id },
    });
    await detectAndStoreOpportunities(linked);
    const [withGoal] = await listOpportunities(linked);

    expect(Number(withGoal?.score)).toBeGreaterThan(Number(without?.score));

    const inputs = withGoal!.scoreInputsJson as {
      subScores: { key: string; basis: string }[];
    };
    const relevance = inputs.subScores.find((entry) => entry.key === "businessRelevance");

    // The reason is stored, not inferred at render time.
    expect(relevance?.basis).toMatch(/linked to a business goal/i);
  });

  it("refuses a goal belonging to another tenant", async () => {
    const a = await makeContext("goal-iso-a");
    const b = await makeContext("goal-iso-b");
    const theirGoal = await makeGoal(b, "Their goal");
    const keyword = await makeKeyword(a, "payroll software");

    await expect(
      updateKeyword(a, keyword.id, { businessGoalId: theirGoal.id }),
    ).rejects.toBeInstanceOf(KeywordError);
  });
});

/**
 * A refresh candidate is only worth ranking if the demand is still there. A page
 * losing clicks for a term nobody searches any more is a different situation from
 * one losing clicks while the market holds steady.
 */
describe("content refresh knows its keyword", () => {
  async function seedDecliningPage(
    context: TenantContext,
    options: { withOwnership: boolean },
  ) {
    const page = await makePage(context, "/guides/payroll");
    const keyword = await makeKeyword(context, "payroll guide");
    await addVolume(context, keyword.id, 4800);

    const connection = await prisma.connection.create({
      data: {
        websiteId: context.website.id,
        workspaceId: context.workspace.id,
        provider: "GOOGLE_SEARCH_CONSOLE",
        status: "CONNECTED",
      },
    });
    const query = await prisma.query.create({
      data: {
        websiteId: context.website.id,
        query: "payroll guide",
        normalizedQuery: "payroll guide",
      },
    });

    if (options.withOwnership) {
      await assignOwnership(context, { keywordId: keyword.id, pageId: page.id });
    } else {
      await addRanking(context, keyword.id, 9, page.id);
    }

    // Clicks fall sharply between the two windows.
    for (const [daysBack, clicks] of [
      [40, 200],
      [10, 60],
    ] as const) {
      await prisma.gscMetricDaily.create({
        data: {
          websiteId: context.website.id,
          pageId: page.id,
          queryId: query.id,
          date: daysAgo(daysBack),
          clicks,
          impressions: clicks * 20,
          ctr: 0.05,
          position: 9,
          sourceConnectionId: connection.id,
        },
      });
    }

    return { page, keyword };
  }

  it("attaches the keyword the page is nominated to own", async () => {
    const context = await makeContext("refresh-owned");
    const { keyword } = await seedDecliningPage(context, { withOwnership: true });

    await detectAndStoreOpportunities(context);

    const [refresh] = await listOpportunities(context, { type: "CONTENT_REFRESH" });

    expect(refresh).toBeDefined();
    expect(refresh?.keywordId).toBe(keyword.id);
  });

  it("falls back to a keyword the page ranks for", async () => {
    const context = await makeContext("refresh-ranked");
    const { keyword } = await seedDecliningPage(context, { withOwnership: false });

    await detectAndStoreOpportunities(context);

    const [refresh] = await listOpportunities(context, { type: "CONTENT_REFRESH" });

    expect(refresh?.keywordId).toBe(keyword.id);
  });

  it("scores demand from that keyword instead of guessing", async () => {
    const context = await makeContext("refresh-demand");
    await seedDecliningPage(context, { withOwnership: true });

    await detectAndStoreOpportunities(context);

    const [refresh] = await listOpportunities(context, { type: "CONTENT_REFRESH" });
    const inputs = refresh!.scoreInputsJson as {
      subScores: { key: string; basis: string }[];
    };
    const demand = inputs.subScores.find((entry) => entry.key === "searchDemand");

    // Previously this always read "no provider has reported search volume".
    expect(demand?.basis).toContain("4,800");
    expect(demand?.basis).not.toMatch(/no provider/i);
  });
});
