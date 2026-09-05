import crypto from "node:crypto";

import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { isAiConfigured } from "@/server/ai/registry";
import { getContentWorkItem } from "@/server/services/content-work";
import { currentBrief } from "@/server/services/content-brief";
import {
  NO_PROVIDER_MESSAGE,
  getDraft,
  getDraftForWorkItem,
  listDraftsForWorkItem,
  revisionFindings,
} from "@/server/services/content-draft";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";
import {
  GenerateRevisionButton,
  RequestReviewButton,
  ReturnToDraftingForm,
  StartDraftButton,
  StartFromBriefButton,
} from "@/components/execution/draft-controls";
import { RevisionDetail } from "@/components/execution/revision-detail";

export const metadata = { title: "Draft · SEO OS" };

/**
 * The draft for a work item (docs/P4_SPEC.md §9-§12; M4.2, M4.3). Start
 * drafting, generate, edit by hand, request review, send back, move on to a
 * newer brief - and inspect the current revision with its provenance, claims
 * and findings. `?draft=` opens a particular draft, superseded ones included.
 */
export default async function DraftPage({
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

  const [openView, brief, drafts] = await Promise.all([
    getDraftForWorkItem(context, item.id),
    currentBrief(context, item.id),
    listDraftsForWorkItem(context, item.id),
  ]);
  const view =
    requestedDraftId && requestedDraftId !== openView?.draft.id
      ? await getDraft(context, requestedDraftId)
      : openView;
  if (requestedDraftId && (!view || view.draft.contentWorkItemId !== item.id)) notFound();

  const canWrite = hasRole(context.membership.role, REQUIRED.WRITE);
  const canReview = hasRole(context.membership.role, REQUIRED.REVIEW);
  const briefApproved = brief?.status === "APPROVED";
  const drafting = item.status === "DRAFTING";
  const aiConfigured = isAiConfigured();
  // Minted per render: a retry of this page's form returns the same revision.
  const generationToken = crypto.randomUUID();

  const current = view?.current ?? null;
  const findings = current ? revisionFindings(current) : null;
  const blocked = Boolean(findings?.blocking);
  const isOpen = view
    ? view.draft.status === "DRAFTING" || view.draft.status === "AWAITING_EDITOR_REVIEW"
    : false;
  const editable = Boolean(view && isOpen && canWrite && drafting);
  const canGenerate =
    Boolean(view && view.draft.status === "DRAFTING" && view.brief.status === "APPROVED") &&
    canWrite &&
    drafting;
  const base = `/websites/${websiteId}/content/${item.id}/draft`;
  const withDraft = (path: string) => (view ? `${path}?draft=${view.draft.id}` : path);

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={current ? current.title : "Draft"}
          description={`${humanize(item.type)} · ${item.title}`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap gap-4 text-sm">
        <Link href={`/websites/${websiteId}/content/${item.id}`} className="hover:underline">
          ← Work item
        </Link>
        <Link href={`/websites/${websiteId}/content/${item.id}/brief`} className="hover:underline">
          Brief
        </Link>
        {view ? (
          <>
            <Link href={withDraft(`${base}/history`)} className="hover:underline">
              Revision history
            </Link>
            {view.revisionCount >= 2 ? (
              <Link href={withDraft(`${base}/compare`)} className="hover:underline">
                Compare
              </Link>
            ) : null}
          </>
        ) : null}
      </nav>

      {!view ? (
        <section className="space-y-4">
          {!briefApproved || !drafting ? (
            <EmptyState>
              Drafting starts once a brief version has been approved.{" "}
              {brief
                ? `The current brief (v${brief.version}) is ${humanize(brief.status).toLowerCase()}.`
                : "There is no brief yet."}
            </EmptyState>
          ) : (
            <>
              <p className="text-muted-foreground max-w-prose text-sm">
                The draft will be pinned to brief{" "}
                <span className="font-mono">v{brief.version}</span>. Approving a later brief version
                will not move it.
              </p>
              {canWrite ? <StartDraftButton websiteId={websiteId} workItemId={item.id} /> : null}
            </>
          )}
        </section>
      ) : (
        <>
          {/* ------------------------------------------------ Status */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={view.draft.status} />
              {view.draft.status === "AWAITING_EDITOR_REVIEW" ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                  Review requested
                </span>
              ) : null}
              <span className="text-muted-foreground text-xs">
                pinned to brief{" "}
                <Link
                  href={`/websites/${websiteId}/content/${item.id}/brief?version=${view.brief.version}`}
                  className="font-mono hover:underline"
                >
                  v{view.brief.version}
                </Link>
                {view.brief.status !== "APPROVED"
                  ? ` (${humanize(view.brief.status).toLowerCase()})`
                  : ""}
                {" · "}
                {view.revisionCount} revision{view.revisionCount === 1 ? "" : "s"}
              </span>
            </div>

            {view.draft.status === "SUPERSEDED" ? (
              <p className="border-border rounded-lg border border-dashed p-3 text-sm">
                <span className="font-medium">This draft is superseded.</span> It was written from
                brief v{view.brief.version}; a later draft was started from a newer approved
                version. Everything here is kept as it was.{" "}
                {openView ? (
                  <Link href={`${base}?draft=${openView.draft.id}`} className="hover:underline">
                    Open the current draft →
                  </Link>
                ) : null}
              </p>
            ) : null}

            {view.briefMismatch && isOpen ? (
              <div className="border-border space-y-3 rounded-lg border border-dashed p-3 text-sm">
                <p>
                  <span className="font-medium">
                    This draft was created from Brief v{view.brief.version}. Brief v
                    {view.briefMismatch.approvedVersion} is now approved.
                  </span>{" "}
                  Generating against v{view.brief.version} is closed. Hand-written revisions of this
                  draft are still allowed, and everything here is kept either way.
                </p>
                {canWrite && drafting ? (
                  <StartFromBriefButton
                    websiteId={websiteId}
                    workItemId={item.id}
                    briefId={view.briefMismatch.approvedBriefId}
                    version={view.briefMismatch.approvedVersion}
                  />
                ) : null}
              </div>
            ) : null}

            {view.lastReturn && view.draft.status === "DRAFTING" ? (
              <div className="border-border rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  Returned to drafting
                  {view.lastReturn.by ? ` by ${view.lastReturn.by}` : ""} on{" "}
                  {view.lastReturn.at.toLocaleString("en-GB")}
                </p>
                <p className="text-muted-foreground mt-1">“{view.lastReturn.note}”</p>
              </div>
            ) : null}

            {isOpen ? (
              <div className="space-y-4">
                {canGenerate ? (
                  aiConfigured ? (
                    <GenerateRevisionButton
                      websiteId={websiteId}
                      workItemId={item.id}
                      draftId={view.draft.id}
                      generationToken={generationToken}
                      label={current ? "Generate again from the brief" : "Generate first draft"}
                    />
                  ) : (
                    <p className="border-border rounded-lg border border-dashed p-3 text-sm">
                      {NO_PROVIDER_MESSAGE}{" "}
                      <Link href={withDraft(`${base}/edit`)} className="hover:underline">
                        Write it by hand →
                      </Link>
                    </p>
                  )
                ) : null}

                {editable ? (
                  <p className="text-sm">
                    <Link href={withDraft(`${base}/edit`)} className="font-medium hover:underline">
                      {current
                        ? "Edit and save as a new revision →"
                        : "Write the first revision by hand →"}
                    </Link>
                    {view.draft.status === "AWAITING_EDITOR_REVIEW" ? (
                      <span className="text-muted-foreground">
                        {" "}
                        Saving while review is requested sends the draft back to drafting.
                      </span>
                    ) : null}
                  </p>
                ) : null}

                {canWrite && drafting && view.draft.status === "DRAFTING" && current ? (
                  <RequestReviewButton
                    websiteId={websiteId}
                    workItemId={item.id}
                    draftId={view.draft.id}
                    blocked={blocked}
                  />
                ) : null}

                {canReview && drafting && view.draft.status === "AWAITING_EDITOR_REVIEW" ? (
                  <ReturnToDraftingForm
                    websiteId={websiteId}
                    workItemId={item.id}
                    draftId={view.draft.id}
                  />
                ) : null}
              </div>
            ) : null}
          </section>

          {drafts.length > 1 ? (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Drafts of this work item</h2>
              <ul className="divide-border border-border divide-y rounded-lg border text-sm">
                {drafts.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                    <StatusBadge status={row.status} />
                    <span className="text-muted-foreground text-xs">
                      brief v{row.briefVersion} · {row.revisionCount} revision
                      {row.revisionCount === 1 ? "" : "s"}
                    </span>
                    {row.id === view.draft.id ? (
                      <span className="text-xs">
                        {row.currentTitle ?? "No revision yet"} (this one)
                      </span>
                    ) : (
                      <Link href={`${base}?draft=${row.id}`} className="text-xs hover:underline">
                        {row.currentTitle ?? "No revision yet"} →
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {!current ? (
            <EmptyState>No revision yet.</EmptyState>
          ) : (
            <RevisionDetail revision={current} viewerUserId={context.user.id} />
          )}
        </>
      )}
    </main>
  );
}
