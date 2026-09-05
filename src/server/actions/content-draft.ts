"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  ContentDraftError,
  generateRevision,
  requestDraftReview,
  returnDraftToDrafting,
  saveRevision,
  startDraft,
  startDraftFromBrief,
} from "@/server/services/content-draft";

/**
 * Drafting (docs/P4_SPEC.md §9-§11; M4.2, M4.3). The acts a person takes on
 * a draft: start one, ask for a generation, save a revision by hand, send it
 * for review, send it back, and move on to a newer approved brief. Each
 * needs the role the service asks for; the service checks again and refuses
 * a job's context. Generation carries the token the page minted, so a retry
 * of the same request returns the same revision.
 */

export type DraftActionState = {
  error?: string;
  /** The service's code, so the screen can word the state ("in progress", "no provider"). */
  code?: string;
  /** Field-level problems with a submitted revision. */
  issues?: string[];
  /** The blocking findings that kept a draft out of review. */
  findings?: string[];
};

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function raw(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function failed(error: unknown): DraftActionState {
  if (error instanceof ContentDraftError) {
    return {
      error: error.message,
      code: error.code,
      issues: error.issues.length ? error.issues : undefined,
      findings: error.findings.length
        ? error.findings.map(
            (finding) => `${finding.kind.replace(/_/g, " ").toLowerCase()}: ${finding.message}`,
          )
        : undefined,
    };
  }
  throw error;
}

function draftPath(websiteId: string, workItemId: string, draftId?: string): string {
  const base = `/websites/${websiteId}/content/${workItemId}/draft`;
  return draftId ? `${base}?draft=${draftId}` : base;
}

export async function startDraftAction(
  _previous: DraftActionState,
  formData: FormData,
): Promise<DraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  let draftId: string;
  try {
    draftId = (await startDraft(context, workItemId)).draft.id;
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(draftPath(websiteId, workItemId, draftId));
}

export async function startFromBriefAction(
  _previous: DraftActionState,
  formData: FormData,
): Promise<DraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const briefId = text(formData, "__briefId");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  let draftId: string;
  try {
    draftId = (await startDraftFromBrief(context, workItemId, briefId)).draft.id;
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(draftPath(websiteId, workItemId, draftId));
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

  try {
    const outcome = await generateRevision(context, draftId, { generationToken });
    if (!outcome.ok) {
      return { error: outcome.message, code: outcome.code };
    }
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(draftPath(websiteId, workItemId, draftId));
}

export async function saveRevisionAction(
  _previous: DraftActionState,
  formData: FormData,
): Promise<DraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const draftId = text(formData, "__draftId");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  try {
    await saveRevision(context, draftId, {
      title: text(formData, "title"),
      slug: text(formData, "slug") || null,
      excerpt: text(formData, "excerpt") || null,
      metaTitle: text(formData, "metaTitle") || null,
      metaDescription: text(formData, "metaDescription") || null,
      bodyMarkdown: raw(formData, "bodyMarkdown"),
      changeSummary: text(formData, "changeSummary"),
    });
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(draftPath(websiteId, workItemId, draftId));
}

export async function requestReviewAction(
  _previous: DraftActionState,
  formData: FormData,
): Promise<DraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const draftId = text(formData, "__draftId");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  try {
    await requestDraftReview(context, draftId);
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(draftPath(websiteId, workItemId, draftId));
}

export async function returnToDraftingAction(
  _previous: DraftActionState,
  formData: FormData,
): Promise<DraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const draftId = text(formData, "__draftId");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.REVIEW, { throwOnDenied: true });

  try {
    await returnDraftToDrafting(context, draftId, text(formData, "note"));
  } catch (error) {
    return failed(error);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  redirect(draftPath(websiteId, workItemId, draftId));
}
