import Link from "next/link";

import type { QaQueueRow } from "@/server/services/content-qa";
import { DemoBadge } from "@/components/metrics/primitives";
import { humanize } from "@/components/diagnosis/primitives";
import { shortHash } from "@/lib/content/draft-ux";
import { qaStatusLabel, qaWorkItemLabel, staleReasonLabel } from "@/lib/content/qa-ux";
import { QaStatusBadge } from "@/components/execution/qa-report";

/**
 * Execution → QA (M5.4 §2). Every work item at or past the gate, most
 * actionable first, with the exact revision QA judged, what it found, and
 * whether the approval still means anything.
 */
export function QaQueueTable({
  rows,
  websiteId,
  isDemo,
}: {
  rows: QaQueueRow[];
  websiteId: string;
  isDemo: boolean;
}) {
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">Work items at the QA gate</caption>
        <thead className="bg-muted/40 text-muted-foreground text-left text-xs tracking-wide uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Work item
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Type
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Revision
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              State
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              QA outcome
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Blocking
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Warnings
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Not checked
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Freshness
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Approval
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Updated
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {rows.map((row) => (
            <tr key={row.workItemId} className="align-top">
              <td className="px-3 py-2">
                <Link
                  href={`/websites/${websiteId}/content/${row.workItemId}/qa`}
                  className="font-medium hover:underline"
                >
                  {row.title}
                </Link>
                {isDemo ? (
                  <span className="ml-2 align-middle">
                    <DemoBadge />
                  </span>
                ) : null}
              </td>
              <td className="text-muted-foreground px-3 py-2 text-xs">
                {row.contentType ? humanize(row.contentType) : "—"}
              </td>
              <td className="px-3 py-2 text-xs tabular-nums">
                {row.revisionNumber === null ? (
                  <span className="text-muted-foreground">None approved</span>
                ) : (
                  <>
                    {row.revisionNumber}
                    <span className="text-muted-foreground font-mono">
                      {" "}
                      {shortHash(row.revisionHash ?? "")}
                    </span>
                    {row.briefVersion !== null ? (
                      <span className="text-muted-foreground"> · Brief v{row.briefVersion}</span>
                    ) : null}
                  </>
                )}
              </td>
              <td className="px-3 py-2 text-xs">{qaWorkItemLabel(row.itemStatus, row.outcome)}</td>
              <td className="px-3 py-2">
                {row.runStatus === null ? (
                  <span className="text-muted-foreground text-xs">Not run</span>
                ) : row.runStatus === "RUNNING" ? (
                  <span className="text-muted-foreground text-xs">Running</span>
                ) : row.runStatus === "FAILED" ? (
                  <span className="text-xs text-red-700 dark:text-red-400">Did not complete</span>
                ) : (
                  <QaStatusBadge status={row.outcome ?? "NOT_CHECKED"} />
                )}
              </td>
              <td className="px-3 py-2 tabular-nums">{row.blockingCount}</td>
              <td className="px-3 py-2 tabular-nums">{row.warningCount}</td>
              <td className="px-3 py-2 tabular-nums">{row.notCheckedCount}</td>
              <td className="text-muted-foreground px-3 py-2 text-xs">
                {row.runStatus === null
                  ? "—"
                  : row.runCurrent
                    ? "Current"
                    : row.runStatus === "COMPLETED"
                      ? "Stale"
                      : "—"}
              </td>
              <td className="px-3 py-2 text-xs">
                {!row.approved ? (
                  <span className="text-muted-foreground">—</span>
                ) : row.approvalStale ? (
                  <>
                    <span className="text-amber-700 dark:text-amber-400">
                      Approved · QA now stale
                    </span>
                    <p className="text-muted-foreground">
                      {row.approvalStaleReasons.map(staleReasonLabel)[0] ?? ""}
                    </p>
                  </>
                ) : (
                  <>
                    <span>Approved for CMS</span>
                    <p className="text-muted-foreground">
                      {row.approvedBy}
                      {row.selfDecided ? " · self-approval recorded" : ""}
                    </p>
                  </>
                )}
              </td>
              <td className="text-muted-foreground px-3 py-2 text-xs">
                {row.updatedAt.toLocaleDateString("en-GB")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The one-line QA state for the Content Work queue (M5.4 §18). */
export function QaCell({ label }: { label: string }) {
  return <span className="text-xs">{label}</span>;
}

export { qaStatusLabel };
