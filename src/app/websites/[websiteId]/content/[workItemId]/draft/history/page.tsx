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
 * Every revision of a draft, newest first (docs/P4_SPEC.md §10; M4.4 §8):
 * who or what wrote it and from which revision, when, how long, what the
 * server found, the change summary and a short provenance line. The current
 * revision is marked; earlier ones open read-only.
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
    <main className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Revision history"
          description={`${humanize(item.type)} · ${item.title} · draft based on Brief v${view.brief.version}`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav
        className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm"
        aria-label="History"
      >
        <Link href={`${base}?draft=${view.draft.id}`} className="hover:underline">
          ← Back to the draft
        </Link>
        {revisions.length >= 2 ? (
          <Link href={`${base}/compare?draft=${view.draft.id}`} className="hover:underline">
            Compare revisions
          </Link>
        ) : null}
        <StatusBadge status={view.draft.status} />
        {view.draft.status === "SUPERSEDED" ? (
          <span className="text-xs">Superseded draft: history is kept as it was.</span>
        ) : null}
      </nav>

      {revisions.length === 0 ? (
        <EmptyState>No revisions yet.</EmptyState>
      ) : (
        <ol
          className="divide-border border-border divide-y rounded-lg border text-sm"
          aria-label="Revisions, newest first"
        >
          {revisions.map((revision) => {
            const current = revision.id === view.draft.currentRevisionId;
            return (
              <li
                key={revision.id}
                className={`space-y-1.5 px-4 py-3 ${current ? "bg-accent/40" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">v{revision.revisionNumber}</span>
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${
                      revision.author.kind === "AI"
                        ? "border-sky-700/40 text-sky-700 dark:text-sky-400"
                        : "border-border"
                    }`}
                  >
                    {revision.author.label}
                  </span>
                  {revision.basedOnRevisionNumber ? (
                    <span className="text-muted-foreground text-xs">
                      from v{revision.basedOnRevisionNumber}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">the first revision</span>
                  )}
                  {current ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200">
                      Current
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">read-only</span>
                  )}
                </div>
                <p className="break-words">{revision.changeSummary}</p>
                <p className="text-muted-foreground text-xs">
                  {revision.createdAt.toLocaleString("en-GB")} · {revision.wordCount ?? "?"} words ·{" "}
                  {revision.findings.blocking} blocking · {revision.findings.warning} warning ·{" "}
                  {revision.findings.info} note
                </p>
                <p className="text-muted-foreground text-xs break-all">{revision.provenance}</p>
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
            );
          })}
        </ol>
      )}
    </main>
  );
}
