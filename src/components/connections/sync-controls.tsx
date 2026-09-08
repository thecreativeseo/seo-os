"use client";

import { useActionState } from "react";

import {
  syncAnalyticsAction,
  syncSearchConsoleAction,
  type SyncActionState,
} from "@/server/actions/sync";

const initial: SyncActionState = {};

/**
 * The button asks; the worker syncs. The request only queues the job, so this
 * comes back in a moment with "queued" (or why not), and the Data Health table
 * shows the attempt's state on the next load. Nothing here claims a result the
 * run has not reported.
 */
export function SyncButton({
  websiteId,
  provider,
}: {
  websiteId: string;
  provider: "GOOGLE_SEARCH_CONSOLE" | "GOOGLE_ANALYTICS";
}) {
  const action =
    provider === "GOOGLE_SEARCH_CONSOLE" ? syncSearchConsoleAction : syncAnalyticsAction;
  const [state, submit, pending] = useActionState(action, initial);

  return (
    <div className="space-y-1.5">
      <form action={submit}>
        <input type="hidden" name="__websiteId" value={websiteId} />
        <button
          type="submit"
          disabled={pending}
          className="border-border hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-xs disabled:opacity-60"
        >
          {pending ? "Queuing…" : "Sync now"}
        </button>
      </form>

      {state.message ? (
        <p aria-live="polite" className="text-muted-foreground text-xs">
          {state.message}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
