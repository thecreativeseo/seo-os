import Link from "next/link";

import type { QaRunSummary, QaSummary } from "@/server/services/content-qa";
import { shortHash } from "@/lib/content/draft-ux";
import {
  freshnessLabel,
  freshnessReason,
  qaRunStatusLabel,
  qaWorkItemLabel,
  staleReasonLabel,
} from "@/lib/content/qa-ux";
import { QaStatusBadge } from "@/components/execution/qa-report";

/**
 * QA where the work is (M5.4 §16, §17): a short panel in the draft
 * workspace, and the runs that judged one revision on the revision page.
 * Both link to the report rather than repeating it.
 */

export function QaSummaryCard({
  summary,
  websiteId,
  workItemId,
}: {
  summary: QaSummary;
  websiteId: string;
  workItemId: string;
}) {
  const { latest, approval } = summary;
  const href = `/websites/${websiteId}/content/${workItemId}/qa`;

  return (
    <section aria-labelledby="qa-summary" className="border-border space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="qa-summary" className="text-sm font-medium">
          QA
        </h2>
        <Link href={href} className="text-xs hover:underline">
          Open QA report
        </Link>
      </div>

      <p className="text-muted-foreground text-xs">
        {qaWorkItemLabel(summary.itemStatus, latest?.outcome ?? null)}
        {summary.approvedRevision
          ? ` · revision ${summary.approvedRevision.revisionNumber} (${shortHash(summary.approvedRevision.revisionHash)})`
          : " · no approved revision"}
      </p>

      {!latest ? (
        <p className="text-sm">
          QA has not run for this work yet.{" "}
          {summary.approvedRevision
            ? "Run it from the QA report."
            : "Approve a draft first, then run QA."}
        </p>
      ) : latest.status === "RUNNING" ? (
        <p className="text-sm">QA is running.</p>
      ) : latest.status === "FAILED" ? (
        <p className="text-sm text-red-700 dark:text-red-400">
          The last QA run could not be completed. Nothing was recorded as passed.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <QaStatusBadge status={latest.outcome ?? "NOT_CHECKED"} />
            <span className="text-muted-foreground text-xs">
              {freshnessLabel(latest.currency, latest.status)} · revision {latest.revisionNumber} ·{" "}
              {(latest.completedAt ?? latest.startedAt).toLocaleString("en-GB")}
            </span>
          </div>
          <dl className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <div className="flex gap-1">
              <dt>Blocking</dt>
              <dd className="text-foreground tabular-nums">{latest.blockingCount}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Warnings</dt>
              <dd className="text-foreground tabular-nums">{latest.warningCount}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Not checked</dt>
              <dd className="text-foreground tabular-nums">{latest.notCheckedCount}</dd>
            </div>
          </dl>
          {!latest.current ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {freshnessReason(latest.currency)} Re-run QA from the report.
            </p>
          ) : null}
        </>
      )}

      {approval ? (
        <p
          className={`text-xs ${approval.executable ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}`}
        >
          {approval.executable
            ? `Approved for CMS by ${approval.approval.approvedBy.email}. No CMS action has been performed.`
            : `Approved for CMS, but QA is now stale: ${staleReasonLabel(approval.staleReasons[0] ?? "")} Re-run QA and approve again before execution.`}
        </p>
      ) : null}
    </section>
  );
}

/** The QA runs that judged exactly this revision (M5.4 §17). */
export function RevisionQaRuns({
  runs,
  websiteId,
  workItemId,
  currentRunId,
}: {
  runs: QaRunSummary[];
  websiteId: string;
  workItemId: string;
  currentRunId: string | null;
}) {
  return (
    <section aria-labelledby="revision-qa" className="space-y-2">
      <h2 id="revision-qa" className="text-sm font-medium">
        QA runs for this revision
      </h2>
      {runs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No QA run has judged this revision. A run judges exactly one revision, so a run of another
          revision never appears here.
        </p>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <Link
                href={`/websites/${websiteId}/content/${workItemId}/qa?run=${run.id}`}
                className="hover:underline"
              >
                {(run.completedAt ?? run.startedAt).toLocaleString("en-GB")}
              </Link>
              {run.status === "COMPLETED" && run.outcome ? (
                <QaStatusBadge status={run.outcome} />
              ) : (
                <span className="text-muted-foreground text-xs">
                  {qaRunStatusLabel(run.status)}
                </span>
              )}
              <span className="text-muted-foreground text-xs tabular-nums">
                {run.blockingCount} blocking · {run.warningCount} warnings · {run.notCheckedCount}{" "}
                not checked
              </span>
              <span className="text-muted-foreground text-xs">
                {run.id === currentRunId ? "Current" : "Historical"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
