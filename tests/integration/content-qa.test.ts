import crypto from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { resetProvider, useStubProvider as installStubProvider } from "@/server/ai/registry";
import type { GenerateStructuredRequest } from "@/lib/ai/provider";
import type { ContentBriefOutput } from "@/lib/ai/schemas/content-brief";
import { systemContextFor } from "@/server/jobs/system-context";
import { decide } from "@/server/services/decision";
import { startFromRecommendation } from "@/server/services/content-work";
import { approveBrief, generateBrief } from "@/server/services/content-brief";
import {
  approveDraft,
  reopenDraft,
  requestDraftReview,
  saveRevision,
  startDraft,
} from "@/server/services/content-draft";
import {
  ContentQaError,
  QA_FAILED_MESSAGE,
  QA_REVISION_CHANGED_MESSAGE,
  currentInputsFingerprint,
  getQaRun,
  latestQaRun,
  listQaRuns,
  qaRunsForRevision,
  runQa,
  siteHostOf,
} from "@/server/services/content-qa";
import { QA_CHECKER_VERSION, QA_TYPES, runDeterministicChecks } from "@/lib/content/qa";
import type { Role } from "@/generated/prisma/client";
import { deleteOrganizations } from "../helpers/teardown";

/**
 * P4 M5.1: the QA run service. Exactly the approved revision, by id and
 * hash; ten results per run; NOT_CHECKED where there was nothing to check
 * with and FAILED where a check could not finish; the work item following
 * the outcome; history kept; and a database that refuses to let any of it
 * be rewritten.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & {
  pageId: string;
  keywordId: string;
  factApproved: string;
  ruleId: string;
};

async function makeTenant(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `qa-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);
  const organization = await prisma.organization.create({
    data: { name: `QA ${label}`, slug: `qa-${label}-${suffix}` },
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

async function colleague(tenant: Fixture, role: Role): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      authUserId: crypto.randomUUID(),
      email: `qa-${role.toLowerCase()}-${suffix}@example.com`,
    },
  });
  userIds.push(user.id);
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

const BODY = [
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

/** A work item Ready for QA: brief approved, a hand-written revision approved by a lead. */
async function readyForQa(tenant: Fixture, lead: TenantContext, bodyMarkdown = BODY) {
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

// The deterministic path, on purpose: no judge is configured here. The
// judged path has its own suite.
beforeAll(() => {
  vi.stubEnv("AI_PROVIDER", "null");
  resetProvider();
});

afterEach(() => resetProvider());

afterAll(async () => {
  if (organizationIds.length > 0) {
    await deleteOrganizations(organizationIds);
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("running QA on the approved revision", () => {
  it("records ten results bound to the exact revision, and moves the work item to await final approval", async () => {
    const tenant = await makeTenant("run");
    const lead = await colleague(tenant, "SEO_LEAD");
    const { item, revision, brief } = await readyForQa(tenant, lead);
    expect(item.status).toBe("QA");

    const outcome = await runQa(tenant, item.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The run: bound, completed, fingerprinted, sealed.
    expect(outcome.run).toMatchObject({
      status: "COMPLETED",
      outcome: "PASS_WITH_WARNINGS",
      contentRevisionId: revision.id,
      revisionNumber: 1,
      revisionHash: revision.contentHash,
      briefId: brief.id,
      briefVersion: 1,
      checkerVersion: QA_CHECKER_VERSION,
      requestedByUserId: tenant.user.id,
      blockingCount: 0,
      errorCode: null,
    });
    expect(outcome.run.inputsFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(outcome.run.inputsFingerprint).toBe(await currentInputsFingerprint(tenant));
    expect(outcome.run.completedAt).not.toBeNull();
    expect(outcome.run.evidencePackageId).not.toBeNull();
    const pkg = await prisma.evidencePackage.findUniqueOrThrow({
      where: { id: outcome.run.evidencePackageId! },
    });
    expect(pkg).toMatchObject({
      purpose: "QA_CONTENT",
      targetType: "CONTENT_REVISION",
      targetId: revision.id,
    });
    expect(pkg.sealedAt).not.toBeNull();
    expect(outcome.run.contextVersionId).not.toBeNull();
    expect(outcome.run.aiRunId).toBeNull();
    expect(outcome.workItem.status).toBe("AWAITING_EDITOR_REVIEW");

    // The results: one per type, in the spec's order, each on the run's hash.
    const rows = await prisma.contentQaResult.findMany({
      where: { qaRunId: outcome.run.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((row) => row.qaType)).toEqual([...QA_TYPES]);
    for (const row of rows) {
      expect(row.contentRevisionId).toBe(revision.id);
      expect(row.revisionHash).toBe(revision.contentHash);
      expect(row.checkerVersion).toBe(QA_CHECKER_VERSION);
      expect(row.aiRunId).toBeNull();
      expect(row.source).toBe("DETERMINISTIC");
    }
    const byType = new Map(rows.map((row) => [row.qaType, row]));
    expect(byType.get("BRAND_FACT_VALIDATION")?.status).toBe("PASS");
    expect(byType.get("SEO_RULE_VALIDATION")?.status).toBe("PASS");
    expect(byType.get("INTENT_ALIGNMENT")).toMatchObject({
      status: "NOT_CHECKED",
      notCheckedReason: "NO_PROVIDER",
    });
    expect(byType.get("ANSWER_READINESS")).toMatchObject({
      status: "NOT_CHECKED",
      notCheckedReason: "NO_PROVIDER",
    });
    // Only one page: nothing to compare against for duplicates.
    expect(byType.get("DUPLICATION_RISK")?.status).toBe("PASS_WITH_WARNINGS");
    expect(outcome.run.notCheckedCount).toBeGreaterThan(0);

    // The reader agrees with the rows and says the run is current.
    const view = await getQaRun(tenant, outcome.run.id);
    expect(view?.results).toHaveLength(10);
    expect(
      view?.results.every(
        (result) => Array.isArray(result.findings) && Array.isArray(result.coverage),
      ),
    ).toBe(true);
    expect(view?.revision).toMatchObject({ id: revision.id, revisionNumber: 1 });
    expect(view?.currency).toEqual({
      revisionApproved: true,
      inputsCurrent: true,
      latestForRevision: true,
      current: true,
    });
    expect((await latestQaRun(tenant, item.id))?.run.id).toBe(outcome.run.id);
    expect((await qaRunsForRevision(tenant, revision.id)).map((row) => row.id)).toEqual([
      outcome.run.id,
    ]);

    // The trail.
    const events = await prisma.auditEvent.findMany({
      where: { entityType: "ContentQaRun", entityId: outcome.run.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.action)).toEqual(["EXECUTE", "COMPLETE"]);
    expect(JSON.stringify(events)).not.toContain("Every employer files the same forms");
  });

  it("fails the run and keeps the work item in QA when a fact was revoked after the editorial approval", async () => {
    const tenant = await makeTenant("revoked");
    const lead = await colleague(tenant, "SEO_LEAD");
    const { item } = await readyForQa(tenant, lead);
    const before = await currentInputsFingerprint(tenant);
    await prisma.brandFact.update({
      where: { id: tenant.factApproved },
      data: { approvalStatus: "REJECTED" },
    });
    expect(await currentInputsFingerprint(tenant)).not.toBe(before);

    const outcome = await runQa(tenant, item.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.run.outcome).toBe("FAIL");
    expect(outcome.run.blockingCount).toBeGreaterThanOrEqual(1);
    expect(outcome.workItem.status).toBe("QA");
    const facts = await prisma.contentQaResult.findFirstOrThrow({
      where: { qaRunId: outcome.run.id, qaType: "BRAND_FACT_VALIDATION" },
    });
    expect(facts.status).toBe("FAIL");
    const blocking = facts.blockingIssuesJson as { code: string; refs?: { factId?: string } }[];
    expect(blocking[0]).toMatchObject({
      code: "STALE_CLAIM",
      refs: { factId: tenant.factApproved },
    });
    // Nothing about the content changed.
    const draft = await prisma.contentDraft.findFirstOrThrow({
      where: { contentWorkItemId: item.id },
    });
    expect(draft.status).toBe("APPROVED");
    expect(draft.approvedRevisionId).not.toBeNull();
  });

  it("re-runs into history: a second run agrees with the first, and the item comes back on a later FAIL", async () => {
    const tenant = await makeTenant("rerun");
    const lead = await colleague(tenant, "SEO_LEAD");
    const { item, revision } = await readyForQa(tenant, lead);
    const first = await runQa(tenant, item.id);
    const second = await runQa(tenant, item.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.run.inputsFingerprint).toBe(first.run.inputsFingerprint);
    const findingsOf = async (runId: string) =>
      (
        await prisma.contentQaResult.findMany({
          where: { qaRunId: runId },
          orderBy: { qaType: "asc" },
        })
      ).map((row) => [
        row.qaType,
        row.status,
        JSON.stringify(row.blockingIssuesJson),
        JSON.stringify(row.warningsJson),
      ]);
    expect(await findingsOf(second.run.id)).toEqual(await findingsOf(first.run.id));
    expect((await listQaRuns(tenant, item.id)).map((row) => row.id)).toEqual([
      second.run.id,
      first.run.id,
    ]);
    expect((await getQaRun(tenant, first.run.id))?.currency.latestForRevision).toBe(false);
    expect((await getQaRun(tenant, second.run.id))?.currency.current).toBe(true);
    expect(await qaRunsForRevision(tenant, revision.id)).toHaveLength(2);

    await prisma.brandFact.update({
      where: { id: tenant.factApproved },
      data: { approvalStatus: "REJECTED" },
    });
    expect((await getQaRun(tenant, second.run.id))?.currency).toMatchObject({
      inputsCurrent: false,
      current: false,
    });
    const third = await runQa(tenant, item.id);
    expect(third.ok && third.run.outcome === "FAIL").toBe(true);
    if (!third.ok) return;
    expect(third.workItem.status).toBe("QA");
  });
});

describe("what QA refuses, and how it fails", () => {
  it("refuses a work item with nothing approved, one in the wrong state, a viewer, and the system actor", async () => {
    const tenant = await makeTenant("refuse");
    const lead = await colleague(tenant, "SEO_LEAD");
    const viewer = await colleague(tenant, "VIEWER");
    const member = await colleague(tenant, "MEMBER");
    const { item, draft } = await readyForQa(tenant, lead);

    await expect(runQa(viewer, item.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(runQa(await systemContextFor(tenant.website.id), item.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(runQa(member, crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });

    // Reopened: the draft is no longer approved, the item is drafting.
    await reopenDraft(member, draft.id, "One more pass.");
    await expect(runQa(member, item.id)).rejects.toMatchObject({ code: "invalid_state" });
    // Back in QA by status, but the pointer was cleared: still nothing approved.
    await prisma.contentWorkItem.update({ where: { id: item.id }, data: { status: "QA" } });
    await expect(runQa(member, item.id)).rejects.toBeInstanceOf(ContentQaError);
    await expect(runQa(member, item.id)).rejects.toMatchObject({ code: "no_approved_revision" });
    expect(await prisma.contentQaRun.count({ where: { contentWorkItemId: item.id } })).toBe(0);
  });

  it("fails the run, records no result, and leaves the item alone when a checker throws", async () => {
    const tenant = await makeTenant("crash");
    const lead = await colleague(tenant, "SEO_LEAD");
    const { item } = await readyForQa(tenant, lead);
    const outcome = await runQa(tenant, item.id, {
      checks: () => {
        throw new Error("a product error inside a checker");
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("checker_error");
    expect(outcome.message).toBe(QA_FAILED_MESSAGE);
    expect(outcome.run.status).toBe("FAILED");
    expect(outcome.run.outcome).toBeNull();
    expect(outcome.run.errorCode).toBe("checker_error");
    expect(outcome.run.errorSummary).not.toContain("product error inside");
    expect(await prisma.contentQaResult.count({ where: { qaRunId: outcome.run.id } })).toBe(0);
    expect(
      (await prisma.contentWorkItem.findUniqueOrThrow({ where: { id: item.id } })).status,
    ).toBe("QA");
    // A checker that returns nothing is a product error too, not NOT_CHECKED.
    const empty = await runQa(tenant, item.id, { checks: () => [] });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.code).toBe("checker_error");
    // And the next honest run goes through.
    const honest = await runQa(tenant, item.id);
    expect(honest.ok).toBe(true);
    expect((await listQaRuns(tenant, item.id)).map((row) => row.status)).toEqual([
      "COMPLETED",
      "FAILED",
      "FAILED",
    ]);
  });

  it("fails the run without recording a verdict when the approval moves underneath it", async () => {
    const tenant = await makeTenant("changed");
    const lead = await colleague(tenant, "SEO_LEAD");
    const { item, revision } = await readyForQa(tenant, lead);

    const tampered = await runQa(tenant, item.id, {
      checks: async (subject, ctx) => {
        // The approval pointer moves between the checks and the transaction
        // that records the verdict, as if someone reopened the draft mid-run.
        await prisma.contentDraft.updateMany({
          where: { contentWorkItemId: item.id },
          data: { approvedRevisionHash: "sha256:tampered" },
        });
        return runDeterministicChecks(subject, ctx);
      },
    });
    expect(tampered.ok).toBe(false);
    if (tampered.ok) return;
    expect(tampered.code).toBe("revision_changed");
    expect(tampered.message).toBe(QA_REVISION_CHANGED_MESSAGE);
    expect(await prisma.contentQaResult.count({ where: { qaRunId: tampered.run.id } })).toBe(0);
    expect(tampered.run.status).toBe("FAILED");
    // The revision itself was never touched.
    const row = await prisma.contentRevision.findUniqueOrThrow({ where: { id: revision.id } });
    expect(row.contentHash).toBe(revision.contentHash);
  });

  it("allows one run at a time, and closes a run that died", async () => {
    const tenant = await makeTenant("guard");
    const lead = await colleague(tenant, "SEO_LEAD");
    const { item, revision, draft, brief } = await readyForQa(tenant, lead);
    const stuck = await prisma.contentQaRun.create({
      data: {
        websiteId: tenant.website.id,
        contentWorkItemId: item.id,
        contentDraftId: draft.id,
        contentRevisionId: revision.id,
        revisionNumber: 1,
        revisionHash: revision.contentHash,
        briefId: brief.id,
        briefVersion: 1,
        inputsFingerprint: "pending",
        checkerVersion: QA_CHECKER_VERSION,
        requestedByUserId: tenant.user.id,
      },
    });
    await expect(runQa(tenant, item.id)).rejects.toMatchObject({ code: "in_progress" });
    await prisma.contentQaRun.update({
      where: { id: stuck.id },
      data: { startedAt: new Date(Date.now() - 11 * 60 * 1000) },
    });
    const outcome = await runQa(tenant, item.id);
    expect(outcome.ok).toBe(true);
    expect((await prisma.contentQaRun.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe(
      "FAILED",
    );
  });
});

describe("what the database refuses", () => {
  it("keeps results bound to their run's revision and hash, and never lets a completed run or a result change", async () => {
    const tenant = await makeTenant("db");
    const lead = await colleague(tenant, "SEO_LEAD");
    const { item, revision } = await readyForQa(tenant, lead);
    const outcome = await runQa(tenant, item.id);
    if (!outcome.ok) throw new Error("run failed");
    const result = await prisma.contentQaResult.findFirstOrThrow({
      where: { qaRunId: outcome.run.id },
    });

    // A status it does not already hold: writing a column its own value
    // changes nothing and is not a mutation.
    await expect(
      prisma.contentQaResult.update({
        where: { id: result.id },
        data: { status: result.status === "PASS" ? "FAIL" : "PASS" },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.contentQaRun.update({ where: { id: outcome.run.id }, data: { outcome: "PASS" } }),
    ).rejects.toThrow(/immutable/);
    await expect(prisma.contentQaResult.delete({ where: { id: result.id } })).rejects.toThrow(
      /history/,
    );
    await expect(prisma.contentQaRun.delete({ where: { id: outcome.run.id } })).rejects.toThrow(
      /history/,
    );
    // A result cannot be added to a completed run.
    await expect(
      prisma.contentQaResult.create({
        data: {
          websiteId: tenant.website.id,
          contentRevisionId: revision.id,
          qaRunId: outcome.run.id,
          revisionHash: revision.contentHash,
          qaType: "STRUCTURE",
          status: "PASS",
          checkerVersion: "x",
        },
      }),
    ).rejects.toThrow(/COMPLETED/);
  });

  it("holds one effective CMS approval per work item, never edits one, and needs a reason to invalidate it", async () => {
    const tenant = await makeTenant("approval");
    const lead = await colleague(tenant, "SEO_LEAD");
    const { item, revision, draft, brief } = await readyForQa(tenant, lead);
    const outcome = await runQa(tenant, item.id);
    if (!outcome.ok) throw new Error("run failed");
    const data = {
      websiteId: tenant.website.id,
      contentWorkItemId: item.id,
      contentDraftId: draft.id,
      contentRevisionId: revision.id,
      revisionNumber: 1,
      revisionHash: revision.contentHash,
      qaRunId: outcome.run.id,
      briefId: brief.id,
      briefVersion: 1,
      approvedByUserId: lead.user.id,
    };
    const approval = await prisma.contentCmsApproval.create({ data });
    await expect(prisma.contentCmsApproval.create({ data })).rejects.toThrow(/unique/i);
    await expect(
      prisma.contentCmsApproval.update({ where: { id: approval.id }, data: { note: "edited" } }),
    ).rejects.toThrow(/only be invalidated/);
    await expect(
      prisma.contentCmsApproval.update({
        where: { id: approval.id },
        data: { status: "INVALIDATED" },
      }),
    ).rejects.toThrow(/reason/);
    await expect(
      prisma.contentCmsApproval.update({
        where: { id: approval.id },
        data: { status: "INVALIDATED", invalidatedReason: "Reopened.", revisionHash: "other" },
      }),
    ).rejects.toThrow(/pins/);
    const invalidated = await prisma.contentCmsApproval.update({
      where: { id: approval.id },
      data: { status: "INVALIDATED", invalidatedAt: new Date(), invalidatedReason: "Reopened." },
    });
    expect(invalidated.status).toBe("INVALIDATED");
    await expect(
      prisma.contentCmsApproval.update({
        where: { id: approval.id },
        data: { invalidatedReason: "Again." },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(prisma.contentCmsApproval.delete({ where: { id: approval.id } })).rejects.toThrow(
      /history/,
    );
    // A second effective approval is allowed once the first is history.
    await prisma.contentCmsApproval.create({ data });
  });

  it("reads the host out of whatever the domain field holds", () => {
    expect(siteHostOf("example.com")).toBe("example.com");
    expect(siteHostOf("https://www.northwind-analytics.com/")).toBe("northwind-analytics.com");
    expect(siteHostOf("WWW.Example.com:443/path")).toBe("example.com");
  });
});
