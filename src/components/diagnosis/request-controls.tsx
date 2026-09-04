"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  cancelDiagnosisRequestAction,
  type DiagnosisActionState,
} from "@/server/actions/diagnosis";

const initial: DiagnosisActionState = {};

/**
 * Keeps a request's page current while a worker has it.
 *
 * Nothing clever: the page is server-rendered from the request row, so
 * refreshing it every few seconds is the whole mechanism. It stops on its own
 * after a while, because a tab left open overnight should not poll all night.
 */
export function RequestPoller({
  intervalMs = 3000,
  maxMs = 15 * 60 * 1000,
}: {
  intervalMs?: number;
  maxMs?: number;
}) {
  const router = useRouter();
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      if (Date.now() - startedAt > maxMs) {
        clearInterval(timer);
        setStopped(true);
        return;
      }
      router.refresh();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [router, intervalMs, maxMs]);

  return (
    <span className="text-muted-foreground text-xs">
      {stopped ? "Stopped checking. Reload to see the latest." : "Checking every few seconds…"}
    </span>
  );
}

/** Withdraws a request that has not finished (section 14). Same bar as asking. */
export function CancelRequestButton({
  websiteId,
  requestId,
}: {
  websiteId: string;
  requestId: string;
}) {
  const [state, action, pending] = useActionState(cancelDiagnosisRequestAction, initial);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__requestId" value={requestId} />
      <button
        type="submit"
        disabled={pending}
        className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
      >
        {pending ? "Cancelling…" : "Cancel this request"}
      </button>
      {state.message ? (
        <span className="text-muted-foreground text-xs">{state.message}</span>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
