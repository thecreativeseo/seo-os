import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { buildEvidenceId } from "@/lib/evidence/id";
import { reconcileBriefClaims } from "@/lib/content/reconcile";
import { assembleContentDraftPackage, sealPackage } from "@/server/services/evidence-assembler";

/**
 * The content-draft package (M4 plan, D-M4-2 as clarified): truth as of now.
 * A fact revoked after a brief was approved is absent from the package the
 * draft is written from, and the brief's claim on it reconciles as STALE.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & {
  pageId: string;
  linkPageId: string;
  keywordId: string;
  factA: string;
  factB: string;
  ruleId: string;
  contextVersionId: string;
  linkOwnershipId: string;
};

async function makeTenant(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `dp-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Draft package ${label}`, slug: `dp-${label}-${suffix}` },
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
      rule: "No superlatives.",
      severity: "BLOCKING",
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
  await prisma.pageContentSnapshot.create({
    data: {
      websiteId: website.id,
      pageId: page.id,
      capturedAt: new Date(),
      contentHash: crypto.createHash("sha256").update(`${suffix}-body`).digest("hex"),
      source: "MANUAL_PASTE",
      title: "Payroll",
      bodyText: "The current page text.",
      wordCount: 4,
    },
  });
  const linkPage = await prisma.page.create({
    data: {
      websiteId: website.id,
      url: `https://${host}/pricing`,
      normalizedUrl: `https://${host}/pricing`,
      path: "/pricing",
      hostname: host,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });

  const keyword = await prisma.keyword.create({
    data: {
      websiteId: website.id,
      keyword: `${label} payroll`,
      normalizedKeyword: `${label} payroll`,
      locale: "en-PH",
      language: "en",
      market: "PH",
    },
  });
  const linkKeyword = await prisma.keyword.create({
    data: {
      websiteId: website.id,
      keyword: `${label} pricing`,
      normalizedKeyword: `${label} pricing`,
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
  const linkOwnership = await prisma.keywordPageOwnership.create({
    data: {
      websiteId: website.id,
      keywordId: linkKeyword.id,
      pageId: linkPage.id,
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
    linkPageId: linkPage.id,
    keywordId: keyword.id,
    factA: factA.id,
    factB: factB.id,
    ruleId: rule.id,
    contextVersionId: version.id,
    linkOwnershipId: linkOwnership.id,
  };
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

describe("the content-draft package", () => {
  it("holds truth as of now, and a brief's claim on a revoked fact reconciles as stale", async () => {
    const tenant = await makeTenant("truth");
    const workItemId = crypto.randomUUID();
    const subject = {
      workItemId,
      pageId: tenant.pageId,
      keywordId: tenant.keywordId,
      topicId: null,
      linkTargetPageIds: [tenant.linkPageId],
    };

    const idA = buildEvidenceId({ kind: "fact", brandFactId: tenant.factA });
    const idB = buildEvidenceId({ kind: "fact", brandFactId: tenant.factB });
    const ruleId = buildEvidenceId({ kind: "rule", seoRuleId: tenant.ruleId });
    const linkId = buildEvidenceId({ kind: "own", ownershipId: tenant.linkOwnershipId });

    const first = await assembleContentDraftPackage(tenant, subject);
    expect(first.package).toMatchObject({
      purpose: "GENERATE_DRAFT",
      targetType: "CONTENT_WORK_ITEM",
      targetId: workItemId,
      contextVersionId: tenant.contextVersionId,
      retrievalPolicyVersion: 1,
    });
    expect(first.manifest.policy).toEqual({ name: "content-draft", version: 1 });

    const ids = new Set(first.evidence.map((record) => record.id));
    expect(ids.has(idA)).toBe(true);
    expect(ids.has(idB)).toBe(true);
    expect(ids.has(ruleId)).toBe(true);
    expect(ids.has(linkId)).toBe(true);
    expect(first.evidence.some((record) => record.type === "PAGE_CONTENT")).toBe(true);

    // The brief was approved while B was a fact. Then B is revoked.
    await prisma.brandFact.update({
      where: { id: tenant.factB },
      data: { approvalStatus: "REJECTED" },
    });

    const second = await assembleContentDraftPackage(tenant, subject);
    const types = new Map(second.evidence.map((record) => [record.id, record.type as string]));
    expect(types.has(idA)).toBe(true);
    expect(types.has(idB)).toBe(false);

    const reconciled = reconcileBriefClaims(
      [
        { text: "Payslips follow BIR formats", evidenceId: idA, source: "BRAND_FACT" },
        { text: "Trusted by 10,000 businesses", evidenceId: idB, source: "BRAND_FACT" },
      ],
      types,
    );
    expect(reconciled.valid.map((c) => c.evidenceId)).toEqual([idA]);
    expect(reconciled.stale).toEqual([
      expect.objectContaining({
        evidenceId: idB,
        status: "STALE",
        text: "Trusted by 10,000 businesses",
      }),
    ]);

    // The first package is untouched by the second: both are records.
    const sealed = await sealPackage(tenant, first.package.id);
    expect(sealed?.sealedAt).not.toBeNull();
    const kept = await prisma.evidenceRef.count({
      where: { packageId: first.package.id, evidenceId: idB },
    });
    expect(kept).toBe(1);
  });

  it("is scoped: another tenant's subject yields an empty package, not theirs", async () => {
    const tenant = await makeTenant("scope");
    const other = await makeTenant("scope-other");

    const result = await assembleContentDraftPackage(tenant, {
      workItemId: crypto.randomUUID(),
      pageId: other.pageId,
      keywordId: other.keywordId,
      topicId: null,
      linkTargetPageIds: [other.linkPageId],
    });

    const sources = new Set(result.evidence.map((record) => record.sourceEntityId));
    expect(sources.has(other.factA)).toBe(false);
    expect(sources.has(other.linkOwnershipId)).toBe(false);
    expect(sources.has(tenant.factA)).toBe(true);
    expect(result.manifest.notes.join(" ")).toMatch(/no longer available/);
  });
});
