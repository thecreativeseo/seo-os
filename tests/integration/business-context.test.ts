import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import {
  BusinessContextError,
  approveDraft,
  contentFromOnboarding,
  createDraftFromApproved,
  getCurrentApproved,
  getOpenDraft,
  listVersions,
  upsertDraft,
} from "@/server/services/business-context";
import type { TenantContext } from "@/server/auth/guards";
import type { Role } from "@/generated/prisma/client";

/**
 * Business Context versioning (P0_ACCEPTANCE_CRITERIA "Business Context").
 *
 * "Approved context mutation = P0 FAIL." These prove the rule at the service layer
 * and confirm the database trigger still backs it up.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string, role: Role = "OWNER"): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `ctx-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Context ${label}`, slug: `ctx-${label}-${suffix}` },
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

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: `${label}-${suffix}.example.com`,
      normalizedDomain: `${label}-${suffix}.example.com`,
    },
  });

  return { user, membership, organization, workspace, website };
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

describe("draft creation", () => {
  it("creates version 1 as a draft", async () => {
    const context = await makeContext("draft1");
    const draft = await upsertDraft(context, { productService: "Widgets" });

    expect(draft.versionNumber).toBe(1);
    expect(draft.status).toBe("DRAFT");
    expect(draft.approvedAt).toBeNull();
    expect(draft.approvedByUserId).toBeNull();
  });

  it("updates the open draft rather than creating a second one", async () => {
    const context = await makeContext("draft2");
    const first = await upsertDraft(context, { productService: "First" });
    const second = await upsertDraft(context, { productService: "Second" });

    expect(second.id).toBe(first.id);
    expect(second.productService).toBe("Second");
    expect(await listVersions(context.website.id)).toHaveLength(1);
  });

  it("leaves unanswered fields null rather than inventing them", async () => {
    const context = await makeContext("nulls");
    const draft = await upsertDraft(
      context,
      contentFromOnboarding({ business: { productService: "Only this" } } as never),
    );

    expect(draft.productService).toBe("Only this");
    expect(draft.primaryCustomer).toBeNull();
    expect(draft.primaryMarket).toBeNull();
    expect(draft.brandVoice).toBeNull();
    expect(draft.competitorSummary).toBeNull();
    expect(draft.approvedClaims).toEqual([]);
  });

  it("records an audit event on creation", async () => {
    const context = await makeContext("audit");
    const draft = await upsertDraft(context, { productService: "Audited" });

    const events = await prisma.auditEvent.findMany({
      where: { entityId: draft.id, entityType: "BusinessContextVersion" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("CREATE");
    expect(events[0]?.actorUserId).toBe(context.user.id);
  });
});

describe("approval", () => {
  it("approves a draft and makes it canonical", async () => {
    const context = await makeContext("approve");
    const draft = await upsertDraft(context, { productService: "To approve" });

    const approved = await approveDraft(context, draft.id);

    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedByUserId).toBe(context.user.id);
    expect(approved.approvedAt).not.toBeNull();

    const current = await getCurrentApproved(context.website.id);
    expect(current?.id).toBe(approved.id);
  });

  it("records an approval audit event", async () => {
    const context = await makeContext("approveaudit");
    const draft = await upsertDraft(context, { productService: "x" });
    const approved = await approveDraft(context, draft.id);

    const events = await prisma.auditEvent.findMany({
      where: { entityId: approved.id, action: "APPROVE" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.beforeSnapshotJson).toMatchObject({ status: "DRAFT" });
    expect(events[0]?.afterSnapshotJson).toMatchObject({ status: "APPROVED" });
  });

  it("refuses to approve twice", async () => {
    const context = await makeContext("twice");
    const draft = await upsertDraft(context, { productService: "x" });
    await approveDraft(context, draft.id);

    await expect(approveDraft(context, draft.id)).rejects.toBeInstanceOf(
      BusinessContextError,
    );
  });

  it("refuses a version belonging to another website", async () => {
    const a = await makeContext("owner-a");
    const b = await makeContext("owner-b");
    const draftB = await upsertDraft(b, { productService: "B only" });

    await expect(approveDraft(a, draftB.id)).rejects.toBeInstanceOf(BusinessContextError);
  });
});

describe("role enforcement", () => {
  it("denies approval to a MEMBER", async () => {
    const context = await makeContext("member", "MEMBER");
    const draft = await upsertDraft(context, { productService: "x" });

    await expect(approveDraft(context, draft.id)).rejects.toThrow(/permission/i);

    const current = await getCurrentApproved(context.website.id);
    expect(current).toBeNull();
  });

  it("denies approval to a SEO_LEAD", async () => {
    const context = await makeContext("seolead", "SEO_LEAD");
    const draft = await upsertDraft(context, { productService: "x" });

    await expect(approveDraft(context, draft.id)).rejects.toThrow(/permission/i);
  });

  it("allows an ADMIN to approve", async () => {
    const context = await makeContext("admin", "ADMIN");
    const draft = await upsertDraft(context, { productService: "x" });

    const approved = await approveDraft(context, draft.id);
    expect(approved.status).toBe("APPROVED");
  });
});

describe("approved context is immutable", () => {
  it("cannot be updated, even directly through the ORM", async () => {
    const context = await makeContext("immutable");
    const draft = await upsertDraft(context, { productService: "Original" });
    const approved = await approveDraft(context, draft.id);

    await expect(
      prisma.businessContextVersion.update({
        where: { id: approved.id },
        data: { productService: "Tampered" },
      }),
    ).rejects.toThrow(/immutable/i);

    const unchanged = await prisma.businessContextVersion.findUnique({
      where: { id: approved.id },
    });
    expect(unchanged?.productService).toBe("Original");
  });

  it("editing approved context creates a new draft instead", async () => {
    const context = await makeContext("newdraft");
    const first = await upsertDraft(context, { productService: "Version one" });
    const approved = await approveDraft(context, first.id);

    const draft = await createDraftFromApproved(context);

    expect(draft.id).not.toBe(approved.id);
    expect(draft.versionNumber).toBe(approved.versionNumber + 1);
    expect(draft.status).toBe("DRAFT");
    // Content is carried forward so editing starts from what was agreed.
    expect(draft.productService).toBe("Version one");
  });

  it("keeps the approved version canonical until the new draft is approved", async () => {
    const context = await makeContext("canonical");
    const first = await upsertDraft(context, { productService: "One" });
    const approved = await approveDraft(context, first.id);

    const draft = await createDraftFromApproved(context);
    await prisma.businessContextVersion.update({
      where: { id: draft.id },
      data: { productService: "Two" },
    });

    // Still pointing at version 1.
    expect((await getCurrentApproved(context.website.id))?.id).toBe(approved.id);

    await approveDraft(context, draft.id);

    const current = await getCurrentApproved(context.website.id);
    expect(current?.id).toBe(draft.id);
    expect(current?.productService).toBe("Two");
  });

  it("keeps historical versions retrievable", async () => {
    const context = await makeContext("history");
    const v1 = await approveDraft(context, (await upsertDraft(context, { productService: "One" })).id);
    const v2draft = await createDraftFromApproved(context);
    await prisma.businessContextVersion.update({
      where: { id: v2draft.id },
      data: { productService: "Two" },
    });
    const v2 = await approveDraft(context, v2draft.id);

    const versions = await listVersions(context.website.id);

    expect(versions.map((version) => version.versionNumber)).toEqual([2, 1]);
    const original = versions.find((version) => version.id === v1.id);
    expect(original?.productService).toBe("One");
    expect(original?.status).toBe("APPROVED");
    expect(v2.versionNumber).toBe(2);
  });

  it("does not start a second draft while one is open", async () => {
    const context = await makeContext("onedraft");
    await approveDraft(context, (await upsertDraft(context, { productService: "One" })).id);

    const first = await createDraftFromApproved(context);
    const second = await createDraftFromApproved(context);

    expect(second.id).toBe(first.id);
  });

  it("refuses to start a draft when nothing is approved", async () => {
    const context = await makeContext("nodraft");
    await expect(createDraftFromApproved(context)).rejects.toBeInstanceOf(
      BusinessContextError,
    );
  });
});

describe("tenant isolation", () => {
  it("does not expose another website's context", async () => {
    const a = await makeContext("iso-a");
    const b = await makeContext("iso-b");

    await approveDraft(a, (await upsertDraft(a, { productService: "A secret" })).id);

    expect(await getCurrentApproved(b.website.id)).toBeNull();
    expect(await listVersions(b.website.id)).toHaveLength(0);
    expect(await getOpenDraft(b.website.id)).toBeNull();
  });
});
