"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  DiagnosisError,
  markDiagnosisReviewed,
  requestPageDiagnosis,
} from "@/server/services/diagnosis";

/**
 * Asking for a diagnosis, and closing one (docs/P3_SPEC.md §14, §19, §36).
 *
 * Requesting needs WRITE: it spends a model call and creates records. Marking a
 * diagnosis reviewed needs APPROVE, the same bar as deciding on what it
 * proposed — the service checks it again. Nothing in the form names a tenant
 * with any authority; the website ID only says which guard to ask.
 */

export type DiagnosisActionState = { error?: string; message?: string };

export async function requestDiagnosisAction(
  _previous: DiagnosisActionState,
  formData: FormData,
): Promise<DiagnosisActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const pageId = String(formData.get("__pageId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  let diagnosisId: string;

  try {
    const outcome = await requestPageDiagnosis(context, { pageId });

    if (!outcome.ok) {
      // Our own sentence, from the fixed error table — never a provider's text.
      return { error: outcome.error.message };
    }

    diagnosisId = outcome.diagnosis.id;
  } catch (error) {
    if (error instanceof DiagnosisError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  // Outside the try: redirect() signals by throwing, and a catch would eat it.
  redirect(`/websites/${websiteId}/diagnoses/${diagnosisId}`);
}

export async function markDiagnosisReviewedAction(
  _previous: DiagnosisActionState,
  formData: FormData,
): Promise<DiagnosisActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const diagnosisId = String(formData.get("__diagnosisId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.APPROVE, {
    throwOnDenied: true,
  });

  try {
    await markDiagnosisReviewed(context, diagnosisId);
  } catch (error) {
    if (error instanceof DiagnosisError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return { message: "Marked as reviewed." };
}
