"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { ContentDraftError, generateRevision, startDraft } from "@/server/services/content-draft";

/**
 * Drafting (docs/P4_SPEC.md §9-§11). Two acts a person takes: start a draft
 * from the approved brief, and ask for a revision to be generated. Both need
 * WRITE; the service checks again and refuses a job's context. The form
 * carries a website, a work item or draft, and - for generation - the token
 * the page minted, so a retry of the same request returns the same revision.
 */

export type DraftActionState = {
  error?: string;
  /** The service's code, so the screen can word the state ("in progress", "no provider"). */
  code?: string;
  message?: string;
};

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function startDraftAction(
  _previous: DraftActionState,
  formData: FormData,
): Promise<DraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  try {
    await startDraft(context, workItemId);
  } catch (error) {
    if (error instanceof ContentDraftError) return { error: error.message, code: error.code };
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(`/websites/${websiteId}/content/${workItemId}/draft`);
}

export async function generateRevisionAction(
  _previous: DraftActionState,
  formData: FormData,
): Promise<DraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const draftId = text(formData, "__draftId");
  const generationToken = text(formData, "__generationToken");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  let revisionNumber: number;
  try {
    const outcome = await generateRevision(context, draftId, { generationToken });
    if (!outcome.ok) {
      return { error: outcome.message, code: outcome.code };
    }
    revisionNumber = outcome.revision.revisionNumber;
  } catch (error) {
    if (error instanceof ContentDraftError) return { error: error.message, code: error.code };
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(`/websites/${websiteId}/content/${workItemId}/draft?revision=${revisionNumber}`);
}
