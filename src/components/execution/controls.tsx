"use client";

import Link from "next/link";
import { useActionState } from "react";

import { startContentWorkAction, type ContentWorkActionState } from "@/server/actions/content-work";

const initial: ContentWorkActionState = {};

/**
 * The explicit act (docs/P4_SPEC.md §5, D1): a person chooses to start work
 * on an approved recommendation. On success the action redirects to the new
 * work item; every refusal is a sentence from the service, in our words.
 */
export function StartContentWorkButton({
  websiteId,
  recommendationId,
  compact = false,
}: {
  websiteId: string;
  recommendationId: string;
  compact?: boolean;
}) {
  const [state, action, pending] = useActionState(startContentWorkAction, initial);

  return (
    <form action={action} className={compact ? "space-y-1" : "space-y-2"}>
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__recommendationId" value={recommendationId} />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className={
            compact
              ? "border-border hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium disabled:opacity-60"
              : "bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
          }
        >
          {pending ? "Starting…" : "Start content work"}
        </button>
        {!compact ? (
          <span className="text-muted-foreground text-xs">
            Creates a work item in the Content Work Queue. Nothing is written or published yet.
          </span>
        ) : null}
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
          {state.existingItemId ? (
            <>
              {" "}
              <Link
                href={`/websites/${websiteId}/content/${state.existingItemId}`}
                className="underline"
              >
                Open it
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
