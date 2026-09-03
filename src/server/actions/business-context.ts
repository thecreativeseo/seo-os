"use server";

import { MAX_ADDITIONAL_MARKETS, resolveMarketCode } from "@/lib/markets";
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
  discardDraft,
  getOpenDraft,
  updateDraft,
  upsertDraft,
} from "@/server/services/business-context";
import { answersOf } from "@/server/services/onboarding";

export type ContextActionState = { error?: string; saved?: boolean };

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

/**
 * Text fields arrive as-is; list fields arrive as one entry per line.
 * Empty means unknown, so blanks become null rather than "".
 */
function readContent(formData: FormData) {
  const text = (key: string) => {
    const value = formData.get(key);
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  };
  const list = (key: string) => {
    const value = formData.get(key);
    if (typeof value !== "string") return [];
    return value
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
  };

  // Markets are codes. The select cannot submit a sentence, so an unresolvable
  // value here is a crafted request or a stale form, and it is refused with a
  // sentence rather than filed under a default: this field decides which
  // country's search data the connectors ask for.
  const market = (key: string): string | null => {
    const raw = text(key);
    if (raw === null) return null;
    const code = resolveMarketCode(raw);
    if (code === null) throw new BusinessContextError("Choose a market from the list.");
    return code;
  };

  // A hand-typed list: names or codes, one per line. Resolved, de-duplicated,
  // and relieved of the main market, which listing again says nothing. An entry
  // nobody can resolve and a sixth market are refused, not trimmed.
  const markets = (key: string, exclude: string | null): string[] => {
    const codes: string[] = [];
    for (const entry of list(key)) {
      const code = resolveMarketCode(entry);
      if (code === null) {
        throw new BusinessContextError(`"${entry}" is not a market SEO OS recognises.`);
      }
      if (code !== exclude && !codes.includes(code)) codes.push(code);
    }
    if (codes.length > MAX_ADDITIONAL_MARKETS) {
      throw new BusinessContextError(
        `Choose at most ${MAX_ADDITIONAL_MARKETS} additional markets.`,
      );
    }
    return codes;
  };

  const primaryMarket = market("primaryMarket");

  return {
    companySummary: text("companySummary"),
    productService: text("productService"),
    businessModel: text("businessModel"),
    primaryCustomer: text("primaryCustomer"),
    primaryMarket,
    additionalMarkets: markets("additionalMarkets", primaryMarket),
    primaryConversion: text("primaryConversion"),
    competitorSummary: text("competitorSummary"),
    brandVoice: text("brandVoice"),
    buyerRoles: list("buyerRoles"),
    languages: list("languages"),
    secondaryConversions: list("secondaryConversions"),
    businessPriorities: list("businessPriorities"),
    seoPriorities: list("seoPriorities"),
    differentiators: list("differentiators"),
    priorityTopics: list("priorityTopics"),
    avoidTopics: list("avoidTopics"),
    approvedClaims: list("approvedClaims"),
    prohibitedClaims: list("prohibitedClaims"),
  };
}

/** Saves edits to the open draft. */
export async function saveContextDraftAction(
  _previous: ContextActionState,
  formData: FormData,
): Promise<ContextActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const versionId = String(formData.get("__versionId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  try {
    await updateDraft(context, versionId, readContent(formData));
  } catch (error) {
    if (error instanceof BusinessContextError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}/context`);
  return { saved: true };
}

/** Throws away the open draft, returning to the approved version. */
export async function discardContextDraftAction(
  _previous: ContextActionState,
  formData: FormData,
): Promise<ContextActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const versionId = String(formData.get("__versionId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  try {
    await discardDraft(context, versionId);
  } catch (error) {
    if (error instanceof BusinessContextError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}/context`);
  return {};
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
