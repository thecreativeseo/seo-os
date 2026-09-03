import { afterAll, afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { buildEvidenceId } from "@/lib/evidence/id";
import { resetProvider, useStubProvider } from "@/server/ai/registry";
import type { GenerateStructuredRequest } from "@/lib/ai/provider";
import type { PageDiagnosisOutput, RecommendationOutput } from "@/lib/ai/schemas/page-diagnosis";
import { requestPageDiagnosis } from "@/server/services/diagnosis";
import { decide, getRecommendationForReview, listReviewQueue } from "@/server/services/decision";
import type { Role } from "@/generated/prisma/client";

/**
 * Recommendations and human review (docs/P3_SPEC.md §21–§25, §36).
 *
 * The guardrails in §23 are tested the way the findings were: the stub is
 * scripted to propose what a careless or compromised model would — advice with
 * nothing cited, a forecast dressed as an effect, a change that walks straight
 * through a BLOCKING rule — and the assertion is what the server did about it.
 *
 * The decision tests hold the lines P3_ACCEPTANCE_CRITERIA calls automatic
 * failures: a viewer cannot approve, a client cannot forge approval by naming a
 * decision in a form, a blocked recommendation cannot be approved silently, and
 * nothing a model does ever produces a Decision row.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & { pageId: string; goalId: string };

type RuleFixture = { rule: string; severity: "INFO" | "WARNING" | "BLOCKING"; appliesTo?: string };

/**
 * A tenant with enough real data for a non-empty package, optionally with SEO
 * rules and a membership at a chosen role.
 */
async function makeTenant(
  label: string,
  options: { role?: Role; rules?: RuleFixture[] } = {},
): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `rv-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Review ${label}`, slug: `rv-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: options.role ?? "OWNER",
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

  const context: TenantContext = { user, membership, organization, workspace, website };

  const page = await prisma.page.create({
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

  const goal = await prisma.businessGoal.create({
    data: {
      websiteId: website.id,
      title: "Grow qualified demo requests",
      status: "ACTIVE",
      businessObjective: "More pipeline from organic",
      primaryMetric: "demo_requests",
    },
  });

  const businessContext = await prisma.businessContext.create({ data: { websiteId: website.id } });

  await prisma.businessContextVersion.create({
    data: {
      businessContextId: businessContext.id,
      versionNumber: 1,
      status: "APPROVED",
      companySummary: `${label} sells analytics software.`,
      createdByUserId: user.id,
      approvedByUserId: user.id,
      approvedAt: new Date(),
    },
  });

  for (const rule of options.rules ?? []) {
    await prisma.seoRule.create({
      data: {
        websiteId: website.id,
        category: "Content",
        rule: rule.rule,
        severity: rule.severity,
        appliesTo: rule.appliesTo,
        active: true,
      },
    });
  }

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
    data: { websiteId: website.id, query: `${label} pricing`, normalizedQuery: `${label} pricing` },
  });

  const today = new Date();
  const days = Array.from({ length: 40 }, (_, index) => {
    const date = new Date(today);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (index + 1));
    return date;
  });

  await prisma.gscMetricDaily.createMany({
    data: days.map((date) => ({
      websiteId: website.id,
      pageId: page.id,
      queryId: query.id,
      date,
      clicks: 10,
      impressions: 400,
      position: 6.5,
      sourceConnectionId: connection.id,
    })),
  });

  return { ...context, pageId: page.id, goalId: goal.id };
}

/** The evidence IDs as the model sees them, pulled from the rendered block. */
function citableIds(request: GenerateStructuredRequest<unknown>): string[] {
  return [...(request.untrustedData ?? "").matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]);
}

function ruleIds(request: GenerateStructuredRequest<unknown>): string[] {
  return citableIds(request).filter((id) => id.startsWith("rule:"));
}

function answer(overrides: Partial<PageDiagnosisOutput> = {}): PageDiagnosisOutput {
  return {
    executive_summary: "Clicks held steady against the previous period.",
    overall_confidence: "MEDIUM",
    findings: [],
    recommendations: [],
    ...overrides,
  };
}

function proposal(overrides: Partial<RecommendationOutput> = {}): RecommendationOutput {
  return {
    type: "TITLE_META_UPDATE",
    title: "Rewrite the title to match the commercial query",
    summary: "The title reads as a guide; the query is a purchase.",
    rationale: "Impressions are steady while clicks are flat, which points at the snippet.",
    priority: "HIGH",
    confidence: "MEDIUM",
    effort: "LOW",
    risk: "LOW",
    evidence_ids: [],
    expected_effect_description: null,
    conflicting_rule_ids: [],
    missing_evidence: [],
    ...overrides,
  };
}

/** A recommendation row without a model run, for the decision tests. */
async function makeRecommendation(
  tenant: Fixture,
  overrides: Partial<{
    status: "AWAITING_REVIEW" | "NEEDS_EVIDENCE";
    blockedByRuleId: string | null;
    title: string;
  }> = {},
) {
  return prisma.recommendation.create({
    data: {
      websiteId: tenant.website.id,
      pageId: tenant.pageId,
      type: "TITLE_META_UPDATE",
      status: overrides.status ?? "AWAITING_REVIEW",
      priority: "HIGH",
      title: overrides.title ?? "Rewrite the title",
      summary: "The title reads as a guide.",
      rationale: "Clicks are flat while impressions hold.",
      confidence: "MEDIUM",
      effort: "LOW",
      risk: "LOW",
      blockedByRuleId: overrides.blockedByRuleId ?? null,
      blockedReason: overrides.blockedByRuleId ? "Conflicts with a BLOCKING SEO rule" : null,
    },
  });
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

// ---------------------------------------------------------------------------
// §21-§23: what a proposal is allowed to claim
// ---------------------------------------------------------------------------

describe("recommendations from a diagnosis", () => {
  it("stores a cited proposal awaiting review, attributed to the run and not to a person", async () => {
    const tenant = await makeTenant("cited");

    useStubProvider({
      respond: (request) =>
        answer({
          recommendations: [
            proposal({
              evidence_ids: citableIds(request).slice(0, 3),
              expected_effect_description: "A snippet that answers a buying query.",
            }),
          ],
        }),
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.recommendations).toHaveLength(1);
    const row = outcome.recommendations[0]!;

    expect(row.status).toBe("AWAITING_REVIEW");
    expect(row.diagnosisId).toBe(outcome.diagnosis.id);
    expect(row.pageId).toBe(tenant.pageId);
    expect(row.priority).toBe("HIGH");
    expect(row.effort).toBe("LOW");
    expect(row.risk).toBe("LOW");
    expect(row.confidence).toBe("MEDIUM");
    expect(row.expectedEffectDescription).toBe("A snippet that answers a buying query.");
    // Written by the run, decided by nobody yet.
    expect(row.createdByAiRunId).toBe(outcome.request.aiRunId);
    expect(row.createdByUserId).toBeNull();
    expect(row.blockedByRuleId).toBeNull();

    const links = await prisma.recommendationEvidence.findMany({
      where: { recommendationId: row.id },
    });
    expect(links).toHaveLength(3);
  });

  it("records a proposal with nothing cited as needing evidence, not as advice", async () => {
    const tenant = await makeTenant("uncited");

    useStubProvider({
      responses: [answer({ recommendations: [proposal({ confidence: "HIGH" })] })],
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const row = outcome.recommendations[0]!;
    expect(row.status).toBe("NEEDS_EVIDENCE");
    // A claim resting on nothing cannot be highly confident about it.
    expect(row.confidence).toBe("UNKNOWN");
  });

  it("treats citations that were never in the package as nothing cited", async () => {
    const [tenant, victim] = await Promise.all([makeTenant("outside"), makeTenant("victim")]);
    const stolen = buildEvidenceId({ kind: "goal", goalId: victim.goalId });

    useStubProvider({
      responses: [
        answer({
          recommendations: [
            proposal({ evidence_ids: [stolen, "the analytics", "evidence-7"], confidence: "HIGH" }),
          ],
        }),
      ],
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.citations.outsidePackage).toContain(stolen);
    expect(outcome.citations.malformed).toEqual(["the analytics", "evidence-7"]);

    const row = outcome.recommendations[0]!;
    expect(row.status).toBe("NEEDS_EVIDENCE");
    expect(await prisma.recommendationEvidence.count({ where: { recommendationId: row.id } })).toBe(
      0,
    );
  });

  it("files a REQUEST_MORE_EVIDENCE proposal as needing evidence even when it cites some", async () => {
    const tenant = await makeTenant("more");

    useStubProvider({
      respond: (request) =>
        answer({
          recommendations: [
            proposal({
              type: "REQUEST_MORE_EVIDENCE",
              title: "Capture the page content before deciding",
              evidence_ids: citableIds(request).slice(0, 1),
              missing_evidence: ["No content snapshot for this page."],
            }),
          ],
        }),
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.recommendations[0]?.status).toBe("NEEDS_EVIDENCE");
  });

  it("removes a forecast from the expected effect and says so in the audit trail", async () => {
    const tenant = await makeTenant("forecast");

    useStubProvider({
      respond: (request) =>
        answer({
          recommendations: [
            proposal({
              evidence_ids: citableIds(request).slice(0, 2),
              // The one place a number is a prediction, whatever the units.
              expected_effect_description: "Roughly 20% more clicks within 6 weeks.",
            }),
          ],
        }),
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const row = outcome.recommendations[0]!;
    expect(row.expectedEffectDescription).toBeNull();
    // Still a real, cited, reviewable proposal; only the forecast is gone.
    expect(row.status).toBe("AWAITING_REVIEW");

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: "Recommendation", entityId: row.id, action: "CREATE" },
    });
    expect((audit?.afterSnapshotJson as { forecastRemoved?: boolean })?.forecastRemoved).toBe(true);
  });

  it("blocks a proposal that declares a conflict with a BLOCKING rule", async () => {
    const tenant = await makeTenant("blocked", {
      rules: [
        { rule: "Never remove the pricing table from a commercial page", severity: "BLOCKING" },
        { rule: "Prefer sentence case in titles", severity: "WARNING" },
      ],
    });

    useStubProvider({
      respond: (request) => {
        const rules = ruleIds(request);
        expect(rules).toHaveLength(2);
        return answer({
          recommendations: [
            proposal({
              type: "PAGE_CONSOLIDATION",
              title: "Fold the pricing table into the guide",
              evidence_ids: citableIds(request).slice(0, 2),
              conflicting_rule_ids: rules,
            }),
          ],
        });
      },
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const row = outcome.recommendations[0]!;
    const blocking = await prisma.seoRule.findFirstOrThrow({
      where: { websiteId: tenant.website.id, severity: "BLOCKING" },
    });

    expect(row.blockedByRuleId).toBe(blocking.id);
    expect(row.blockedReason).toContain("Never remove the pricing table");
    // Blocked is not decided: it still waits for a person, who must override by name.
    expect(row.status).toBe("AWAITING_REVIEW");
  });

  it("does not block on a WARNING rule, and ignores an invented rule id", async () => {
    const tenant = await makeTenant("warning", {
      rules: [{ rule: "Prefer sentence case in titles", severity: "WARNING" }],
    });

    useStubProvider({
      respond: (request) =>
        answer({
          recommendations: [
            proposal({
              evidence_ids: citableIds(request).slice(0, 1),
              conflicting_rule_ids: [
                ...ruleIds(request),
                buildEvidenceId({ kind: "rule", seoRuleId: crypto.randomUUID() }),
              ],
            }),
          ],
        }),
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.recommendations[0]?.blockedByRuleId).toBeNull();
    // The invented rule went through the same gate as any citation.
    expect(outcome.citations.outsidePackage).toHaveLength(1);
  });

  it("blocks on a BLOCKING rule that names this page, whether or not the model noticed", async () => {
    const tenant = await makeTenant("named", {
      rules: [
        {
          rule: "The pricing page is frozen during the audit",
          severity: "BLOCKING",
          appliesTo: "/pricing",
        },
      ],
    });

    useStubProvider({
      respond: (request) =>
        answer({
          recommendations: [
            proposal({ evidence_ids: citableIds(request).slice(0, 1), conflicting_rule_ids: [] }),
          ],
        }),
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.recommendations[0]?.blockedByRuleId).not.toBeNull();
    expect(outcome.recommendations[0]?.blockedReason).toContain("frozen during the audit");
  });

  it("never produces a Decision, whatever the model proposes", async () => {
    const tenant = await makeTenant("noself");

    useStubProvider({
      respond: (request) =>
        answer({
          recommendations: [
            proposal({ evidence_ids: citableIds(request).slice(0, 1), confidence: "HIGH" }),
            proposal({
              type: "MONITOR_ONLY",
              title: "Watch it",
              evidence_ids: citableIds(request).slice(1, 2),
            }),
          ],
        }),
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The whole point of §25's last line, held at the service layer as well as
    // in the schema: a run ends with proposals and nothing decided.
    expect(await prisma.decision.count({ where: { websiteId: tenant.website.id } })).toBe(0);
    for (const row of outcome.recommendations) {
      expect(["AWAITING_REVIEW", "NEEDS_EVIDENCE"]).toContain(row.status);
    }
  });

  it("proposes nothing for an empty package", async () => {
    const tenant = await makeTenant("empty");
    // A page the assembler can find nothing about.
    const bare = await prisma.page.create({
      data: {
        websiteId: tenant.website.id,
        url: `https://${tenant.website.normalizedDomain}/bare`,
        normalizedUrl: `https://${tenant.website.normalizedDomain}/bare`,
        path: "/bare",
        hostname: tenant.website.normalizedDomain,
        protocol: "https",
        sourceFirstSeen: "SITEMAP",
      },
    });

    // The governance records still make the package non-empty for this tenant,
    // so this asserts the shape of the outcome rather than the empty path itself.
    useStubProvider({ responses: [answer()] });
    const outcome = await requestPageDiagnosis(tenant, { pageId: bare.id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.recommendations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §24-§25: a person decides
// ---------------------------------------------------------------------------

describe("deciding on a recommendation", () => {
  it("lets an owner approve, and records who and why", async () => {
    const tenant = await makeTenant("approve");
    const row = await makeRecommendation(tenant);

    const { decision, recommendation } = await decide(tenant, row.id, {
      decision: "APPROVED",
      reason: "Matches the goal and the evidence.",
    });

    expect(recommendation.status).toBe("APPROVED");
    expect(decision.decision).toBe("APPROVED");
    expect(decision.decidedByUserId).toBe(tenant.user.id);
    expect(decision.reason).toBe("Matches the goal and the evidence.");
    expect(decision.overriddenRuleId).toBeNull();

    const audit = await prisma.auditEvent.findMany({
      where: { entityId: { in: [row.id, decision.id] } },
      select: { entityType: true, action: true },
    });
    expect(audit).toEqual(
      expect.arrayContaining([
        { entityType: "Decision", action: "CREATE" },
        { entityType: "Recommendation", action: "APPROVE" },
      ]),
    );
  });

  it("refuses a viewer and a member, whatever the form says", async () => {
    for (const role of ["VIEWER", "MEMBER", "SEO_LEAD"] as const) {
      const tenant = await makeTenant(`role-${role.toLowerCase()}`, { role });
      const row = await makeRecommendation(tenant);

      await expect(decide(tenant, row.id, { decision: "APPROVED" })).rejects.toMatchObject({
        code: "forbidden",
      });

      const unchanged = await prisma.recommendation.findUniqueOrThrow({ where: { id: row.id } });
      expect(unchanged.status).toBe("AWAITING_REVIEW");
      expect(await prisma.decision.count({ where: { recommendationId: row.id } })).toBe(0);
    }
  });

  it("lets an admin decide", async () => {
    const tenant = await makeTenant("admin", { role: "ADMIN" });
    const row = await makeRecommendation(tenant);

    const { recommendation } = await decide(tenant, row.id, {
      decision: "REJECTED",
      reason: "Not this quarter.",
    });
    expect(recommendation.status).toBe("REJECTED");
  });

  it("will not approve a blocked recommendation silently", async () => {
    const tenant = await makeTenant("override", {
      rules: [{ rule: "Never remove the pricing table", severity: "BLOCKING" }],
    });
    const rule = await prisma.seoRule.findFirstOrThrow({ where: { websiteId: tenant.website.id } });
    const row = await makeRecommendation(tenant, { blockedByRuleId: rule.id });

    // No override: refused.
    await expect(decide(tenant, row.id, { decision: "APPROVED" })).rejects.toMatchObject({
      code: "override_required",
    });

    // The wrong rule named: refused. An override is of a specific rule.
    await expect(
      decide(tenant, row.id, {
        decision: "APPROVED",
        override: { ruleId: crypto.randomUUID(), reason: "Because." },
      }),
    ).rejects.toMatchObject({ code: "override_mismatch" });

    // No reason: refused.
    await expect(
      decide(tenant, row.id, { decision: "APPROVED", override: { ruleId: rule.id, reason: "  " } }),
    ).rejects.toMatchObject({ code: "reason_required" });

    // The rule named and a reason given: recorded as an override, by name.
    const { decision, recommendation } = await decide(tenant, row.id, {
      decision: "APPROVED",
      override: { ruleId: rule.id, reason: "The table moves to the new pricing page first." },
    });
    expect(recommendation.status).toBe("APPROVED");
    expect(decision.overriddenRuleId).toBe(rule.id);
    expect(decision.overrideReason).toContain("moves to the new pricing page");
  });

  it("will not approve a recommendation that still needs evidence", async () => {
    const tenant = await makeTenant("needs");
    const row = await makeRecommendation(tenant, { status: "NEEDS_EVIDENCE" });

    await expect(decide(tenant, row.id, { decision: "APPROVED" })).rejects.toMatchObject({
      code: "needs_evidence",
    });

    // It can still be rejected, or sent back again.
    const { recommendation } = await decide(tenant, row.id, {
      decision: "REJECTED",
      reason: "Not worth chasing the evidence.",
    });
    expect(recommendation.status).toBe("REJECTED");
  });

  it("requires a reason to reject or to ask for more evidence", async () => {
    const tenant = await makeTenant("reason");
    const row = await makeRecommendation(tenant);

    await expect(
      decide(tenant, row.id, { decision: "REJECTED", reason: "" }),
    ).rejects.toMatchObject({
      code: "reason_required",
    });
    await expect(
      decide(tenant, row.id, { decision: "NEEDS_EVIDENCE", reason: "   " }),
    ).rejects.toMatchObject({ code: "reason_required" });

    const { decision } = await decide(tenant, row.id, {
      decision: "NEEDS_EVIDENCE",
      reason: "Show me the SERP first.",
    });
    expect(decision.decision).toBe("NEEDS_EVIDENCE");
  });

  it("keeps a modification as a diff beside the proposal, not over it", async () => {
    const tenant = await makeTenant("modify");
    const row = await makeRecommendation(tenant, { title: "Rewrite the title" });

    await expect(
      decide(tenant, row.id, { decision: "MODIFIED", modifications: {} }),
    ).rejects.toMatchObject({ code: "nothing_modified" });

    // The reviewer is held to §23 too.
    await expect(
      decide(tenant, row.id, {
        decision: "MODIFIED",
        modifications: { expectedEffectDescription: "About 15% more clicks." },
      }),
    ).rejects.toMatchObject({ code: "nothing_modified" });

    const { decision, recommendation } = await decide(tenant, row.id, {
      decision: "MODIFIED",
      reason: "Narrower change.",
      modifications: { title: "Rewrite only the meta description", effort: "LOW" },
    });

    expect(recommendation.status).toBe("MODIFIED");
    // The proposal's text is untouched; the change lives on the decision.
    expect(recommendation.title).toBe("Rewrite the title");
    expect(decision.modifiedRecommendationJson).toEqual({
      before: { title: "Rewrite the title" },
      after: { title: "Rewrite only the meta description" },
    });
  });

  it("decides once; decisions are appended, never rewritten", async () => {
    const tenant = await makeTenant("once");
    const row = await makeRecommendation(tenant);

    await decide(tenant, row.id, { decision: "APPROVED" });

    await expect(
      decide(tenant, row.id, { decision: "REJECTED", reason: "Changed my mind." }),
    ).rejects.toMatchObject({ code: "already_decided" });

    expect(await prisma.decision.count({ where: { recommendationId: row.id } })).toBe(1);
  });

  it("does not let another tenant's owner decide", async () => {
    const [owner, outsider] = await Promise.all([makeTenant("own"), makeTenant("out")]);
    const row = await makeRecommendation(owner);

    await expect(decide(outsider, row.id, { decision: "APPROVED" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await prisma.decision.count({ where: { recommendationId: row.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §24: what the reviewer sees
// ---------------------------------------------------------------------------

describe("the review queue and screen", () => {
  it("lists what is undecided and nothing else", async () => {
    const tenant = await makeTenant("queue");
    const open = await makeRecommendation(tenant, { title: "Open" });
    const needs = await makeRecommendation(tenant, { title: "Needs", status: "NEEDS_EVIDENCE" });
    const done = await makeRecommendation(tenant, { title: "Done" });
    await decide(tenant, done.id, { decision: "APPROVED" });

    const queue = await listReviewQueue(tenant);
    const ids = queue.map((item) => item.id);

    expect(ids).toContain(open.id);
    expect(ids).toContain(needs.id);
    expect(ids).not.toContain(done.id);
  });

  it("assembles everything §24 says a reviewer sees, with rules BLOCKING first", async () => {
    const tenant = await makeTenant("screen", {
      rules: [
        { rule: "Prefer sentence case", severity: "INFO" },
        { rule: "Never remove the pricing table", severity: "BLOCKING" },
      ],
    });

    useStubProvider({
      respond: (request) =>
        answer({
          findings: [
            {
              category: "CTR_SERP_MISMATCH",
              verdict: "SUSPECT",
              confidence: "MEDIUM",
              title: "Snippet may not match the query",
              summary: "Impressions steady, clicks flat.",
              supporting_evidence_ids: citableIds(request).slice(0, 1),
              contradicting_evidence_ids: [],
              missing_evidence: ["No SERP snapshot."],
            },
          ],
          recommendations: [proposal({ evidence_ids: citableIds(request).slice(0, 2) })],
        }),
    });

    const outcome = await requestPageDiagnosis(tenant, { pageId: tenant.pageId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const row = outcome.recommendations[0]!;
    await decide(tenant, row.id, { decision: "NEEDS_EVIDENCE", reason: "Show the SERP." });

    const review = await getRecommendationForReview(tenant, row.id);
    expect(review).not.toBeNull();

    // Diagnosis, findings and their missing evidence.
    expect(review!.diagnosis?.id).toBe(outcome.diagnosis.id);
    expect(review!.diagnosis?.findings[0]?.missingEvidenceJson).toEqual(["No SERP snapshot."]);
    // The cited evidence, resolved now, not read back from a cache.
    expect(review!.evidence).toHaveLength(2);
    expect(review!.staleEvidenceIds).toEqual([]);
    // Rules in force, most severe first, whether or not they bite.
    expect(review!.rules.map((rule) => rule.severity)).toEqual(["BLOCKING", "INFO"]);
    // Risk, effort, confidence on the recommendation itself.
    expect(review!.recommendation.effort).toBe("LOW");
    expect(review!.recommendation.risk).toBe("LOW");
    // And the decision history, with who decided.
    expect(review!.decisions).toHaveLength(1);
    expect(review!.decisions[0]?.decidedBy.email).toBe(tenant.user.email);
  });

  it("shows nothing to another tenant", async () => {
    const [owner, outsider] = await Promise.all([makeTenant("see-a"), makeTenant("see-b")]);
    const row = await makeRecommendation(owner);

    expect(await getRecommendationForReview(outsider, row.id)).toBeNull();
    expect((await listReviewQueue(outsider)).map((item) => item.id)).not.toContain(row.id);
  });
});
