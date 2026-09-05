import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getContentWorkItem } from "@/server/services/content-work";
import { getDraft, getRevision } from "@/server/services/content-draft";
import { PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";
import { AuthorLabel } from "@/components/execution/provenance-panel";
import { RevisionDetail } from "@/components/execution/revision-detail";

export const metadata = { title: "Revision · SEO OS" };

/** One revision, read-only, exactly as it was stored (docs/P4_SPEC.md §10). */
export default async function RevisionPage({
  params,
}: {
  params: Promise<{ websiteId: string; workItemId: string; revisionId: string }>;
}) {
  const { websiteId, workItemId, revisionId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();

  const revision = await getRevision(context, revisionId);
  if (!revision) notFound();
  const view = await getDraft(context, revision.contentDraftId);
  if (!view || view.draft.contentWorkItemId !== item.id) notFound();

  const base = `/websites/${websiteId}/content/${item.id}/draft`;
  const isCurrent = revision.id === view.draft.currentRevisionId;

  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={`Revision ${revision.revisionNumber} · ${revision.title}`}
          description={`${humanize(item.type)} · ${item.title} · based on Brief v${view.brief.version} · read-only`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav
        className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm"
        aria-label="Revision"
      >
        <Link href={`${base}?draft=${view.draft.id}`} className="hover:underline">
          ← Back to the draft
        </Link>
        <Link href={`${base}/history?draft=${view.draft.id}`} className="hover:underline">
          Revision history
        </Link>
        {revision.basedOnRevisionNumber ? (
          <Link
            href={`${base}/compare?draft=${view.draft.id}&to=${revision.id}`}
            className="hover:underline"
          >
            Compare with v{revision.basedOnRevisionNumber}
          </Link>
        ) : null}
        <StatusBadge status={view.draft.status} />
        <AuthorLabel revision={revision} viewerUserId={context.user.id} />
        <span className="text-xs">
          {isCurrent
            ? "This is the current revision."
            : "An earlier revision; the draft has moved on. Nothing here can be changed."}
        </span>
      </nav>

      <RevisionDetail
        revision={revision}
        viewerUserId={context.user.id}
        lineage={{
          briefVersion: view.brief.version,
          briefSuperseded: view.brief.status !== "APPROVED",
          workItem: { title: item.title, type: item.type },
          recommendation: { title: item.recommendation.title },
          decision: {
            decision: item.decision.decision,
            decidedBy: item.decision.decidedBy.email,
            decidedAt: item.decision.decidedAt,
          },
        }}
      />
    </main>
  );
}
