import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { getContentWorkItem } from "@/server/services/content-work";
import { getQaRun, listQaRuns, qaProvenanceFor, qaSummaryFor } from "@/server/services/content-qa";
import { shortHash } from "@/lib/content/draft-ux";
import { qaControls, qaStatusLabel, qaWorkItemLabel } from "@/lib/content/qa-ux";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { humanize } from "@/components/diagnosis/primitives";
import {
  ApprovalPanel,
  FreshnessNotice,
  QaFindingsSection,
  QaProvenanceBlock,
  QaResultsTable,
  QaRunFailureNotice,
  QaRunHistory,
  QaStatusBadge,
} from "@/components/execution/qa-report";
import {
  ApproveForCmsForm,
  ReturnForRevisionForm,
  RunQaButton,
} from "@/components/execution/qa-controls";

export const metadata = { title: "QA report · SEO OS" };

/**
 * The QA report (M5.4 §3-§15).
 *
 * One run over one revision: the ten checks, what each found, what could not
 * be checked and why, where the report came from, and what a person may do
 * next. `?run=` opens a historical run, read-only; without it the latest run
 * is shown. The revision a report is about is the one the run pinned, never
 * whatever is current now.
 */
export default async function QaReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const { run: requestedRunId } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();
  const summary = await qaSummaryFor(context, workItemId);
  if (!summary) notFound();

  const runs = await listQaRuns(context, workItemId);
  const selectedId = requestedRunId ?? summary.latest?.id ?? null;
  const view = selectedId ? await getQaRun(context, selectedId) : null;
  if (requestedRunId && !view) notFound();
  const provenance = view ? await qaProvenanceFor(context, view.run.id) : null;

  const canWrite = hasRole(context.membership.role, REQUIRED.WRITE);
  const canReview = hasRole(context.membership.role, REQUIRED.REVIEW);
  const latest = summary.latest;
  const controls = qaControls({
    canWrite,
    canReview,
    itemStatus: summary.itemStatus,
    hasApprovedRevision: summary.approvedRevision !== null,
    runStatus: latest?.status ?? null,
    runOutcome: latest?.outcome ?? null,
    runCurrent: latest?.current,
    blockingCount: latest?.blockingCount ?? 0,
    // The service requires an acknowledgement for a QA type that could not be
    // checked at all; a partly covered type is a warning, not a gap.
    notCheckedTypes: view
      ? view.results.filter((result) => result.status === "NOT_CHECKED").length
      : 0,
    approved: summary.approval !== null,
    approvalStale: summary.approval !== null && !summary.approval.executable,
    briefSuperseded: summary.briefSuperseded,
  });
  const needsConfirmation = view
    ? view.results.reduce(
        (total, result) =>
          total + result.findings.filter((finding) => finding.needsHumanConfirmation).length,
        0,
      )
    : 0;
  const historical = view !== null && latest !== null && view.run.id !== latest.id;

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="QA report" description={`${item.title} · ${humanize(item.type)}`} />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap gap-4 text-sm" aria-label="This work">
        <Link href={`/websites/${websiteId}/qa`} className="hover:underline">
          QA queue
        </Link>
        <Link href={`/websites/${websiteId}/content/${workItemId}`} className="hover:underline">
          Work item
        </Link>
        <Link
          href={`/websites/${websiteId}/content/${workItemId}/draft`}
          className="hover:underline"
        >
          Draft
        </Link>
        <span aria-current="page" className="text-foreground font-medium">
          QA
        </span>
      </nav>

      <section
        aria-labelledby="qa-header"
        className="border-border space-y-2 rounded-lg border p-4"
      >
        <h2 id="qa-header" className="sr-only">
          What this report is about
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {qaWorkItemLabel(summary.itemStatus, latest?.outcome ?? null)}
          </span>
          {view && view.run.status === "COMPLETED" && view.run.outcome ? (
            <QaStatusBadge status={view.run.outcome} />
          ) : null}
          {historical ? (
            <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
              Historical run
            </span>
          ) : null}
        </div>
        {view ? (
          <dl className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <div className="flex gap-1">
              <dt>Revision</dt>
              <dd className="text-foreground">
                {view.run.revisionNumber} ·{" "}
                <span className="font-mono">{shortHash(view.run.revisionHash)}</span>
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>Brief</dt>
              <dd className="text-foreground">v{view.run.briefVersion}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Run</dt>
              <dd className="text-foreground">
                {view.run.status === "COMPLETED"
                  ? qaStatusLabel(view.run.outcome ?? "NOT_CHECKED")
                  : view.run.status === "RUNNING"
                    ? "Running"
                    : "Could not complete"}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>Requested by</dt>
              <dd className="text-foreground">{view.run.requestedBy.email}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Started</dt>
              <dd className="text-foreground">{view.run.startedAt.toLocaleString("en-GB")}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground text-xs">
            {summary.approvedRevision
              ? `Revision ${summary.approvedRevision.revisionNumber} (${shortHash(summary.approvedRevision.revisionHash)}) is approved and can be checked.`
              : "There is no approved revision to check."}
          </p>
        )}
        {view && view.run.status === "COMPLETED" ? (
          <FreshnessNotice currency={view.currency} runStatus={view.run.status} />
        ) : null}
      </section>

      {summary.approval ? <ApprovalPanel view={summary.approval} /> : null}

      <section aria-labelledby="qa-actions" className="space-y-3">
        <h2 id="qa-actions" className="text-sm font-medium">
          What you can do
        </h2>
        {controls.canRun ? (
          <RunQaButton
            websiteId={websiteId}
            workItemId={workItemId}
            label={controls.runLabel}
            revisionNumber={summary.approvedRevision?.revisionNumber ?? null}
            revisionHash={summary.approvedRevision?.revisionHash ?? null}
          />
        ) : controls.runReason ? (
          <p className="text-muted-foreground text-sm">{controls.runReason}</p>
        ) : null}

        {canReview && summary.itemStatus === "AWAITING_EDITOR_REVIEW" && latest && view ? (
          controls.canApprove ? (
            <ApproveForCmsForm
              websiteId={websiteId}
              workItemId={workItemId}
              revisionNumber={latest.revisionNumber}
              revisionHash={latest.revisionHash}
              runId={latest.id}
              outcome={qaStatusLabel(latest.outcome ?? "NOT_CHECKED")}
              blockingCount={latest.blockingCount}
              warningCount={latest.warningCount}
              notCheckedCount={latest.notCheckedCount}
              briefVersion={latest.briefVersion}
              approvedBriefVersion={summary.briefSuperseded ? null : undefined}
              needsNotCheckedAcknowledgement={controls.needsNotCheckedAcknowledgement}
              needsBriefAcknowledgement={controls.needsBriefAcknowledgement}
              needsConfirmation={{
                count: needsConfirmation,
                label:
                  needsConfirmation === 1
                    ? "AI judgment needs your confirmation."
                    : "AI judgments need your confirmation.",
              }}
            />
          ) : (
            <p className="text-muted-foreground text-sm">{controls.approveReason}</p>
          )
        ) : null}

        {controls.canReturn && summary.approvedRevision ? (
          <ReturnForRevisionForm
            websiteId={websiteId}
            workItemId={workItemId}
            draftId={summary.approvedRevision.draftId}
            revisionNumber={summary.approvedRevision.revisionNumber}
            hasApproval={summary.approval !== null}
          />
        ) : null}
      </section>

      {!view ? (
        <EmptyState>
          QA has not run for this work yet. Running it checks the exact approved revision and
          records what it finds; it never edits the content.
        </EmptyState>
      ) : view.run.status === "FAILED" ? (
        <QaRunFailureNotice
          run={{
            id: view.run.id,
            status: view.run.status,
            outcome: view.run.outcome,
            revisionNumber: view.run.revisionNumber,
            revisionHash: view.run.revisionHash,
            briefVersion: view.run.briefVersion,
            blockingCount: view.run.blockingCount,
            warningCount: view.run.warningCount,
            infoCount: view.run.infoCount,
            notCheckedCount: view.run.notCheckedCount,
            errorCode: view.run.errorCode,
            checkerVersion: view.run.checkerVersion,
            startedAt: view.run.startedAt,
            completedAt: view.run.completedAt,
            requestedBy: view.run.requestedBy.email,
          }}
        />
      ) : view.run.status === "RUNNING" ? (
        <EmptyState>
          QA is running over revision {view.run.revisionNumber}. This page shows the report when it
          finishes.
        </EmptyState>
      ) : (
        <>
          <section aria-labelledby="qa-checks" className="space-y-3">
            <h2 id="qa-checks" className="text-sm font-medium">
              The ten checks
            </h2>
            <QaResultsTable results={view.results} />
          </section>

          <section aria-labelledby="qa-findings" className="space-y-3">
            <h2 id="qa-findings" className="text-sm font-medium">
              What QA found
            </h2>
            <QaFindingsSection results={view.results} />
          </section>
        </>
      )}

      {provenance && view ? (
        <section aria-labelledby="qa-provenance" className="space-y-3">
          <h2 id="qa-provenance" className="text-sm font-medium">
            Where this report came from
          </h2>
          <QaProvenanceBlock
            provenance={provenance}
            run={{
              id: view.run.id,
              status: view.run.status,
              outcome: view.run.outcome,
              revisionNumber: view.run.revisionNumber,
              revisionHash: view.run.revisionHash,
              briefVersion: view.run.briefVersion,
              blockingCount: view.run.blockingCount,
              warningCount: view.run.warningCount,
              infoCount: view.run.infoCount,
              notCheckedCount: view.run.notCheckedCount,
              errorCode: view.run.errorCode,
              checkerVersion: view.run.checkerVersion,
              startedAt: view.run.startedAt,
              completedAt: view.run.completedAt,
              requestedBy: view.run.requestedBy.email,
            }}
          />
        </section>
      ) : null}

      {runs.length > 0 ? (
        <section aria-labelledby="qa-history" className="space-y-3">
          <h2 id="qa-history" className="text-sm font-medium">
            Every QA run for this work
          </h2>
          <p className="text-muted-foreground text-sm">
            A re-run adds a report; it never overwrites one. Open any of them read-only.
          </p>
          <QaRunHistory
            runs={runs}
            websiteId={websiteId}
            workItemId={workItemId}
            selectedRunId={view?.run.id ?? ""}
            currentRunId={latest?.current ? latest.id : null}
          />
        </section>
      ) : null}
    </main>
  );
}
