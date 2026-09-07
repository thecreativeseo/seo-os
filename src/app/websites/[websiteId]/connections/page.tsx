import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { PROVIDER_COUNT, listConnectionCards } from "@/server/services/connections";
import { discoverProperties } from "@/server/services/connection-auth";
import {
  CONNECTION_STATE_LABELS,
  CONNECTION_STATE_MESSAGES,
  canChooseProperty,
  needsReauthorization,
  type ConnectionState,
} from "@/lib/connections/discovery";
import { isGoogleProvider, slugForProvider } from "@/server/connectors/google/oauth";
import { Badge, PageHeader } from "@/components/governance/primitives";
import {
  ApiKeyForm,
  ConnectButton,
  DisconnectButton,
  PropertyPicker,
} from "@/components/connections/connect-controls";

export const metadata = { title: "Connections · SEO OS" };

/**
 * Data & Publishing.
 *
 * Search Console and Analytics can be connected. The others state what is
 * available and offer no connect button, because a button that did nothing — or
 * appeared to succeed — is the dishonesty CLAUDE.md rules out.
 *
 * Semrush and Ahrefs are the awkward middle case: their data does arrive, just
 * not by connecting (P2_SPEC §7 IMPORT MODE). Saying only "not connected" would
 * be true and would still send somebody away believing the product cannot read
 * their Semrush export, so those cards link to the flow that can.
 */
const ERRORS: Record<string, string> = {
  access_denied: "Authorization was cancelled, or Google refused the request.",
  missing_code: "The authorization response was incomplete.",
  invalid_state: "That authorization link is no longer valid. Start again.",
  no_refresh_token:
    "Google did not return a long-lived token. Remove SEO OS from your Google account's third-party access, then connect again.",
  exchange_failed: "The authorization could not be completed.",
  not_configured:
    "Google OAuth is not configured for this deployment yet, so connecting is unavailable.",
};

/** Providers connected by OAuth, which then require choosing a property. */
const CONNECTABLE = new Set(["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS"]);

/** Providers connected by pasting a key. */
const KEY_CONNECTABLE = new Set(["SEMRUSH", "AHREFS"]);

const KEY_HELP: Record<string, string> = {
  SEMRUSH:
    "Found under Subscription info → API units in your Semrush account. Stored encrypted, never shown again, and verified with a single-row request before it is saved. Rows are billed as API units.",
  AHREFS:
    "An API key from your Ahrefs account's API settings. Stored encrypted, never shown again, and verified with a single-row request before it is saved. Rows consume API units.",
};

export default async function ConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<{ error?: string; select?: string }>;
}) {
  const { websiteId } = await params;
  const { error, select } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);
  const cards = await listConnectionCards(context);
  const canManage = hasRole(context.membership.role, "ADMIN");

  const connected = cards.filter((card) => card.status === "CONNECTED").length;

  // Properties are fetched only for the provider being set up, so a page view does
  // not call Google for every connection.
  const selectingProvider = select && isGoogleProvider(select) ? select : null;

  let properties: { id: string; name: string }[] = [];
  /** Set only for the provider being set up, from what Google actually said. */
  let discoveryState: ConnectionState | null = null;

  // Only ask about a provider that has actually been authorized. `?select=` is
  // a query parameter, so it can name anything; discovery would throw for a
  // provider with no connection at all and take the whole page down with it.
  const selectingStatus = selectingProvider
    ? (cards.find((card) => card.provider === selectingProvider)?.status ?? "NOT_CONNECTED")
    : null;

  if (selectingProvider && canManage && selectingStatus !== "NOT_CONNECTED") {
    const discovery = await discoverProperties(context, selectingProvider);
    if (discovery.ok) {
      properties = discovery.properties;
      // Success with nothing in it is its own state. It is not a failure, and
      // telling somebody to reauthorize would send them to fix what is not broken.
      discoveryState =
        properties.length === 0 ? "NO_ACCESSIBLE_PROPERTIES" : "PROPERTY_SELECTION_REQUIRED";
    } else {
      discoveryState = discovery.code;
    }
  }

  /**
   * What is true of a Google card right now.
   *
   * A stored status alone cannot say: CONNECTING means authorized and waiting
   * for a property, and only a live lookup can tell "waiting" from "the account
   * has none" or "the API is off".
   */
  const stateOf = (status: string, isSelecting: boolean): ConnectionState => {
    if (isSelecting && discoveryState) return discoveryState;
    if (status === "NOT_CONNECTED") return "NOT_CONNECTED";
    if (status === "REAUTH_REQUIRED" || status === "ERROR") return "REAUTH_REQUIRED";
    if (status === "CONNECTED") return "READY";
    return "PROPERTY_SELECTION_REQUIRED";
  };

  return (
    <main className="space-y-8">
      <PageHeader
        title="Data & Publishing"
        description="The systems SEO OS is built to operate with. Search Console and Analytics connect directly; Semrush and Ahrefs arrive by CSV import; the rest are not available yet."
      />

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:text-red-300"
        >
          {ERRORS[error] ?? ERRORS.exchange_failed}
        </p>
      ) : null}

      <p className="text-muted-foreground text-sm">
        <span className="font-mono">
          {connected} / {PROVIDER_COUNT}
        </span>{" "}
        connected
      </p>

      <ul className="divide-border border-border divide-y rounded-lg border">
        {cards.map((card) => {
          const slug = slugForProvider(card.provider);
          const connectable = CONNECTABLE.has(card.provider);
          const keyConnectable = KEY_CONNECTABLE.has(card.provider);
          const isSelecting = selectingProvider === card.provider;
          const state = stateOf(card.status, isSelecting);

          return (
            <li key={card.provider} className="space-y-3 px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{card.name}</p>
                  <p className="text-muted-foreground text-sm">{card.purpose}</p>
                  {connectable && card.status === "CONNECTED" ? (
                    <p className="text-muted-foreground mt-1 font-mono text-xs">
                      Property selected
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-muted-foreground text-xs">{card.availability}</span>
                  <Badge>{connectable ? CONNECTION_STATE_LABELS[state] : card.status}</Badge>
                </div>
              </div>

              {connectable && canManage && slug ? (
                <div className="space-y-3">
                  {card.status === "NOT_CONNECTED" ? (
                    <ConnectButton
                      websiteId={websiteId}
                      slug={slug}
                      label={`Connect ${card.name}`}
                    />
                  ) : null}

                  {card.status !== "NOT_CONNECTED" ? (
                    <p
                      role={needsReauthorization(state) ? "alert" : undefined}
                      className={
                        needsReauthorization(state) || state === "API_NOT_ENABLED"
                          ? "text-sm text-red-600"
                          : "text-muted-foreground text-sm"
                      }
                    >
                      {CONNECTION_STATE_MESSAGES[state]}
                    </p>
                  ) : null}

                  {/* The way back into selection. Without it a connection that
                      left the callback redirect was stranded: authorized, told to
                      choose a property, and given nothing to choose with. */}
                  {!isSelecting && canChooseProperty(state) ? (
                    <Link
                      href={`/websites/${websiteId}/connections?select=${card.provider}`}
                      className="border-border inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
                    >
                      {state === "READY" ? "Change property" : "Choose property"}
                    </Link>
                  ) : null}

                  {isSelecting && properties.length > 0 ? (
                    <PropertyPicker
                      websiteId={websiteId}
                      slug={slug}
                      properties={properties}
                      selectedId={null}
                    />
                  ) : null}

                  {card.status !== "NOT_CONNECTED" ? (
                    <DisconnectButton websiteId={websiteId} slug={slug} />
                  ) : null}
                </div>
              ) : null}

              {keyConnectable && canManage ? (
                <div className="space-y-3">
                  <ApiKeyForm
                    websiteId={websiteId}
                    provider={card.provider}
                    providerName={card.name}
                    connected={card.status === "CONNECTED"}
                    helpText={KEY_HELP[card.provider] ?? ""}
                  />

                  {card.status !== "NOT_CONNECTED" ? (
                    <DisconnectButton websiteId={websiteId} slug={card.provider} />
                  ) : null}
                </div>
              ) : null}

              {(connectable || keyConnectable) && !canManage ? (
                <p className="text-muted-foreground text-sm">
                  An owner or admin connects data sources.
                </p>
              ) : null}

              {card.alternative ? (
                <p className="text-sm">
                  <Link
                    href={card.alternative.href(websiteId)}
                    className="underline underline-offset-4"
                  >
                    {card.alternative.label}
                  </Link>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <section className="border-border space-y-2 rounded-lg border border-dashed p-5">
        <h2 className="text-sm font-medium">How connections work</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Signing in with Google proves who you are. Connecting Search Console or Analytics is a
          separate authorization, asking only for read access, and it is attached to the property
          you choose rather than to your account as a whole.
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed">
          The long-lived token is encrypted before it is stored and is never returned by any page.
          Data already collected stays if a connection is removed, because it was really measured.
        </p>
      </section>
    </main>
  );
}
