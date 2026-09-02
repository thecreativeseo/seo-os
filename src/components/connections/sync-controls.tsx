"use client";

import { useActionState } from "react";

import {
  syncAnalyticsAction,
  syncSearchConsoleAction,
  type SyncActionState,
} from "@/server/actions/sync";

const initial: SyncActionState = {};

/**
 * A sync can take a while against a large property, and there is no job queue in
 * P1 to hand it to. The button says what is happening rather than appearing to
 * hang, and never claims a result the run did not report.
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
          {pending ? "Syncing…" : "Sync now"}
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
