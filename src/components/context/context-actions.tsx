"use client";

import { useActionState } from "react";

import {
  approveVersionAction,
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
        {pending ? "Approving…" : "Approve context"}
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
        {pending ? "Creating…" : "Edit as new draft"}
      </button>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
