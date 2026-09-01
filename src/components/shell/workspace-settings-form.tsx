"use client";

import { useActionState } from "react";

import { renameWorkspaceAction, type WorkspaceState } from "@/server/actions/workspace";

const initial: WorkspaceState = {};

export function WorkspaceSettingsForm({
  workspaceId,
  defaultName,
}: {
  workspaceId: string;
  defaultName: string;
}) {
  const [state, action, pending] = useActionState(renameWorkspaceAction, initial);

  return (
    <form action={action} className="border-border space-y-4 rounded-lg border p-5">
      <input type="hidden" name="__workspaceId" value={workspaceId} />

      <div className="space-y-1.5">
        <label htmlFor="workspace-name" className="block text-sm font-medium">
          Workspace name
        </label>
        <input
          id="workspace-name"
          name="name"
          required
          defaultValue={defaultName}
          className="border-border focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {state.saved ? (
          <span aria-live="polite" className="text-muted-foreground text-xs">
            Saved
          </span>
        ) : null}
        {state.error ? (
          <p role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
