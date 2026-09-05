"use client";

import { useActionState } from "react";

import {
  generateRevisionAction,
  requestReviewAction,
  returnToDraftingAction,
  startDraftAction,
  startFromBriefAction,
  type DraftActionState,
} from "@/server/actions/content-draft";

const initial: DraftActionState = {};

const PRIMARY =
  "bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60";
const SECONDARY =
  "border-border inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium disabled:opacity-60";

/** Asks once before an act that changes state for other people. */
function confirmOr(message: string) {
  return (event: React.FormEvent<HTMLFormElement>) => {
    if (typeof window !== "undefined" && !window.confirm(message)) event.preventDefault();
  };
}

function Feedback({ state }: { state: DraftActionState }) {
  if (!state.error) return null;
  const soft =
    state.code === "generation_in_progress" ||
    state.code === "no_provider" ||
    state.code === "blocked" ||
    state.code === "nothing_changed";
  return (
    <div
      role="alert"
      className={`space-y-1 text-sm ${soft ? "text-amber-700 dark:text-amber-400" : "text-red-600"}`}
    >
      <p>{state.error}</p>
      {state.findings ? (
        <ul className="list-disc pl-5 text-xs">
          {state.findings.map((finding) => (
            <li key={finding}>{finding}</li>
          ))}
        </ul>
      ) : null}
      {state.issues ? (
        <ul className="list-disc pl-5 text-xs">
          {state.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </div>
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

/** The explicit move to a newer approved brief: a separate draft, the old one kept. */
export function StartFromBriefButton({
  websiteId,
  workItemId,
  briefId,
  version,
}: {
  websiteId: string;
  workItemId: string;
  briefId: string;
  version: number;
}) {
  const [state, action, pending] = useActionState(startFromBriefAction, initial);

  return (
    <form
      action={action}
      className="space-y-2"
      onSubmit={confirmOr(
        `Start a new draft from Brief v${version}? The current draft and all its revisions are kept and marked superseded. Nothing is copied across.`,
      )}
    >
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <input type="hidden" name="__briefId" value={briefId} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? "Starting…" : `Start a draft from Brief v${version}`}
        </button>
        <span className="text-muted-foreground text-xs">
          Creates a new draft pinned to v{version}. This draft and all its revisions are kept and
          marked superseded; nothing is copied across.
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
        <span className="text-muted-foreground text-xs" aria-live="polite">
          {pending
            ? "Assembling fresh evidence and writing from the brief. The page updates when the revision is stored."
            : "Writes from the approved brief and the facts approved right now. The result is a revision for a person to inspect - never approved by being written."}
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Sends the current revision for editorial review. Disabled, with the reason, when it would be refused. */
export function RequestReviewButton({
  websiteId,
  workItemId,
  draftId,
  blocked,
  reason,
}: {
  websiteId: string;
  workItemId: string;
  draftId: string;
  /** The page already knows the request would be refused; the button says why. */
  blocked: boolean;
  reason?: string | null;
}) {
  const [state, action, pending] = useActionState(requestReviewAction, initial);

  return (
    <form
      action={action}
      className="space-y-2"
      onSubmit={confirmOr(
        "Request editorial review of the current revision? An SEO lead, admin or owner will be able to return it with a note.",
      )}
    >
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <input type="hidden" name="__draftId" value={draftId} />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || blocked}
          aria-disabled={blocked}
          className={SECONDARY}
        >
          {pending ? "Requesting…" : "Request review"}
        </button>
        <span className="text-muted-foreground text-xs">
          {blocked
            ? (reason ?? "Not available for this revision.")
            : "Marks the current revision as ready for an editor. Warnings are shown to them, not hidden."}
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** A reviewer sends the draft back, with a note the editor will read. */
export function ReturnToDraftingForm({
  websiteId,
  workItemId,
  draftId,
}: {
  websiteId: string;
  workItemId: string;
  draftId: string;
}) {
  const [state, action, pending] = useActionState(returnToDraftingAction, initial);

  return (
    <form
      action={action}
      className="space-y-2"
      onSubmit={confirmOr(
        "Return this draft to drafting with your note? The editor will see it on the draft.",
      )}
    >
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <input type="hidden" name="__draftId" value={draftId} />
      <label htmlFor="return-note" className="text-sm font-medium">
        Return to drafting
      </label>
      <textarea
        id="return-note"
        name="note"
        rows={3}
        required
        placeholder="What needs to change before this can be reviewed again."
        className="border-border bg-background w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={SECONDARY}>
          {pending ? "Returning…" : "Return with this note"}
        </button>
        <span className="text-muted-foreground text-xs">
          The note is recorded and shown on the draft. Approval is not part of this step.
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}
