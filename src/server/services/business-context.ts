import { prisma } from "@/server/db/prisma";
import { redact } from "@/lib/redact";
import type { StepAnswers } from "@/lib/onboarding/schemas";
import type { TenantContext } from "@/server/auth/guards";
import type {
  BusinessContext,
  BusinessContextVersion,
  Prisma,
} from "@/generated/prisma/client";

/**
 * Business Context versioning (docs/P0_SPEC.md §13, CLAUDE.md "Business Context").
 *
 * Rules, in order of importance:
 *
 *   1. An APPROVED version is immutable. Nothing here updates one — and the
 *      database rejects it anyway (see the M2 trigger), so a regression in this
 *      file cannot rewrite history.
 *   2. Editing approved context creates a NEW draft, numbered one higher.
 *   3. Historical versions remain retrievable.
 *   4. Unknown fields stay null. Nothing is inferred or filled in.
 */

export class BusinessContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessContextError";
  }
}

/** Fields that make up a context version's content, excluding bookkeeping. */
const CONTENT_FIELDS = [
  "companySummary",
  "productService",
  "businessModel",
  "primaryCustomer",
  "buyerRoles",
  "primaryMarket",
  "languages",
  "primaryConversion",
  "secondaryConversions",
  "businessPriorities",
  "seoPriorities",
  "competitorSummary",
  "differentiators",
  "brandVoice",
  "priorityTopics",
  "avoidTopics",
  "approvedClaims",
  "prohibitedClaims",
] as const;

export type ContextContent = Partial<
  Pick<BusinessContextVersion, (typeof CONTENT_FIELDS)[number]>
>;

export async function getOrCreateContext(websiteId: string): Promise<BusinessContext> {
  const existing = await prisma.businessContext.findUnique({ where: { websiteId } });
  if (existing) return existing;

  return prisma.businessContext.create({ data: { websiteId } });
}

export async function getCurrentApproved(
  websiteId: string,
): Promise<BusinessContextVersion | null> {
  const context = await prisma.businessContext.findUnique({
    where: { websiteId },
    include: { currentApprovedVersion: true },
  });

  return context?.currentApprovedVersion ?? null;
}

export async function listVersions(websiteId: string): Promise<BusinessContextVersion[]> {
  const context = await prisma.businessContext.findUnique({ where: { websiteId } });
  if (!context) return [];

  return prisma.businessContextVersion.findMany({
    where: { businessContextId: context.id },
    orderBy: { versionNumber: "desc" },
  });
}

export async function getOpenDraft(
  websiteId: string,
): Promise<BusinessContextVersion | null> {
  const context = await prisma.businessContext.findUnique({ where: { websiteId } });
  if (!context) return null;

  return prisma.businessContextVersion.findFirst({
    where: { businessContextId: context.id, status: { in: ["DRAFT", "IN_REVIEW"] } },
    orderBy: { versionNumber: "desc" },
  });
}

async function nextVersionNumber(businessContextId: string): Promise<number> {
  const latest = await prisma.businessContextVersion.findFirst({
    where: { businessContextId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });

  return (latest?.versionNumber ?? 0) + 1;
}

/**
 * Maps onboarding answers onto context fields.
 *
 * Every field is optional. An unanswered question produces null, never a placeholder
 * — a Business Context that claims something the user never said would be a
 * fabricated business fact.
 */
export function contentFromOnboarding(answers: StepAnswers): ContextContent {
  return {
    companySummary: answers.business?.companySummary ?? null,
    productService: answers.business?.productService ?? null,
    businessModel: answers.business?.businessModel ?? null,
    primaryCustomer: answers.customer?.primaryCustomer ?? null,
    buyerRoles: answers.customer?.buyerRoles ?? [],
    primaryMarket: answers.market?.primaryMarket ?? null,
    languages: answers.market?.primaryLanguage ? [answers.market.primaryLanguage] : [],
    primaryConversion: answers.conversion?.primaryConversion ?? null,
    secondaryConversions: answers.conversion?.secondaryConversions ?? [],
    seoPriorities: answers["seo-priorities"]?.seoPriorities ?? [],
    // Onboarding does not ask about these, so they stay empty rather than being
    // guessed from adjacent answers. They are filled in later, by a human.
    businessPriorities: [],
    competitorSummary: null,
    differentiators: [],
    brandVoice: null,
    priorityTopics: [],
    avoidTopics: [],
    approvedClaims: [],
    prohibitedClaims: [],
  };
}

/**
 * Creates or updates the open draft for a website.
 *
 * If the newest version is APPROVED, a new draft is started at versionNumber + 1
 * rather than touching it. That is the "editing approved context creates a new
 * draft version" rule, expressed as the only code path that exists.
 */
export async function upsertDraft(
  context: TenantContext,
  content: ContextContent,
): Promise<BusinessContextVersion> {
  const businessContext = await getOrCreateContext(context.website.id);
  const open = await getOpenDraft(context.website.id);

  if (open) {
    return prisma.businessContextVersion.update({
      where: { id: open.id },
      data: content as Prisma.BusinessContextVersionUpdateInput,
    });
  }

  const versionNumber = await nextVersionNumber(businessContext.id);

  const created = await prisma.businessContextVersion.create({
    data: {
      ...(content as Prisma.BusinessContextVersionCreateInput),
      businessContext: { connect: { id: businessContext.id } },
      versionNumber,
      status: "DRAFT",
      createdBy: { connect: { id: context.user.id } },
      owner: { connect: { id: context.user.id } },
    },
  });

  await prisma.auditEvent.create({
    data: {
      organizationId: context.organization.id,
      workspaceId: context.workspace.id,
      websiteId: context.website.id,
      actorUserId: context.user.id,
      entityType: "BusinessContextVersion",
      entityId: created.id,
      action: "CREATE",
      afterSnapshotJson: redact({ versionNumber, status: created.status }),
    },
  });

  return created;
}

/**
 * Saves edits to an open draft.
 *
 * Refuses anything that is not DRAFT or IN_REVIEW. The database trigger would
 * reject an approved row anyway, but failing here gives the user a sentence they
 * can act on instead of a database error.
 */
export async function updateDraft(
  context: TenantContext,
  versionId: string,
  content: ContextContent,
): Promise<BusinessContextVersion> {
  const businessContext = await getOrCreateContext(context.website.id);

  const version = await prisma.businessContextVersion.findFirst({
    where: { id: versionId, businessContextId: businessContext.id },
  });

  if (!version) {
    throw new BusinessContextError("That version is not available.");
  }

  if (version.status === "APPROVED") {
    throw new BusinessContextError(
      "Approved context cannot be edited. Start a new draft instead.",
    );
  }

  if (version.status === "ARCHIVED") {
    throw new BusinessContextError("An archived version cannot be edited.");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.businessContextVersion.update({
      where: { id: version.id },
      data: content as Prisma.BusinessContextVersionUpdateInput,
    });

    await tx.auditEvent.create({
      data: {
        organizationId: context.organization.id,
        workspaceId: context.workspace.id,
        websiteId: context.website.id,
        actorUserId: context.user.id,
        entityType: "BusinessContextVersion",
        entityId: updated.id,
        action: "UPDATE",
        afterSnapshotJson: redact({ versionNumber: updated.versionNumber }),
      },
    });

    return updated;
  });
}

/**
 * Throws away an open draft.
 *
 * Only permitted when an approved version exists to fall back to — otherwise
 * discarding would leave the website with no context at all and no way to rebuild
 * it, since the onboarding session that produced it is already complete.
 */
export async function discardDraft(
  context: TenantContext,
  versionId: string,
): Promise<void> {
  const businessContext = await getOrCreateContext(context.website.id);

  const version = await prisma.businessContextVersion.findFirst({
    where: { id: versionId, businessContextId: businessContext.id },
  });

  if (!version) {
    throw new BusinessContextError("That version is not available.");
  }

  if (version.status === "APPROVED") {
    throw new BusinessContextError("An approved version cannot be discarded.");
  }

  const approved = await prisma.businessContextVersion.findFirst({
    where: { businessContextId: businessContext.id, status: "APPROVED" },
  });

  if (!approved) {
    throw new BusinessContextError(
      "This is the only context for this website. Edit it rather than discarding it.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.auditEvent.create({
      data: {
        organizationId: context.organization.id,
        workspaceId: context.workspace.id,
        websiteId: context.website.id,
        actorUserId: context.user.id,
        entityType: "BusinessContextVersion",
        entityId: version.id,
        action: "ARCHIVE",
        beforeSnapshotJson: redact({
          versionNumber: version.versionNumber,
          status: version.status,
        }),
      },
    });

    await tx.businessContextVersion.delete({ where: { id: version.id } });
  });
}

/**
 * Approves a draft and makes it canonical.
 *
 * The status flip and the canonical pointer move together in one transaction: a
 * version marked APPROVED that nothing points at, or a pointer to a version that
 * is not approved, would both be a lie about what the business has agreed.
 *
 * Requires ADMIN or above — enforced by the caller's guard, asserted again here.
 */
export async function approveDraft(
  context: TenantContext,
  versionId: string,
): Promise<BusinessContextVersion> {
  if (context.membership.role !== "OWNER" && context.membership.role !== "ADMIN") {
    throw new BusinessContextError("You do not have permission to approve context.");
  }

  const businessContext = await getOrCreateContext(context.website.id);

  const version = await prisma.businessContextVersion.findFirst({
    where: { id: versionId, businessContextId: businessContext.id },
  });

  if (!version) {
    throw new BusinessContextError("That version is not available.");
  }

  if (version.status === "APPROVED") {
    throw new BusinessContextError("That version is already approved.");
  }

  if (version.status === "ARCHIVED") {
    throw new BusinessContextError("An archived version cannot be approved.");
  }

  return prisma.$transaction(async (tx) => {
    const approved = await tx.businessContextVersion.update({
      where: { id: version.id },
      data: {
        status: "APPROVED",
        approvedByUserId: context.user.id,
        approvedAt: new Date(),
      },
    });

    await tx.businessContext.update({
      where: { id: businessContext.id },
      data: { currentApprovedVersionId: approved.id },
    });

    await tx.auditEvent.create({
      data: {
        organizationId: context.organization.id,
        workspaceId: context.workspace.id,
        websiteId: context.website.id,
        actorUserId: context.user.id,
        entityType: "BusinessContextVersion",
        entityId: approved.id,
        action: "APPROVE",
        beforeSnapshotJson: redact({ status: version.status }),
        afterSnapshotJson: redact({
          status: approved.status,
          versionNumber: approved.versionNumber,
        }),
      },
    });

    return approved;
  });
}

/**
 * Starts a new draft from the current approved version.
 *
 * Content is copied forward so an edit begins from what was agreed, not from a
 * blank form. The approved row itself is never touched.
 */
export async function createDraftFromApproved(
  context: TenantContext,
): Promise<BusinessContextVersion> {
  const businessContext = await getOrCreateContext(context.website.id);
  const existingDraft = await getOpenDraft(context.website.id);

  if (existingDraft) {
    return existingDraft;
  }

  const approved = await prisma.businessContextVersion.findFirst({
    where: { businessContextId: businessContext.id, status: "APPROVED" },
    orderBy: { versionNumber: "desc" },
  });

  if (!approved) {
    throw new BusinessContextError("There is no approved context to edit yet.");
  }

  const content: ContextContent = {};
  for (const field of CONTENT_FIELDS) {
    // Copying by key keeps this honest: adding a field to the model without
    // adding it here would be visible as a missing value, not silently dropped.
    (content as Record<string, unknown>)[field] = approved[field];
  }

  const versionNumber = await nextVersionNumber(businessContext.id);

  const draft = await prisma.businessContextVersion.create({
    data: {
      ...(content as Prisma.BusinessContextVersionCreateInput),
      businessContext: { connect: { id: businessContext.id } },
      versionNumber,
      status: "DRAFT",
      createdBy: { connect: { id: context.user.id } },
      owner: { connect: { id: context.user.id } },
    },
  });

  await prisma.auditEvent.create({
    data: {
      organizationId: context.organization.id,
      workspaceId: context.workspace.id,
      websiteId: context.website.id,
      actorUserId: context.user.id,
      entityType: "BusinessContextVersion",
      entityId: draft.id,
      action: "CREATE",
      afterSnapshotJson: redact({
        versionNumber,
        copiedFromVersion: approved.versionNumber,
      }),
    },
  });

  return draft;
}
