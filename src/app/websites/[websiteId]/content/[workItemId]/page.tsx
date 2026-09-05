import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getContentWorkItem } from "@/server/services/content-work";
import { currentBrief, listBriefVersions } from "@/server/services/content-brief";
import {
  getDraftForWorkItem,
  listDraftsForWorkItem,
  revisionFindings,
} from "@/server/services/content-draft";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { PriorityBadge } from "@/components/opportunity/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";
import { StartDraftButton } from "@/components/execution/draft-controls";

/**
 * One work item (docs/P4_SPEC.md §6; M4.4 §10): where it came from, read
 * as a chain - Recommendation → Decision → Brief → Draft - and where each
 * link stands. The active draft is shown apart from any earlier, superseded
 * ones. Stages that follow arrive with their own milestones.
 */
export default async function ContentWorkItemPage({
  params,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();

  const [brief, versions, draftView, drafts] = await Promise.all([
    currentBrief(context, item.id),
    listBriefVersions(context, item.id),
    getDraftForWorkItem(context, item.id),
    listDraftsForWorkItem(context, item.id),
  ]);
  const awaiting = versions.filter((row) => row.status === "AWAITING_REVIEW").length;
  const canWrite = hasRole(context.membership.role, REQUIRED.WRITE);
  const briefable =
    item.status === "QUEUED" || item.status === "BRIEFING" || item.status === "DRAFTING";
  const earlier = drafts.filter((row) => row.status === "SUPERSEDED" || row.status === "ARCHIVED");
  const currentFindings = draftView?.current ? revisionFindings(draftView.current) : null;
  const blockingCount =
    currentFindings?.findings.filter((row) => row.severity === "BLOCKING").length ?? 0;
  const base = `/websites/${websiteId}/content/${item.id}`;

  const steps = [
    {
      label: "Recommendation",
      value: item.recommendation.title,
      status: item.recommendation.status,
      href: `/websites/${websiteId}/review/${item.recommendation.id}`,
    },
    {
      label: "Decision",
      value: `${humanize(item.decision.decision)} by ${item.decision.decidedBy.email}`,
      status: item.decision.decision,
      href: `/websites/${websiteId}/review/${item.recommendation.id}`,
    },
    {
      label: "Brief",
      value: brief ? `v${brief.version} · ${brief.title}` : "Not written yet",
      status: brief?.status ?? null,
      href: `${base}/brief`,
    },
    {
      label: "Draft",
      value: draftView
        ? draftView.current
          ? `Revision ${draftView.current.revisionNumber} · ${draftView.current.title}`
          : "Started, no revision yet"
        : "Not started",
      status: draftView?.draft.status ?? null,
      href: `${base}/draft`,
    },
  ];

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title={item.title} description={item.objective} />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={item.status} />
        <PriorityBadge priority={item.priority} />
        <span className="text-muted-foreground text-xs">{humanize(item.type)}</span>
      </div>

      {/* ------------------------------------------------------ Lineage */}
      <section className="space-y-3" aria-labelledby="lineage-heading">
        <h2 id="lineage-heading" className="text-sm font-medium">
          How it got here
        </h2>
        <ol className="grid gap-2 md:grid-cols-4">
          {steps.map((step, index) => (
            <li key={step.label} className="border-border rounded-lg border p-3 text-sm">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {index + 1}. {step.label}
              </p>
              <Link href={step.href} className="mt-1 block font-medium break-words hover:underline">
                {step.value}
              </Link>
              <div className="mt-1">
                {step.status ? (
                  <StatusBadge status={step.status} />
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Where it came from</h2>
        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          <Row label="Recommendation">
            <Link
              href={`/websites/${websiteId}/review/${item.recommendation.id}`}
              className="hover:underline"
            >
              {item.recommendation.title}
            </Link>
            <span className="text-muted-foreground">
              {" "}
              · {humanize(item.recommendation.type)} · {humanize(item.recommendation.status)}
            </span>
          </Row>
          <Row label="Decision">
            {humanize(item.decision.decision)} by {item.decision.decidedBy.email} on{" "}
            {item.decision.decidedAt.toLocaleString("en-GB")}
            {item.decision.reason ? (
              <span className="text-muted-foreground"> · “{item.decision.reason}”</span>
            ) : null}
          </Row>
          <Row label="Page">
            {item.page ? (
              <Link
                href={`/websites/${websiteId}/pages/${item.page.id}`}
                className="font-mono text-xs hover:underline"
              >
                {item.page.path}
              </Link>
            ) : (
              <span className="text-muted-foreground">None yet — new content</span>
            )}
          </Row>
          <Row label="Keyword">
            {item.keyword ? (
              <Link
                href={`/websites/${websiteId}/keywords/${item.keyword.id}`}
                className="hover:underline"
              >
                {item.keyword.keyword}
              </Link>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="Topic">
            {item.topic ? (
              <Link
                href={`/websites/${websiteId}/topics/${item.topic.id}`}
                className="hover:underline"
              >
                {item.topic.name}
              </Link>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="Owner">
            {item.owner ? (
              (item.owner.displayName ?? item.owner.email)
            ) : (
              <span className="text-muted-foreground">Unassigned</span>
            )}
          </Row>
          <Row label="Started">{item.createdAt.toLocaleString("en-GB")}</Row>
        </dl>
      </section>

      {/* ------------------------------------------------------ Brief */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Brief</h2>
          <Link href={`${base}/brief`} className="text-sm hover:underline">
            {brief ? "Open the brief →" : "Brief"}
          </Link>
        </div>
        {brief ? (
          <div className="border-border space-y-2 rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">v{brief.version}</span>
              <StatusBadge status={brief.status} />
              <span className="text-muted-foreground text-xs">
                {versions.length} version{versions.length === 1 ? "" : "s"}
                {awaiting > 0 ? ` · ${awaiting} awaiting review` : ""}
              </span>
            </div>
            <p className="text-sm font-medium">{brief.title}</p>
            {brief.status === "AWAITING_REVIEW" ? (
              <p className="text-sm">
                <span className="font-medium">Review pending.</span> An SEO lead, admin or owner
                needs to approve it before drafting begins.
              </p>
            ) : brief.status === "APPROVED" ? (
              <p className="text-muted-foreground text-sm">
                Approved. Drafting is the next step and starts when a person chooses to.
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">A draft, not yet sent for review.</p>
            )}
          </div>
        ) : (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
            No brief yet.{" "}
            {canWrite && briefable ? (
              <Link href={`${base}/brief`} className="text-foreground hover:underline">
                Generate one from the evidence, or write it by hand.
              </Link>
            ) : null}
          </p>
        )}
      </section>

      {/* ------------------------------------------------------ Draft */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Draft</h2>
          {draftView ? (
            <Link
              href={`${base}/draft?draft=${draftView.draft.id}`}
              className="text-sm hover:underline"
            >
              Open the draft →
            </Link>
          ) : null}
        </div>
        {draftView ? (
          <div className="border-border space-y-2 rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={draftView.draft.status} />
              {draftView.draft.status === "AWAITING_EDITOR_REVIEW" ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                  Review requested
                </span>
              ) : null}
              {blockingCount > 0 ? (
                <span className="inline-flex items-center rounded border border-red-300 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-red-800 uppercase dark:border-red-900 dark:text-red-300">
                  {blockingCount} blocking
                </span>
              ) : null}
              <span className="text-muted-foreground text-xs">
                based on Brief v{draftView.brief.version} · {draftView.revisionCount} revision
                {draftView.revisionCount === 1 ? "" : "s"}
              </span>
            </div>
            {draftView.current ? (
              <p className="text-sm">
                <span className="font-medium">{draftView.current.title}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · revision {draftView.current.revisionNumber} ·{" "}
                  {draftView.current.createdByAiRun ? "generated by AI" : "written by hand"}
                </span>
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">No revision yet.</p>
            )}
            {draftView.briefMismatch ? (
              <p className="text-sm">
                <span className="font-medium">
                  This draft is based on Brief v{draftView.brief.version}. Brief v
                  {draftView.briefMismatch.approvedVersion} is now approved.
                </span>{" "}
                <span className="text-muted-foreground">
                  Generation against v{draftView.brief.version} is closed; start a draft from v
                  {draftView.briefMismatch.approvedVersion} on the draft page.
                </span>
              </p>
            ) : null}
          </div>
        ) : brief?.status === "APPROVED" && item.status === "DRAFTING" && canWrite ? (
          <div className="border-border space-y-3 rounded-lg border border-dashed p-4">
            <p className="text-muted-foreground text-sm">
              No draft yet. It will be pinned to Brief v{brief.version}.
            </p>
            <StartDraftButton websiteId={websiteId} workItemId={item.id} />
          </div>
        ) : (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
            {brief?.status === "APPROVED"
              ? "No draft yet. A member or above can start one from the approved brief."
              : "A draft can start once a brief version is approved."}
          </p>
        )}

        {earlier.length > 0 ? (
          <div className="space-y-1">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Earlier drafts, superseded and kept
            </h3>
            <ul className="divide-border border-border divide-y rounded-lg border text-sm">
              {earlier.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                  <StatusBadge status={row.status} />
                  <span className="text-muted-foreground text-xs">
                    based on Brief v{row.briefVersion} · {row.revisionCount} revision
                    {row.revisionCount === 1 ? "" : "s"}
                  </span>
                  <Link href={`${base}/draft?draft=${row.id}`} className="text-xs hover:underline">
                    {row.currentTitle ?? "No revision"} →
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Next</h2>
        <p className="text-muted-foreground border-border rounded-lg border border-dashed p-4 text-sm">
          {draftView?.draft.status === "AWAITING_EDITOR_REVIEW"
            ? "An editor reviews the current revision. QA, approval and CMS steps follow in later milestones."
            : brief?.status === "APPROVED"
              ? "Draft, revise and request editorial review. QA, approval and CMS steps follow in later milestones."
              : "An approved brief comes first. Drafting, QA and CMS steps follow in later milestones."}
        </p>
      </section>

      <div className="flex flex-wrap gap-4 text-sm">
        <Link href={`/websites/${websiteId}/content`} className="hover:underline">
          ← Content Work
        </Link>
        <Link href={`/websites/${websiteId}/drafts`} className="hover:underline">
          Drafts
        </Link>
      </div>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5">
      <dt className="text-muted-foreground w-36 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
