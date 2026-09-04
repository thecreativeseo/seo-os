"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  DiagnosisError,
  cancelDiagnosisRequest,
  markDiagnosisReviewed,
} from "@/server/services/diagnosis";
import { submitPageDiagnosis } from "@/server/services/diagnosis-runner";

/**
 * Asking for a diagnosis, withdrawing the ask, and closing one
 * (docs/P3_SPEC.md sections 14, 19, 36).
 *
 * Requesting needs WRITE: it spends a model call and creates records; so does
 * cancelling, which is the same person changing their mind. Marking a
 * diagnosis reviewed needs APPROVE, the same bar as deciding on what it
 * proposed - the service checks it again. Nothing in the form names a tenant
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

  let destination: string;

  try {
    const submitted = await submitPageDiagnosis(context, { pageId });

    if (submitted.outcome && !submitted.outcome.ok) {
      // Our own sentence, from the fixed error table - never a provider's text.
      return { error: submitted.outcome.error.message };
    }

    // Ran here: straight to the diagnosis. Queued: to the request, which
    // follows the row and moves on to the diagnosis when there is one.
    destination = submitted.outcome
      ? `/websites/${websiteId}/diagnoses/${submitted.outcome.diagnosis.id}`
      : `/websites/${websiteId}/diagnoses/requests/${submitted.request.id}`;
  } catch (error) {
    if (error instanceof DiagnosisError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  // Outside the try: redirect() signals by throwing, and a catch would eat it.
  redirect(destination);
}

export async function cancelDiagnosisRequestAction(
  _previous: DiagnosisActionState,
  formData: FormData,
): Promise<DiagnosisActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const requestId = String(formData.get("__requestId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  try {
    await cancelDiagnosisRequest(context, requestId);
  } catch (error) {
    if (error instanceof DiagnosisError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return { message: "Request cancelled." };
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
