"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import type { ManualSyncProvider } from "@/server/jobs/names";
import { SyncError } from "@/server/services/sync";
import { requestManualSync, type ManualSyncRequest } from "@/server/services/sync-request";

export type SyncActionState = { error?: string; message?: string };

/**
 * "Sync now".
 *
 * The request validates and enqueues; the worker pulls. Nothing here waits on
 * a provider, so the page comes back at once and says what it knows: queued,
 * already queued, already running, or that the queue could not take it. The
 * page reads the run's state afresh on each load — a sync that finishes in
 * minutes does not need a live channel.
 */
function describe(request: ManualSyncRequest): SyncActionState {
  switch (request.status) {
    case "queued":
      return {
        message: "Sync queued. It runs in the background; refresh this page to follow it.",
      };
    case "already_queued":
      return { message: "A sync for this source is already queued." };
    case "already_running":
      return {
        message: `A sync for this source has been running since ${request.since.toLocaleTimeString(
          "en-GB",
          { hour: "2-digit", minute: "2-digit" },
        )}.`,
      };
    case "queue_unavailable":
      return {
        error: "The sync could not be queued. The worker service may not be running.",
      };
  }
}

async function run(formData: FormData, provider: ManualSyncProvider): Promise<SyncActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  let request: ManualSyncRequest;

  try {
    request = await requestManualSync(context, provider);
  } catch (error) {
    if (error instanceof SyncError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return describe(request);
}

export async function syncSearchConsoleAction(
  _previous: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  return run(formData, "GOOGLE_SEARCH_CONSOLE");
}

export async function syncAnalyticsAction(
  _previous: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  return run(formData, "GOOGLE_ANALYTICS");
}
