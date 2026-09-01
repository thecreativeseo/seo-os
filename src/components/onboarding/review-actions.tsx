"use client";

import { useActionState } from "react";

import {
  approveFromOnboardingAction,
  saveDraftContextAction,
  type ContextActionState,
} from "@/server/actions/business-context";

const initial: ContextActionState = {};

/**
 * Review-step actions.
 *
 * Each button gets its own form and its own useActionState binding. Putting two
 * differently-typed actions on one form via `formAction` calls them with a single
 * argument, which does not match the (previousState, formData) signature these
 * actions have — the reason an earlier version crashed on `formData.get`.
 *
 * Separate forms also mean each action can report its own error in place.
 */
export function ReviewActions({
  sessionId,
  canApprove,
}: {
  sessionId: string;
  canApprove: boolean;
}) {
  const [draftState, draftAction, draftPending] = useActionState(
    saveDraftContextAction,
    initial,
  );
  const [approveState, approveAction, approvePending] = useActionState(
    approveFromOnboardingAction,
    initial,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <form action={draftAction}>
          <input type="hidden" name="__sessionId" value={sessionId} />
          <button
            type="submit"
            disabled={draftPending || approvePending}
            className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
          >
            {draftPending ? "Saving…" : "Save draft"}
          </button>
        </form>

        {canApprove ? (
          <form action={approveAction}>
            <input type="hidden" name="__sessionId" value={sessionId} />
            <button
              type="submit"
              disabled={draftPending || approvePending}
              className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
            >
              {approvePending ? "Approving…" : "Approve context"}
            </button>
          </form>
        ) : (
          <p className="text-muted-foreground text-sm">
            An owner or admin must approve this context.
          </p>
        )}
      </div>

      {draftState.error ? (
        <p role="alert" className="text-sm text-red-600">
          {draftState.error}
        </p>
      ) : null}
      {approveState.error ? (
        <p role="alert" className="text-sm text-red-600">
          {approveState.error}
        </p>
      ) : null}
    </div>
  );
}
