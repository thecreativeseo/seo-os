"use client";

import { useActionState } from "react";

import {
  approveVersionAction,
  discardContextDraftAction,
  startDraftAction,
  type ContextActionState,
} from "@/server/actions/business-context";

const initial: ContextActionState = {};

export function ApproveVersionButton({
  websiteId,
  versionId,
}: {
  websiteId: string;
  versionId: string;
}) {
  const [state, action, pending] = useActionState(approveVersionAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__versionId" value={versionId} />
      <button
        type="submit"
        disabled={pending}
        className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Publishing…" : "Publish version"}
      </button>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Throws away the open draft and returns to the published version.
 *
 * Sits beside Publish because both are decisions about the draft as a whole —
 * unlike "Discard changes" in the editor, which only undoes unsaved typing.
 */
export function DiscardDraftButton({
  websiteId,
  versionId,
}: {
  websiteId: string;
  versionId: string;
}) {
  const [state, action, pending] = useActionState(discardContextDraftAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__versionId" value={versionId} />
      <button
        type="submit"
        disabled={pending}
        className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
      >
        {pending ? "Discarding…" : "Discard this draft"}
      </button>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function StartDraftButton({ websiteId }: { websiteId: string }) {
  const [state, action, pending] = useActionState(startDraftAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <button
        type="submit"
        disabled={pending}
        className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Creating…" : "Edit this context"}
      </button>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
