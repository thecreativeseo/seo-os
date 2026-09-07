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
  APPROVED_LOCKED_MESSAGE,
  ContentDraftError,
  approveDraft,
  approvedRevisionFor,
  generateRevision,
  getDraft,
  getDraftForWorkItem,
  listDraftReviews,
  listDrafts,
  listRevisions,
  reopenDraft,
  requestDraftReview,
  returnDraftToDrafting,
  saveRevision,
  startDraft,
  startDraftFromBrief,
  type RevisionInput,
} from "@/server/services/content-draft";
import type { Role } from "@/generated/prisma/client";
import { deleteOrganizations } from "../helpers/teardown";

/**
 * Draft review and approval (docs/P4_SPEC.md §9, §25, §36; M4.5.1).
 *
 * A request pins the exact revision; a person with REVIEW decides it once;
 * approval binds the draft to that revision by id and hash and hands the
 * work item to QA; nothing edits an approved draft until a person reopens
 * it; the decided row never changes. Every invariant of the M4.5 plan has a
 * case here.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & {
  pageId: string;
  keywordId: string;
  factA: string;
  factB: string;
  ruleId: string;
  contextVersionId: string;
};

async function makeTenant(label: string, role: Role = "OWNER"): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `cdrv-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Review ${label}`, slug: `cdrv-${label}-${suffix}` },
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
      prohibitedClaims: ["Guaranteed compliance"],
      avoidTopics: [],
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
    factA: factA.id,
    factB: factB.id,
    ruleId: rule.id,
    contextVersionId: version.id,
  };
}

/** A second person in the same organization, with the given role. */
async function colleague(tenant: Fixture, role: Role): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      authUserId: crypto.randomUUID(),
      email: `cdrv-${role.toLowerCase()}-${suffix}@example.com`,
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

function ids(tenant: Fixture) {
  return {
    factA: buildEvidenceId({ kind: "fact", brandFactId: tenant.factA }),
    factB: buildEvidenceId({ kind: "fact", brandFactId: tenant.factB }),
    ctx: buildEvidenceId({ kind: "ctx", contextVersionId: tenant.contextVersionId }),
    rule: buildEvidenceId({ kind: "rule", seoRuleId: tenant.ruleId }),
  };
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
      title: `Payroll software guide (brief v${version})`,
      contentType: "GUIDE",
      searchIntent: "COMMERCIAL",
      audience: "HR leads",
      keyQuestionsJson: ["Which tools produce BIR-compliant payslips?"],
      requiredSectionsJson: [{ heading: "Compliance", purpose: "The core." }],
      optionalSectionsJson: [],
      approvedClaimsJson: [
        { text: "Payslips follow BIR formats", evidenceId: id.factA, source: "BRAND_FACT" },
        { text: "Trusted by 10,000 businesses", evidenceId: id.factB, source: "BRAND_FACT" },
      ],
      prohibitedClaimsJson: [
        { text: "Guaranteed compliance", evidenceId: id.ctx, source: "BUSINESS_CONTEXT" },
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
      internalLinkTargetsJson: [],
      targetPageId: tenant.pageId,
      primaryKeywordId: tenant.keywordId,
      status,
      createdByUserId: tenant.user.id,
      approvedByUserId: status === "APPROVED" ? tenant.user.id : null,
      approvedAt: status === "APPROVED" ? new Date() : null,
    },
  });
}

/** A DRAFTING work item with an approved brief v1. */
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
      summary: "Summary.",
      rationale: "Rationale.",
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

function answer(tenant: Fixture, overrides: Partial<ContentDraftOutput> = {}): ContentDraftOutput {
  return {
    title: "Payroll software in the Philippines: a buyer's guide",
    slug: "payroll-software-philippines",
    excerpt: "How to shortlist payroll software.",
    meta_title: "Payroll Software Philippines | Guide",
    meta_description: "Compare payroll software for Philippine employers.",
    body_markdown: "# Guide\n\n## Compliance\n\nPayslips follow BIR formats.\n",
    claims: [{ text: "Payslips follow BIR formats", evidence_id: ids(tenant).factA }],
    internal_links_used: [],
    sections_covered: ["Compliance"],
    open_questions: [],
    change_summary: "First draft.",
    ...overrides,
  };
}

function edit(overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    title: "Payroll software in the Philippines: the buyer's guide",
    slug: "payroll-software-philippines",
    excerpt: "How to shortlist payroll software.",
    metaTitle: "Payroll Software Philippines | Guide",
    metaDescription: "Compare payroll software for Philippine employers.",
    bodyMarkdown:
      "# Guide\n\n## Compliance\n\nPayslips follow BIR formats.\n\n## Choosing\n\nStart with compliance.\n",
    changeSummary: "Added a choosing section.",
    ...overrides,
  };
}

/** A draft with a clean AI revision v1 and, unless told otherwise, review requested. */
async function draftUnderReview(tenant: Fixture, options: { request?: boolean } = {}) {
  const { item, brief } = await makeItem(tenant);
  const { draft } = await startDraft(tenant, item.id);
  installStubProvider({ responses: [answer(tenant)] });
  const generated = await generateRevision(tenant, draft.id, {
    generationToken: crypto.randomUUID(),
  });
  if (!generated.ok) throw new Error(generated.message);
  if (options.request !== false) await requestDraftReview(tenant, draft.id);
  return { item, brief, draft, revision: generated.revision };
}

async function draftStatus(draftId: string) {
  return (await prisma.contentDraft.findUniqueOrThrow({ where: { id: draftId } })).status;
}
async function itemStatus(itemId: string) {
  return (await prisma.contentWorkItem.findUniqueOrThrow({ where: { id: itemId } })).status;
}

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

describe("requesting review", () => {
  it("creates one open request pinned to the exact revision, hash and brief", async () => {
    const tenant = await makeTenant("request");
    const { item, brief, draft, revision } = await draftUnderReview(tenant);

    const reviews = await listDraftReviews(tenant, draft.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      status: "REQUESTED",
      contentWorkItemId: item.id,
      contentDraftId: draft.id,
      contentRevisionId: revision.id,
      revisionNumber: 1,
      revisionHash: revision.contentHash,
      briefId: brief.id,
      briefVersion: 1,
      requestedByUserId: tenant.user.id,
      decidedByUserId: null,
      decidedAt: null,
      note: null,
    });
    expect(reviews[0]!.requestedBy.email).toBe(tenant.user.email);

    // One open request per draft, at the database.
    await expect(
      prisma.contentDraftReview.create({
        data: {
          websiteId: tenant.website.id,
          contentWorkItemId: item.id,
          contentDraftId: draft.id,
          contentRevisionId: revision.id,
          revisionNumber: 1,
          revisionHash: revision.contentHash,
          briefId: brief.id,
          briefVersion: 1,
          requestedByUserId: tenant.user.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const view = await getDraft(tenant, draft.id);
    expect(view?.review.open?.id).toBe(reviews[0]!.id);
    expect(view?.review.approval).toBeNull();
    expect(await approvedRevisionFor(tenant, item.id)).toBeNull();
  });

  it("invalidates the open request when the content changes under review, and a new request opens a new row", async () => {
    const tenant = await makeTenant("invalidate");
    const { draft } = await draftUnderReview(tenant);
    const first = (await listDraftReviews(tenant, draft.id))[0]!;

    const saved = await saveRevision(tenant, draft.id, edit());
    expect(saved.returnedToDrafting).toBe(true);
    const afterEdit = await prisma.contentDraftReview.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(afterEdit).toMatchObject({
      status: "INVALIDATED",
      invalidatedReason: "content_changed",
    });

    await requestDraftReview(tenant, draft.id);
    const reviews = await listDraftReviews(tenant, draft.id);
    expect(reviews.map((row) => [row.revisionNumber, row.status])).toEqual([
      [2, "REQUESTED"],
      [1, "INVALIDATED"],
    ]);
    expect(reviews[0]!.revisionHash).toBe(saved.revision.contentHash);
  });

  it("decides the open request as RETURNED with the reviewer's note", async () => {
    const tenant = await makeTenant("return");
    const { draft, revision } = await draftUnderReview(tenant);
    const lead = await colleague(tenant, "SEO_LEAD");

    await returnDraftToDrafting(lead, draft.id, "Needs prices in the choosing section.");
    const review = (await listDraftReviews(tenant, draft.id))[0]!;
    expect(review).toMatchObject({
      status: "RETURNED",
      contentRevisionId: revision.id,
      decidedByUserId: lead.user.id,
      note: "Needs prices in the choosing section.",
      selfDecided: false,
    });
    expect(review.decidedAt).not.toBeNull();
    expect(await draftStatus(draft.id)).toBe("DRAFTING");

    // The returned revision is marked in history.
    const history = await listRevisions(tenant, draft.id);
    expect(history[0]!.review).toMatchObject({
      status: "RETURNED",
      decidedBy: lead.user.email,
      current: false,
    });
  });
});

describe("approving a draft", () => {
  it("approves exactly the requested revision, atomically, and hands the work item to QA", async () => {
    const tenant = await makeTenant("approve");
    const { item, brief, draft, revision } = await draftUnderReview(tenant);
    const lead = await colleague(tenant, "SEO_LEAD");

    const result = await approveDraft(lead, draft.id, { note: "Reads well; ship to QA." });

    // The row.
    expect(result.review).toMatchObject({
      status: "APPROVED",
      contentRevisionId: revision.id,
      revisionNumber: 1,
      revisionHash: revision.contentHash,
      briefId: brief.id,
      briefVersion: 1,
      decidedByUserId: lead.user.id,
      note: "Reads well; ship to QA.",
      selfDecided: false,
      briefSupersededAtDecision: false,
      briefMismatchAcknowledged: false,
    });
    expect(result.review.decidedAt).not.toBeNull();

    // The draft's standing pointer.
    expect(result.draft).toMatchObject({
      status: "APPROVED",
      approvedRevisionId: revision.id,
      approvedRevisionHash: revision.contentHash,
      approvedByUserId: lead.user.id,
      approvedReviewId: result.review.id,
    });
    expect(result.draft.approvedAt).toEqual(result.review.decidedAt);

    // The work item.
    expect(result.workItem.status).toBe("QA");
    expect(await itemStatus(item.id)).toBe("QA");

    // What M5 consumes.
    expect(await approvedRevisionFor(tenant, item.id)).toEqual({
      workItemId: item.id,
      draftId: draft.id,
      reviewId: result.review.id,
      revisionId: revision.id,
      revisionNumber: 1,
      revisionHash: revision.contentHash,
      briefId: brief.id,
      briefVersion: 1,
      approvedByUserId: lead.user.id,
      approvedAt: result.draft.approvedAt,
    });

    // The readers.
    const view = await getDraftForWorkItem(tenant, item.id);
    expect(view?.draft.id).toBe(draft.id);
    expect(view?.review.open).toBeNull();
    expect(view?.review.approval).toMatchObject({
      reviewId: result.review.id,
      revisionNumber: 1,
      by: lead.user.email,
      note: "Reads well; ship to QA.",
    });
    const history = await listRevisions(tenant, draft.id);
    expect(history[0]!.review).toMatchObject({
      status: "APPROVED",
      decidedBy: lead.user.email,
      current: true,
    });
    const listed = (await listDrafts(tenant)).find((row) => row.id === draft.id);
    expect(listed).toMatchObject({ status: "APPROVED", approvedRevisionNumber: 1 });

    // The audit trail: CONTENT_DRAFT_APPROVED on the draft, APPROVE on the row, the work item move.
    const draftEvent = await prisma.auditEvent.findFirst({
      where: { entityType: "ContentDraft", entityId: draft.id, action: "APPROVE" },
    });
    expect(draftEvent?.actorUserId).toBe(lead.user.id);
    expect(draftEvent?.afterSnapshotJson).toMatchObject({
      reviewId: result.review.id,
      revisionId: revision.id,
      revisionNumber: 1,
      revisionHash: revision.contentHash,
      briefVersion: 1,
      note: "Reads well; ship to QA.",
      selfDecided: false,
      workItemStatus: "QA",
    });
    expect(
      await prisma.auditEvent.count({
        where: { entityType: "ContentDraftReview", entityId: result.review.id, action: "APPROVE" },
      }),
    ).toBe(1);
  });

  it("records self-approval when the reviewer wrote the revision, and allows an empty note", async () => {
    const tenant = await makeTenant("self");
    const { item } = await makeItem(tenant);
    const { draft } = await startDraft(tenant, item.id);
    await saveRevision(tenant, draft.id, edit({ changeSummary: "Written by hand." }));
    await requestDraftReview(tenant, draft.id);

    const result = await approveDraft(tenant, draft.id, {});
    expect(result.review.selfDecided).toBe(true);
    expect(result.review.note).toBeNull();
    expect(result.draft.approvedByUserId).toBe(tenant.user.id);
  });

  it("is a reviewer's act: MEMBER, VIEWER and the system actor are refused, nothing changes", async () => {
    const tenant = await makeTenant("roles");
    const { item, draft } = await draftUnderReview(tenant);

    const member = await colleague(tenant, "MEMBER");
    await expect(approveDraft(member, draft.id, {})).rejects.toMatchObject({ code: "forbidden" });
    const viewer = await colleague(tenant, "VIEWER");
    await expect(approveDraft(viewer, draft.id, {})).rejects.toMatchObject({ code: "forbidden" });
    const system = await systemContextFor(tenant.website.id);
    await expect(approveDraft(system, draft.id, {})).rejects.toMatchObject({ code: "forbidden" });

    expect(await draftStatus(draft.id)).toBe("AWAITING_EDITOR_REVIEW");
    expect(await itemStatus(item.id)).toBe("DRAFTING");
    expect((await listDraftReviews(tenant, draft.id))[0]!.status).toBe("REQUESTED");
    expect(await approvedRevisionFor(tenant, item.id)).toBeNull();
  });

  it("refuses when nothing is requested, when already approved, and when the draft is superseded", async () => {
    const tenant = await makeTenant("states");
    const { item, draft } = await draftUnderReview(tenant, { request: false });
    await expect(approveDraft(tenant, draft.id, {})).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringMatching(/No review has been requested/),
    });

    await requestDraftReview(tenant, draft.id);
    await approveDraft(tenant, draft.id, {});
    await expect(approveDraft(tenant, draft.id, {})).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringMatching(/already approved/),
    });
    await expect(requestDraftReview(tenant, draft.id)).rejects.toMatchObject({
      code: "invalid_state",
    });

    // Superseded: a newer brief, an explicit restart, then approval of the old draft is refused.
    const v2 = await makeBrief(tenant, item.id, 2, "DRAFT");
    await approveBrief(tenant, v2.id);
    const restarted = await startDraftFromBrief(tenant, item.id, v2.id);
    expect(restarted.supersededDraftIds).toEqual([draft.id]);
    await expect(approveDraft(tenant, draft.id, {})).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringMatching(/superseded and cannot be approved/),
    });
  });

  it("refuses while the revision has blocking findings, and lets warnings through", async () => {
    const tenant = await makeTenant("blocking");

    // A blocked revision put under review by hand: the service would never
    // request review for it, so the row is written directly for this case.
    const blocked = await draftUnderReview(tenant, { request: false });
    const bad = await saveRevision(
      tenant,
      blocked.draft.id,
      edit({ bodyMarkdown: "# Guide\n\nWe offer guaranteed compliance.\n", changeSummary: "Bad." }),
    );
    await prisma.contentDraft.update({
      where: { id: blocked.draft.id },
      data: { status: "AWAITING_EDITOR_REVIEW" },
    });
    await prisma.contentDraftReview.create({
      data: {
        websiteId: tenant.website.id,
        contentWorkItemId: blocked.item.id,
        contentDraftId: blocked.draft.id,
        contentRevisionId: bad.revision.id,
        revisionNumber: bad.revision.revisionNumber,
        revisionHash: bad.revision.contentHash,
        briefId: blocked.brief.id,
        briefVersion: 1,
        requestedByUserId: tenant.user.id,
      },
    });
    let refused: unknown;
    try {
      await approveDraft(tenant, blocked.draft.id, {});
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ContentDraftError);
    expect((refused as ContentDraftError).code).toBe("blocked");
    expect((refused as ContentDraftError).findings).toEqual([
      expect.objectContaining({ kind: "PROHIBITED_CLAIM", severity: "BLOCKING" }),
    ]);
    expect(await draftStatus(blocked.draft.id)).toBe("AWAITING_EDITOR_REVIEW");
    expect(await itemStatus(blocked.item.id)).toBe("DRAFTING");

    // Warnings only: an unapproved figure.
    const warned = await draftUnderReview(tenant, { request: false });
    await saveRevision(
      warned.draft.id === blocked.draft.id ? tenant : tenant,
      warned.draft.id,
      edit({
        bodyMarkdown: "# Guide\n\nTeams cut payroll time by 40%.\n",
        changeSummary: "Figure.",
      }),
    );
    await requestDraftReview(tenant, warned.draft.id);
    const result = await approveDraft(tenant, warned.draft.id, {});
    expect(result.draft.status).toBe("APPROVED");
  });

  it("re-checks claims against current Brand Facts: a fact revoked since writing refuses approval", async () => {
    const tenant = await makeTenant("stale");
    const { draft } = await draftUnderReview(tenant);

    await prisma.brandFact.update({
      where: { id: tenant.factA },
      data: { approvalStatus: "REJECTED" },
    });
    let refused: unknown;
    try {
      await approveDraft(tenant, draft.id, {});
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ContentDraftError);
    expect((refused as ContentDraftError).code).toBe("blocked");
    expect((refused as ContentDraftError).findings).toEqual([
      expect.objectContaining({
        kind: "STALE_CLAIM",
        severity: "BLOCKING",
        excerpt: "Payslips follow BIR formats",
      }),
    ]);
    expect(await draftStatus(draft.id)).toBe("AWAITING_EDITOR_REVIEW");

    await prisma.brandFact.update({
      where: { id: tenant.factA },
      data: { approvalStatus: "APPROVED" },
    });
    expect((await approveDraft(tenant, draft.id, {})).draft.status).toBe("APPROVED");
  });

  it("refuses when the request no longer names the current revision", async () => {
    const tenant = await makeTenant("conflict");
    const { draft } = await draftUnderReview(tenant);

    // A second revision written outside the service (the service would have
    // invalidated the request); the pointer moves, the request does not.
    const other = await prisma.contentRevision.create({
      data: {
        websiteId: tenant.website.id,
        contentDraftId: draft.id,
        revisionNumber: 2,
        title: "Other",
        bodyMarkdown: "# Other",
        changeSummary: "Other.",
        contentHash: "sha256:other",
        createdByUserId: tenant.user.id,
      },
    });
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: { currentRevisionId: other.id },
    });

    await expect(approveDraft(tenant, draft.id, {})).rejects.toMatchObject({
      code: "version_conflict",
    });
    expect(await draftStatus(draft.id)).toBe("AWAITING_EDITOR_REVIEW");
  });
});

describe("a newer brief", () => {
  it("requires explicit acknowledgement to approve a draft on a superseded brief, and records it", async () => {
    const tenant = await makeTenant("ack");
    const { item, draft } = await draftUnderReview(tenant);
    const v2 = await makeBrief(tenant, item.id, 2, "DRAFT");
    await approveBrief(tenant, v2.id);

    await expect(approveDraft(tenant, draft.id, {})).rejects.toMatchObject({
      code: "brief_superseded",
      message: expect.stringMatching(/based on Brief v1. Brief v2 is now approved/),
    });
    expect(await draftStatus(draft.id)).toBe("AWAITING_EDITOR_REVIEW");

    const result = await approveDraft(tenant, draft.id, { acknowledgeBriefMismatch: true });
    expect(result.review).toMatchObject({
      status: "APPROVED",
      briefVersion: 1,
      briefSupersededAtDecision: true,
      briefMismatchAcknowledged: true,
    });
    expect(await approvedRevisionFor(tenant, item.id)).toMatchObject({ briefVersion: 1 });
  });

  it("approved later, does not alter an already approved draft", async () => {
    const tenant = await makeTenant("after");
    const { item, draft, revision } = await draftUnderReview(tenant);
    const approved = await approveDraft(tenant, draft.id, {});

    const v2 = await makeBrief(tenant, item.id, 2, "DRAFT");
    await approveBrief(tenant, v2.id);

    const view = await getDraft(tenant, draft.id);
    expect(view?.draft).toMatchObject({
      status: "APPROVED",
      approvedRevisionId: revision.id,
      approvedReviewId: approved.review.id,
      briefId: approved.draft.briefId,
    });
    expect(view?.briefMismatch).toEqual({ approvedVersion: 2, approvedBriefId: v2.id });
    expect(view?.review.approval?.briefVersion).toBe(1);
    expect(await approvedRevisionFor(tenant, item.id)).toMatchObject({ revisionId: revision.id });
    expect(await itemStatus(item.id)).toBe("QA");
  });
});

describe("after approval", () => {
  it("locks the draft until a person reopens it with a reason; the approval stays in history", async () => {
    const tenant = await makeTenant("reopen");
    const { item, draft, revision } = await draftUnderReview(tenant);
    const approved = await approveDraft(tenant, draft.id, { note: "First approval." });

    // Nothing edits an approved draft in place.
    await expect(saveRevision(tenant, draft.id, edit())).rejects.toMatchObject({
      code: "invalid_state",
      message: APPROVED_LOCKED_MESSAGE,
    });
    installStubProvider({ responses: [answer(tenant)] });
    await expect(
      generateRevision(tenant, draft.id, { generationToken: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "invalid_state", message: APPROVED_LOCKED_MESSAGE });
    await expect(returnDraftToDrafting(tenant, draft.id, "no")).rejects.toMatchObject({
      code: "invalid_state",
    });

    // Reopen needs a reason and WRITE; a viewer and the system actor are refused.
    await expect(reopenDraft(tenant, draft.id, "  ")).rejects.toMatchObject({
      code: "invalid_input",
    });
    const viewer = await colleague(tenant, "VIEWER");
    await expect(reopenDraft(viewer, draft.id, "x")).rejects.toMatchObject({ code: "forbidden" });
    const system = await systemContextFor(tenant.website.id);
    await expect(reopenDraft(system, draft.id, "x")).rejects.toMatchObject({ code: "forbidden" });
    expect(await draftStatus(draft.id)).toBe("APPROVED");

    const member = await colleague(tenant, "MEMBER");
    const reopened = await reopenDraft(
      member,
      draft.id,
      "The pricing changed; the choosing section must too.",
    );
    expect(reopened.draft).toMatchObject({
      status: "DRAFTING",
      approvedRevisionId: null,
      approvedRevisionHash: null,
      approvedByUserId: null,
      approvedAt: null,
      approvedReviewId: null,
    });
    expect(reopened.workItem.status).toBe("DRAFTING");
    expect(await approvedRevisionFor(tenant, item.id)).toBeNull();

    // The decided row is untouched and immutable.
    const row = await prisma.contentDraftReview.findUniqueOrThrow({
      where: { id: approved.review.id },
    });
    expect(row).toMatchObject({
      status: "APPROVED",
      contentRevisionId: revision.id,
      note: "First approval.",
    });
    await expect(
      prisma.contentDraftReview.update({ where: { id: row.id }, data: { note: "tampered" } }),
    ).rejects.toThrow(/immutable/);
    await expect(prisma.contentDraftReview.delete({ where: { id: row.id } })).rejects.toThrow(
      /history/,
    );

    const retired = await prisma.auditEvent.findFirst({
      where: { entityType: "ContentDraftReview", entityId: row.id, action: "RETIRE" },
    });
    expect((retired?.afterSnapshotJson as { reason: string }).reason).toMatch(/pricing changed/);

    // A new revision, a new request, a new approval: the pointer moves to v2 only through review.
    const saved = await saveRevision(tenant, draft.id, edit({ changeSummary: "Updated prices." }));
    await expect(reopenDraft(tenant, draft.id, "again")).rejects.toMatchObject({
      code: "invalid_state",
    });
    await requestDraftReview(tenant, draft.id);
    const again = await approveDraft(tenant, draft.id, {});
    expect(again.draft.approvedRevisionId).toBe(saved.revision.id);
    expect(again.review.id).not.toBe(approved.review.id);
    expect(await itemStatus(item.id)).toBe("QA");

    const history = await listRevisions(tenant, draft.id);
    expect(
      history.map((row) => [
        row.revisionNumber,
        row.review?.status ?? null,
        row.review?.current ?? null,
      ]),
    ).toEqual([
      [2, "APPROVED", true],
      [1, "APPROVED", false],
    ]);
    expect(
      (await listDraftReviews(tenant, draft.id)).map((row) => [row.revisionNumber, row.status]),
    ).toEqual([
      [2, "APPROVED"],
      [1, "APPROVED"],
    ]);
  });

  it("superseding an approved draft clears its standing approval and moves the work item back to drafting", async () => {
    const tenant = await makeTenant("supersede");
    const { item, draft } = await draftUnderReview(tenant);
    const approved = await approveDraft(tenant, draft.id, {});
    expect(await itemStatus(item.id)).toBe("QA");

    const v2 = await makeBrief(tenant, item.id, 2, "DRAFT");
    await approveBrief(tenant, v2.id);
    const restarted = await startDraftFromBrief(tenant, item.id, v2.id);
    expect(restarted.supersededDraftIds).toEqual([draft.id]);

    const old = await prisma.contentDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(old).toMatchObject({
      status: "SUPERSEDED",
      approvedRevisionId: null,
      approvedReviewId: null,
    });
    expect(await itemStatus(item.id)).toBe("DRAFTING");
    expect(await approvedRevisionFor(tenant, item.id)).toBeNull();
    expect(
      (await prisma.contentDraftReview.findUniqueOrThrow({ where: { id: approved.review.id } }))
        .status,
    ).toBe("APPROVED");
    expect(
      await prisma.auditEvent.count({
        where: { entityType: "ContentDraftReview", entityId: approved.review.id, action: "RETIRE" },
      }),
    ).toBe(1);

    // Starting a draft on the item returns the new open draft, not a third one.
    const started = await startDraft(tenant, item.id);
    expect(started.created).toBe(false);
    expect(started.draft.id).toBe(restarted.draft.id);
  });

  it("superseding a draft under review invalidates the open request", async () => {
    const tenant = await makeTenant("supersede-open");
    const { item, draft } = await draftUnderReview(tenant);
    const v2 = await makeBrief(tenant, item.id, 2, "DRAFT");
    await approveBrief(tenant, v2.id);
    await startDraftFromBrief(tenant, item.id, v2.id);

    const rows = await listDraftReviews(tenant, draft.id);
    expect(rows.map((row) => [row.status, row.invalidatedReason])).toEqual([
      ["INVALIDATED", "draft_superseded"],
    ]);
    expect(await draftStatus(draft.id)).toBe("SUPERSEDED");
  });
});
