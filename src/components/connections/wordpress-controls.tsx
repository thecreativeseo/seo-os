"use client";

import { useActionState } from "react";

import {
  configureWordPressAction,
  testWordPressConnectionAction,
  type CmsConnectionActionState,
} from "@/server/actions/cms-drafts";

/**
 * Configuring and testing the WordPress connection (M6.4 §4, §6, §9).
 *
 * The application password is a password field, is never given a value, and is
 * never returned by the action that receives it. After it has been stored the
 * form does not show it, does not hint at its length and does not pre-fill it —
 * replacing it means typing a new one. The placeholder says it is stored, which
 * is the only thing about it a person needs to see.
 */

const initial: CmsConnectionActionState = {};

const PRIMARY =
  "bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60";
const SECONDARY =
  "border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm disabled:opacity-60";

function Feedback({ state }: { state: CmsConnectionActionState }) {
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

export function WordPressConnectionForm({
  websiteId,
  baseUrl,
  credentialConfigured,
}: {
  websiteId: string;
  baseUrl: string | null;
  credentialConfigured: boolean;
}) {
  const [state, action, pending] = useActionState(configureWordPressAction, initial);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="__websiteId" value={websiteId} />

      <div className="space-y-1.5">
        <label htmlFor="wp-base-url" className="block text-sm font-medium">
          WordPress site address
        </label>
        <input
          id="wp-base-url"
          name="baseUrl"
          type="url"
          inputMode="url"
          required
          spellCheck={false}
          defaultValue={baseUrl ?? ""}
          placeholder="https://example.com"
          className="border-border h-9 w-full max-w-md rounded-md border px-3 text-sm"
        />
        <p className="text-muted-foreground text-xs">
          Use the HTTPS base URL of the WordPress site — <code>https://example.com</code>, not a
          REST endpoint such as <code>https://example.com/wp-json/…</code>.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="wp-username" className="block text-sm font-medium">
          WordPress username
        </label>
        <input
          id="wp-username"
          name="username"
          type="text"
          autoComplete="username"
          required
          spellCheck={false}
          className="border-border h-9 w-full max-w-md rounded-md border px-3 text-sm"
        />
        <p className="text-muted-foreground text-xs">
          The username the application password belongs to. It is stored with the password,
          encrypted, so it is entered again whenever credentials are replaced rather than read back
          to fill this in.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="wp-application-password" className="block text-sm font-medium">
          {credentialConfigured ? "Replace application password" : "Application password"}
        </label>
        <input
          id="wp-application-password"
          name="applicationPassword"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          required
          // Never given a value, and never pre-filled after saving.
          placeholder={
            credentialConfigured
              ? "Stored — enter a new one to replace it"
              : "xxxx xxxx xxxx xxxx xxxx xxxx"
          }
          className="border-border h-9 w-full max-w-md rounded-md border px-3 font-mono text-sm"
        />
        <p className="text-muted-foreground text-xs">
          Create one in WordPress under Users → Profile → Application Passwords. Stored encrypted
          and never shown again. SEO OS creates drafts only; it cannot publish.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? "Saving…" : credentialConfigured ? "Replace credentials" : "Save connection"}
        </button>
      </div>

      <Feedback state={state} />
    </form>
  );
}

/**
 * "Test connection": one read of the WordPress REST API.
 *
 * It proves the site answers, the credentials are accepted and what the account
 * is permitted to do. It creates nothing — a capability that cannot be
 * confirmed without writing something is recorded as not granted instead.
 */
export function TestWordPressButton({ websiteId }: { websiteId: string }) {
  const [state, action, pending] = useActionState(testWordPressConnectionAction, initial);

  return (
    <div className="space-y-2">
      <form action={action}>
        <input type="hidden" name="__websiteId" value={websiteId} />
        <button type="submit" disabled={pending} className={SECONDARY}>
          {pending ? "Testing…" : "Test connection"}
        </button>
      </form>
      <Feedback state={state} />
    </div>
  );
}
