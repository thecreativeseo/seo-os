"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { ContentWorkError, startFromRecommendation } from "@/server/services/content-work";

/**
 * "Start content work" (docs/P4_SPEC.md §5).
 *
 * The one deliberate act that turns an approved recommendation into P4 work.
 * WRITE is enough to press it: the authority came from the decision, which
 * needed APPROVE, and the service re-checks that decision from its row. The
 * form names a website and a recommendation; neither is trusted for anything
 * but choosing which guard and which row to ask.
 */

export type ContentWorkActionState = {
  error?: string;
  /** Set when work already exists, so the screen can offer the link instead of a retry. */
  existingItemId?: string;
};

export async function startContentWorkAction(
  _previous: ContentWorkActionState,
  formData: FormData,
): Promise<ContentWorkActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const recommendationId = String(formData.get("__recommendationId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  let itemId: string;

  try {
    const item = await startFromRecommendation(context, recommendationId);
    itemId = item.id;
  } catch (error) {
    if (error instanceof ContentWorkError) {
      return { error: error.message, existingItemId: error.existingItemId };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  // Outside the try: redirect() signals by throwing, and a catch would eat it.
  redirect(`/websites/${websiteId}/content/${itemId}`);
}
