import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { PROVIDER_COUNT, listConnectionCards } from "@/server/services/connections";
import { listAvailableProperties } from "@/server/services/connection-auth";
import { isGoogleProvider, slugForProvider } from "@/server/connectors/google/oauth";
import { Badge, PageHeader } from "@/components/governance/primitives";
import {
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

const CONNECTABLE = new Set(["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS"]);

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
  let propertyError: string | null = null;

  if (selectingProvider && canManage) {
    try {
      properties = await listAvailableProperties(context, selectingProvider);
    } catch {
      propertyError =
        "Could not read the list of properties. The authorization may need to be repeated.";
    }
  }

  return (
    <main className="space-y-8">
      <PageHeader
        title="Data & Publishing"
        description="The systems SEO OS is built to operate with. Search Console and Analytics connect directly; Semrush and Ahrefs arrive by CSV import; the rest are not available yet."
      />

      {error ? (
        <p role="alert" className="rounded-lg border border-red-300 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:text-red-300">
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
          const isSelecting = selectingProvider === card.provider;

          return (
            <li key={card.provider} className="space-y-3 px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{card.name}</p>
                  <p className="text-muted-foreground text-sm">{card.purpose}</p>
                  {card.status === "CONNECTED" ? (
                    <p className="text-muted-foreground mt-1 font-mono text-xs">
                      {card.hasCredentialReference || connectable
                        ? "Property selected"
                        : null}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-muted-foreground text-xs">{card.availability}</span>
                  <Badge>{card.status}</Badge>
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

                  {card.status === "CONNECTING" && !isSelecting ? (
                    <p className="text-muted-foreground text-sm">
                      Authorised. Choose a property to finish connecting.
                    </p>
                  ) : null}

                  {isSelecting ? (
                    propertyError ? (
                      <p role="alert" className="text-sm text-red-600">
                        {propertyError}
                      </p>
                    ) : (
                      <PropertyPicker
                        websiteId={websiteId}
                        slug={slug}
                        properties={properties}
                        selectedId={null}
                      />
                    )
                  ) : null}

                  {card.status !== "NOT_CONNECTED" ? (
                    <DisconnectButton websiteId={websiteId} slug={slug} />
                  ) : null}
                </div>
              ) : null}

              {connectable && !canManage ? (
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
          Signing in with Google proves who you are. Connecting Search Console or
          Analytics is a separate authorization, asking only for read access, and it is
          attached to the property you choose rather than to your account as a whole.
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed">
          The long-lived token is encrypted before it is stored and is never returned by
          any page. Data already collected stays if a connection is removed, because it
          was really measured.
        </p>
      </section>
    </main>
  );
}
