"use client";

import { useActionState } from "react";

import { saveRevisionAction, type DraftActionState } from "@/server/actions/content-draft";

const initial: DraftActionState = {};

export type DraftFormDefaults = {
  title: string;
  slug: string;
  excerpt: string;
  metaTitle: string;
  metaDescription: string;
  bodyMarkdown: string;
};

const INPUT =
  "border-border bg-background w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2";

function Field({
  name,
  label,
  defaultValue,
  hint,
  rows,
  required,
  mono,
}: {
  name: string;
  label: string;
  defaultValue: string;
  hint?: string;
  rows?: number;
  required?: boolean;
  mono?: boolean;
}) {
  const id = `draft-${name}`;
  const className = mono ? `${INPUT} font-mono` : INPUT;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required ? <span className="text-muted-foreground"> · required</span> : null}
      </label>
      {rows ? (
        <textarea
          id={id}
          name={name}
          rows={rows}
          defaultValue={defaultValue}
          required={required}
          className={className}
        />
      ) : (
        <input
          id={id}
          name={name}
          type="text"
          defaultValue={defaultValue}
          required={required}
          className={className}
        />
      )}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

/**
 * A person's revision of a draft (docs/P4_SPEC.md §10; M4.3). Saving never
 * edits a revision: it writes the next one, based on the current one, with
 * the change summary the editor gives. The server checks it the way it
 * checks generated text and keeps safe external links, flagged.
 */
export function DraftForm({
  websiteId,
  workItemId,
  draftId,
  defaults,
  basedOn,
}: {
  websiteId: string;
  workItemId: string;
  draftId: string;
  defaults: DraftFormDefaults;
  /** The revision number this edit starts from, or null for a first hand-written revision. */
  basedOn: number | null;
}) {
  const [state, action, pending] = useActionState(saveRevisionAction, initial);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__workItemId" value={workItemId} />
      <input type="hidden" name="__draftId" value={draftId} />

      <Field name="title" label="Title" defaultValue={defaults.title} required />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          name="slug"
          label="Slug"
          defaultValue={defaults.slug}
          mono
          hint="Lowercase words joined by hyphens. Leave empty to decide later."
        />
        <Field name="metaTitle" label="Meta title" defaultValue={defaults.metaTitle} />
      </div>
      <Field
        name="metaDescription"
        label="Meta description"
        defaultValue={defaults.metaDescription}
        rows={2}
      />
      <Field name="excerpt" label="Excerpt" defaultValue={defaults.excerpt} rows={2} />
      <Field
        name="bodyMarkdown"
        label="Body (markdown)"
        defaultValue={defaults.bodyMarkdown}
        rows={24}
        required
        mono
        hint="Safe http(s) links are kept and flagged for QA when they are not a brief target. Unsafe schemes are removed."
      />
      <Field
        name="changeSummary"
        label="What changed"
        defaultValue=""
        rows={2}
        required
        hint="One or two sentences. Recorded with the revision; a reviewer reads this first."
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Saving…" : basedOn ? `Save as revision ${basedOn + 1}` : "Save as revision 1"}
        </button>
        <span className="text-muted-foreground text-xs">
          {basedOn
            ? `A new revision based on revision ${basedOn}. Revision ${basedOn} stays as it is.`
            : "The first revision, written by hand."}
        </span>
      </div>

      {state.error ? (
        <div role="alert" className="space-y-1 text-sm text-red-600">
          <p>{state.error}</p>
          {state.issues ? (
            <ul className="list-disc pl-5 text-xs">
              {state.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
