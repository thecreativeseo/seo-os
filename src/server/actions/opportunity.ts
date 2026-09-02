"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  OpportunityError,
  assignOpportunityOwner,
  detectAndStoreOpportunities,
  setOpportunityStatus,
} from "@/server/services/opportunity";
import { KeywordError, updateKeyword } from "@/server/services/keyword";
import { OwnershipError, assignOwnership } from "@/server/services/ownership";
import type { KeywordIntent, OpportunityStatus } from "@/generated/prisma/client";

export type P2ActionState = { error?: string; message?: string };

const STATUSES: OpportunityStatus[] = [
  "IDENTIFIED",
  "QUALIFIED",
  "SCHEDULED",
  "IN_PROGRESS",
  "DECLINED",
  "COMPLETED",
  "ARCHIVED",
];

const INTENTS: KeywordIntent[] = [
  "INFORMATIONAL",
  "COMMERCIAL",
  "TRANSACTIONAL",
  "NAVIGATIONAL",
  "LOCAL",
  "MIXED",
  "UNKNOWN",
];

/**
 * Every action here validates the value against our own list before it reaches a
 * service. A status or an intent arriving from a form is a string somebody sent,
 * and the fact that a select element offered four options is not evidence about
 * what was posted.
 */
async function run(
  formData: FormData,
  work: (context: Awaited<ReturnType<typeof requireWebsiteAccess>>) => Promise<string | void>,
): Promise<P2ActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  let message: string | void;

  try {
    message = await work(context);
  } catch (error) {
    if (
      error instanceof OpportunityError ||
      error instanceof KeywordError ||
      error instanceof OwnershipError
    ) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return message ? { message } : {};
}

export async function detectOpportunitiesAction(
  _previous: P2ActionState,
  formData: FormData,
): Promise<P2ActionState> {
  return run(formData, async (context) => {
    const summary = await detectAndStoreOpportunities(context);

    // Says what happened per outcome. "Detection complete" would hide the case
    // where nothing was found because nothing has been imported.
    const parts = [
      `${summary.created} new`,
      `${summary.updated} refreshed`,
      summary.preserved > 0 ? `${summary.preserved} left as you set them` : null,
    ].filter(Boolean);

    return summary.detected === 0
      ? "No opportunities found. Import keyword data or connect Search Console first."
      : `${summary.detected} opportunities: ${parts.join(", ")}.`;
  });
}

export async function setOpportunityStatusAction(
  _previous: P2ActionState,
  formData: FormData,
): Promise<P2ActionState> {
  const opportunityId = String(formData.get("__opportunityId") ?? "");
  const requested = String(formData.get("status") ?? "");
  const status = STATUSES.find((candidate) => candidate === requested);

  if (!status) return { error: "That is not a status." };

  return run(formData, async (context) => {
    await setOpportunityStatus(context, opportunityId, status);
  });
}

export async function assignOpportunityAction(
  _previous: P2ActionState,
  formData: FormData,
): Promise<P2ActionState> {
  const opportunityId = String(formData.get("__opportunityId") ?? "");
  const ownerUserId = String(formData.get("ownerUserId") ?? "").trim();

  return run(formData, async (context) => {
    await assignOpportunityOwner(context, opportunityId, ownerUserId || null);
  });
}

export async function updateKeywordAction(
  _previous: P2ActionState,
  formData: FormData,
): Promise<P2ActionState> {
  const keywordId = String(formData.get("__keywordId") ?? "");
  const requestedIntent = String(formData.get("intent") ?? "");
  const intent = INTENTS.find((candidate) => candidate === requestedIntent);

  const readScore = (name: string): number | null | undefined => {
    const raw = formData.get(name);
    if (raw === null) return undefined;

    const value = String(raw).trim();
    if (value === "") return null;

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const goalId = String(formData.get("businessGoalId") ?? "").trim();

  return run(formData, async (context) => {
    await updateKeyword(context, keywordId, {
      ...(intent ? { intent } : {}),
      businessRelevance: readScore("businessRelevance"),
      commercialValue: readScore("commercialValue"),
      ...(formData.has("businessGoalId") ? { businessGoalId: goalId || null } : {}),
    });

    return "Saved.";
  });
}

export async function assignOwnershipAction(
  _previous: P2ActionState,
  formData: FormData,
): Promise<P2ActionState> {
  const keywordId = String(formData.get("__keywordId") ?? "");
  const pageId = String(formData.get("pageId") ?? "").trim();

  if (!pageId) return { error: "Choose a page." };

  return run(formData, async (context) => {
    const ownership = await assignOwnership(context, { keywordId, pageId });
    return `${ownership.page.path} now owns this keyword.`;
  });
}
