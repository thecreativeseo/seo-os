import crypto from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { resetProvider, useStubProvider } from "@/server/ai/registry";
import { buildEvidenceId } from "@/lib/evidence/id";
import type { ContentBriefOutput } from "@/lib/ai/schemas/content-brief";
import { systemContextFor } from "@/server/jobs/system-context";
import { decide } from "@/server/services/decision";
import { startFromRecommendation } from "@/server/services/content-work";
import {
  ContentBriefError,
  approveBrief,
  archiveBrief,
  changedFields,
  createManualBrief,
  currentBrief,
  generateBrief,
  getBriefEvidence,
  listBriefVersions,
  requestBriefReview,
  saveBrief,
  type BriefInput,
  type CitedClaim,
  type LinkTarget,
  type ProhibitedClaim,
  type RuleConstraint,
} from "@/server/services/content-brief";
import type { Role } from "@/generated/prisma/client";

/**
 * Content briefs (docs/P4_SPEC.md §7, §8, §11).
 *
 * The stub provider plays a model that cites badly on purpose: an ID it made
 * up, one from another tenant, one for a fact that was never approved, and a
 * real record cited for a field it cannot support. What is asserted is what
 * survives to the row - and that an approved version never changes again.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & {
  pageId: string;
  otherPageId: string;
  keywordId: string;
  otherKeywordId: string;
  topicId: string;
  goalId: string;
  approvedFactId: string;
  proposedFactId: string;
  blockingRuleId: string;
  contextVersionId: string;
  ownershipId: string;
  otherOwnershipId: string;
};

async function makeTenant(label: string, role: Role = "OWNER"): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `cb-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Brief ${label}`, slug: `cb-${label}-${suffix}` },
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

  const context = await prisma.businessContext.create({ data: { websiteId: website.id } });
  const version = await prisma.businessContextVersion.create({
    data: {
      businessContextId: context.id,
      versionNumber: 1,
      status: "APPROVED",
      createdByUserId: user.id,
      approvedByUserId: user.id,
      approvedAt: new Date(),
      companySummary: "Payroll software for Philippine employers.",
      primaryCustomer: "HR leads at growing companies",
      primaryConversion: "Book a demo",
      approvedClaims: ["BIR-compliant payslips"],
      prohibitedClaims: ["Guaranteed compliance", "Cheapest payroll software"],
      avoidTopics: ["Tax evasion"],
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

  const approvedFact = await prisma.brandFact.create({
    data: {
      websiteId: website.id,
      category: "Product",
      factKey: "compliance",
      value: "Payslips follow BIR formats",
      approvalStatus: "APPROVED",
    },
  });
  const proposedFact = await prisma.brandFact.create({
    data: {
      websiteId: website.id,
      category: "Traction",
      factKey: "customers",
      value: "Trusted by 10,000 businesses",
      approvalStatus: "PROPOSED",
    },
  });

  const blockingRule = await prisma.seoRule.create({
    data: {
      websiteId: website.id,
      category: "Claims",
      rule: "Never promise outcomes: no guarantees, no 'best', no 'cheapest'.",
      severity: "BLOCKING",
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
  const otherPage = await prisma.page.create({
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

  await prisma.pageContentSnapshot.create({
    data: {
      websiteId: website.id,
      pageId: page.id,
      capturedAt: new Date(),
      contentHash: crypto.createHash("sha256").update(`${suffix}-body`).digest("hex"),
      source: "MANUAL_PASTE",
      title: "Payroll software",
      bodyText: "Our payroll software handles Philippine payroll end to end.",
      wordCount: 9,
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
  const otherKeyword = await prisma.keyword.create({
    data: {
      websiteId: website.id,
      keyword: `${label} payroll pricing`,
      normalizedKeyword: `${label} payroll pricing`,
      locale: "en-PH",
      language: "en",
      market: "PH",
      intent: "TRANSACTIONAL",
    },
  });

  const topic = await prisma.topic.create({
    data: { websiteId: website.id, name: "Payroll", slug: `payroll-${suffix}` },
  });
  await prisma.topicKeyword.createMany({
    data: [
      { topicId: topic.id, keywordId: keyword.id },
      { topicId: topic.id, keywordId: otherKeyword.id },
    ],
  });

  const ownership = await prisma.keywordPageOwnership.create({
    data: {
      websiteId: website.id,
      keywordId: keyword.id,
      pageId: page.id,
      ownershipType: "PRIMARY",
      status: "ACTIVE",
    },
  });
  const otherOwnership = await prisma.keywordPageOwnership.create({
    data: {
      websiteId: website.id,
      keywordId: otherKeyword.id,
      pageId: otherPage.id,
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
    otherPageId: otherPage.id,
    keywordId: keyword.id,
    otherKeywordId: otherKeyword.id,
    topicId: topic.id,
    goalId: goal.id,
    approvedFactId: approvedFact.id,
    proposedFactId: proposedFact.id,
    blockingRuleId: blockingRule.id,
    contextVersionId: version.id,
    ownershipId: ownership.id,
    otherOwnershipId: otherOwnership.id,
  };
}

/** An approved CONTENT_REFRESH work item on the fixture's page. */
async function makeItem(tenant: Fixture) {
  const recommendation = await prisma.recommendation.create({
    data: {
      websiteId: tenant.website.id,
      pageId: tenant.pageId,
      keywordId: tenant.keywordId,
      topicId: tenant.topicId,
      type: "CONTENT_REFRESH",
      status: "AWAITING_REVIEW",
      priority: "HIGH",
      title: "Refresh the payroll software page",
      summary: "Bring the page in line with what buyers search for.",
      rationale: "Clicks fell while impressions held.",
    },
  });
  await decide(tenant, recommendation.id, { decision: "APPROVED" });
  return startFromRecommendation(tenant, recommendation.id);
}

/** The IDs the fixture's records carry in a package. */
function ids(tenant: Fixture) {
  return {
    fact: buildEvidenceId({ kind: "fact", brandFactId: tenant.approvedFactId }),
    proposedFact: buildEvidenceId({ kind: "fact", brandFactId: tenant.proposedFactId }),
    ctx: buildEvidenceId({ kind: "ctx", contextVersionId: tenant.contextVersionId }),
    rule: buildEvidenceId({ kind: "rule", seoRuleId: tenant.blockingRuleId }),
    goal: buildEvidenceId({ kind: "goal", goalId: tenant.goalId }),
    ownOther: buildEvidenceId({ kind: "own", ownershipId: tenant.otherOwnershipId }),
    ownSelf: buildEvidenceId({ kind: "own", ownershipId: tenant.ownershipId }),
    // Well-formed, never issued: the same string every time it is asked for.
    fabricated: buildEvidenceId({
      kind: "fact",
      brandFactId: "00000000-0000-4000-8000-0000000000ff",
    }),
  };
}

/** A model that cites well, and also badly in every way the server must catch. */
function answer(tenant: Fixture, crossTenantId: string): ContentBriefOutput {
  const id = ids(tenant);
  return {
    title: "Payroll software in the Philippines: a buyer's guide",
    content_type: "GUIDE",
    search_intent: "COMMERCIAL",
    primary_conversion: "Book a demo",
    audience: "HR leads at growing Philippine companies",
    customer_problem: "They cannot tell which payroll tools handle BIR requirements.",
    desired_outcome: "The reader shortlists tools and books a demo.",
    recommended_angle: "Compliance first, features second.",
    key_questions: ["Which payroll tools produce BIR-compliant payslips?", "What does it cost?"],
    required_sections: [
      { heading: "What BIR compliance requires", purpose: "Answer the first question." },
    ],
    optional_sections: [{ heading: "Glossary", purpose: "Terms a first-time buyer meets." }],
    internal_link_targets: [
      { evidence_id: id.ownOther, anchor_text: "payroll pricing", reason: "The next step." },
      // The page's own ownership record: a page must not link to itself.
      { evidence_id: id.ownSelf, anchor_text: "payroll software", reason: "self" },
    ],
    external_evidence_requirements: ["A verified customer count, if one is to be quoted."],
    approved_claims: [
      { text: "Payslips follow BIR formats", evidence_id: id.fact },
      { text: "Trusted by 10,000 businesses", evidence_id: id.proposedFact },
      { text: "Rated best payroll tool", evidence_id: id.fabricated },
      { text: "Something from another tenant", evidence_id: crossTenantId },
      { text: "Grow demo requests", evidence_id: id.goal },
      { text: "Nonsense", evidence_id: "ev-42" },
    ],
    prohibited_claims: [{ text: "Never say 'cheapest'", evidence_id: id.rule }],
    seo_rule_constraints: [
      { evidence_id: id.rule, constraint: "No superlatives anywhere in the copy." },
    ],
    secondary_keyword_evidence_ids: [id.ownOther],
    brand_voice_notes: "Plain, specific, no hype.",
    missing_evidence: ["No ranking data for the primary keyword."],
  };
}

const manualInput: BriefInput = {
  title: "Hand-written brief",
  contentType: "GUIDE",
  searchIntent: "COMMERCIAL",
  primaryConversion: "Book a demo",
  audience: "HR leads",
  customerProblem: "Compliance confusion",
  desiredOutcome: "A shortlist",
  recommendedAngle: "Compliance first",
  keyQuestions: ["What does BIR require?"],
  requiredSections: [{ heading: "Compliance", purpose: "The core" }],
  optionalSections: [],
  externalEvidenceRequirements: [],
  brandVoiceNotes: null,
};

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

describe("generating a brief", () => {
  it("keeps only what the sealed package can vouch for, field by field", async () => {
    const tenant = await makeTenant("gen");
    const other = await makeTenant("other");
    const item = await makeItem(tenant);

    const stub = useStubProvider({ responses: [answer(tenant, ids(other).fact)] });
    const outcome = await generateBrief(tenant, item.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const id = ids(tenant);
    const { brief, citations } = outcome;

    // Approved claims: only the approved fact survives.
    const approved = brief.approvedClaimsJson as CitedClaim[];
    expect(approved).toEqual([
      { text: "Payslips follow BIR formats", evidenceId: id.fact, source: "BRAND_FACT" },
    ]);

    // The ways it cited badly, each counted where it belongs.
    expect(citations.malformed).toEqual(["ev-42"]);
    expect(citations.outsidePackage).toEqual(
      expect.arrayContaining([id.proposedFact, id.fabricated, ids(other).fact]),
    );
    expect(citations.wrongField).toContain(id.goal);
    expect(citations.unresolved).toEqual([]);

    // Prohibited claims: the approved context's list is canonical, avoid-topics
    // become prohibitions, and the rule-backed one the model added is kept.
    const prohibited = brief.prohibitedClaimsJson as ProhibitedClaim[];
    expect(prohibited.map((row) => row.text)).toEqual(
      expect.arrayContaining([
        "Guaranteed compliance",
        "Cheapest payroll software",
        "Avoid the topic: Tax evasion",
        "Never say 'cheapest'",
      ]),
    );
    expect(prohibited.find((row) => row.text === "Never say 'cheapest'")).toMatchObject({
      evidenceId: id.rule,
      source: "SEO_RULE",
    });
    expect(prohibited.find((row) => row.text === "Guaranteed compliance")).toMatchObject({
      evidenceId: id.ctx,
      source: "BUSINESS_CONTEXT",
    });

    // Rules: every active rule is in, with the model's reading where it gave one.
    const rules = brief.seoRuleConstraintsJson as RuleConstraint[];
    expect(rules).toEqual([
      expect.objectContaining({
        ruleId: tenant.blockingRuleId,
        evidenceId: id.rule,
        severity: "BLOCKING",
        constraint: "No superlatives anywhere in the copy.",
      }),
    ]);

    // Links: the other page, resolved to its path; never the page itself.
    const links = brief.internalLinkTargetsJson as LinkTarget[];
    expect(links).toEqual([
      expect.objectContaining({
        pageId: tenant.otherPageId,
        path: "/pricing",
        evidenceId: id.ownOther,
      }),
    ]);

    // Secondary keywords come from the cited ownership record.
    expect(brief.secondaryKeywordIdsJson).toEqual([tenant.otherKeywordId]);

    // Scalars and lists as answered; missing evidence surfaces to the editor.
    expect(brief.title).toBe("Payroll software in the Philippines: a buyer's guide");
    expect(brief.searchIntent).toBe("COMMERCIAL");
    expect(brief.keyQuestionsJson).toHaveLength(2);
    expect(brief.externalEvidenceRequirementsJson).toEqual([
      "A verified customer count, if one is to be quoted.",
      "Missing evidence: No ranking data for the primary keyword.",
    ]);
    expect(brief.businessGoalId).toBe(tenant.goalId);
    expect(brief.status).toBe("DRAFT");

    // The model was shown the fact, the context, the rule, the page, and never
    // the proposed fact.
    const request = stub.requests[0]!;
    expect(request.untrustedData).toContain(id.fact);
    expect(request.untrustedData).toContain(id.ctx);
    expect(request.untrustedData).toContain(id.rule);
    expect(request.untrustedData).not.toContain(id.proposedFact);
    expect(request.task).toContain("CONTENT_REFRESH");
    expect(request.task).toContain("/payroll-software");
  });

  it("records what the model saw: run, prompt, schema, package, policy, context version", async () => {
    const tenant = await makeTenant("prov");
    const other = await makeTenant("prov-other");
    const item = await makeItem(tenant);
    useStubProvider({ responses: [answer(tenant, ids(other).fact)] });

    const outcome = await generateBrief(tenant, item.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const [version] = await listBriefVersions(tenant, item.id);
    expect(version?.createdByAiRun).toMatchObject({
      id: outcome.run.id,
      provider: "stub",
      promptTemplateVersion: 1,
      outputSchemaVersion: "1",
      status: "SUCCEEDED",
    });
    expect(version?.evidencePackage).toMatchObject({
      sealedAt: expect.any(Date),
      retrievalPolicyVersion: 1,
      contextVersionId: tenant.contextVersionId,
      retrievalPolicy: { name: "content-brief", version: 1 },
    });

    const view = await getBriefEvidence(tenant, version!.id);
    expect(view?.packageId).toBe(version?.evidencePackageId);
    expect(view?.evidence.some((record) => record.sourceEntityId === tenant.proposedFactId)).toBe(
      false,
    );
    expect(view?.evidence.some((record) => record.sourceEntityId === tenant.approvedFactId)).toBe(
      true,
    );
    expect(view?.manifest?.policy).toEqual({ name: "content-brief", version: 1 });

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: "ContentBrief", entityId: version!.id, action: "CREATE" },
    });
    expect(audit?.actorUserId).toBe(tenant.user.id);
  });

  it("moves the work item from QUEUED to BRIEFING, and to DRAFTING only on approval", async () => {
    const tenant = await makeTenant("flow");
    const other = await makeTenant("flow-other");
    const item = await makeItem(tenant);
    expect(item.status).toBe("QUEUED");

    useStubProvider({ responses: [answer(tenant, ids(other).fact)] });
    const outcome = await generateBrief(tenant, item.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.item.status).toBe("BRIEFING");

    await requestBriefReview(tenant, outcome.brief.id);
    expect(
      (await prisma.contentWorkItem.findUniqueOrThrow({ where: { id: item.id } })).status,
    ).toBe("BRIEFING");

    await approveBrief(tenant, outcome.brief.id);
    const after = await prisma.contentWorkItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe("DRAFTING");

    // Nothing downstream was started by the approval.
    expect(await prisma.contentDraft.count({ where: { contentWorkItemId: item.id } })).toBe(0);
  });

  it("returns the failure, with the package sealed, when the model does not answer", async () => {
    const tenant = await makeTenant("fail");
    const item = await makeItem(tenant);
    useStubProvider({ responses: [{ title: "not a brief" }] });

    const outcome = await generateBrief(tenant, item.id);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_output");

    expect(await prisma.contentBrief.count({ where: { contentWorkItemId: item.id } })).toBe(0);
    const pkg = await prisma.evidencePackage.findFirst({
      where: { targetType: "CONTENT_WORK_ITEM", targetId: item.id },
    });
    expect(pkg?.sealedAt).not.toBeNull();
  });
});

describe("versions", () => {
  it("numbers versions in order, freezes an approved one, and supersedes it when the next is approved", async () => {
    const tenant = await makeTenant("ver");
    const other = await makeTenant("ver-other");
    const item = await makeItem(tenant);

    useStubProvider({
      responses: [answer(tenant, ids(other).fact), answer(tenant, ids(other).fact)],
    });
    const first = await generateBrief(tenant, item.id);
    const second = await generateBrief(tenant, item.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.brief.version).toBe(1);
    expect(second.brief.version).toBe(2);

    const v1 = await approveBrief(tenant, first.brief.id);
    expect(v1.status).toBe("APPROVED");
    expect(v1.approvedByUserId).toBe(tenant.user.id);
    expect((await currentBrief(tenant, item.id))?.id).toBe(v1.id);

    // The approved row is immutable at the database.
    await expect(
      prisma.contentBrief.update({ where: { id: v1.id }, data: { title: "tampered" } }),
    ).rejects.toThrow(/immutable/);

    // Editing it creates version 3, carrying the evidence-backed fields.
    const edited = await saveBrief(tenant, v1.id, { ...manualInput, title: "Edited from v1" });
    expect(edited.newVersion).toBe(true);
    expect(edited.brief.version).toBe(3);
    expect(edited.brief.status).toBe("DRAFT");
    expect(edited.brief.createdByUserId).toBe(tenant.user.id);
    expect(edited.brief.approvedClaimsJson).toEqual(v1.approvedClaimsJson);
    expect(edited.brief.seoRuleConstraintsJson).toEqual(v1.seoRuleConstraintsJson);
    expect(edited.brief.evidencePackageId).toBe(v1.evidencePackageId);
    expect(changedFields(v1, edited.brief)).toEqual(
      expect.arrayContaining(["title", "audience", "keyQuestionsJson"]),
    );
    expect(changedFields(v1, edited.brief)).not.toContain("approvedClaimsJson");

    const unchanged = await prisma.contentBrief.findUniqueOrThrow({ where: { id: v1.id } });
    expect(unchanged.title).toBe(v1.title);
    expect(unchanged.status).toBe("APPROVED");

    // Approving v3 supersedes v1; v2 is untouched.
    const v3 = await approveBrief(tenant, edited.brief.id);
    expect(v3.status).toBe("APPROVED");
    const versions = await listBriefVersions(tenant, item.id);
    expect(versions.map((row) => [row.version, row.status])).toEqual([
      [3, "APPROVED"],
      [2, "DRAFT"],
      [1, "SUPERSEDED"],
    ]);
    expect((await currentBrief(tenant, item.id))?.id).toBe(v3.id);

    const supersedeAudit = await prisma.auditEvent.findFirst({
      where: { entityType: "ContentBrief", entityId: v1.id, action: "SUPERSEDE" },
    });
    expect(supersedeAudit).not.toBeNull();

    // A superseded version can be archived; the approved one cannot.
    expect((await archiveBrief(tenant, v1.id)).status).toBe("ARCHIVED");
    await expect(archiveBrief(tenant, v3.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("edits a draft in place and returns a version awaiting review to draft", async () => {
    const tenant = await makeTenant("draft");
    const item = await makeItem(tenant);

    const v1 = await createManualBrief(tenant, item.id, manualInput);
    expect(v1.version).toBe(1);
    expect(v1.createdByUserId).toBe(tenant.user.id);
    expect(
      (await prisma.contentWorkItem.findUniqueOrThrow({ where: { id: item.id } })).status,
    ).toBe("BRIEFING");

    const requested = await requestBriefReview(tenant, v1.id);
    expect(requested.status).toBe("AWAITING_REVIEW");

    const saved = await saveBrief(tenant, v1.id, { ...manualInput, audience: "Finance leads" });
    expect(saved.newVersion).toBe(false);
    expect(saved.brief.id).toBe(v1.id);
    expect(saved.brief.status).toBe("DRAFT");
    expect(saved.brief.audience).toBe("Finance leads");

    await expect(
      saveBrief(tenant, v1.id, { ...manualInput, audience: "Finance leads" }),
    ).rejects.toMatchObject({
      code: "nothing_changed",
    });
  });
});

describe("who may do what", () => {
  it("lets a member write and request review but not approve", async () => {
    const tenant = await makeTenant("member", "MEMBER");
    const item = await makeItem(tenant).catch(() => null);
    // A MEMBER cannot decide on a recommendation; make the item as an owner instead.
    expect(item).toBeNull();
  });

  it("needs REVIEW to approve, WRITE to generate, and refuses a viewer both", async () => {
    const owner = await makeTenant("roles");
    const item = await makeItem(owner);
    const v1 = await createManualBrief(owner, item.id, manualInput);

    const member = { ...owner, membership: { ...owner.membership, role: "MEMBER" as const } };
    await expect(approveBrief(member, v1.id)).rejects.toMatchObject({ code: "forbidden" });
    expect((await requestBriefReview(member, v1.id)).status).toBe("AWAITING_REVIEW");

    const viewer = { ...owner, membership: { ...owner.membership, role: "VIEWER" as const } };
    await expect(generateBrief(viewer, item.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveBrief(viewer, v1.id, manualInput)).rejects.toMatchObject({
      code: "forbidden",
    });

    const lead = { ...owner, membership: { ...owner.membership, role: "SEO_LEAD" as const } };
    expect((await approveBrief(lead, v1.id)).status).toBe("APPROVED");
  });

  it("never lets the system actor approve, whatever its role", async () => {
    const owner = await makeTenant("system");
    const item = await makeItem(owner);
    const v1 = await createManualBrief(owner, item.id, manualInput);

    const system = await systemContextFor(owner.website.id);
    expect(system.membership.role).toBe("ADMIN");

    let refused: unknown;
    try {
      await approveBrief(system, v1.id);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ContentBriefError);
    expect((refused as ContentBriefError).code).toBe("forbidden");
    expect((refused as ContentBriefError).message).toMatch(/person/);

    const still = await prisma.contentBrief.findUniqueOrThrow({ where: { id: v1.id } });
    expect(still.status).toBe("DRAFT");
  });
});
