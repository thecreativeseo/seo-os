"use client";

import { useActionState, useRef, useState } from "react";

import {
  createWordPressDraftAction,
  reconcileWordPressDraftAction,
  reverifyWordPressDraftAction,
  type CmsDraftActionState,
} from "@/server/actions/cms-drafts";
import { CREATE_WORDPRESS_DRAFT, TARGET_LABELS } from "@/lib/cms/draft-ux";
import type { CmsEntityType } from "@/generated/prisma/client";

/**
 * The three controls a person acts through (M6.4 §14, §16, §19, §21).
 *
 * Create is the only one with an external side effect, and it is the only one
 * behind a confirmation. The dialog says what will happen and, just as
 * importantly, what will not: a draft is created, and nothing is published.
 *
 * The pending state exists so a person is not left wondering whether their
 * click registered. It is not the safety mechanism, and nothing here pretends
 * otherwise — pressing the button twice is safe because M6.1's idempotency and
 * M6.3's checks make it safe, not because the button greys out.
 */

const initial: CmsDraftActionState = {};

const PRIMARY =
  "bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60";
const SECONDARY =
  "border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60";
const QUIET = "text-muted-foreground hover:text-foreground h-9 px-3 text-sm disabled:opacity-60";

function Feedback({ state }: { state: CmsDraftActionState }) {
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

/**
 * "Create WordPress Draft", behind a deliberate confirmation.
 *
 * Only the targets WordPress has actually confirmed this account may create are
 * offered. When only one is available it is stated rather than chosen, because
 * a select with a single option is a question with one answer.
 */
export function CreateDraftButton({
  websiteId,
  workItemId,
  title,
  siteHost,
  targets,
}: {
  websiteId: string;
  workItemId: string;
  title: string;
  siteHost: string | null;
  targets: CmsEntityType[];
}) {
  const [state, action, pending] = useActionState(createWordPressDraftAction, initial);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  if (targets.length === 0) return null;

  const only = targets.length === 1 ? targets[0]! : null;

  return (
    <div className="space-y-2">
      {open ? (
        <div
          ref={dialog}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`create-draft-${workItemId}`}
          className="border-border bg-background max-w-lg space-y-3 rounded-lg border p-4 shadow-sm"
        >
          <h3 id={`create-draft-${workItemId}`} className="text-sm font-medium">
            Create WordPress Draft
          </h3>
          <p className="text-muted-foreground text-sm">
            This will create a new <strong className="text-foreground">draft</strong> in WordPress
            {siteHost ? ` on ${siteHost}` : ""} from the approved revision of “{title}”.{" "}
            <strong className="text-foreground">SEO OS will not publish it.</strong>
          </p>

          <form action={action} className="space-y-3">
            <input type="hidden" name="__websiteId" value={websiteId} />
            <input type="hidden" name="__workItemId" value={workItemId} />
            {/* The exact word the server compares against. A browser can send
                anything; only the server's comparison decides. */}
            <input type="hidden" name="confirmation" value={CREATE_WORDPRESS_DRAFT} />

            {only ? (
              <>
                <input type="hidden" name="targetEntityType" value={only} />
                <p className="text-sm">
                  Target: <span className="font-medium">{TARGET_LABELS[only]}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    — the only kind this WordPress account may create.
                  </span>
                </p>
              </>
            ) : (
              <div className="space-y-1.5">
                <label htmlFor={`target-${workItemId}`} className="block text-sm font-medium">
                  Create as
                </label>
                <select
                  id={`target-${workItemId}`}
                  name="targetEntityType"
                  defaultValue={targets[0]}
                  className="border-border h-9 rounded-md border px-3 text-sm"
                >
                  {targets.map((target) => (
                    <option key={target} value={target}>
                      {TARGET_LABELS[target]}
                    </option>
                  ))}
                </select>
                <p className="text-muted-foreground text-xs">
                  A post is dated editorial content; a page is a standing page. This choice is fixed
                  once the draft is created.
                </p>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button type="submit" disabled={pending} className={PRIMARY}>
                {pending ? "Creating draft…" : "Create WordPress Draft"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className={QUIET}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={PRIMARY}>
          Create WordPress Draft
        </button>
      )}

      <Feedback state={state} />
    </div>
  );
}

/**
 * "Reconcile": goes looking for a draft an uncertain attempt may have made.
 *
 * Says plainly that it searches and does not create, because the situation it
 * appears in is exactly the one where a person's instinct is to press Create
 * again.
 */
export function ReconcileDraftButton({
  websiteId,
  workItemId,
}: {
  websiteId: string;
  workItemId: string;
}) {
  const [state, action, pending] = useActionState(reconcileWordPressDraftAction, initial);

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">
        SEO OS will search WordPress for evidence of the uncertain draft. It will not create another
        draft.
      </p>
      <form action={action}>
        <input type="hidden" name="__websiteId" value={websiteId} />
        <input type="hidden" name="__workItemId" value={workItemId} />
        <button type="submit" disabled={pending} className={SECONDARY}>
          {pending ? "Searching WordPress…" : "Reconcile WordPress Draft"}
        </button>
      </form>
      <Feedback state={state} />
    </div>
  );
}

/** "Re-verify": reads the existing draft and compares. Never writes. */
export function ReverifyDraftButton({
  websiteId,
  workItemId,
}: {
  websiteId: string;
  workItemId: string;
}) {
  const [state, action, pending] = useActionState(reverifyWordPressDraftAction, initial);

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">
        SEO OS will read the existing WordPress draft and compare it with the exact approved
        revision. Nothing in WordPress is changed.
      </p>
      <form action={action}>
        <input type="hidden" name="__websiteId" value={websiteId} />
        <input type="hidden" name="__workItemId" value={workItemId} />
        <button type="submit" disabled={pending} className={SECONDARY}>
          {pending ? "Reading WordPress…" : "Re-verify WordPress Draft"}
        </button>
      </form>
      <Feedback state={state} />
    </div>
  );
}
