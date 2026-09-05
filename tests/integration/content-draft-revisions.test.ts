import crypto from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { resetProvider, useStubProvider as installStubProvider } from "@/server/ai/registry";
import { buildEvidenceId } from "@/lib/evidence/id";
import type { ContentDraftOutput } from "@/lib/ai/schemas/content-draft";
import { systemContextFor } from "@/server/jobs/system-context";
import { decide } from "@/server/services/decision";
import { startFromRecommendation } from "@/server/services/content-work";
import { approveBrief } from "@/server/services/content-brief";
import {
  ContentDraftError,
  compareRevisions,
  generateRevision,
  getDraft,
  getDraftForWorkItem,
  listDraftsForWorkItem,
  listRevisions,
  previewHtml,
  requestDraftReview,
  returnDraftToDrafting,
  revisionClaims,
  revisionFindings,
  saveRevision,
  startDraft,
  startDraftFromBrief,
  type RevisionInput,
} from "@/server/services/content-draft";
import type { Role } from "@/generated/prisma/client";

/**
 * Hand-written revisions, lineage, compare, review request and the
 * superseded-brief rule (docs/P4_SPEC.md §9-§12; M4.3).
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

async function makeTenant(label: string, role: Role = "OWNER"): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `cdr-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Revisions ${label}`, slug: `cdr-${label}-${suffix}` },
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
      brandVoice: "Plain and specific.",
      prohibitedClaims: ["Guaranteed compliance"],
      avoidTopics: ["Tax evasion"],
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
      keyword: `${label} payroll software`,
      normalizedKeyword: `${label} payroll software`,
      locale: "en-PH",
      language: "en",
      market: "PH",
      intent: "COMMERCIAL",
    },
  });
  const linkKeyword = await prisma.keyword.create({
    data: {
      websiteId: website.id,
      keyword: `${label} payroll pricing`,
      normalizedKeyword: `${label} payroll pricing`,
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

function ids(tenant: Fixture) {
  return {
    factA: buildEvidenceId({ kind: "fact", brandFactId: tenant.factA }),
    factB: buildEvidenceId({ kind: "fact", brandFactId: tenant.factB }),
    ctx: buildEvidenceId({ kind: "ctx", contextVersionId: tenant.contextVersionId }),
    rule: buildEvidenceId({ kind: "rule", seoRuleId: tenant.ruleId }),
    link: buildEvidenceId({ kind: "own", ownershipId: tenant.linkOwnershipId }),
  };
}

/** A DRAFTING work item with an approved brief v1 that cites facts A and B. */
async function makeItem(tenant: Fixture) {
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
  await decide(tenant, recommendation.id, { decision: "APPROVED" });
  const item = await startFromRecommendation(tenant, recommendation.id);
  const brief = await makeBrief(tenant, item.id, 1, "APPROVED");
  const updated = await prisma.contentWorkItem.update({
    where: { id: item.id },
    data: { status: "DRAFTING" },
  });
  return { item: updated, brief };
}

async function makeBrief(
  tenant: Fixture,
  workItemId: string,
  version: number,
  status: "APPROVED" | "DRAFT",
) {
  const id = ids(tenant);
  return prisma.contentBrief.create({
    data: {
      websiteId: tenant.website.id,
      contentWorkItemId: workItemId,
      version,
      title: `Payroll software in the Philippines: a buyer's guide (v${version})`,
      contentType: "GUIDE",
      searchIntent: "COMMERCIAL",
      audience: "HR leads at growing Philippine companies",
      keyQuestionsJson: ["Which tools produce BIR-compliant payslips?"],
      requiredSectionsJson: [{ heading: "What BIR compliance requires", purpose: "The core." }],
      optionalSectionsJson: [],
      approvedClaimsJson: [
        { text: "Payslips follow BIR formats", evidenceId: id.factA, source: "BRAND_FACT" },
        { text: "Trusted by 10,000 businesses", evidenceId: id.factB, source: "BRAND_FACT" },
      ],
      prohibitedClaimsJson: [
        { text: "Guaranteed compliance", evidenceId: id.ctx, source: "BUSINESS_CONTEXT" },
        { text: "Avoid the topic: Tax evasion", evidenceId: id.ctx, source: "AVOID_TOPIC" },
      ],
      seoRuleConstraintsJson: [
        {
          ruleId: tenant.ruleId,
          evidenceId: id.rule,
          severity: "BLOCKING",
          rule: "Meta titles stay under 60 characters.",
          constraint: null,
        },
      ],
      internalLinkTargetsJson: [
        {
          pageId: tenant.linkPageId,
          path: "/pricing",
          evidenceId: id.link,
          anchorText: "payroll pricing",
          reason: "The next step.",
        },
      ],
      targetPageId: tenant.pageId,
      primaryKeywordId: tenant.keywordId,
      status,
      createdByUserId: tenant.user.id,
      approvedByUserId: status === "APPROVED" ? tenant.user.id : null,
      approvedAt: status === "APPROVED" ? new Date() : null,
    },
  });
}

function answer(tenant: Fixture, overrides: Partial<ContentDraftOutput> = {}): ContentDraftOutput {
  const id = ids(tenant);
  return {
    title: "Payroll software in the Philippines: a buyer's guide",
    slug: "payroll-software-philippines",
    excerpt: "How to shortlist payroll software that handles BIR requirements.",
    meta_title: "Payroll Software Philippines | Buyer's Guide",
    meta_description: "Compare payroll software for Philippine employers.",
    body_markdown:
      "# Payroll software in the Philippines\n\n## What BIR compliance requires\n\nPayslips follow BIR formats. See our [payroll pricing](/pricing).\n",
    claims: [{ text: "Payslips follow BIR formats", evidence_id: id.factA }],
    internal_links_used: [{ evidence_id: id.link, anchor_text: "payroll pricing" }],
    sections_covered: ["What BIR compliance requires"],
    open_questions: [],
    change_summary: "First draft from the brief.",
    ...overrides,
  };
}

function edit(overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    title: "Payroll software in the Philippines: the 2026 buyer's guide",
    slug: "payroll-software-philippines",
    excerpt: "How to shortlist payroll software that handles BIR requirements.",
    metaTitle: "Payroll Software Philippines | 2026 Guide",
    metaDescription: "Compare payroll software for Philippine employers.",
    bodyMarkdown:
      "# Payroll software in the Philippines\n\n## What BIR compliance requires\n\nPayslips follow BIR formats. See our [payroll pricing](/pricing) and the [BIR site](https://www.bir.gov.ph/).\n\n## Choosing\n\nStart with compliance, then price.\n",
    changeSummary: "Added the BIR reference and a choosing section.",
    ...overrides,
  };
}

/** A draft with one generated revision, ready for a person. */
async function draftWithAiRevision(tenant: Fixture, overrides: Partial<ContentDraftOutput> = {}) {
  const { item, brief } = await makeItem(tenant);
  const { draft } = await startDraft(tenant, item.id);
  installStubProvider({ responses: [answer(tenant, overrides)] });
  const outcome = await generateRevision(tenant, draft.id, {
    generationToken: crypto.randomUUID(),
  });
  if (!outcome.ok) throw new Error(`generation failed: ${outcome.message}`);
  return { item, brief, draft, ai: outcome.revision };
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

describe("hand-written revisions", () => {
  it("writes the next revision from the current one, and leaves the current one as it was", async () => {
    const tenant = await makeTenant("edit");
    const { draft, ai } = await draftWithAiRevision(tenant);
    const id = ids(tenant);

    const saved = await saveRevision(tenant, draft.id, edit());
    const { revision } = saved;
    expect(revision.revisionNumber).toBe(2);
    expect(revision.basedOnRevisionNumber).toBe(1);
    expect(revision.createdByUserId).toBe(tenant.user.id);
    expect(revision.createdByAiRunId).toBeNull();
    expect(revision.evidencePackageId).toBeNull();
    expect(revision.generationToken).toBeNull();
    expect(revision.changeSummary).toBe("Added the BIR reference and a choosing section.");
    expect(revision.wordCount).toBeGreaterThan(20);
    expect(revision.contentHash).not.toBe(ai.contentHash);
    expect(saved.draft.currentRevisionId).toBe(revision.id);
    expect(saved.returnedToDrafting).toBe(false);

    // A safe external link a person wrote is kept, and flagged for QA.
    expect(revision.bodyMarkdown).toContain("[BIR site](https://www.bir.gov.ph/)");
    const findings = revisionFindings(revision)!;
    expect(findings.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "EXTERNAL_LINK_UNAPPROVED",
          severity: "WARNING",
          url: "https://www.bir.gov.ph/",
        }),
      ]),
    );
    expect(findings.blocking).toBe(false);

    // The claim the text still carries stays supported by the approved fact.
    expect(revisionClaims(revision)).toEqual([
      expect.objectContaining({
        text: "Payslips follow BIR formats",
        evidenceId: id.factA,
        status: "SUPPORTED",
      }),
    ]);

    // Revision 1 is untouched and immutable.
    const first = await prisma.contentRevision.findUniqueOrThrow({ where: { id: ai.id } });
    expect(first.title).toBe(ai.title);
    expect(first.contentHash).toBe(ai.contentHash);
    await expect(
      prisma.contentRevision.update({ where: { id: ai.id }, data: { title: "tampered" } }),
    ).rejects.toThrow(/immutable/);

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: "ContentRevision", entityId: revision.id, action: "CREATE" },
    });
    expect((audit?.afterSnapshotJson as { author?: string })?.author).toBe("HUMAN");
  });

  it("requires a change summary and refuses a revision that changes nothing", async () => {
    const tenant = await makeTenant("summary");
    const { draft, ai } = await draftWithAiRevision(tenant);

    await expect(
      saveRevision(tenant, draft.id, edit({ changeSummary: "  " })),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: [expect.stringMatching(/changeSummary/)],
    });

    await expect(
      saveRevision(tenant, draft.id, {
        title: ai.title,
        slug: ai.slug,
        excerpt: ai.excerpt,
        metaTitle: ai.metaTitle,
        metaDescription: ai.metaDescription,
        bodyMarkdown: ai.bodyMarkdown,
        changeSummary: "No change really.",
      }),
    ).rejects.toMatchObject({ code: "nothing_changed" });

    expect(await prisma.contentRevision.count({ where: { contentDraftId: draft.id } })).toBe(1);
  });

  it("checks a person's text like generated text, and marks a stale claim", async () => {
    const tenant = await makeTenant("checks");
    const { draft } = await draftWithAiRevision(tenant);
    const id = ids(tenant);

    await prisma.brandFact.update({
      where: { id: tenant.factB },
      data: { approvalStatus: "REJECTED" },
    });

    const saved = await saveRevision(
      tenant,
      draft.id,
      edit({
        metaTitle: "A meta title that runs on far past sixty characters to break the rule",
        bodyMarkdown:
          "# Guide\n\nTrusted by 10,000 businesses. We offer guaranteed compliance. [x](javascript:alert(1))\n",
      }),
    );
    const findings = revisionFindings(saved.revision)!;
    const kinds = findings.findings.map((finding) => `${finding.kind}:${finding.severity}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "STALE_CLAIM:BLOCKING",
        "PROHIBITED_CLAIM:BLOCKING",
        "RULE_CHECK:BLOCKING",
      ]),
    );
    expect(findings.blocking).toBe(true);
    expect(findings.staleClaims).toEqual([expect.objectContaining({ evidenceId: id.factB })]);
    expect(previewHtml(saved.revision)).not.toMatch(/href="javascript/i);
  });

  it("is a person's act: the system actor and viewers are refused, a first revision may be hand-written", async () => {
    const tenant = await makeTenant("who");
    const { item } = await makeItem(tenant);
    const { draft } = await startDraft(tenant, item.id);

    const system = await systemContextFor(tenant.website.id);
    await expect(saveRevision(system, draft.id, edit())).rejects.toMatchObject({
      code: "forbidden",
    });
    const viewer = { ...tenant, membership: { ...tenant.membership, role: "VIEWER" as const } };
    await expect(saveRevision(viewer, draft.id, edit())).rejects.toMatchObject({
      code: "forbidden",
    });

    const member = { ...tenant, membership: { ...tenant.membership, role: "MEMBER" as const } };
    const saved = await saveRevision(member, draft.id, edit({ changeSummary: "Written by hand." }));
    expect(saved.revision.revisionNumber).toBe(1);
    expect(saved.revision.basedOnRevisionNumber).toBeNull();
  });
});

describe("history and compare", () => {
  it("lists the lineage with authorship, and compares two revisions of the same draft only", async () => {
    const tenant = await makeTenant("history");
    const other = await makeTenant("history-other");
    const { draft, ai } = await draftWithAiRevision(tenant);
    const second = await saveRevision(tenant, draft.id, edit());
    const third = await saveRevision(
      tenant,
      draft.id,
      edit({ title: "Third title", changeSummary: "Retitled." }),
    );

    const history = await listRevisions(tenant, draft.id, tenant.user.id);
    expect(
      history.map((row) => [row.revisionNumber, row.basedOnRevisionNumber, row.author.kind]),
    ).toEqual([
      [3, 2, "HUMAN"],
      [2, 1, "HUMAN"],
      [1, null, "AI"],
    ]);
    expect(history[0]!.author.label).toBe("Edited by you");
    expect(history[2]!.author.label).toMatch(/^Generated by AI/);
    expect(history[2]!.provenance).toMatch(/^stub · .* · prompt v1 · schema v1 · package /);
    expect(history[1]!.findings.warning).toBeGreaterThanOrEqual(1);

    const comparison = await compareRevisions(tenant, draft.id, ai.id, second.revision.id);
    expect(comparison).not.toBeNull();
    expect(comparison!.changes.changed).toEqual(
      expect.arrayContaining(["title", "metaTitle", "bodyMarkdown"]),
    );
    expect(comparison!.changes.wordsAfter).toBeGreaterThan(comparison!.changes.wordsBefore);
    expect(comparison!.changes.linesAdded).toBeGreaterThan(0);
    expect(comparison!.diff.some((line) => line.type === "added")).toBe(true);

    const retitle = await compareRevisions(tenant, draft.id, second.revision.id, third.revision.id);
    expect(retitle!.changes.changed).toEqual(["title"]);
    expect(retitle!.changes.linesAdded + retitle!.changes.linesRemoved).toBe(0);

    // Refusals: same revision twice, a made-up id, another draft, another tenant.
    expect(await compareRevisions(tenant, draft.id, ai.id, ai.id)).toBeNull();
    expect(await compareRevisions(tenant, draft.id, ai.id, crypto.randomUUID())).toBeNull();
    const elsewhere = await draftWithAiRevision(other);
    expect(await compareRevisions(tenant, draft.id, ai.id, elsewhere.ai.id)).toBeNull();
    expect(await compareRevisions(other, elsewhere.draft.id, elsewhere.ai.id, ai.id)).toBeNull();
    expect(await compareRevisions(other, draft.id, ai.id, second.revision.id)).toBeNull();
    expect(await listRevisions(other, draft.id)).toEqual([]);
  });
});

describe("requesting review", () => {
  it("needs a current revision without blocking findings; warnings do not stand in the way", async () => {
    const tenant = await makeTenant("review");
    const { item } = await makeItem(tenant);
    const { draft } = await startDraft(tenant, item.id);

    await expect(requestDraftReview(tenant, draft.id)).rejects.toMatchObject({
      code: "invalid_state",
    });

    // A blocked revision: prohibited claim.
    await saveRevision(
      tenant,
      draft.id,
      edit({
        bodyMarkdown: "# Guide\n\nWe offer guaranteed compliance.\n",
        changeSummary: "Draft.",
      }),
    );
    let refused: unknown;
    try {
      await requestDraftReview(tenant, draft.id);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ContentDraftError);
    expect((refused as ContentDraftError).code).toBe("blocked");
    expect((refused as ContentDraftError).findings).toEqual([
      expect.objectContaining({ kind: "PROHIBITED_CLAIM", severity: "BLOCKING" }),
    ]);
    expect((await prisma.contentDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      "DRAFTING",
    );

    // A revision with only a warning (an unapproved numeric claim) goes through.
    await saveRevision(
      tenant,
      draft.id,
      edit({
        bodyMarkdown: "# Guide\n\nTeams cut payroll time by 40%.\n",
        changeSummary: "Removed the prohibited claim.",
      }),
    );
    const view = await getDraftForWorkItem(tenant, item.id);
    expect(revisionFindings(view!.current!)!.findings).toEqual([
      expect.objectContaining({ kind: "UNSUPPORTED_NUMERIC_CLAIM", severity: "WARNING" }),
    ]);
    const requested = await requestDraftReview(tenant, draft.id);
    expect(requested.status).toBe("AWAITING_EDITOR_REVIEW");
    expect(
      (await prisma.contentWorkItem.findUniqueOrThrow({ where: { id: item.id } })).status,
    ).toBe("DRAFTING");

    await expect(requestDraftReview(tenant, draft.id)).rejects.toMatchObject({
      code: "invalid_state",
    });
    const system = await systemContextFor(tenant.website.id);
    await expect(requestDraftReview(system, draft.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("goes back to drafting when the content changes under review, or when a reviewer returns it with a note", async () => {
    const tenant = await makeTenant("back");
    const { draft } = await draftWithAiRevision(tenant);
    await requestDraftReview(tenant, draft.id);

    // A member cannot return it; an SEO lead can, with a note.
    const member = { ...tenant, membership: { ...tenant.membership, role: "MEMBER" as const } };
    await expect(returnDraftToDrafting(member, draft.id, "Not yet.")).rejects.toMatchObject({
      code: "forbidden",
    });
    const lead = { ...tenant, membership: { ...tenant.membership, role: "SEO_LEAD" as const } };
    await expect(returnDraftToDrafting(lead, draft.id, "   ")).rejects.toMatchObject({
      code: "invalid_input",
    });
    const returned = await returnDraftToDrafting(
      lead,
      draft.id,
      "The choosing section needs prices.",
    );
    expect(returned.status).toBe("DRAFTING");
    const view = await getDraft(tenant, draft.id);
    expect(view?.lastReturn).toMatchObject({
      note: "The choosing section needs prices.",
      by: tenant.user.email,
    });
    await expect(returnDraftToDrafting(lead, draft.id, "Again.")).rejects.toMatchObject({
      code: "invalid_state",
    });

    // Under review again; an edit sends it back by itself.
    await requestDraftReview(tenant, draft.id);
    const saved = await saveRevision(tenant, draft.id, edit({ changeSummary: "Added prices." }));
    expect(saved.returnedToDrafting).toBe(true);
    expect(saved.draft.status).toBe("DRAFTING");
    const events = await prisma.auditEvent.findMany({
      where: { entityType: "ContentDraft", entityId: draft.id, action: "UPDATE" },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((row) => (row.afterSnapshotJson as { status: string }).status)).toEqual([
      "AWAITING_EDITOR_REVIEW",
      "AWAITING_EDITOR_REVIEW",
      "DRAFTING",
    ]);

    // AI generation while awaiting review is refused; the person acts first.
    await requestDraftReview(tenant, draft.id);
    installStubProvider({ responses: [answer(tenant)] });
    await expect(
      generateRevision(tenant, draft.id, { generationToken: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("a newer approved brief", () => {
  it("does not move the draft, closes generation, and a person starts a separate draft explicitly", async () => {
    const tenant = await makeTenant("supersede");
    const { item, brief: v1, draft, ai } = await draftWithAiRevision(tenant);
    await saveRevision(tenant, draft.id, edit());

    const v2 = await makeBrief(tenant, item.id, 2, "DRAFT");
    await approveBrief(tenant, v2.id);

    // Untouched, and told so.
    const view = await getDraftForWorkItem(tenant, item.id);
    expect(view?.draft.id).toBe(draft.id);
    expect(view?.draft.briefId).toBe(v1.id);
    expect(view?.brief.status).toBe("SUPERSEDED");
    expect(view?.briefMismatch).toEqual({ approvedVersion: 2, approvedBriefId: v2.id });
    expect(view?.revisionCount).toBe(2);

    // Generation against v1 is closed; a hand-written revision is still allowed.
    installStubProvider({ responses: [answer(tenant)] });
    await expect(
      generateRevision(tenant, draft.id, { generationToken: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "brief_superseded" });
    const byHand = await saveRevision(
      tenant,
      draft.id,
      edit({ title: "Still written to brief v1", changeSummary: "Still on v1." }),
    );
    expect(byHand.revision.revisionNumber).toBe(3);

    // Refusals before the explicit act: a draft brief, a brief of another item.
    const v3draft = await makeBrief(tenant, item.id, 3, "DRAFT");
    await expect(startDraftFromBrief(tenant, item.id, v3draft.id)).rejects.toMatchObject({
      code: "brief_not_approved",
    });
    const elsewhere = await makeItem(tenant);
    await expect(startDraftFromBrief(tenant, item.id, elsewhere.brief.id)).rejects.toMatchObject({
      code: "not_found",
    });

    // The explicit act.
    const started = await startDraftFromBrief(tenant, item.id, v2.id);
    expect(started.created).toBe(true);
    expect(started.draft.briefId).toBe(v2.id);
    expect(started.draft.status).toBe("DRAFTING");
    expect(started.draft.currentRevisionId).toBeNull();
    expect(started.supersededDraftIds).toEqual([draft.id]);

    const old = await getDraft(tenant, draft.id);
    expect(old?.draft.status).toBe("SUPERSEDED");
    expect(old?.draft.briefId).toBe(v1.id);
    expect(old?.revisionCount).toBe(3);
    expect(old?.current?.id).toBe(byHand.revision.id);
    expect(await listRevisions(tenant, draft.id)).toHaveLength(3);
    expect(await listRevisions(tenant, started.draft.id)).toEqual([]);

    const drafts = await listDraftsForWorkItem(tenant, item.id);
    expect(drafts.map((row) => [row.briefVersion, row.status, row.revisionCount])).toEqual([
      [1, "SUPERSEDED", 3],
      [2, "DRAFTING", 0],
    ]);
    expect((await getDraftForWorkItem(tenant, item.id))?.draft.id).toBe(started.draft.id);

    // The old draft is closed to writing; the new one generates from v2 and a fresh package.
    await expect(
      saveRevision(tenant, draft.id, edit({ changeSummary: "Too late." })),
    ).rejects.toMatchObject({
      code: "invalid_state",
    });
    const stub = installStubProvider({ responses: [answer(tenant)] });
    const fresh = await generateRevision(tenant, started.draft.id, {
      generationToken: crypto.randomUUID(),
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.revision.revisionNumber).toBe(1);
    expect(fresh.revision.basedOnRevisionNumber).toBeNull();
    expect(fresh.revision.evidencePackageId).not.toBe(ai.evidencePackageId);
    expect(stub.requests[0]!.task).toContain("APPROVED BRIEF v2");

    // Starting again from v2 returns the same draft rather than a third.
    const again = await startDraftFromBrief(tenant, item.id, v2.id);
    expect(again.created).toBe(false);
    expect(again.draft.id).toBe(started.draft.id);

    // The audit trail links both ways.
    const superseded = await prisma.auditEvent.findFirst({
      where: { entityType: "ContentDraft", entityId: draft.id, action: "SUPERSEDE" },
    });
    expect(
      (superseded?.afterSnapshotJson as { supersededByDraftId: string }).supersededByDraftId,
    ).toBe(started.draft.id);
    const created = await prisma.auditEvent.findFirst({
      where: { entityType: "ContentDraft", entityId: started.draft.id, action: "CREATE" },
    });
    expect((created?.afterSnapshotJson as { previousDraftIds: string[] }).previousDraftIds).toEqual(
      [draft.id],
    );
    expect(
      (await prisma.contentWorkItem.findUniqueOrThrow({ where: { id: item.id } })).status,
    ).toBe("DRAFTING");
  });
});
