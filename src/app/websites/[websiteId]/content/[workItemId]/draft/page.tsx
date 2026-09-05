import crypto from "node:crypto";

import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { isAiConfigured } from "@/server/ai/registry";
import { getContentWorkItem } from "@/server/services/content-work";
import { currentBrief } from "@/server/services/content-brief";
import {
  getBriefPanel,
  getDraft,
  getDraftForWorkItem,
  listDraftsForWorkItem,
  previewHtml,
  revisionClaims,
  revisionFindings,
} from "@/server/services/content-draft";
import { draftControls } from "@/lib/content/draft-ux";
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
import { DraftForm } from "@/components/execution/draft-form";
import { BriefPanel } from "@/components/execution/brief-panel";
import { ClaimsPanel } from "@/components/execution/claims-panel";
import { DraftStateNotice } from "@/components/execution/draft-state";
import { FindingsPanel, ReviewBlockers } from "@/components/execution/findings-panel";
import { AuthorLabel, ProvenancePanel } from "@/components/execution/provenance-panel";

export const metadata = { title: "Draft · SEO OS" };

/**
 * The draft workspace (docs/P4_SPEC.md §9-§12; M4.4 §3-§7, §12-§13).
 *
 * Three areas: the pinned brief as constraints on the left, the draft in
 * the middle - preview or editor - and on the right who wrote it, what the
 * server found, and what it claims. Controls follow the service rules for
 * the person's role and the draft's state; a superseded draft is read-only
 * for everyone. `?draft=` opens a particular draft; `?mode=edit` opens the
 * editor.
 */
export default async function DraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
  searchParams: Promise<{ draft?: string; mode?: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const { draft: requestedDraftId, mode } = await searchParams;
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
  const panel = view ? await getBriefPanel(context, view.brief.id) : null;

  const canWrite = hasRole(context.membership.role, REQUIRED.WRITE);
  const canReview = hasRole(context.membership.role, REQUIRED.REVIEW);
  const briefApproved = brief?.status === "APPROVED";
  const drafting = item.status === "DRAFTING";
  const aiConfigured = isAiConfigured();
  // Minted per render: a retry of this page's form returns the same revision.
  const generationToken = crypto.randomUUID();

  const current = view?.current ?? null;
  const findings = current ? revisionFindings(current) : null;
  const findingRows = findings?.findings ?? [];
  const staleClaims = findings?.staleClaims ?? [];
  const blocking = Boolean(findings?.blocking);

  const controls = view
    ? draftControls({
        canWrite,
        canReview,
        draftStatus: view.draft.status,
        itemDrafting: drafting,
        briefCurrent: view.brief.status === "APPROVED",
        hasRevision: Boolean(current),
        blocking,
        aiConfigured,
      })
    : null;
  const editing = mode === "edit" && Boolean(controls?.canEdit);

  const base = `/websites/${websiteId}/content/${item.id}/draft`;
  const withDraft = (path: string, extra = "") =>
    view ? `${path}?draft=${view.draft.id}${extra}` : path;
  const earlier = drafts.filter((row) => row.status === "SUPERSEDED" || row.status === "ARCHIVED");

  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={current ? current.title : "Draft"}
          description={`${humanize(item.type)} · ${item.title}`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap gap-4 text-sm" aria-label="Draft">
        <Link href={`/websites/${websiteId}/drafts`} className="hover:underline">
          ← Drafts
        </Link>
        <Link href={`/websites/${websiteId}/content/${item.id}`} className="hover:underline">
          Work item
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

      {!view || !controls || !panel ? (
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
              {canWrite ? (
                <StartDraftButton websiteId={websiteId} workItemId={item.id} />
              ) : (
                <p className="text-muted-foreground text-sm">
                  Starting a draft needs a member&apos;s access or above.
                </p>
              )}
            </>
          )}
        </section>
      ) : (
        <>
          {/* ------------------------------------------------ Status strip */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={view.draft.status} />
              {view.draft.status === "AWAITING_EDITOR_REVIEW" ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                  Review requested
                </span>
              ) : null}
              <span className="text-muted-foreground text-xs">
                Draft based on{" "}
                <Link
                  href={`/websites/${websiteId}/content/${item.id}/brief?version=${view.brief.version}`}
                  className="font-mono hover:underline"
                >
                  Brief v{view.brief.version}
                </Link>
                {view.brief.status !== "APPROVED"
                  ? ` (${humanize(view.brief.status).toLowerCase()})`
                  : ""}
                {" · "}
                {view.revisionCount} revision{view.revisionCount === 1 ? "" : "s"}
              </span>
              {current ? <AuthorLabel revision={current} viewerUserId={context.user.id} /> : null}
            </div>

            {view.draft.status === "SUPERSEDED" ? (
              <DraftStateNotice kind="superseded">
                {openView ? (
                  <Link
                    href={`${base}?draft=${openView.draft.id}`}
                    className="text-sm hover:underline"
                  >
                    Open the current draft (brief v{openView.brief.version}) →
                  </Link>
                ) : null}
              </DraftStateNotice>
            ) : null}

            {view.briefMismatch && view.draft.status !== "SUPERSEDED" ? (
              <DraftStateNotice
                kind="newer_brief"
                detail={{
                  briefVersion: view.brief.version,
                  approvedVersion: view.briefMismatch.approvedVersion,
                }}
              >
                {controls.canStartFromNewBrief ? (
                  <StartFromBriefButton
                    websiteId={websiteId}
                    workItemId={item.id}
                    briefId={view.briefMismatch.approvedBriefId}
                    version={view.briefMismatch.approvedVersion}
                  />
                ) : null}
              </DraftStateNotice>
            ) : null}

            {view.draft.status === "AWAITING_EDITOR_REVIEW" ? (
              <DraftStateNotice kind="awaiting_review">
                {controls.canReturn ? (
                  <ReturnToDraftingForm
                    websiteId={websiteId}
                    workItemId={item.id}
                    draftId={view.draft.id}
                  />
                ) : null}
              </DraftStateNotice>
            ) : null}

            {view.lastReturn && view.draft.status === "DRAFTING" ? (
              <div role="status" className="border-border rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  Returned to drafting
                  {view.lastReturn.by ? ` by ${view.lastReturn.by}` : ""} on{" "}
                  {view.lastReturn.at.toLocaleString("en-GB")}
                </p>
                <p className="text-muted-foreground mt-1">“{view.lastReturn.note}”</p>
              </div>
            ) : null}

            {controls.readOnly && controls.readOnlyReason && view.draft.status !== "SUPERSEDED" ? (
              <p className="text-muted-foreground text-sm">{controls.readOnlyReason}</p>
            ) : null}

            {!current && !controls.readOnly ? (
              <DraftStateNotice kind="no_revision">
                <div className="space-y-3">
                  {controls.canGenerate ? (
                    <GenerateRevisionButton
                      websiteId={websiteId}
                      workItemId={item.id}
                      draftId={view.draft.id}
                      generationToken={generationToken}
                      label="Generate first draft"
                    />
                  ) : controls.generateReason ? (
                    <p className="text-sm">{controls.generateReason}</p>
                  ) : null}
                  <p className="text-sm">
                    <Link
                      href={withDraft(base, "&mode=edit")}
                      className="font-medium hover:underline"
                    >
                      Write the first revision by hand →
                    </Link>
                  </p>
                </div>
              </DraftStateNotice>
            ) : null}
            {!current && controls.readOnly ? (
              <EmptyState>No revision was written.</EmptyState>
            ) : null}

            {current && !aiConfigured && controls.canEdit && view.draft.status === "DRAFTING" ? (
              <DraftStateNotice kind="no_provider" />
            ) : null}
            {current && blocking && !controls.readOnly ? (
              <DraftStateNotice
                kind="blocking"
                detail={{
                  count:
                    findings?.findings.filter((row) => row.severity === "BLOCKING").length ?? 0,
                }}
              >
                <ReviewBlockers findings={findingRows} />
              </DraftStateNotice>
            ) : null}
            {staleClaims.length > 0 && !controls.readOnly ? (
              <DraftStateNotice kind="stale_evidence" detail={{ count: staleClaims.length }} />
            ) : null}
          </section>

          {/* ------------------------------------------------ Three areas */}
          <div className="grid gap-6 xl:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)_minmax(18rem,22rem)]">
            <aside className="border-border rounded-lg border p-4 xl:order-1">
              <BriefPanel
                brief={panel}
                mismatch={
                  view.briefMismatch
                    ? { approvedVersion: view.briefMismatch.approvedVersion }
                    : null
                }
              />
            </aside>

            <section className="min-w-0 space-y-4 xl:order-2" aria-labelledby="draft-heading">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="draft-heading" className="text-sm font-medium">
                  {current ? `Revision ${current.revisionNumber}` : "Draft"}
                  {current ? (
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      · {current.wordCount ?? "?"} words
                    </span>
                  ) : null}
                </h2>
                {controls.canEdit ? (
                  <div className="flex gap-1 text-sm" role="tablist" aria-label="Mode">
                    <Link
                      href={withDraft(base)}
                      role="tab"
                      aria-selected={!editing}
                      className={`rounded-md px-3 py-1 ${!editing ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60"}`}
                    >
                      Preview
                    </Link>
                    <Link
                      href={withDraft(base, "&mode=edit")}
                      role="tab"
                      aria-selected={editing}
                      className={`rounded-md px-3 py-1 ${editing ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60"}`}
                    >
                      Edit
                    </Link>
                  </div>
                ) : null}
              </div>

              {editing ? (
                <>
                  {view.draft.status === "AWAITING_EDITOR_REVIEW" ? (
                    <p className="text-muted-foreground text-sm">
                      Saving while review is requested sends the draft back to drafting.
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
              ) : current ? (
                <>
                  <dl className="divide-border border-border divide-y rounded-lg border text-sm">
                    <Field label="Title">{current.title}</Field>
                    <Field label="Slug">
                      {current.slug ? (
                        <span className="font-mono text-xs">{current.slug}</span>
                      ) : (
                        "—"
                      )}
                    </Field>
                    <Field label="Meta title">{current.metaTitle ?? "—"}</Field>
                    <Field label="Meta description">{current.metaDescription ?? "—"}</Field>
                    <Field label="Excerpt">{current.excerpt ?? "—"}</Field>
                  </dl>
                  <article
                    className="prose prose-sm border-border max-w-none overflow-x-auto rounded-lg border p-5 break-words"
                    // Sanitized server-side by renderMarkdown: allowlisted tags only.
                    dangerouslySetInnerHTML={{ __html: previewHtml(current) }}
                  />

                  {controls.canEdit || controls.canGenerate || controls.canRequestReview ? (
                    <div className="space-y-4">
                      {controls.canGenerate ? (
                        <GenerateRevisionButton
                          websiteId={websiteId}
                          workItemId={item.id}
                          draftId={view.draft.id}
                          generationToken={generationToken}
                          label="Generate again from the brief"
                        />
                      ) : controls.canEdit && controls.generateReason ? (
                        <p className="text-muted-foreground text-sm">{controls.generateReason}</p>
                      ) : null}
                      {controls.canEdit ? (
                        <p className="text-sm">
                          <Link
                            href={withDraft(base, "&mode=edit")}
                            className="font-medium hover:underline"
                          >
                            Edit and save as a new revision →
                          </Link>
                        </p>
                      ) : null}
                      {controls.canEdit && view.draft.status === "DRAFTING" ? (
                        <RequestReviewButton
                          websiteId={websiteId}
                          workItemId={item.id}
                          draftId={view.draft.id}
                          blocked={!controls.canRequestReview}
                          reason={controls.requestReviewReason}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>

            <aside className="min-w-0 space-y-6 xl:order-3">
              {current ? (
                <>
                  <ProvenancePanel
                    revision={current}
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
                  <FindingsPanel findings={findingRows} staleClaims={staleClaims} />
                  <ClaimsPanel
                    claims={revisionClaims(current)}
                    staleClaims={staleClaims}
                    openQuestions={findings?.openQuestions ?? []}
                  />
                </>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Provenance, findings and claims appear with the first revision.
                </p>
              )}
            </aside>
          </div>

          {earlier.length > 0 || drafts.length > 1 ? (
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
                        {row.currentTitle ?? "No revision yet"} (open now)
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
        </>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5">
      <dt className="text-muted-foreground w-36 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}
