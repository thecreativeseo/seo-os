"use client";

import { useActionState } from "react";

import {
  connectApiKeyAction,
  disconnectProviderAction,
  selectPropertyAction,
  type ConnectionActionState,
} from "@/server/actions/connections";

const initial: ConnectionActionState = {};

/**
 * Entering a vendor API key.
 *
 * `type="password"` and `autoComplete="off"` because this is a bearer secret with
 * account-wide access, and a browser that remembered it or a shoulder that read
 * it are both real. The field is never populated back from the server: once
 * stored, the key is write-only as far as the interface is concerned, and the
 * only offered operation is replacing it.
 */
export function ApiKeyForm({
  websiteId,
  provider,
  providerName,
  connected,
  helpText,
}: {
  websiteId: string;
  provider: string;
  providerName: string;
  connected: boolean;
  helpText: string;
}) {
  const [state, action, pending] = useActionState(connectApiKeyAction, initial);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__provider" value={provider} />

      <div className="space-y-1.5">
        <label htmlFor={`api-key-${provider}`} className="block text-sm font-medium">
          {connected ? `Replace ${providerName} API key` : `${providerName} API key`}
        </label>
        <input
          id={`api-key-${provider}`}
          name="apiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder={connected ? "Stored — enter a new key to replace" : "Paste the API key"}
          className="border-border h-9 w-full max-w-md rounded-md border px-3 font-mono text-sm"
        />
        <p className="text-muted-foreground text-xs">{helpText}</p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Verifying…" : connected ? "Replace key" : `Connect ${providerName}`}
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

/**
 * Starting an authorization is a plain form POST to a route handler, not a Server
 * Action, because the response is a redirect to Google rather than a state update.
 */
export function ConnectButton({
  websiteId,
  slug,
  label,
}: {
  websiteId: string;
  slug: string;
  label: string;
}) {
  return (
    <form method="post" action={`/api/connections/${slug}/start`}>
      <input type="hidden" name="websiteId" value={websiteId} />
      <button
        type="submit"
        className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
      >
        {label}
      </button>
    </form>
  );
}

/**
 * Property selection.
 *
 * A separate, explicit step: authorising an account is not choosing which property
 * SEO OS reads, and guessing would attach a website to the wrong data.
 */
export function PropertyPicker({
  websiteId,
  slug,
  properties,
  selectedId,
}: {
  websiteId: string;
  slug: string;
  properties: { id: string; name: string }[];
  selectedId: string | null;
}) {
  const [state, action, pending] = useActionState(selectPropertyAction, initial);

  if (properties.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        This Google account has no readable properties. Check that the account has
        access, then reconnect.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__provider" value={slug} />

      <div className="space-y-1.5">
        <label htmlFor={`property-${slug}`} className="block text-sm font-medium">
          Property
        </label>
        <select
          id={`property-${slug}`}
          name="propertyId"
          defaultValue={selectedId ?? ""}
          className="border-border h-9 w-full max-w-md rounded-md border px-3 text-sm"
        >
          <option value="">Choose a property</option>
          {properties.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground text-xs">
          SEO OS reads data only from the property you choose here.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Saving…" : "Use this property"}
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

export function DisconnectButton({
  websiteId,
  slug,
}: {
  websiteId: string;
  slug: string;
}) {
  const [state, action, pending] = useActionState(disconnectProviderAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="__websiteId" value={websiteId} />
      <input type="hidden" name="__provider" value={slug} />
      <button
        type="submit"
        disabled={pending}
        className="text-muted-foreground hover:text-foreground inline-flex h-8 items-center rounded-md px-2 text-xs disabled:opacity-60"
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </button>
      <p className="text-muted-foreground text-xs">
        Removes the stored credential. Data already collected is kept, because it was
        really measured.
      </p>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
