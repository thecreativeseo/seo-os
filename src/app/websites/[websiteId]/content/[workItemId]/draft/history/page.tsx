import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getContentWorkItem } from "@/server/services/content-work";
import { getDraft, getDraftForWorkItem, listRevisions } from "@/server/services/content-draft";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";

export const metadata = { title: "Revision history · SEO OS" };

/**
 * Every revision of a draft, newest first (docs/P4_SPEC.md §10; M4.3):
 * who or what wrote it and from which revision, when, how long, what the
 * server found, and the change summary. Each opens read-only; any two can be
 * compared.
 */
export default async function RevisionHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
  searchParams: Promise<{ draft?: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const { draft: requestedDraftId } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();

  const view = requestedDraftId
    ? await getDraft(context, requestedDraftId)
    : await getDraftForWorkItem(context, item.id);
  if (!view || view.draft.contentWorkItemId !== item.id) notFound();

  const revisions = await listRevisions(context, view.draft.id, context.user.id);
  const base = `/websites/${websiteId}/content/${item.id}/draft`;

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Revision history"
          description={`${humanize(item.type)} · ${item.title} · brief v${view.brief.version}`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm">
        <Link href={`${base}?draft=${view.draft.id}`} className="hover:underline">
          ← Back to the draft
        </Link>
        <StatusBadge status={view.draft.status} />
        {revisions.length >= 2 ? (
          <Link href={`${base}/compare?draft=${view.draft.id}`} className="hover:underline">
            Compare revisions
          </Link>
        ) : null}
      </nav>

      {revisions.length === 0 ? (
        <EmptyState>No revisions yet.</EmptyState>
      ) : (
        <ol className="divide-border border-border divide-y rounded-lg border text-sm">
          {revisions.map((revision) => (
            <li key={revision.id} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">v{revision.revisionNumber}</span>
                <span className="font-medium">
                  {revision.author.label}
                  {revision.basedOnRevisionNumber ? ` from v${revision.basedOnRevisionNumber}` : ""}
                </span>
                {revision.id === view.draft.currentRevisionId ? (
                  <span className="text-muted-foreground text-xs">· current</span>
                ) : null}
              </div>
              <p>{revision.changeSummary}</p>
              <p className="text-muted-foreground text-xs">
                {revision.createdAt.toLocaleString("en-GB")} · {revision.wordCount ?? "?"} words ·{" "}
                {revision.findings.blocking} blocking · {revision.findings.warning} warning ·{" "}
                {revision.findings.info} info
              </p>
              <p className="text-muted-foreground text-xs">{revision.provenance}</p>
              <div className="flex flex-wrap gap-4 text-xs">
                <Link href={`${base}/revisions/${revision.id}`} className="hover:underline">
                  Open read-only →
                </Link>
                {revision.basedOnRevisionNumber ? (
                  <Link
                    href={`${base}/compare?draft=${view.draft.id}&to=${revision.id}`}
                    className="hover:underline"
                  >
                    Compare with v{revision.basedOnRevisionNumber} →
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
