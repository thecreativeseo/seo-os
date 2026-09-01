import { requireWebsiteAccess } from "@/server/auth/guards";
import { PROVIDER_COUNT, listConnectionCards } from "@/server/services/connections";
import { Badge, PageHeader } from "@/components/governance/primitives";

export const metadata = { title: "Connections · SEO OS" };

/**
 * Data & Publishing (docs/P0_SPEC.md §18, blueprint "Connections").
 *
 * Every card is read-only. There is no connect button, because nothing connects in
 * this phase and a button that did nothing — or worse, appeared to succeed — would
 * be exactly the dishonesty CLAUDE.md rules out.
 *
 * Availability is stated per provider so the roadmap is legible without implying
 * anything is available now.
 */
export default async function ConnectionsPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const cards = await listConnectionCards(context);
  const connected = cards.filter((card) => card.status === "CONNECTED").length;

  return (
    <main className="space-y-8">
      <PageHeader
        title="Data & Publishing"
        description="The systems SEO OS is built to operate with. Nothing connects in this phase — these are shown so the architecture is visible, not to suggest data is flowing."
      />

      <p className="text-muted-foreground text-sm">
        <span className="font-mono">
          {connected} / {PROVIDER_COUNT}
        </span>{" "}
        connected
      </p>

      <ul className="divide-border border-border divide-y rounded-lg border">
        {cards.map((card) => (
          <li
            key={card.provider}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{card.name}</p>
              <p className="text-muted-foreground text-sm">{card.purpose}</p>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <span className="text-muted-foreground text-xs">{card.availability}</span>
              <Badge>{card.status}</Badge>
            </div>
          </li>
        ))}
      </ul>

      <section className="border-border space-y-2 rounded-lg border border-dashed p-5">
        <h2 className="text-sm font-medium">How connections will work</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          When a provider is connected, SEO OS stores a reference to the credential in
          a secret manager — never the credential itself. Provider-specific logic sits
          behind a connector abstraction, so adding a provider does not change how the
          rest of the system reads data.
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Search Console and Analytics activate in P1. Until then every provider stays{" "}
          <span className="font-mono text-xs">NOT_CONNECTED</span>, and nothing in SEO
          OS reports a metric it has not been given.
        </p>
      </section>
    </main>
  );
}
