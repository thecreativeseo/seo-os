"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { ContentDraftError, reopenDraft } from "@/server/services/content-draft";
import { ContentQaError, approveForCms, runQa } from "@/server/services/content-qa";

/**
 * The acts a person takes at the QA gate (M5.4 §10, §11, §15): run QA over
 * the approved revision, approve exactly that revision for the CMS, or send
 * the work back for revision.
 *
 * The form carries ids and the person's words only. Which revision is
 * checked, which run backs an approval and which hash is pinned are decided
 * by the server, so nothing here can forge a QA result or an approval. Each
 * act needs the role the service asks for, and the service checks again.
 */

export type QaActionState = {
  error?: string;
  /** The service's code, so the screen can word the state. */
  code?: string;
};

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function checked(formData: FormData, key: string): boolean {
  const value = formData.get(key);
  return value === "on" || value === "1" || value === "true";
}

function failed(error: unknown): QaActionState {
  if (error instanceof ContentQaError || error instanceof ContentDraftError) {
    return { error: error.message, code: error.code };
  }
  throw error;
}

const qaPath = (websiteId: string, workItemId: string) =>
  `/websites/${websiteId}/content/${workItemId}/qa`;

/** Runs QA over the work item's approved revision. Never edits the content. */
export async function runQaAction(
  _previous: QaActionState,
  formData: FormData,
): Promise<QaActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  let runId: string | null = null;
  try {
    const outcome = await runQa(context, workItemId);
    runId = outcome.run.id;
    if (!outcome.ok) {
      return { error: outcome.message, code: outcome.code };
    }
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(`${qaPath(websiteId, workItemId)}?run=${runId}`);
}

/** Approves exactly the checked revision for the CMS. Nothing is published. */
export async function approveForCmsAction(
  _previous: QaActionState,
  formData: FormData,
): Promise<QaActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.REVIEW, { throwOnDenied: true });

  try {
    await approveForCms(context, workItemId, {
      note: text(formData, "note") || undefined,
      acknowledgeNotChecked: checked(formData, "acknowledgeNotChecked"),
      acknowledgeBriefMismatch: checked(formData, "acknowledgeBriefMismatch"),
    });
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(qaPath(websiteId, workItemId));
}

/**
 * Sends the work back for revision: the draft reopens, any CMS approval is
 * invalidated with this reason, and the QA history stays as it is.
 */
export async function returnForRevisionAction(
  _previous: QaActionState,
  formData: FormData,
): Promise<QaActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const draftId = text(formData, "__draftId");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  try {
    await reopenDraft(context, draftId, text(formData, "reason"));
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(`/websites/${websiteId}/content/${workItemId}/draft?draft=${draftId}`);
}
