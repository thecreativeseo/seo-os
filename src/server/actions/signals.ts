"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { SignalError, setSignalStatus } from "@/server/services/signals";

export type SignalActionState = { error?: string };

async function updateStatus(
  formData: FormData,
  status: "REVIEWED" | "DISMISSED",
): Promise<SignalActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const signalId = String(formData.get("__signalId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  try {
    await setSignalStatus(context, signalId, status);
  } catch (error) {
    if (error instanceof SignalError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return {};
}

export async function markSignalReviewedAction(
  _previous: SignalActionState,
  formData: FormData,
): Promise<SignalActionState> {
  return updateStatus(formData, "REVIEWED");
}

export async function dismissSignalAction(
  _previous: SignalActionState,
  formData: FormData,
): Promise<SignalActionState> {
  return updateStatus(formData, "DISMISSED");
}
