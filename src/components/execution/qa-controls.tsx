"use client";

import { useActionState } from "react";

import {
  approveForCmsAction,
  returnForRevisionAction,
  runQaAction,
  type QaActionState,
} from "@/server/actions/content-qa";
import { shortHash } from "@/lib/content/draft-ux";

/**
 * The three acts at the QA gate (M5.4 §10, §11, §15). Each says exactly what
 * it will do to which revision before it does it, asks once, and reports
 * failure in our own words. What is shown here is convenience: the server
 * decides.
 */

const initial: QaActionState = {};

const PRIMARY =
  "bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60";
const SECONDARY =
  "border-border inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium disabled:opacity-60";
const TEXTAREA =
  "border-border bg-background w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2";

function confirmOr(message: string) {
  return (event: React.FormEvent<HTMLFormElement>) => {
    if (typeof window !== "undefined" && !window.confirm(message)) event.preventDefault();
  };
}

function Feedback({ state }: { state: QaActionState }) {
  if (!state.error) return null;
  const soft =
    state.code === "in_progress" ||
    state.code === "qa_stale" ||
    state.code === "qa_required" ||
    state.code === "brief_superseded" ||
    state.code === "not_checked_unacknowledged" ||
    state.code === "generation_failed";
  return (
    <p
      role="alert"
      className={`text-sm ${soft ? "text-amber-700 dark:text-amber-400" : "text-red-600"}`}
    >
      {state.error}
    </p>
  );
}

/** Runs QA over the approved revision. Says which one, and that nothing is edited. */
export function RunQaButton({
  websiteId,
  workItemId,
  label,
  revisionNumber,
  revisionHash,
  disabled,
  reason,
}: {
  websiteId: string;
  workItemId: string;
  label: "Run QA" | "Re-run QA";
  revisionNumber: number | null;
  revisionHash: string | null;
  disabled?: boolean;
  reason?: string | null;
}) {
  const [state, action, pending] = useActionState(runQaAction, initial);
  const target =
    revisionNumber !== null && revisionHash
      ? `revision ${revisionNumber} (${shortHash(revisionHash)})`
      : "the approved revision";

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || disabled}
          aria-disabled={disabled ? "true" : undefined}
          className={PRIMARY}
        >
          {pending ? "Running QA…" : label}
        </button>
        <span className="text-muted-foreground text-xs">
          {pending
            ? `Checking ${target}. This can take a moment.`
            : `Checks ${target}. QA reads the content; it never edits it.`}
        </span>
      </div>
      {reason ? <p className="text-muted-foreground text-xs">{reason}</p> : null}
      <Feedback state={state} />
    </form>
  );
}

/** The final human gate. Everything being approved is named on the form. */
export function ApproveForCmsForm({
  websiteId,
  workItemId,
  revisionNumber,
  revisionHash,
  runId,
  outcome,
  blockingCount,
  warningCount,
  notCheckedCount,
  briefVersion,
  approvedBriefVersion,
  needsNotCheckedAcknowledgement,
  needsBriefAcknowledgement,
  needsConfirmation,
  disabled,
  reason,
}: {
  websiteId: string;
  workItemId: string;
  revisionNumber: number;
  revisionHash: string;
  runId: string;
  outcome: string;
  blockingCount: number;
  warningCount: number;
  notCheckedCount: number;
  briefVersion: number;
  approvedBriefVersion?: number | null;
  needsNotCheckedAcknowledgement: boolean;
  needsBriefAcknowledgement: boolean;
  needsConfirmation: { label: string; count: number };
  disabled?: boolean;
  reason?: string | null;
}) {
  const [state, action, pending] = useActionState(approveForCmsAction, initial);

  return (
    <form
      action={action}
      className="border-border space-y-3 rounded-lg border p-4"
      onSubmit={confirmOr(
        `Approve revision ${revisionNumber} (${shortHash(revisionHash)}) for the CMS? Nothing is published; the work becomes approved for CMS and a person can take it further later.`,
      )}
    >
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />

      <div className="space-y-1">
        <h3 className="text-sm font-medium">You are approving</h3>
        <dl className="text-muted-foreground grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-2">
            <dt>Revision</dt>
            <dd className="text-foreground font-medium">
              {revisionNumber} · <span className="font-mono">{shortHash(revisionHash)}</span>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt>Brief</dt>
            <dd className="text-foreground font-medium">v{briefVersion}</dd>
          </div>
          <div className="flex gap-2">
            <dt>QA run</dt>
            <dd className="text-foreground font-mono">{runId.slice(0, 8)}…</dd>
          </div>
          <div className="flex gap-2">
            <dt>Outcome</dt>
            <dd className="text-foreground font-medium">{outcome}</dd>
          </div>
          <div className="flex gap-2">
            <dt>Blocking</dt>
            <dd className="text-foreground font-medium">{blockingCount}</dd>
          </div>
          <div className="flex gap-2">
            <dt>Warnings</dt>
            <dd className="text-foreground font-medium">{warningCount}</dd>
          </div>
          <div className="flex gap-2">
            <dt>Not checked</dt>
            <dd className="text-foreground font-medium">{notCheckedCount}</dd>
          </div>
        </dl>
      </div>

      {needsConfirmation.count > 0 ? (
        <p className="border-border rounded-md border border-dashed p-2 text-xs">
          <span className="font-medium">{needsConfirmation.count}</span> {needsConfirmation.label}{" "}
          Read them above before approving; approving records that you accepted them.
        </p>
      ) : null}

      <div className="space-y-1">
        <label htmlFor="cms-note" className="text-sm font-medium">
          Approval note <span className="text-muted-foreground font-normal">· optional</span>
        </label>
        <textarea
          id="cms-note"
          name="note"
          rows={2}
          placeholder="Anything the next person should know."
          className={TEXTAREA}
          disabled={disabled}
        />
      </div>

      {needsNotCheckedAcknowledgement ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="acknowledgeNotChecked"
            required
            disabled={disabled}
            className="mt-1"
          />
          <span>I acknowledge the QA checks that were not completed.</span>
        </label>
      ) : null}

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
            approve this revision against Brief v{briefVersion} anyway. This is recorded with the
            approval.
          </span>
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || disabled}
          aria-disabled={disabled ? "true" : undefined}
          className={PRIMARY}
        >
          {pending ? "Approving…" : "Approve for CMS"}
        </button>
        <span className="text-muted-foreground text-xs">
          Nothing is published. No CMS action is performed.
        </span>
      </div>
      {reason ? <p className="text-muted-foreground text-xs">{reason}</p> : null}
      <Feedback state={state} />
    </form>
  );
}

/** Sends the work back for revision, and says what that costs. */
export function ReturnForRevisionForm({
  websiteId,
  workItemId,
  draftId,
  revisionNumber,
  hasApproval,
}: {
  websiteId: string;
  workItemId: string;
  draftId: string;
  revisionNumber: number | null;
  hasApproval: boolean;
}) {
  const [state, action, pending] = useActionState(returnForRevisionAction, initial);

  return (
    <form
      action={action}
      className="border-border space-y-3 rounded-lg border p-4"
      onSubmit={confirmOr(
        hasApproval
          ? "Return this work for revision? The CMS approval is invalidated with your reason, the draft reopens, and a new revision will need its own QA and approval."
          : "Return this work for revision? The draft reopens and a new revision will need its own QA before it can be approved.",
      )}
    >
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <input type="hidden" name="__draftId" value={draftId} />
      <div>
        <h3 className="text-sm font-medium">Return for revision</h3>
        <p className="text-muted-foreground text-xs">
          {hasApproval
            ? "The CMS approval is invalidated with your reason and kept as history."
            : "The draft reopens for editing."}{" "}
          Revision {revisionNumber ?? "—"} and every QA run stay exactly as they are. A new revision
          needs its own QA and approval before execution.
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor="return-reason" className="text-sm font-medium">
          Why <span className="text-muted-foreground font-normal">· required</span>
        </label>
        <textarea
          id="return-reason"
          name="reason"
          rows={2}
          required
          placeholder="What has to change, in a sentence."
          className={TEXTAREA}
        />
      </div>
      <button type="submit" disabled={pending} className={SECONDARY}>
        {pending ? "Returning…" : "Return for revision"}
      </button>
      <Feedback state={state} />
    </form>
  );
}
