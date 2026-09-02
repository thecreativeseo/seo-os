"use client";

import { useActionState } from "react";

import {
  dismissSignalAction,
  markSignalReviewedAction,
  type SignalActionState,
} from "@/server/actions/signals";

const initial: SignalActionState = {};

/**
 * A person's judgement on a signal.
 *
 * Both actions record a decision rather than changing any measurement — the
 * numbers behind a dismissed signal stay exactly as they were.
 */
export function SignalActions({
  websiteId,
  signalId,
  status,
}: {
  websiteId: string;
  signalId: string;
  status: string;
}) {
  const [reviewState, review, reviewing] = useActionState(markSignalReviewedAction, initial);
  const [dismissState, dismiss, dismissing] = useActionState(dismissSignalAction, initial);

  if (status !== "DETECTED") {
    return (
      <span className="text-muted-foreground font-mono text-[10px] tracking-wide">
        {status}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <form action={review}>
        <input type="hidden" name="__websiteId" value={websiteId} />
        <input type="hidden" name="__signalId" value={signalId} />
        <button
          type="submit"
          disabled={reviewing || dismissing}
          className="border-border hover:bg-accent h-8 rounded-md border px-3 text-xs disabled:opacity-60"
        >
          {reviewing ? "Saving…" : "Mark reviewed"}
        </button>
      </form>
      <form action={dismiss}>
        <input type="hidden" name="__websiteId" value={websiteId} />
        <input type="hidden" name="__signalId" value={signalId} />
        <button
          type="submit"
          disabled={reviewing || dismissing}
          className="text-muted-foreground hover:text-foreground h-8 px-2 text-xs disabled:opacity-60"
        >
          {dismissing ? "Dismissing…" : "Dismiss"}
        </button>
      </form>
      {reviewState.error || dismissState.error ? (
        <p role="alert" className="text-xs text-red-600">
          {reviewState.error ?? dismissState.error}
        </p>
      ) : null}
    </div>
  );
}
