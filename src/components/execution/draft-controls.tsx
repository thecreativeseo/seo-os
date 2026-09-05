"use client";

import { useActionState } from "react";

import {
  approveDraftAction,
  generateRevisionAction,
  reopenDraftAction,
  requestReviewAction,
  returnToDraftingAction,
  startDraftAction,
  startFromBriefAction,
  type DraftActionState,
} from "@/server/actions/content-draft";
import { shortHash } from "@/lib/content/draft-ux";

const initial: DraftActionState = {};

const PRIMARY =
  "bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60";
const SECONDARY =
  "border-border inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium disabled:opacity-60";
const TEXTAREA =
  "border-border bg-background w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2";

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
    state.code === "brief_superseded" ||
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
        "Request editorial review of the current revision? An SEO lead, admin or owner will approve exactly this revision, or return it with a note.",
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
            : "Pins the current revision for an editor. Warnings are shown to them, not hidden."}
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
        className={TEXTAREA}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={SECONDARY}>
          {pending ? "Returning…" : "Return with this note"}
        </button>
        <span className="text-muted-foreground text-xs">
          The note is recorded on the review and shown on the draft.
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/**
 * Approves exactly the requested revision (M4.5). The form says which
 * revision and hash it will pin, takes an optional note, and - when a newer
 * brief has been approved meanwhile - requires the reviewer to acknowledge
 * it. Disabled with the authoritative reason when the server would refuse.
 */
export function ApproveDraftForm({
  websiteId,
  workItemId,
  draftId,
  revisionNumber,
  revisionHash,
  disabled,
  reason,
  needsBriefAcknowledgement,
  briefVersion,
  approvedBriefVersion,
}: {
  websiteId: string;
  workItemId: string;
  draftId: string;
  revisionNumber: number;
  revisionHash: string;
  disabled: boolean;
  reason?: string | null;
  needsBriefAcknowledgement: boolean;
  briefVersion: number;
  approvedBriefVersion?: number | null;
}) {
  const [state, action, pending] = useActionState(approveDraftAction, initial);

  return (
    <form
      action={action}
      className="border-border space-y-3 rounded-lg border p-3"
      onSubmit={confirmOr(
        `Approve revision ${revisionNumber} (${shortHash(revisionHash)}) exactly as it is? The work item becomes ready for QA, and nothing edits this draft until a person reopens it.`,
      )}
    >
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <input type="hidden" name="__draftId" value={draftId} />
      <div>
        <p className="text-sm font-medium">Approve revision {revisionNumber}</p>
        <p className="text-muted-foreground text-xs">
          Exactly this revision, <span className="font-mono">{shortHash(revisionHash)}</span>,
          written to Brief v{briefVersion}. A later revision will need a new review.
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor="approve-note" className="text-sm font-medium">
          Approval note <span className="text-muted-foreground font-normal">· optional</span>
        </label>
        <textarea
          id="approve-note"
          name="note"
          rows={2}
          placeholder="Anything QA or the editor should know."
          className={TEXTAREA}
          disabled={disabled}
        />
      </div>
      {needsBriefAcknowledgement ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="acknowledgeBriefMismatch"
            required
            disabled={disabled}
            className="mt-1"
          />
          <span>
            I have read Brief v{approvedBriefVersion ?? "?"}, the newer approved version, and I
            approve this draft against Brief v{briefVersion} anyway. This is recorded with the
            approval.
          </span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || disabled}
          aria-disabled={disabled}
          className={PRIMARY}
        >
          {pending ? "Approving…" : `Approve revision ${revisionNumber}`}
        </button>
        <span className="text-muted-foreground text-xs">
          {disabled
            ? (reason ?? "Not available.")
            : "Sets the standing approval and hands the work item to QA. QA itself runs in a later milestone."}
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/**
 * Reopens an approved draft for revision (M4.5). A reason is required; the
 * approval stays in history and is marked no longer current.
 */
export function ReopenDraftForm({
  websiteId,
  workItemId,
  draftId,
  approvedRevisionNumber,
}: {
  websiteId: string;
  workItemId: string;
  draftId: string;
  approvedRevisionNumber: number | null;
}) {
  const [state, action, pending] = useActionState(reopenDraftAction, initial);

  return (
    <form
      action={action}
      className="space-y-2"
      onSubmit={confirmOr(
        `Reopen this draft for revision? The approval of revision ${approvedRevisionNumber ?? "?"} will no longer be current, the work item goes back to drafting, and Edit and Generate become available again. The approval stays in history.`,
      )}
    >
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <input type="hidden" name="__draftId" value={draftId} />
      <label htmlFor="reopen-reason" className="text-sm font-medium">
        Reopen for revision
      </label>
      <textarea
        id="reopen-reason"
        name="reason"
        rows={2}
        required
        placeholder="Why the approved draft needs to change."
        className={TEXTAREA}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={SECONDARY}>
          {pending ? "Reopening…" : "Reopen with this reason"}
        </button>
        <span className="text-muted-foreground text-xs">
          Makes Edit and Generate available again. The standing approval becomes no longer current;
          it stays in history with the reason.
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}
