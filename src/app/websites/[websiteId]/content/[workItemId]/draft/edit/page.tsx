import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { getContentWorkItem } from "@/server/services/content-work";
import { getDraft, getDraftForWorkItem } from "@/server/services/content-draft";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";
import { DraftForm } from "@/components/execution/draft-form";

export const metadata = { title: "Edit draft · SEO OS" };

/**
 * The editor (docs/P4_SPEC.md §10; M4.3). Prefilled from the current
 * revision; saving writes the next one. WRITE is required to reach it.
 */
export default async function EditDraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
  searchParams: Promise<{ draft?: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const { draft: requestedDraftId } = await searchParams;
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();

  const view = requestedDraftId
    ? await getDraft(context, requestedDraftId)
    : await getDraftForWorkItem(context, item.id);
  if (!view || view.draft.contentWorkItemId !== item.id) notFound();

  const base = `/websites/${websiteId}/content/${item.id}/draft?draft=${view.draft.id}`;
  const editable =
    item.status === "DRAFTING" &&
    (view.draft.status === "DRAFTING" || view.draft.status === "AWAITING_EDITOR_REVIEW");
  const current = view.current;

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={current ? `Edit: ${current.title}` : "Write the first revision"}
          description={`${humanize(item.type)} · ${item.title} · brief v${view.brief.version}`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm">
        <Link href={base} className="hover:underline">
          ← Back to the draft
        </Link>
        <StatusBadge status={view.draft.status} />
      </nav>

      {!editable ? (
        <EmptyState>
          This draft is {humanize(view.draft.status).toLowerCase()}; it can be read but not written
          to.
        </EmptyState>
      ) : (
        <>
          {view.briefMismatch ? (
            <p className="border-border rounded-lg border border-dashed p-3 text-sm">
              This draft was created from Brief v{view.brief.version}; Brief v
              {view.briefMismatch.approvedVersion} is now approved. You can still revise this draft
              by hand, or start a draft from the new version from the draft page.
            </p>
          ) : null}
          {view.draft.status === "AWAITING_EDITOR_REVIEW" ? (
            <p className="border-border rounded-lg border border-dashed p-3 text-sm">
              Review has been requested. Saving a revision sends the draft back to drafting, because
              what the reviewer was looking at will have changed.
            </p>
          ) : null}
          <DraftForm
            websiteId={websiteId}
            workItemId={item.id}
            draftId={view.draft.id}
            basedOn={current?.revisionNumber ?? null}
            defaults={{
              title: current?.title ?? "",
              slug: current?.slug ?? "",
              excerpt: current?.excerpt ?? "",
              metaTitle: current?.metaTitle ?? "",
              metaDescription: current?.metaDescription ?? "",
              bodyMarkdown: current?.bodyMarkdown ?? "",
            }}
          />
        </>
      )}
    </main>
  );
}
