import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { decide } from "@/server/services/decision";
import {
  ContentWorkError,
  contentWorkForRecommendation,
  effectiveRecommendation,
  eligibilityFor,
  getContentWorkItem,
  listApprovedNotStarted,
  listContentWorkItems,
  startFromRecommendation,
} from "@/server/services/content-work";
import type { RecommendationType, Role } from "@/generated/prisma/client";

/**
 * The P3 → P4 handoff (docs/P4_SPEC.md §5, §6, §31).
 *
 * Every path in starts from a real Decision row written by decide(), because
 * that row - not the recommendation's status - is what a work item is proof
 * of. The refusals are the point: nothing undecided, rejected, unbacked,
 * technical, or already started becomes work.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & { pageId: string; keywordId: string; topicId: string };

async function makeTenant(label: string, role: Role = "OWNER"): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `cw-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Content work ${label}`, slug: `cw-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role,
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });

  const host = `${label}-${suffix}.example.com`;
  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: host,
      normalizedDomain: host,
      primaryLanguage: "en",
      primaryMarket: "PH",
    },
  });

  const page = await prisma.page.create({
    data: {
      websiteId: website.id,
      url: `https://${host}/payroll-software`,
      normalizedUrl: `https://${host}/payroll-software`,
      path: "/payroll-software",
      hostname: host,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });

  const keyword = await prisma.keyword.create({
    data: {
      websiteId: website.id,
      keyword: `${label} payroll software`,
      normalizedKeyword: `${label} payroll software`,
      locale: "en-PH",
      language: "en",
      market: "PH",
    },
  });

  const topic = await prisma.topic.create({
    data: { websiteId: website.id, name: "Payroll", slug: `payroll-${suffix}` },
  });

  return {
    user,
    membership,
    organization,
    workspace,
    website,
    pageId: page.id,
    keywordId: keyword.id,
    topicId: topic.id,
  };
}

async function makeRecommendation(
  tenant: Fixture,
  overrides: Partial<{
    type: RecommendationType;
    status: "AWAITING_REVIEW" | "NEEDS_EVIDENCE" | "APPROVED";
    title: string;
    ownerUserId: string | null;
  }> = {},
) {
  return prisma.recommendation.create({
    data: {
      websiteId: tenant.website.id,
      pageId: tenant.pageId,
      keywordId: tenant.keywordId,
      topicId: tenant.topicId,
      type: overrides.type ?? "CONTENT_REFRESH",
      status: overrides.status ?? "AWAITING_REVIEW",
      priority: "HIGH",
      title: overrides.title ?? "Refresh the payroll software guide",
      summary: "Bring the guide back in line with what buyers search for.",
      rationale: "Clicks fell 40% over 28 days while impressions held.",
      ownerUserId: overrides.ownerUserId ?? tenant.user.id,
    },
  });
}

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

describe("starting content work", () => {
  it("turns an APPROVED decision into a work item, atomically with its audit event", async () => {
    const tenant = await makeTenant("approved");
    const recommendation = await makeRecommendation(tenant);
    const { decision } = await decide(tenant, recommendation.id, { decision: "APPROVED" });

    const item = await startFromRecommendation(tenant, recommendation.id);

    expect(item).toMatchObject({
      websiteId: tenant.website.id,
      recommendationId: recommendation.id,
      decisionId: decision.id,
      type: "CONTENT_REFRESH",
      status: "QUEUED",
      priority: "HIGH",
      pageId: tenant.pageId,
      keywordId: tenant.keywordId,
      topicId: tenant.topicId,
      title: recommendation.title,
      objective: recommendation.summary,
      ownerUserId: tenant.user.id,
    });

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: "ContentWorkItem", entityId: item.id, action: "CREATE" },
    });
    expect(audit?.actorUserId).toBe(tenant.user.id);
    expect(audit?.websiteId).toBe(tenant.website.id);
    expect((audit?.afterSnapshotJson as { recommendationId?: string })?.recommendationId).toBe(
      recommendation.id,
    );

    // The recommendation and decision are untouched: the item points at them.
    const after = await prisma.recommendation.findUniqueOrThrow({
      where: { id: recommendation.id },
    });
    expect(after.status).toBe("APPROVED");
    expect(await contentWorkForRecommendation(tenant, recommendation.id)).toMatchObject({
      id: item.id,
    });
  });

  it("builds the item from what the reviewer approved when the decision was MODIFIED", async () => {
    const tenant = await makeTenant("modified");
    // A technical finding the reviewer turned into a content refresh.
    const recommendation = await makeRecommendation(tenant, { type: "TECHNICAL_FIX" });

    await decide(tenant, recommendation.id, {
      decision: "MODIFIED",
      modifications: {
        type: "CONTENT_REFRESH",
        title: "Refresh instead of fixing",
        priority: "LOW",
      },
    });

    const item = await startFromRecommendation(tenant, recommendation.id);
    expect(item.type).toBe("CONTENT_REFRESH");
    expect(item.title).toBe("Refresh instead of fixing");
    expect(item.priority).toBe("LOW");
    // What was not modified comes from the recommendation as written.
    expect(item.objective).toBe(recommendation.summary);
  });

  it("refuses a recommendation nobody has decided on", async () => {
    const tenant = await makeTenant("undecided");
    const recommendation = await makeRecommendation(tenant);

    await expect(startFromRecommendation(tenant, recommendation.id)).rejects.toMatchObject({
      name: "ContentWorkError",
      code: "not_approved",
    });
  });

  it("refuses a rejected recommendation and one that needs evidence", async () => {
    const tenant = await makeTenant("rejected");

    const rejected = await makeRecommendation(tenant);
    await decide(tenant, rejected.id, { decision: "REJECTED", reason: "Not this quarter." });
    await expect(startFromRecommendation(tenant, rejected.id)).rejects.toMatchObject({
      code: "not_approved",
    });

    const needs = await makeRecommendation(tenant);
    await decide(tenant, needs.id, { decision: "NEEDS_EVIDENCE", reason: "Show me the SERP." });
    await expect(startFromRecommendation(tenant, needs.id)).rejects.toMatchObject({
      code: "not_approved",
    });
  });

  it("refuses an APPROVED status that no decision row stands behind", async () => {
    const tenant = await makeTenant("unbacked");
    const recommendation = await makeRecommendation(tenant, { status: "APPROVED" });

    await expect(startFromRecommendation(tenant, recommendation.id)).rejects.toMatchObject({
      code: "no_decision",
    });
  });

  it("refuses types P4 cannot execute, and says why", async () => {
    const tenant = await makeTenant("ineligible");

    for (const type of ["MONITOR_ONLY", "TECHNICAL_FIX", "SERP_REVIEW", "OTHER"] as const) {
      const recommendation = await makeRecommendation(tenant, { type });
      await decide(tenant, recommendation.id, { decision: "APPROVED" });

      await expect(startFromRecommendation(tenant, recommendation.id)).rejects.toMatchObject({
        code: "not_eligible",
      });
    }

    expect(eligibilityFor("MONITOR_ONLY")).toMatchObject({
      eligible: false,
      reason: expect.stringMatching(/Monitoring/),
    });
    expect(eligibilityFor("TECHNICAL_FIX")).toMatchObject({
      eligible: false,
      reason: expect.stringMatching(/P5/),
    });
    expect(eligibilityFor("CONTENT_CREATE")).toEqual({ eligible: true, workType: "NEW_CONTENT" });
    expect(eligibilityFor("PAGE_CONSOLIDATION")).toEqual({
      eligible: true,
      workType: "PAGE_CONSOLIDATION_PREP",
    });
  });

  it("allows one open item per recommendation, and another once it is closed", async () => {
    const tenant = await makeTenant("once");
    const recommendation = await makeRecommendation(tenant);
    await decide(tenant, recommendation.id, { decision: "APPROVED" });

    const first = await startFromRecommendation(tenant, recommendation.id);

    let refused: unknown;
    try {
      await startFromRecommendation(tenant, recommendation.id);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ContentWorkError);
    expect((refused as ContentWorkError).code).toBe("already_started");
    expect((refused as ContentWorkError).existingItemId).toBe(first.id);

    await prisma.contentWorkItem.update({ where: { id: first.id }, data: { status: "CANCELLED" } });

    const second = await startFromRecommendation(tenant, recommendation.id);
    expect(second.id).not.toBe(first.id);
  });

  it("needs WRITE: a viewer cannot start work", async () => {
    const tenant = await makeTenant("viewer", "VIEWER");
    const recommendation = await makeRecommendation(tenant, { status: "APPROVED" });

    await expect(startFromRecommendation(tenant, recommendation.id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("only assigns an owner who is a member of this organization", async () => {
    const tenant = await makeTenant("owner");
    const stranger = await makeTenant("stranger");
    const recommendation = await makeRecommendation(tenant);
    await decide(tenant, recommendation.id, { decision: "APPROVED" });

    await expect(
      startFromRecommendation(tenant, recommendation.id, { ownerUserId: stranger.user.id }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const item = await startFromRecommendation(tenant, recommendation.id, {
      ownerUserId: tenant.user.id,
    });
    expect(item.ownerUserId).toBe(tenant.user.id);
  });
});

describe("reading the queue", () => {
  it("lists open work with the rows a person needs to understand it", async () => {
    const tenant = await makeTenant("queue");
    const recommendation = await makeRecommendation(tenant);
    await decide(tenant, recommendation.id, { decision: "APPROVED" });
    const item = await startFromRecommendation(tenant, recommendation.id);

    const [row] = await listContentWorkItems(tenant);
    expect(row).toMatchObject({
      id: item.id,
      recommendation: { id: recommendation.id, title: recommendation.title, status: "APPROVED" },
      page: { path: "/payroll-software" },
      topic: { name: "Payroll" },
      keyword: { keyword: expect.stringContaining("payroll software") },
      owner: { email: tenant.user.email },
    });

    const detail = await getContentWorkItem(tenant, item.id);
    expect(detail?.decision.decidedBy.email).toBe(tenant.user.email);
    expect(detail?.decision.decision).toBe("APPROVED");

    await prisma.contentWorkItem.update({ where: { id: item.id }, data: { status: "CANCELLED" } });
    expect(await listContentWorkItems(tenant)).toHaveLength(0);
    expect(await listContentWorkItems(tenant, { status: "all" })).toHaveLength(1);
  });

  it("lists approved recommendations not yet started, eligible first, with reasons for the rest", async () => {
    const tenant = await makeTenant("waiting");

    const eligible = await makeRecommendation(tenant, { title: "Eligible" });
    await decide(tenant, eligible.id, { decision: "APPROVED" });

    const technical = await makeRecommendation(tenant, {
      type: "TECHNICAL_FIX",
      title: "Technical",
    });
    await decide(tenant, technical.id, { decision: "APPROVED" });

    const started = await makeRecommendation(tenant, { title: "Started" });
    await decide(tenant, started.id, { decision: "APPROVED" });
    await startFromRecommendation(tenant, started.id);

    const undecided = await makeRecommendation(tenant, { title: "Undecided" });
    const unbacked = await makeRecommendation(tenant, { status: "APPROVED", title: "Unbacked" });

    const rows = await listApprovedNotStarted(tenant);
    const titles = rows.map((row) => row.recommendation.title);

    expect(titles[0]).toBe("Eligible");
    expect(titles).toContain("Technical");
    expect(titles).not.toContain("Started");
    expect(titles).not.toContain(undecided.title);
    expect(titles).not.toContain(unbacked.title);

    const technicalRow = rows.find((row) => row.recommendation.id === technical.id)!;
    expect(technicalRow.eligibility).toMatchObject({ eligible: false, reason: expect.any(String) });
    expect(rows.find((row) => row.recommendation.id === eligible.id)!.eligibility).toEqual({
      eligible: true,
      workType: "CONTENT_REFRESH",
    });
  });

  it("reads a MODIFIED decision's changes when showing what was approved", () => {
    const base = { title: "T", summary: "S", type: "TECHNICAL_FIX", priority: "HIGH" } as const;
    expect(effectiveRecommendation(base, null)).toEqual(base);
    expect(
      effectiveRecommendation(base, {
        decision: "MODIFIED",
        modifiedRecommendationJson: {
          before: { type: "TECHNICAL_FIX", priority: "HIGH" },
          after: { type: "CONTENT_REFRESH", priority: "LOW" },
        },
      }),
    ).toEqual({ title: "T", summary: "S", type: "CONTENT_REFRESH", priority: "LOW" });
    // An APPROVED decision carries no changes even if the column holds something.
    expect(
      effectiveRecommendation(base, {
        decision: "APPROVED",
        modifiedRecommendationJson: { before: { title: "T" }, after: { title: "ignored" } },
      }),
    ).toEqual(base);
  });
});
