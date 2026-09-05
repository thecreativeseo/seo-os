"use client";

import { useActionState } from "react";

import {
  generateRevisionAction,
  startDraftAction,
  type DraftActionState,
} from "@/server/actions/content-draft";

const initial: DraftActionState = {};

const PRIMARY =
  "bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60";

function Feedback({ state }: { state: DraftActionState }) {
  if (!state.error) return null;
  const tone =
    state.code === "generation_in_progress" || state.code === "no_provider"
      ? "text-amber-700 dark:text-amber-400"
      : "text-red-600";
  return (
    <p role="alert" className={`text-sm ${tone}`}>
      {state.error}
    </p>
  );
}

/** Opens the draft for a work item: one container, pinned to the approved brief. */
export function StartDraftButton({
  websiteId,
  workItemId,
}: {
  websiteId: string;
  workItemId: string;
}) {
  const [state, action, pending] = useActionState(startDraftAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? "Starting…" : "Start drafting"}
        </button>
        <span className="text-muted-foreground text-xs">
          Opens a draft pinned to the approved brief. Nothing is generated until you ask.
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/**
 * Asks for a revision. The token comes from the page that rendered the
 * button, so a double-click or a retry of the same page carries the same
 * token and gets the same revision back instead of a second one.
 */
export function GenerateRevisionButton({
  websiteId,
  workItemId,
  draftId,
  generationToken,
  label,
}: {
  websiteId: string;
  workItemId: string;
  draftId: string;
  generationToken: string;
  label: string;
}) {
  const [state, action, pending] = useActionState(generateRevisionAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <input type="hidden" name="__draftId" value={draftId} />
      <input type="hidden" name="__generationToken" value={generationToken} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={PRIMARY} aria-busy={pending}>
          {pending ? "Generating… this can take a minute or two" : label}
        </button>
        <span className="text-muted-foreground text-xs">
          Writes from the approved brief and the facts approved right now. The result is a draft
          revision for a person to inspect - never approved by being written.
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}
