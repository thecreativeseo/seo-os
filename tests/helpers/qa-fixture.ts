import crypto from "node:crypto";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { resetProvider, useStubProvider as installStubProvider } from "@/server/ai/registry";
import type { GenerateStructuredRequest } from "@/lib/ai/provider";
import type { ContentBriefOutput } from "@/lib/ai/schemas/content-brief";
import { decide } from "@/server/services/decision";
import { startFromRecommendation } from "@/server/services/content-work";
import { approveBrief, generateBrief } from "@/server/services/content-brief";
import {
  approveDraft,
  requestDraftReview,
  saveRevision,
  startDraft,
} from "@/server/services/content-draft";
import type { Role } from "@/generated/prisma/client";

/**
 * A tenant with everything QA reads - approved context, an approved fact, a
 * BLOCKING machine rule, a page with captured content, a keyword it owns -
 * and a work item taken all the way to Ready for QA through the real
 * services under the stub provider. Shared by the QA suites.
 */

export type QaFixture = TenantContext & {
  pageId: string;
  keywordId: string;
  factApproved: string;
  ruleId: string;
};

export class QaFixtures {
  readonly organizationIds: string[] = [];
  readonly userIds: string[] = [];

  async tenant(label: string): Promise<QaFixture> {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { authUserId: crypto.randomUUID(), email: `qa-${label}-${suffix}@example.com` },
    });
    this.userIds.push(user.id);
    const organization = await prisma.organization.create({
      data: { name: `QA ${label}`, slug: `qa-${label}-${suffix}` },
    });
    this.organizationIds.push(organization.id);
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
    await prisma.businessContextVersion.create({
      data: {
        businessContextId: context.id,
        versionNumber: 1,
        status: "APPROVED",
        createdByUserId: user.id,
        approvedByUserId: user.id,
        approvedAt: new Date(),
        companySummary: "Payroll software for Philippine employers.",
        brandVoice: "Plain and specific.",
        prohibitedClaims: ["Guaranteed compliance"],
        avoidTopics: ["Tax evasion"],
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
    const factApproved = await prisma.brandFact.create({
      data: {
        websiteId: website.id,
        category: "Product",
        factKey: "compliance",
        value: "Payslips follow BIR formats",
        approvalStatus: "APPROVED",
      },
    });
    const rule = await prisma.seoRule.create({
      data: {
        websiteId: website.id,
        category: "On-page",
        rule: "Meta titles stay under 60 characters.",
        severity: "BLOCKING",
        checkJson: { kind: "max_length", field: "meta_title", max: 60 },
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
    await prisma.pageContentSnapshot.create({
      data: {
        websiteId: website.id,
        pageId: page.id,
        capturedAt: new Date(),
        contentHash: crypto.createHash("sha256").update(`${suffix}-body`).digest("hex"),
        source: "MANUAL_PASTE",
        title: "Payroll software",
        metaDescription: "The old description of the payroll page.",
        bodyText: "Our payroll software handles Philippine payroll end to end for growing teams.",
        wordCount: 12,
      },
    });
    const keyword = await prisma.keyword.create({
      data: {
        websiteId: website.id,
        keyword: "payroll software",
        normalizedKeyword: "payroll software",
        locale: "en-PH",
        language: "en",
        market: "PH",
        intent: "COMMERCIAL",
        businessGoalId: goal.id,
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
      factApproved: factApproved.id,
      ruleId: rule.id,
    };
  }

  async colleague(tenant: QaFixture, role: Role): Promise<TenantContext> {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        authUserId: crypto.randomUUID(),
        email: `qa-${role.toLowerCase()}-${suffix}@example.com`,
      },
    });
    this.userIds.push(user.id);
    const membership = await prisma.organizationMembership.create({
      data: {
        organizationId: tenant.organization.id,
        userId: user.id,
        role,
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    });
    return { ...tenant, user, membership };
  }

  /** A work item Ready for QA: brief approved, a hand-written revision approved by a lead. */
  async readyForQa(tenant: QaFixture, lead: TenantContext, bodyMarkdown = QA_BODY) {
    installStubProvider({ respond: briefAnswer });
    const recommendation = await prisma.recommendation.create({
      data: {
        websiteId: tenant.website.id,
        pageId: tenant.pageId,
        keywordId: tenant.keywordId,
        type: "CONTENT_REFRESH",
        status: "AWAITING_REVIEW",
        priority: "HIGH",
        title: "Refresh the payroll software page",
        summary: "Bring the page in line with what buyers search for.",
        rationale: "Clicks fell while impressions held.",
      },
    });
    await decide(tenant, recommendation.id, { decision: "APPROVED", reason: "Worth doing." });
    const item = await startFromRecommendation(tenant, recommendation.id);
    const generated = await generateBrief(tenant, item.id);
    if (!generated.ok) throw new Error(generated.error.message);
    await approveBrief(lead, generated.brief.id);
    // The brief stub goes; each suite installs the judge it wants, or none.
    resetProvider();
    const { draft } = await startDraft(tenant, item.id);
    const saved = await saveRevision(tenant, draft.id, {
      title: "Payroll software in the Philippines: a buyer's guide",
      slug: "payroll-software",
      excerpt: "How to shortlist payroll software that handles BIR requirements.",
      metaTitle: "Payroll Software Philippines | Guide",
      metaDescription:
        "Compare payroll software for Philippine employers, starting from BIR compliance.",
      bodyMarkdown,
      changeSummary: "First hand-written revision.",
    });
    await requestDraftReview(tenant, draft.id);
    const approved = await approveDraft(lead, draft.id, { note: "Ready for QA." });
    return { item: approved.workItem, draft, revision: saved.revision, brief: generated.brief };
  }

  async teardown(): Promise<void> {
    if (this.organizationIds.length > 0) {
      const ids = this.organizationIds;
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
        // QA runs first. A completed run is immutable, and deleting the tenant
        // cascades a SET NULL onto its evidence package and AI run references,
        // which the trigger refuses. Deleting the runs outright is allowed under
        // the switch and leaves the cascade nothing to touch.
        const scope = { website: { workspace: { organizationId: { in: ids } } } };
        await tx.contentQaResult.deleteMany({ where: scope });
        await tx.contentQaRun.deleteMany({ where: scope });
        await tx.organization.deleteMany({ where: { id: { in: ids } } });
      });
    }
    if (this.userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: this.userIds } } });
    }
  }
}

export const QA_BODY = [
  "# Payroll software in the Philippines",
  "",
  "## What BIR compliance requires",
  "",
  "Payslips follow BIR formats. Every employer files the same forms, and the software fills them from the register you already keep.",
  "",
  "## Choosing a tool",
  "",
  "Start with the payroll register, then compare tools on the forms they file and the payslips they produce.",
  "",
].join("\n");

function citable(request: GenerateStructuredRequest<unknown>, kind: string): string[] {
  return [...(request.untrustedData ?? "").matchAll(/^\[([^\]]+)\]/gm)]
    .map((match) => match[1]!)
    .filter((id) => id.startsWith(`${kind}:`));
}

export function briefAnswer(request: GenerateStructuredRequest<unknown>): ContentBriefOutput {
  const facts = citable(request, "fact");
  return {
    title: "Payroll software in the Philippines: a buyer's guide",
    content_type: "GUIDE",
    search_intent: "COMMERCIAL",
    primary_conversion: "Book a demo",
    audience: "HR leads at growing Philippine companies",
    customer_problem: "They cannot tell which payroll tools handle BIR requirements.",
    desired_outcome: "The reader shortlists tools and books a demo.",
    recommended_angle: "Compliance first, features second.",
    key_questions: ["Which payroll tools produce BIR-compliant payslips?"],
    required_sections: [
      { heading: "What BIR compliance requires", purpose: "The core." },
      { heading: "Choosing a tool", purpose: "The decision." },
    ],
    optional_sections: [],
    internal_link_targets: [],
    external_evidence_requirements: [],
    approved_claims: facts.map((evidence_id) => ({
      text: "Payslips follow BIR formats",
      evidence_id,
    })),
    prohibited_claims: [],
    seo_rule_constraints: [],
    secondary_keyword_evidence_ids: [],
    brand_voice_notes: "Plain and specific.",
    missing_evidence: [],
  };
}
