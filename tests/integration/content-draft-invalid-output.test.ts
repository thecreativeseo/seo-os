import crypto from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { resetProvider, useStubProvider as installStubProvider } from "@/server/ai/registry";
import type { GenerateStructuredRequest } from "@/lib/ai/provider";
import type { ContentBriefOutput } from "@/lib/ai/schemas/content-brief";
import { CONTENT_DRAFT_V2_LIMITS, type ContentDraftOutput } from "@/lib/ai/schemas/content-draft";
import { decide } from "@/server/services/decision";
import { startFromRecommendation } from "@/server/services/content-work";
import { approveBrief, generateBrief } from "@/server/services/content-brief";
import { generateRevision, startDraft } from "@/server/services/content-draft";

/**
 * What happens when the model's draft does not match the contract (the
 * CONTENT_DRAFT real-provider fix): the run fails as invalid_output with a
 * structure-only diagnostic, the package is sealed, no revision is written,
 * the draft is untouched - and a draft that uses the room version 2 gives
 * goes through.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const BAD_SLUG = "/payroll-software-philippines";

type Fixture = TenantContext & { pageId: string; keywordId: string };

async function makeTenant(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `shape-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);
  const organization = await prisma.organization.create({
    data: { name: `Shape ${label}`, slug: `shape-${label}-${suffix}` },
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
  await prisma.brandFact.create({
    data: {
      websiteId: website.id,
      category: "Product",
      factKey: "compliance",
      value: "Payslips follow BIR formats",
      approvalStatus: "APPROVED",
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
  };
}

function citable(request: GenerateStructuredRequest<unknown>, kind: string): string[] {
  return [...(request.untrustedData ?? "").matchAll(/^\[([^\]]+)\]/gm)]
    .map((match) => match[1]!)
    .filter((id) => id.startsWith(`${kind}:`));
}

function briefAnswer(request: GenerateStructuredRequest<unknown>): ContentBriefOutput {
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
    required_sections: [{ heading: "What BIR compliance requires", purpose: "The core." }],
    optional_sections: [],
    internal_link_targets: [],
    external_evidence_requirements: [],
    approved_claims: facts.map((evidence_id) => ({ text: "Claim from a fact", evidence_id })),
    prohibited_claims: [],
    seo_rule_constraints: [],
    secondary_keyword_evidence_ids: [],
    brand_voice_notes: "Plain and specific.",
    missing_evidence: [],
  };
}

function draftAnswer(request: GenerateStructuredRequest<unknown>): ContentDraftOutput {
  const fact = citable(request, "fact")[0] ?? null;
  return {
    title: "Payroll software in the Philippines: a buyer's guide",
    slug: "payroll-software-philippines",
    excerpt: "How to shortlist payroll software that handles BIR requirements.",
    meta_title: "Payroll Software Philippines | Guide",
    meta_description: "Compare payroll software for Philippine employers.",
    body_markdown: "# Guide\n\n## What BIR compliance requires\n\nPayslips follow BIR formats.\n",
    claims: fact ? [{ text: "Payslips follow BIR formats", evidence_id: fact }] : [],
    internal_links_used: [],
    sections_covered: ["What BIR compliance requires"],
    open_questions: [],
    change_summary: "First draft from the brief.",
  };
}

/** A draft ready to generate into, its brief approved through the stub. */
async function readyDraft(tenant: Fixture) {
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
  await approveBrief(tenant, generated.brief.id);
  resetProvider();
  const { draft } = await startDraft(tenant, item.id);
  return { item, draft };
}

afterEach(() => {
  resetProvider();
  vi.restoreAllMocks();
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

describe("a draft that does not match the contract", () => {
  it("fails the run, seals the package, writes nothing, and says where without saying what", async () => {
    const tenant = await makeTenant("invalid");
    const { draft } = await readyDraft(tenant);
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    const cases: {
      label: string;
      shape: (base: ContentDraftOutput) => Record<string, unknown>;
      path: string;
      code: string;
      secret: string;
    }[] = [
      {
        label: "a path-style slug",
        shape: (base) => ({ ...base, slug: BAD_SLUG }),
        path: "slug",
        code: "invalid_format",
        secret: BAD_SLUG,
      },
      {
        label: "an oversized open question",
        shape: (base) => ({
          ...base,
          open_questions: [
            "What does the plan cost? "
              .repeat(30)
              .slice(0, CONTENT_DRAFT_V2_LIMITS.openQuestion + 1),
          ],
        }),
        path: "open_questions.0",
        code: "too_big",
        secret: "What does the plan cost?",
      },
      {
        label: "an oversized change summary",
        shape: (base) => ({
          ...base,
          change_summary: "Rewrote the pricing section. "
            .repeat(50)
            .slice(0, CONTENT_DRAFT_V2_LIMITS.changeSummary + 1),
        }),
        path: "change_summary",
        code: "too_big",
        secret: "Rewrote the pricing section.",
      },
      {
        label: "a list sent as a string",
        shape: (base) => ({ ...base, open_questions: "What does the plan cost?" }),
        path: "open_questions",
        code: "invalid_type",
        secret: "What does the plan cost?",
      },
      {
        label: "a field the contract does not name",
        shape: (base) => ({ ...base, tone: "confident and warm" }),
        path: "(root)",
        code: "unrecognized_keys",
        secret: "confident and warm",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      warnings.length = 0;
      installStubProvider({ respond: (request) => testCase.shape(draftAnswer(request)) });
      const before = await prisma.contentDraft.findUniqueOrThrow({ where: { id: draft.id } });
      const outcome = await generateRevision(tenant, draft.id, {
        generationToken: `invalid-${index}`,
      });

      expect(outcome.ok, testCase.label).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("generation_failed");
      expect(outcome.message).toBe(
        "The draft could not be generated. Nothing was stored; the run is recorded with its reason.",
      );
      expect("run" in outcome && outcome.run).toBeTruthy();
      if (!("run" in outcome) || !outcome.run) return;

      // The run: FAILED, with our code and our message.
      const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: outcome.run.id } });
      expect(run.status).toBe("FAILED");
      expect(run.errorCode).toBe("invalid_output");
      expect(run.promptTemplateVersion).toBe(3);
      expect(run.outputSchemaVersion).toBe("2");
      expect(run.errorSummary).not.toContain(testCase.secret);
      // The package: sealed, on the failure path too.
      const pkg = await prisma.evidencePackage.findUniqueOrThrow({
        where: { id: run.evidencePackageId! },
      });
      expect(pkg.sealedAt).not.toBeNull();
      // Nothing stored, nothing moved.
      expect(await prisma.contentRevision.count({ where: { createdByAiRunId: run.id } })).toBe(0);
      expect(await prisma.contentRevision.count({ where: { contentDraftId: draft.id } })).toBe(0);
      const after = await prisma.contentDraft.findUniqueOrThrow({ where: { id: draft.id } });
      expect(after.currentRevisionId).toBe(before.currentRevisionId);
      expect(after.status).toBe(before.status);
      // The audit says the generation completed as FAILED, on the draft.
      expect(
        await prisma.auditEvent.count({
          where: {
            entityType: "ContentDraft",
            entityId: draft.id,
            action: "COMPLETE",
            afterSnapshotJson: { path: ["aiRunId"], equals: run.id },
          },
        }),
      ).toBe(1);

      // The diagnostic: path, code and size, never the value.
      const diagnostic = warnings.find((line) => line.includes("[ai-diagnostic]"));
      expect(diagnostic, testCase.label).toBeDefined();
      expect(diagnostic).toContain(`"runId":"${run.id}"`);
      expect(diagnostic).toContain(`"path":"${testCase.path}"`);
      expect(diagnostic).toContain(`"code":"${testCase.code}"`);
      expect(diagnostic).toContain('"promptVersion":3');
      expect(diagnostic).not.toContain(testCase.secret);
      expect(diagnostic).not.toContain("Payslips follow BIR formats");
    }
  });

  it("goes through when the draft uses the room version 2 gives", async () => {
    const tenant = await makeTenant("room");
    const { draft } = await readyDraft(tenant);
    const openQuestion = "What does the starter plan cost? "
      .repeat(20)
      .slice(0, CONTENT_DRAFT_V2_LIMITS.openQuestion);
    const changeSummary = "Rewrote the pricing section around the questions buyers ask. "
      .repeat(20)
      .slice(0, CONTENT_DRAFT_V2_LIMITS.changeSummary);
    installStubProvider({
      respond: (request) => ({
        ...draftAnswer(request),
        open_questions: [openQuestion],
        change_summary: changeSummary,
      }),
    });

    const outcome = await generateRevision(tenant, draft.id, { generationToken: "room-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.revision.changeSummary).toBe(changeSummary);
    expect(outcome.run?.status).toBe("SUCCEEDED");
    expect(outcome.run?.promptTemplateVersion).toBe(3);
    expect(outcome.run?.outputSchemaVersion).toBe("2");
    const after = await prisma.contentDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.currentRevisionId).toBe(outcome.revision.id);
  });
});
