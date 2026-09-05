import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { decide } from "@/server/services/decision";
import {
  contentWorkForRecommendation,
  getContentWorkItem,
  listApprovedNotStarted,
  listContentWorkItems,
  startFromRecommendation,
} from "@/server/services/content-work";
import {
  approveBrief,
  createManualBrief,
  generateBrief,
  getBrief,
  getBriefEvidence,
  listBriefVersions,
  listBriefs,
  requestBriefReview,
  saveBrief,
  type BriefInput,
} from "@/server/services/content-brief";
import {
  compareRevisions,
  generateRevision,
  getBriefPanel,
  getDraft,
  getDraftForWorkItem,
  getRevision,
  listDrafts,
  listDraftsForWorkItem,
  listRevisions,
  requestDraftReview,
  returnDraftToDrafting,
  saveRevision,
  startDraft,
  startDraftFromBrief,
  type RevisionInput,
} from "@/server/services/content-draft";
import { systemContextFor } from "@/server/jobs/system-context";

/**
 * P4 tenant isolation (P4_ACCEPTANCE_CRITERIA, "Security attack tests").
 *
 * Tenant A holds a valid context of its own and supplies tenant B's ids.
 * Every read must come back empty and every write must be refused as "not
 * found" - never as a different error that would confirm the row exists.
 * Grows with each milestone as more of the twelve entities get a service.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Tenant = TenantContext & { recommendationId: string; itemId: string; briefId: string };

const briefInput: BriefInput = {
  title: "A brief",
  contentType: "GUIDE",
  searchIntent: null,
  primaryConversion: null,
  audience: "Someone",
  customerProblem: "Something",
  desiredOutcome: "Anything",
  recommendedAngle: null,
  keyQuestions: [],
  requiredSections: [],
  optionalSections: [],
  externalEvidenceRequirements: [],
  brandVoiceNotes: null,
};

async function makeTenant(label: string): Promise<Tenant> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `p4iso-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `P4 iso ${label}`, slug: `p4iso-${label}-${suffix}` },
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
    data: { workspaceId: workspace.id, domain: host, normalizedDomain: host, primaryMarket: "PH" },
  });

  const context: TenantContext = { user, membership, organization, workspace, website };

  const recommendation = await prisma.recommendation.create({
    data: {
      websiteId: website.id,
      type: "CONTENT_REFRESH",
      title: `${label} refresh`,
      summary: "Summary",
      rationale: "Rationale",
    },
  });
  await decide(context, recommendation.id, { decision: "APPROVED" });

  // A second, started one, so there is an item to reach for.
  const started = await prisma.recommendation.create({
    data: {
      websiteId: website.id,
      type: "CONTENT_CREATE",
      title: `${label} new page`,
      summary: "Summary",
      rationale: "Rationale",
    },
  });
  await decide(context, started.id, { decision: "APPROVED" });
  const item = await startFromRecommendation(context, started.id);
  const brief = await createManualBrief(context, item.id, briefInput);

  return { ...context, recommendationId: recommendation.id, itemId: item.id, briefId: brief.id };
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  [a, b] = await Promise.all([makeTenant("a"), makeTenant("b")]);
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

describe("content work across tenants", () => {
  it("cannot be started from another tenant's approved recommendation", async () => {
    await expect(startFromRecommendation(a, b.recommendationId)).rejects.toMatchObject({
      name: "ContentWorkError",
      code: "not_found",
    });

    // Nothing was created for B either.
    expect(await contentWorkForRecommendation(b, b.recommendationId)).toBeNull();
  });

  it("cannot be read by id across tenants", async () => {
    expect(await getContentWorkItem(a, b.itemId)).toBeNull();
    expect(await getContentWorkItem(b, a.itemId)).toBeNull();
    expect(await getContentWorkItem(a, a.itemId)).not.toBeNull();
  });

  it("never lists another tenant's work or approved recommendations", async () => {
    const aItems = await listContentWorkItems(a, { status: "all" });
    expect(aItems.map((row) => row.id)).toEqual([a.itemId]);

    const aWaiting = await listApprovedNotStarted(a);
    expect(aWaiting.map((row) => row.recommendation.id)).toEqual([a.recommendationId]);

    expect(await contentWorkForRecommendation(a, b.recommendationId)).toBeNull();
  });

  it("cannot hand ownership to a user from another organization", async () => {
    await expect(
      startFromRecommendation(a, a.recommendationId, { ownerUserId: b.user.id }),
    ).rejects.toMatchObject({ code: "forbidden" });

    expect(await contentWorkForRecommendation(a, a.recommendationId)).toBeNull();
  });
});

describe("briefs across tenants", () => {
  it("cannot be generated for, read from, or listed for another tenant's work item", async () => {
    await expect(generateBrief(a, b.itemId)).rejects.toMatchObject({ code: "not_found" });
    expect(await getBrief(a, b.briefId)).toBeNull();
    expect(await getBriefEvidence(a, b.briefId)).toBeNull();
    expect(await listBriefVersions(a, b.itemId)).toEqual([]);
    expect(await listBriefVersions(b, b.itemId)).toHaveLength(1);
  });

  it("cannot be edited, sent for review, or approved across tenants", async () => {
    await expect(
      saveBrief(a, b.briefId, { ...briefInput, title: "Hijacked" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(requestBriefReview(a, b.briefId)).rejects.toMatchObject({ code: "not_found" });
    await expect(approveBrief(a, b.briefId)).rejects.toMatchObject({ code: "not_found" });

    const untouched = await prisma.contentBrief.findUniqueOrThrow({ where: { id: b.briefId } });
    expect(untouched.status).toBe("DRAFT");
    expect(untouched.title).toBe("A brief");
  });
});

describe("drafts across tenants", () => {
  it("cannot be started, generated, or read for another tenant's work item", async () => {
    // B's brief is approved by B, so B can draft; A must still see nothing.
    await approveBrief(b, b.briefId);
    const { draft } = await startDraft(b, b.itemId);

    await expect(startDraft(a, b.itemId)).rejects.toMatchObject({ code: "not_found" });
    await expect(generateRevision(a, draft.id, { generationToken: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await getDraftForWorkItem(a, b.itemId)).toBeNull();
    expect(await getDraftForWorkItem(b, b.itemId)).not.toBeNull();

    const revisionCount = await prisma.contentRevision.count({
      where: { contentDraftId: draft.id },
    });
    expect(revisionCount).toBe(0);
    expect(await getRevision(a, crypto.randomUUID())).toBeNull();
  });
});

describe("revisions, review and supersession across tenants", () => {
  const revision = (changeSummary: string, body: string): RevisionInput => ({
    title: "B's page",
    slug: null,
    excerpt: null,
    metaTitle: null,
    metaDescription: null,
    bodyMarkdown: body,
    changeSummary,
  });

  it("cannot read, edit, compare, review or supersede another tenant's draft", async () => {
    const bView = await getDraftForWorkItem(b, b.itemId);
    const bDraft = bView!.draft;
    const first = await saveRevision(
      b,
      bDraft.id,
      revision("First, by hand.", "# B\n\nWritten by B."),
    );
    const second = await saveRevision(
      b,
      bDraft.id,
      revision("Second.", "# B\n\nWritten by B, twice."),
    );

    // Reads come back empty.
    expect(await getRevision(a, first.revision.id)).toBeNull();
    expect(await listRevisions(a, bDraft.id)).toEqual([]);
    expect(await getDraft(a, bDraft.id)).toBeNull();
    expect(await listDraftsForWorkItem(a, b.itemId)).toEqual([]);
    expect(await compareRevisions(a, bDraft.id, first.revision.id, second.revision.id)).toBeNull();

    // Writes are refused as not found.
    await expect(saveRevision(a, bDraft.id, revision("Hijack.", "# A"))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(requestDraftReview(a, bDraft.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(returnDraftToDrafting(a, bDraft.id, "Mine now.")).rejects.toMatchObject({
      code: "not_found",
    });

    // Manipulated ids: a made-up revision, and a revision of another draft.
    expect(await compareRevisions(b, bDraft.id, first.revision.id, crypto.randomUUID())).toBeNull();
    await approveBrief(a, a.briefId);
    const { draft: aDraft } = await startDraft(a, a.itemId);
    expect(await compareRevisions(a, aDraft.id, first.revision.id, second.revision.id)).toBeNull();

    // A brief from another tenant cannot start a draft here.
    await expect(startDraftFromBrief(a, a.itemId, b.briefId)).rejects.toMatchObject({
      code: "not_found",
    });

    // Roles and actors: a member cannot return a draft; a job cannot write or request review.
    await requestDraftReview(b, bDraft.id);
    const member = { ...b, membership: { ...b.membership, role: "MEMBER" as const } };
    await expect(returnDraftToDrafting(member, bDraft.id, "No.")).rejects.toMatchObject({
      code: "forbidden",
    });
    const system = await systemContextFor(b.website.id);
    await expect(saveRevision(system, bDraft.id, revision("Job.", "# job"))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(requestDraftReview(system, bDraft.id)).rejects.toMatchObject({
      code: "forbidden",
    });

    const untouched = await prisma.contentDraft.findUniqueOrThrow({ where: { id: bDraft.id } });
    expect(untouched.status).toBe("AWAITING_EDITOR_REVIEW");
    expect(await prisma.contentRevision.count({ where: { contentDraftId: bDraft.id } })).toBe(2);
  });
});

describe("the drafts and briefs lists across tenants", () => {
  it("lists only the tenant's own drafts and briefs, and shows no brief panel for another tenant's brief", async () => {
    const mine = await listDrafts(b);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((row) => row.workItemId === b.itemId)).toBe(true);

    const theirs = await listDrafts(a);
    expect(theirs.map((row) => row.id)).not.toContain(mine[0]!.id);
    expect(theirs.every((row) => row.workItemId === a.itemId)).toBe(true);

    expect(await getBriefPanel(a, b.briefId)).toBeNull();
    expect(await getBriefPanel(b, b.briefId)).not.toBeNull();

    const briefs = await listBriefs(a);
    expect(briefs.map((row) => row.id)).not.toContain(b.briefId);
    expect(briefs.map((row) => row.id)).toContain(a.briefId);
  });
});
