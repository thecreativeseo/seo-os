"use client";

import { useActionState } from "react";

import {
  cancelImportAction,
  commitImportAction,
  revalidateImportAction,
  uploadImportAction,
  type ImportActionState,
} from "@/server/actions/import";

const initial: ImportActionState = {};

export function UploadImportForm({ websiteId }: { websiteId: string }) {
  const [state, action, pending] = useActionState(uploadImportAction, initial);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="__websiteId" value={websiteId} />

      <div className="space-y-1.5">
        <label htmlFor="import-file" className="block text-sm font-medium">
          CSV file
        </label>
        <input
          id="import-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          required
          className="border-border w-full max-w-lg rounded-md border px-3 py-2 text-sm"
        />
        <p className="text-muted-foreground text-xs">
          A Semrush export, up to 5 MB. Nothing is written until you have seen the
          preview.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 sm:max-w-lg">
        <div className="space-y-1.5">
          <label htmlFor="import-source" className="block text-sm font-medium">
            Format
          </label>
          <select
            id="import-source"
            name="source"
            defaultValue=""
            className="border-border h-9 w-full rounded-md border px-2 text-sm"
          >
            {/* Detection is a suggestion. Reading a competitor export as our own
                positions would attribute their rankings to us, and reading an
                Ahrefs file as Semrush would attribute their difficulty score to a
                scale it was not computed on. Both stay overridable. */}
            <option value="">Detect from the column headings</option>
            <optgroup label="Semrush">
              <option value="SEMRUSH_POSITIONS">Organic positions</option>
              <option value="SEMRUSH_KEYWORD_OVERVIEW">Keyword overview</option>
              <option value="SEMRUSH_COMPETITORS">Competitor positions</option>
            </optgroup>
            <optgroup label="Ahrefs">
              <option value="AHREFS_POSITIONS">Organic keywords</option>
              <option value="AHREFS_KEYWORD_OVERVIEW">Keywords explorer</option>
              <option value="AHREFS_COMPETITORS">Competitor keywords</option>
            </optgroup>
            <option value="MANUAL_CSV">Keyword list (no provider metrics)</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="import-date" className="block text-sm font-medium">
            Captured on
          </label>
          <input
            id="import-date"
            name="capturedAt"
            type="date"
            className="border-border h-9 w-full rounded-md border px-2 text-sm"
          />
          <p className="text-muted-foreground text-xs">
            Used only for rows with no date of their own.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60"
        >
          {pending ? "Reading…" : "Upload and preview"}
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

export function CommitImportControls({
  websiteId,
  importId,
  canCommit,
}: {
  websiteId: string;
  importId: string;
  canCommit: boolean;
}) {
  const [commitState, commit, committing] = useActionState(commitImportAction, initial);
  const [, revalidate, revalidating] = useActionState(revalidateImportAction, initial);
  const [, cancel, cancelling] = useActionState(cancelImportAction, initial);

  const busy = committing || revalidating || cancelling;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <form action={commit}>
          <input type="hidden" name="__websiteId" value={websiteId} />
          <input type="hidden" name="__importId" value={importId} />
          <button
            type="submit"
            disabled={busy || !canCommit}
            className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm disabled:opacity-50"
          >
            {committing ? "Committing…" : "Commit valid rows"}
          </button>
        </form>

        <form action={revalidate}>
          <input type="hidden" name="__websiteId" value={websiteId} />
          <input type="hidden" name="__importId" value={importId} />
          <button
            type="submit"
            disabled={busy}
            className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-3 text-sm disabled:opacity-60"
          >
            {revalidating ? "Checking…" : "Re-check rows"}
          </button>
        </form>

        <form action={cancel}>
          <input type="hidden" name="__websiteId" value={websiteId} />
          <input type="hidden" name="__importId" value={importId} />
          <button
            type="submit"
            disabled={busy}
            className="text-muted-foreground hover:text-foreground h-9 px-2 text-sm disabled:opacity-60"
          >
            {cancelling ? "Discarding…" : "Discard"}
          </button>
        </form>
      </div>

      {commitState.message ? (
        <p aria-live="polite" className="text-sm">
          {commitState.message}
        </p>
      ) : null}
      {commitState.error ? (
        <p role="alert" className="text-sm text-red-600">
          {commitState.error}
        </p>
      ) : null}
    </div>
  );
}
