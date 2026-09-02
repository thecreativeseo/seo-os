"use client";

import { useActionState } from "react";

import {
  addSitemapAction,
  removeSitemapAction,
  syncSitemapAction,
  type SitemapActionState,
} from "@/server/actions/sitemap";

const initial: SitemapActionState = {};

export function AddSitemapForm({ websiteId }: { websiteId: string }) {
  const [state, action, pending] = useActionState(addSitemapAction, initial);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <div className="space-y-1.5">
        <label htmlFor="sitemap-url" className="block text-sm font-medium">
          Sitemap URL
        </label>
        <input
          id="sitemap-url"
          name="url"
          required
          placeholder="https://example.com/sitemap.xml"
          className="border-border h-9 w-full max-w-lg rounded-md border px-3 text-sm"
        />
        <p className="text-muted-foreground text-xs">
          Must be on the same domain as this website.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add sitemap"}
        </button>
        {state.error ? (
          <p role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function SitemapRowActions({
  websiteId,
  sitemapId,
}: {
  websiteId: string;
  sitemapId: string;
}) {
  const [syncState, sync, syncing] = useActionState(syncSitemapAction, initial);
  const [, remove, removing] = useActionState(removeSitemapAction, initial);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <form action={sync}>
          <input type="hidden" name="__websiteId" value={websiteId} />
          <input type="hidden" name="__sitemapId" value={sitemapId} />
          <button
            type="submit"
            disabled={syncing || removing}
            className="border-border hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-xs disabled:opacity-60"
          >
            {syncing ? "Fetching…" : "Fetch now"}
          </button>
        </form>
        <form action={remove}>
          <input type="hidden" name="__websiteId" value={websiteId} />
          <input type="hidden" name="__sitemapId" value={sitemapId} />
          <button
            type="submit"
            disabled={syncing || removing}
            className="text-muted-foreground hover:text-foreground h-8 px-2 text-xs disabled:opacity-60"
          >
            {removing ? "Removing…" : "Remove"}
          </button>
        </form>
      </div>
      {syncState.message ? (
        <p aria-live="polite" className="text-muted-foreground text-xs">
          {syncState.message}
        </p>
      ) : null}
      {syncState.error ? (
        <p role="alert" className="text-xs text-red-600">
          {syncState.error}
        </p>
      ) : null}
    </div>
  );
}
