"use client";

import { useActionState } from "react";

import {
  approveBriefAction,
  archiveBriefAction,
  generateBriefAction,
  requestBriefReviewAction,
  type BriefActionState,
} from "@/server/actions/content-brief";

const initial: BriefActionState = {};

const PRIMARY =
  "bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60";
const SECONDARY =
  "border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60";

function Feedback({ state }: { state: BriefActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return <span className="text-muted-foreground text-xs">{state.message}</span>;
  }
  return null;
}

/**
 * "Generate brief": runs the content brief agent over a fresh, sealed
 * package and creates the next version as a draft (docs/P4_SPEC.md §7, §8).
 * Synchronous in this milestone, so the button says how long it takes.
 */
export function GenerateBriefButton({
  websiteId,
  workItemId,
  label = "Generate brief",
}: {
  websiteId: string;
  workItemId: string;
  label?: string;
}) {
  const [state, action, pending] = useActionState(generateBriefAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? "Generating… this can take a minute" : label}
        </button>
        <span className="text-muted-foreground text-xs">
          Reads the approved context, facts, rules and the work item&rsquo;s evidence. Creates a
          draft version for a person to review.
        </span>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function RequestBriefReviewButton({
  websiteId,
  briefId,
}: {
  websiteId: string;
  briefId: string;
}) {
  const [state, action, pending] = useActionState(requestBriefReviewAction, initial);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__briefId" value={briefId} />
      <button type="submit" disabled={pending} className={SECONDARY}>
        {pending ? "Requesting…" : "Request review"}
      </button>
      <Feedback state={state} />
    </form>
  );
}

/** The human gate on a brief (§7). SEO lead and above; the service checks again. */
export function ApproveBriefButton({ websiteId, briefId }: { websiteId: string; briefId: string }) {
  const [state, action, pending] = useActionState(approveBriefAction, initial);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__briefId" value={briefId} />
      <button type="submit" disabled={pending} className={PRIMARY}>
        {pending ? "Approving…" : "Approve brief"}
      </button>
      <span className="text-muted-foreground text-xs">
        Freezes this version. Any earlier approved version is superseded.
      </span>
      <Feedback state={state} />
    </form>
  );
}

export function ArchiveBriefButton({ websiteId, briefId }: { websiteId: string; briefId: string }) {
  const [state, action, pending] = useActionState(archiveBriefAction, initial);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__briefId" value={briefId} />
      <button type="submit" disabled={pending} className={SECONDARY}>
        {pending ? "Archiving…" : "Archive this version"}
      </button>
      <Feedback state={state} />
    </form>
  );
}
