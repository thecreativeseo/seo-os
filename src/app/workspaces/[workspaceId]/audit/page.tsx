import { requireWorkspaceAccess } from "@/server/auth/guards";
import {
  AUDIT_PAGE_SIZE,
  countAuditEvents,
  listAuditEvents,
} from "@/server/services/workspace";
import { Badge, EmptyState, PageHeader } from "@/components/governance/primitives";

export const metadata = { title: "Audit History · SEO OS" };

/**
 * Audit history.
 *
 * Snapshots were redacted when written, so nothing here can display a secret. They
 * are shown as-is rather than summarised: the point of an audit trail is that a
 * person can check what actually changed.
 */
export default async function AuditPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await requireWorkspaceAccess(workspaceId);

  const [events, total] = await Promise.all([
    listAuditEvents(context),
    countAuditEvents(context),
  ]);

  return (
    <main className="space-y-8">
      <PageHeader
        title="Audit History"
        description="Every governance change, who made it, and when. Credentials and tokens are stripped before an event is written."
      />

      {events.length === 0 ? (
        <EmptyState>No changes recorded yet.</EmptyState>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Showing {events.length} of {total}
            {total > AUDIT_PAGE_SIZE ? ", newest first" : ""}
          </p>

          <ul className="divide-border border-border divide-y rounded-lg border">
            {events.map((event) => (
              <li key={event.id} className="space-y-2 px-4 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-sm">
                    <span className="font-medium">{event.entityType}</span>{" "}
                    <span className="text-muted-foreground">
                      {event.action.toLowerCase()}
                    </span>
                    {event.website ? (
                      <span className="text-muted-foreground font-mono text-xs">
                        {" "}
                        · {event.website.normalizedDomain}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground shrink-0 text-xs">
                    {event.createdAt.toLocaleString()}
                  </p>
                </div>

                <p className="text-muted-foreground text-xs">
                  {event.actor?.displayName ?? event.actor?.email ?? "Unknown actor"}
                </p>

                {event.beforeSnapshotJson || event.afterSnapshotJson ? (
                  <details className="text-xs">
                    <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
                      What changed
                    </summary>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      <Snapshot label="Before" value={event.beforeSnapshotJson} />
                      <Snapshot label="After" value={event.afterSnapshotJson} />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>

          {total > events.length ? (
            <p className="text-muted-foreground text-xs">
              Older events are retained but not shown. Paging arrives with the reporting
              work in a later phase.
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}

function Snapshot({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground flex items-center gap-2">
        <Badge>{label}</Badge>
      </p>
      {value === null || value === undefined ? (
        <p className="text-muted-foreground/70 italic">Not recorded</p>
      ) : (
        <pre className="bg-accent/50 overflow-x-auto rounded-md p-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
