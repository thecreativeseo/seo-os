"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { requireUser } from "@/server/auth/session";
import { prisma } from "@/server/db/prisma";
import {
  BusinessContextError,
  approveDraft,
  contentFromOnboarding,
  createDraftFromApproved,
  getOpenDraft,
  upsertDraft,
} from "@/server/services/business-context";
import { answersOf } from "@/server/services/onboarding";

export type ContextActionState = { error?: string };

/**
 * Builds a draft Business Context from the onboarding answers and approves it.
 *
 * Approval requires ADMIN or above. The guard runs before anything is written, so
 * an unauthorized caller cannot even create the draft.
 */
export async function approveFromOnboardingAction(
  _previous: ContextActionState,
  formData: FormData,
): Promise<ContextActionState> {
  const sessionId = String(formData.get("__sessionId") ?? "");

  const { memberships } = await requireUser();
  const organizationIds = memberships.map((membership) => membership.organizationId);

  const session = await prisma.onboardingSession.findFirst({
    where: { id: sessionId, organizationId: { in: organizationIds } },
  });

  if (!session?.websiteId) {
    return { error: "Complete the website step before approving context." };
  }

  const context = await requireWebsiteAccess(session.websiteId, REQUIRED.APPROVE, {
    throwOnDenied: true,
  });

  let websiteId: string;

  try {
    const draft = await upsertDraft(context, contentFromOnboarding(answersOf(session)));
    await approveDraft(context, draft.id);

    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    websiteId = context.website.id;
  } catch (error) {
    if (error instanceof BusinessContextError) {
      return { error: error.message };
    }
    throw error;
  }

  redirect(`/websites/${websiteId}/context`);
}

/** Saves the onboarding answers as a draft without approving. */
export async function saveDraftContextAction(
  _previous: ContextActionState,
  formData: FormData,
): Promise<ContextActionState> {
  const sessionId = String(formData.get("__sessionId") ?? "");

  const { memberships } = await requireUser();
  const organizationIds = memberships.map((membership) => membership.organizationId);

  const session = await prisma.onboardingSession.findFirst({
    where: { id: sessionId, organizationId: { in: organizationIds } },
  });

  if (!session?.websiteId) {
    return { error: "Complete the website step first." };
  }

  const context = await requireWebsiteAccess(session.websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  await upsertDraft(context, contentFromOnboarding(answersOf(session)));

  redirect(`/websites/${context.website.id}/context`);
}

/** Approves an existing draft from the Business Context page. */
export async function approveVersionAction(
  _previous: ContextActionState,
  formData: FormData,
): Promise<ContextActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const versionId = String(formData.get("__versionId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.APPROVE, {
    throwOnDenied: true,
  });

  try {
    await approveDraft(context, versionId);
  } catch (error) {
    if (error instanceof BusinessContextError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}/context`);
  return {};
}

/**
 * Starts a new draft from the approved version.
 * This is the only way to "edit" approved context.
 */
export async function startDraftAction(
  _previous: ContextActionState,
  formData: FormData,
): Promise<ContextActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  try {
    const existing = await getOpenDraft(context.website.id);
    if (!existing) {
      await createDraftFromApproved(context);
    }
  } catch (error) {
    if (error instanceof BusinessContextError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}/context`);
  return {};
}
