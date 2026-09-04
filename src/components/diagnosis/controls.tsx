"use client";

import { useActionState } from "react";

import {
  markDiagnosisReviewedAction,
  requestDiagnosisAction,
  type DiagnosisActionState,
} from "@/server/actions/diagnosis";

const initial: DiagnosisActionState = {};

/**
 * Asking for a diagnosis (docs/P3_SPEC.md §14).
 *
 * Where the run happens is the server's setting, not the button's: inline, it
 * takes about a minute inside this request, so the button says so; queued, the
 * request is handed to the worker and the action redirects to a page that
 * follows it. On failure the reason is shown here, in our own words, never a
 * provider's.
 */
export function DiagnoseButton({
  websiteId,
  pageId,
  runner = "inline",
}: {
  websiteId: string;
  pageId: string;
  runner?: "inline" | "queue";
}) {
  const [state, action, pending] = useActionState(requestDiagnosisAction, initial);
  const busy = runner === "queue" ? "Requesting\u2026" : "Diagnosing\u2026 this can take a minute";

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__pageId" value={pageId} />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {pending ? busy : "Diagnose this page"}
        </button>
        <span className="text-muted-foreground text-xs">
          Reads this page&rsquo;s evidence and explains its performance, citing every record.
          Nothing is changed on the site.
        </span>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Closes the review of a diagnosis (§19). Owner or admin. */
export function MarkReviewedButton({
  websiteId,
  diagnosisId,
}: {
  websiteId: string;
  diagnosisId: string;
}) {
  const [state, action, pending] = useActionState(markDiagnosisReviewedAction, initial);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__diagnosisId" value={diagnosisId} />
      <button
        type="submit"
        disabled={pending}
        className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
      >
        {pending ? "Saving…" : "Mark as reviewed"}
      </button>
      {state.message ? (
        <span className="text-muted-foreground text-xs">{state.message}</span>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
