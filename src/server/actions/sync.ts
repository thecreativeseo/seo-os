"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { runGa4Sync, runGscSync, SyncError, type SyncOutcome } from "@/server/services/sync";
import { detectAndStoreSignals } from "@/server/services/signals";

export type SyncActionState = { error?: string; message?: string };

/**
 * "Sync now".
 *
 * P1 has no durable job runner — the spec's own instruction is not to make the
 * browser one either, so this is an explicit, person-initiated run rather than a
 * loop pretending to be a scheduler. The work happens on the server inside one
 * request; a background queue is P2's problem.
 */
function describe(outcome: SyncOutcome): string {
  if (outcome.reused) {
    return `Already up to date through ${outcome.window.endDate}.`;
  }

  if (outcome.status === "FAILED") {
    return "";
  }

  const skipped =
    outcome.skipped > 0 ? `, ${outcome.skipped} rows could not be matched to a page` : "";

  return `${outcome.received.toLocaleString("en-GB")} rows read for ${
    outcome.window.startDate
  } to ${outcome.window.endDate}${skipped}.`;
}

async function run(
  formData: FormData,
  sync: (context: Awaited<ReturnType<typeof requireWebsiteAccess>>) => Promise<SyncOutcome>,
): Promise<SyncActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  let outcome: SyncOutcome;

  try {
    outcome = await sync(context);
  } catch (error) {
    if (error instanceof SyncError) {
      return { error: error.message };
    }
    throw error;
  }

  if (outcome.status === "FAILED") {
    // The run row already holds our own code and summary; the person gets the same
    // sentence rather than anything the provider said.
    return {
      error: outcome.run.errorSummary ?? "The sync did not complete.",
    };
  }

  // New metrics mean the previous detection is out of date. Re-running it here
  // keeps signals and numbers describing the same day.
  if (!outcome.reused && outcome.written > 0) {
    await detectAndStoreSignals(context);
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return { message: describe(outcome) };
}

export async function syncSearchConsoleAction(
  _previous: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  return run(formData, (context) => runGscSync(context));
}

export async function syncAnalyticsAction(
  _previous: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  return run(formData, (context) => runGa4Sync(context));
}
