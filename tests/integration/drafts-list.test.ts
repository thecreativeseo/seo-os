import crypto from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { resetProvider, useStubProvider as installStubProvider } from "@/server/ai/registry";
import { buildEvidenceId } from "@/lib/evidence/id";
import type { ContentDraftOutput } from "@/lib/ai/schemas/content-draft";
import { decide } from "@/server/services/decision";
import { startFromRecommendation } from "@/server/services/content-work";
import { approveBrief, listBriefs } from "@/server/services/content-brief";
import {
  generateRevision,
  getBriefPanel,
  listDrafts,
  requestDraftReview,
  saveRevision,
  startDraft,
  startDraftFromBrief,
} from "@/server/services/content-draft";

/**
 * The drafts list and the brief panel (M4.4 §2, §3): rows with their
 * computed states, most recently updated first; the pinned brief as
 * constraints with stale claims judged now; and nothing across tenants.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & {
  pageId: string;
  keywordId: string;
  secondaryKeywordId: string;
  goalId: string;
  factA: string;
  factB: string;
  ruleId: string;
  contextVersionId: string;
};

async function makeTenant(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `dl-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);
  const organization = await prisma.organization.create({
    data: { name: `Drafts list ${label}`, slug: `dl-${label}-${suffix}` },
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
  const context = await prisma.businessContext.create({ data: { websiteId: website.id } });
  const version = await prisma.businessContextVersion.create({
    data: {
      businessContextId: context.id,
      versionNumber: 1,
      status: "APPROVED",
      createdByUserId: user.id,
      approvedByUserId: user.id,
      approvedAt: new Date(),
      companySummary: "Payroll software.",
      prohibitedClaims: ["Guaranteed compliance"],
      avoidTopics: [],
    },
  });
  const goal = await prisma.businessGoal.create({
    data: {
      websiteId: website.id,
      title: "Grow demo requests",
      status: "ACTIVE",
      businessObjective: "Pipeline",
      primaryMetric: "demo_requests",
    },
  });
  const factA = await prisma.brandFact.create({
    data: {
      websiteId: website.id,
      category: "Product",
      factKey: "compliance",
      value: "Payslips follow BIR formats",
      approvalStatus: "APPROVED",
    },
  });
  const factB = await prisma.brandFact.create({
    data: {
      websiteId: website.id,
      category: "Traction",
      factKey: "customers",
      value: "Trusted by 10,000 businesses",
      approvalStatus: "APPROVED",
    },
  });
  const rule = await prisma.seoRule.create({
    data: {
      websiteId: website.id,
      category: "Claims",
      rule: "Never quote customer counts.",
      severity: "BLOCKING",
      checkJson: { kind: "forbidden_phrase", phrase: "Trusted by" },
    },
  });
  const page = await prisma.page.create({
    data: {
      websiteId: website.id,
      url: `https://${host}/payroll`,
      normalizedUrl: `https://${host}/payroll`,
      path: "/payroll",
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
      businessGoalId: goal.id,
    },
  });
  const secondary = await prisma.keyword.create({
    data: {
      websiteId: website.id,
      keyword: `${label} payslip generator`,
      normalizedKeyword: `${label} payslip generator`,
      locale: "en-PH",
      language: "en",
      market: "PH",
    },
  });
  await prisma.keywordPageOwnership.create({
    data: {
      websiteId: website.id,
      keywordId: keyword.id,
      pageId: page.id,
      ownershipType: "PRIMARY",
      status: "ACTIVE",
    },
  });
  return {
    user,
    membership,
    organization,
    workspace,
    website,
    pageId: page.id,
    keywordId: keyword.id,
    secondaryKeywordId: secondary.id,
    goalId: goal.id,
    factA: factA.id,
    factB: factB.id,
    ruleId: rule.id,
    contextVersionId: version.id,
  };
}

async function makeItem(tenant: Fixture, title: string, contentType = "GUIDE") {
  const recommendation = await prisma.recommendation.create({
    data: {
      websiteId: tenant.website.id,
      pageId: tenant.pageId,
      keywordId: tenant.keywordId,
      type: "CONTENT_REFRESH",
      status: "AWAITING_REVIEW",
      priority: "HIGH",
      title,
      summary: "Summary.",
      rationale: "Rationale.",
    },
  });
  await decide(tenant, recommendation.id, { decision: "APPROVED" });
  const item = await startFromRecommendation(tenant, recommendation.id);
  const brief = await makeBrief(tenant, item.id, 1, contentType);
  // A brief written by hand moves the item to BRIEFING; approval then moves it to DRAFTING.
  await prisma.contentWorkItem.update({ where: { id: item.id }, data: { status: "BRIEFING" } });
  await approveBrief(tenant, brief.id);
  return { item, brief };
}

async function makeBrief(
  tenant: Fixture,
  workItemId: string,
  version: number,
  contentType = "GUIDE",
) {
  const factA = buildEvidenceId({ kind: "fact", brandFactId: tenant.factA });
  const factB = buildEvidenceId({ kind: "fact", brandFactId: tenant.factB });
  const ctx = buildEvidenceId({ kind: "ctx", contextVersionId: tenant.contextVersionId });
  return prisma.contentBrief.create({
    data: {
      websiteId: tenant.website.id,
      contentWorkItemId: workItemId,
      version,
      title: `Brief v${version}`,
      contentType,
      searchIntent: "COMMERCIAL",
      audience: "HR leads",
      keyQuestionsJson: ["Which tools produce BIR-compliant payslips?"],
      requiredSectionsJson: [{ heading: "Compliance", purpose: "The core." }],
      optionalSectionsJson: [],
      approvedClaimsJson: [
        { text: "Payslips follow BIR formats", evidenceId: factA, source: "BRAND_FACT" },
        { text: "Trusted by 10,000 businesses", evidenceId: factB, source: "BRAND_FACT" },
      ],
      prohibitedClaimsJson: [
        { text: "Guaranteed compliance", evidenceId: ctx, source: "BUSINESS_CONTEXT" },
      ],
      seoRuleConstraintsJson: [
        {
          ruleId: tenant.ruleId,
          evidenceId: buildEvidenceId({ kind: "rule", seoRuleId: tenant.ruleId }),
          severity: "BLOCKING",
          rule: "Never quote customer counts.",
          constraint: "Applies everywhere.",
        },
      ],
      internalLinkTargetsJson: [],
      secondaryKeywordIdsJson: [tenant.secondaryKeywordId],
      targetPageId: tenant.pageId,
      primaryKeywordId: tenant.keywordId,
      businessGoalId: tenant.goalId,
      status: "DRAFT",
      createdByUserId: tenant.user.id,
    },
  });
}

function answer(tenant: Fixture, overrides: Partial<ContentDraftOutput> = {}): ContentDraftOutput {
  return {
    title: "Payroll software guide",
    slug: "payroll-software-guide",
    excerpt: "A guide.",
    meta_title: "Payroll software guide",
    meta_description: "A guide to payroll software.",
    body_markdown: "# Guide\n\n## Compliance\n\nPayslips follow BIR formats.\n",
    claims: [
      {
        text: "Payslips follow BIR formats",
        evidence_id: buildEvidenceId({ kind: "fact", brandFactId: tenant.factA }),
      },
    ],
    internal_links_used: [],
    sections_covered: ["Compliance"],
    open_questions: [],
    change_summary: "First draft.",
    ...overrides,
  };
}

afterEach(() => resetProvider());

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

describe("the drafts list", () => {
  it("shows every draft with its state, most recently updated first, and only this tenant's", async () => {
    const tenant = await makeTenant("list");
    const other = await makeTenant("list-other");

    // 1. A draft with a blocking AI revision.
    const blocked = await makeItem(tenant, "Blocked one");
    const blockedDraft = (await startDraft(tenant, blocked.item.id)).draft;
    installStubProvider({
      responses: [answer(tenant, { body_markdown: "# Guide\n\nTrusted by 10,000 businesses.\n" })],
    });
    const gen = await generateRevision(tenant, blockedDraft.id, { generationToken: "t1" });
    expect(gen.ok).toBe(true);

    // 2. A draft edited by hand and sent for review.
    const reviewed = await makeItem(tenant, "Reviewed one", "LANDING_PAGE");
    const reviewedDraft = (await startDraft(tenant, reviewed.item.id)).draft;
    await saveRevision(tenant, reviewedDraft.id, {
      title: "Landing page",
      slug: null,
      excerpt: null,
      metaTitle: null,
      metaDescription: null,
      bodyMarkdown: "# Landing\n\nPayslips follow BIR formats.\n",
      changeSummary: "Written by hand.",
    });
    await requestDraftReview(tenant, reviewedDraft.id);

    // 3. A draft whose brief was superseded, then restarted from v2.
    const moved = await makeItem(tenant, "Moved one");
    const oldDraft = (await startDraft(tenant, moved.item.id)).draft;
    const v2 = await makeBrief(tenant, moved.item.id, 2);
    await approveBrief(tenant, v2.id);
    const mismatchBefore = (await listDrafts(tenant)).find((row) => row.id === oldDraft.id);
    expect(mismatchBefore?.briefMismatch).toEqual({ approvedVersion: 2, approvedBriefId: v2.id });
    const newDraft = (await startDraftFromBrief(tenant, moved.item.id, v2.id)).draft;

    // Another tenant's draft, which must never appear here.
    const elsewhere = await makeItem(other, "Elsewhere");
    const elsewhereDraft = (await startDraft(other, elsewhere.item.id)).draft;

    const rows = await listDrafts(tenant);
    expect(rows.map((row) => row.id)).not.toContain(elsewhereDraft.id);
    expect(rows).toHaveLength(4);
    // Most recently updated first. Superseding the old draft updates it in the
    // same transaction that creates the new one, so those two share the top.
    expect(
      rows
        .slice(0, 2)
        .map((row) => row.id)
        .sort(),
    ).toEqual([newDraft.id, oldDraft.id].sort());
    expect(rows.slice(2).map((row) => row.id)).toEqual([reviewedDraft.id, blockedDraft.id]);

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(blockedDraft.id)).toMatchObject({
      workItemTitle: "Blocked one",
      workItemType: "CONTENT_REFRESH",
      contentType: "GUIDE",
      briefVersion: 1,
      status: "DRAFTING",
      awaitingReview: false,
      currentRevisionNumber: 1,
      currentTitle: "Payroll software guide",
      revisionCount: 1,
      authorKind: "AI",
      blocking: true,
      briefMismatch: null,
    });
    expect(byId.get(blockedDraft.id)!.findings.blocking).toBeGreaterThanOrEqual(1);
    expect(byId.get(reviewedDraft.id)).toMatchObject({
      contentType: "LANDING_PAGE",
      status: "AWAITING_EDITOR_REVIEW",
      awaitingReview: true,
      authorKind: "HUMAN",
      blocking: false,
      currentTitle: "Landing page",
    });
    expect(byId.get(oldDraft.id)).toMatchObject({
      status: "SUPERSEDED",
      briefVersion: 1,
      briefStatus: "SUPERSEDED",
      briefMismatch: { approvedVersion: 2, approvedBriefId: v2.id },
      currentRevisionNumber: null,
      authorKind: null,
      blocking: false,
    });
    expect(byId.get(newDraft.id)).toMatchObject({
      status: "DRAFTING",
      briefVersion: 2,
      briefMismatch: null,
      currentRevisionNumber: null,
    });

    // The other tenant sees only its own.
    expect((await listDrafts(other)).map((row) => row.id)).toEqual([elsewhereDraft.id]);

    // Briefs, likewise.
    const briefs = await listBriefs(tenant);
    expect(briefs.map((row) => row.contentWorkItem.title).sort()).toEqual([
      "Blocked one",
      "Moved one",
      "Moved one",
      "Reviewed one",
    ]);
    expect(briefs.find((row) => row.id === v2.id)?._count.drafts).toBe(1);
    expect(briefs.map((row) => row.id)).not.toContain(elsewhere.brief.id);
  });
});

describe("the brief panel", () => {
  it("renders the pinned brief as constraints, with claims judged against what is approved now", async () => {
    const tenant = await makeTenant("panel");
    const other = await makeTenant("panel-other");
    const { brief } = await makeItem(tenant, "Panel one");

    const before = await getBriefPanel(tenant, brief.id);
    expect(before).toMatchObject({
      version: 1,
      status: "APPROVED",
      contentType: "GUIDE",
      searchIntent: "COMMERCIAL",
      audience: "HR leads",
      businessGoal: { title: "Grow demo requests" },
      primaryKeyword: { keyword: "panel payroll software" },
      targetPage: { path: "/payroll" },
      keyQuestions: ["Which tools produce BIR-compliant payslips?"],
      requiredSections: [{ heading: "Compliance", purpose: "The core." }],
      prohibitedClaims: [{ text: "Guaranteed compliance", source: "BUSINESS_CONTEXT" }],
      rules: [
        {
          rule: "Never quote customer counts.",
          severity: "BLOCKING",
          constraint: "Applies everywhere.",
        },
      ],
      targetLength: "900-1,500 words",
    });
    expect(before!.secondaryKeywords.map((row) => row.keyword)).toEqual([
      "panel payslip generator",
    ]);
    expect(before!.validClaims.map((row) => row.text).sort()).toEqual([
      "Payslips follow BIR formats",
      "Trusted by 10,000 businesses",
    ]);
    expect(before!.staleClaims).toEqual([]);

    await prisma.brandFact.update({
      where: { id: tenant.factB },
      data: { approvalStatus: "REJECTED" },
    });
    const after = await getBriefPanel(tenant, brief.id);
    expect(after!.validClaims.map((row) => row.text)).toEqual(["Payslips follow BIR formats"]);
    expect(after!.staleClaims).toEqual([
      expect.objectContaining({ text: "Trusted by 10,000 businesses", status: "STALE" }),
    ]);

    // The brief row itself is untouched; the judgement is made at read time.
    const row = await prisma.contentBrief.findUniqueOrThrow({ where: { id: brief.id } });
    expect(row.approvedClaimsJson).toHaveLength(2);

    expect(await getBriefPanel(other, brief.id)).toBeNull();
    expect(await getBriefPanel(tenant, crypto.randomUUID())).toBeNull();
  });
});
