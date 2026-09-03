"use client";

import { useActionState, useState } from "react";

import {
  capturePageContentAction,
  fetchPageContentAction,
  type PageContentActionState,
} from "@/server/actions/page-content";

const initial: PageContentActionState = {};

/**
 * Capturing what a page says (docs/P3_SPEC.md §28).
 *
 * Paste is offered first and fetch second, because paste always works: a page
 * behind a login, on staging, or not yet published cannot be fetched, and those
 * are the pages a team most often wants to reason about.
 */
export function CaptureControls({
  websiteId,
  pageId,
  pageUrl,
}: {
  websiteId: string;
  pageId: string;
  pageUrl: string;
}) {
  const [captureState, capture, capturing] = useActionState(capturePageContentAction, initial);
  const [fetchState, fetchNow, fetching] = useActionState(fetchPageContentAction, initial);
  const [open, setOpen] = useState(false);

  const busy = capturing || fetching;

  return (
    <div className="border-border space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={busy}
          className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
        >
          {open ? "Close" : "Paste or upload content"}
        </button>

        <form action={fetchNow}>
          <input type="hidden" name="__websiteId" value={websiteId} />
          <input type="hidden" name="__pageId" value={pageId} />
          <button
            type="submit"
            disabled={busy}
            className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
          >
            {fetching ? "Fetching…" : "Fetch this URL"}
          </button>
        </form>

        <p className="text-muted-foreground text-xs">
          Reads only <span className="font-mono break-all">{pageUrl}</span>. No other page
          is requested.
        </p>
      </div>

      {open ? (
        <form action={capture} className="space-y-3">
          <input type="hidden" name="__websiteId" value={websiteId} />
          <input type="hidden" name="__pageId" value={pageId} />

          <div className="space-y-1.5">
            <label htmlFor="page-content" className="block text-sm font-medium">
              Page content
            </label>
            <textarea
              id="page-content"
              name="content"
              rows={8}
              placeholder="Paste the page's HTML or its text."
              className="border-border w-full rounded-md border px-3 py-2 font-mono text-xs"
            />
            <p className="text-muted-foreground text-xs">
              HTML or plain text. Scripts, styles and comments are discarded; only the
              readable text is stored.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="page-file" className="block text-sm font-medium">
              Or upload a file
            </label>
            <input
              id="page-file"
              name="file"
              type="file"
              accept=".html,.htm,.txt,.md,text/html,text/plain"
              className="text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
          >
            {capturing ? "Capturing…" : "Capture content"}
          </button>
        </form>
      ) : null}

      <Feedback state={captureState} />
      <Feedback state={fetchState} />
    </div>
  );
}

function Feedback({ state }: { state: PageContentActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {state.error}
      </p>
    );
  }

  if (state.message) {
    return (
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {state.message}
      </p>
    );
  }

  return null;
}
