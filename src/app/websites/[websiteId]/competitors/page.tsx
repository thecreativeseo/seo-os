import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { listCompetitors } from "@/server/services/governance";
import {
  addCompetitorAction,
  archiveCompetitorAction,
  editCompetitorAction,
} from "@/server/actions/governance";
import {
  ActionForm,
  Badge,
  Choice,
  EmptyState,
  Field,
  PageHeader,
} from "@/components/governance/primitives";
import { EditDisclosure } from "@/components/governance/edit-disclosure";

export const metadata = { title: "Competitors · SEO OS" };

const TYPES = [
  { value: "UNKNOWN", label: "Not classified" },
  { value: "DIRECT", label: "Direct" },
  { value: "ADJACENT", label: "Adjacent" },
  { value: "SEARCH", label: "Search" },
  { value: "PUBLISHER", label: "Publisher" },
  { value: "AGGREGATOR", label: "Aggregator" },
] as const;

export default async function CompetitorsPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const competitors = await listCompetitors(context);
  const canWrite = hasRole(context.membership.role, "MEMBER");

  return (
    <main className="space-y-10">
      <PageHeader
        title="Competitors"
        description="Who this website competes with, as told to us. SEO OS does not discover or classify competitors in this phase — a type is set only when someone chooses one."
      />

      {competitors.length === 0 ? (
        <EmptyState>No competitors recorded yet.</EmptyState>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {competitors.map((competitor) => (
            <li key={competitor.id} className="space-y-2 px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{competitor.name}</p>
                  <p className="text-muted-foreground font-mono text-xs">
                    {competitor.normalizedDomain ?? "No domain provided"}
                  </p>
                  {competitor.notes ? (
                    <p className="text-muted-foreground text-sm">{competitor.notes}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge>{competitor.type}</Badge>
                  {competitor.providedByUser ? <Badge>USER_PROVIDED</Badge> : null}
                </div>
              </div>
              {canWrite ? (
                <div className="space-y-3">
                  <ActionForm
                    action={archiveCompetitorAction}
                    websiteId={websiteId}
                    hidden={{ __competitorId: competitor.id }}
                    submitLabel="Archive"
                    variant="quiet"
                    className=""
                  />

                  <EditDisclosure>
                    <ActionForm
                      action={editCompetitorAction}
                      websiteId={websiteId}
                      hidden={{ __competitorId: competitor.id }}
                      submitLabel="Save competitor"
                      pendingLabel="Saving…"
                      variant="secondary"
                    >
                      <Field
                        name="name"
                        label="Name"
                        required
                        defaultValue={competitor.name}
                      />
                      <Field
                        name="domain"
                        label="Domain"
                        defaultValue={competitor.domain ?? ""}
                        hint={
                          competitor.normalizedDomain
                            ? `Currently stored as ${competitor.normalizedDomain}`
                            : "Leave blank if you do not know it."
                        }
                      />
                      <Choice
                        name="type"
                        label="Type"
                        options={TYPES}
                        defaultValue={competitor.type}
                      />
                      <Field
                        name="notes"
                        label="Notes"
                        multiline
                        defaultValue={competitor.notes ?? ""}
                      />
                    </ActionForm>
                  </EditDisclosure>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <section className="border-border space-y-4 rounded-lg border p-5">
          <h2 className="text-sm font-medium">Add a competitor</h2>
          <ActionForm
            action={addCompetitorAction}
            websiteId={websiteId}
            submitLabel="Add competitor"
            pendingLabel="Adding…"
          >
            <Field name="name" label="Name" required placeholder="Rival Co" />
            <Field name="domain" label="Domain" placeholder="rival.com" />
            <Choice name="type" label="Type" options={TYPES} defaultValue="UNKNOWN" />
            <Field name="notes" label="Notes" multiline />
          </ActionForm>
        </section>
      ) : null}
    </main>
  );
}
