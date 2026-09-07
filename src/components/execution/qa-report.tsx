import Link from "next/link";

import type { QaFinding } from "@/lib/content/qa/findings";
import type { QaResultView, QaRunSummary } from "@/server/services/content-qa";
import type { CmsApprovalView, QaProvenance } from "@/server/services/content-qa";
import { shortHash } from "@/lib/content/draft-ux";
import {
  fieldLabel,
  findingPresentation,
  findingSourceLabel,
  freshnessLabel,
  freshnessReason,
  groupFindings,
  notCheckedKind,
  notCheckedNext,
  notCheckedReasonLabel,
  qaRunStatusLabel,
  qaSourceLabel,
  qaStatusLabel,
  qaStatusTone,
  qaTypeDescription,
  qaTypeLabel,
  severityLabel,
  shortFingerprint,
  staleReasonLabel,
  type Currency,
} from "@/lib/content/qa-ux";

/**
 * The QA report (M5.4 §3-§9). Every state is a word before it is a colour,
 * every finding says what it is, why it matters, where it was found, who
 * found it and what to do next, and a check that did not run says so rather
 * than passing quietly.
 */

const TONE: Record<string, string> = {
  pass: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-600/40 text-amber-700 dark:text-amber-400",
  fail: "border-red-600/40 text-red-700 dark:text-red-400",
  unknown: "border-border text-muted-foreground",
};

export function QaStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${TONE[qaStatusTone(status)]}`}
    >
      {qaStatusLabel(status)}
    </span>
  );
}

/** Measured, judged, or both - never left to a colour. */
export function SourceBadge({ source }: { source: string }) {
  return (
    <span className="border-border text-muted-foreground inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
      {qaSourceLabel(source)}
    </span>
  );
}

/** The ten checks, complete, whatever each one says. */
export function QaResultsTable({ results }: { results: QaResultView[] }) {
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">The ten QA checks and what each found</caption>
        <thead className="bg-muted/40 text-muted-foreground text-left text-xs tracking-wide uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Check
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Outcome
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Found by
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Findings
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {results.map((result) => {
            const counted = result.findings.filter((finding) => finding.code !== "NOT_CHECKED");
            return (
              <tr key={result.id} className="align-top">
                <td className="px-3 py-2">
                  <p className="font-medium">{qaTypeLabel(result.qaType)}</p>
                  <p className="text-muted-foreground text-xs">
                    {qaTypeDescription(result.qaType)}
                  </p>
                </td>
                <td className="px-3 py-2">
                  <QaStatusBadge status={result.status} />
                  {result.status === "NOT_CHECKED" ? (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {notCheckedReasonLabel(result.notCheckedReason)}
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <SourceBadge source={result.source} />
                </td>
                <td className="text-muted-foreground px-3 py-2 text-xs tabular-nums">
                  {counted.length === 0 ? "None" : counted.length}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FindingCard({ finding }: { finding: QaFinding }) {
  const presentation = findingPresentation(finding);
  const where = fieldLabel(finding.field);
  return (
    <li className="border-border space-y-1 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{presentation.title}</span>
        <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
          {severityLabel(finding.severity)}
        </span>
        <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
          {findingSourceLabel(finding.source)}
        </span>
        {finding.needsHumanConfirmation ? (
          <span className="rounded border border-amber-600/40 px-1.5 py-0.5 text-[10px] tracking-wide text-amber-700 uppercase dark:text-amber-400">
            Needs human confirmation
          </span>
        ) : null}
        {where ? <span className="text-muted-foreground text-xs">in {where}</span> : null}
      </div>
      <p className="text-sm">{finding.message}</p>
      {finding.excerpt ? (
        <blockquote className="border-border text-muted-foreground border-l-2 pl-3 text-xs italic">
          {finding.excerpt}
        </blockquote>
      ) : null}
      {finding.excerptNote ? (
        <p className="text-muted-foreground text-xs">{finding.excerptNote}</p>
      ) : null}
      <dl className="text-muted-foreground grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="font-medium">Why it matters:</dt>
          <dd>{presentation.why}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium">What to do:</dt>
          <dd>{presentation.next}</dd>
        </div>
      </dl>
      {finding.refs ? <Refs refs={finding.refs} /> : null}
    </li>
  );
}

function Refs({ refs }: { refs: NonNullable<QaFinding["refs"]> }) {
  const rows: [string, string][] = [];
  if (refs.factId) rows.push(["Brand fact", refs.factId]);
  if (refs.ruleId) rows.push(["SEO rule", refs.ruleId]);
  if (refs.pagePath) rows.push(["Page", refs.pagePath]);
  else if (refs.pageId) rows.push(["Page", refs.pageId]);
  if (refs.question) rows.push(["Brief question", refs.question]);
  if (refs.section) rows.push(["Section", refs.section]);
  if (refs.evidenceId) rows.push(["Evidence", refs.evidenceId]);
  if (refs.category) rows.push(["Category", refs.category]);
  if (rows.length === 0) return null;
  return (
    <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
      {rows.map(([label, value]) => (
        <li key={`${label}:${value}`}>
          <span className="font-medium">{label}:</span>{" "}
          <span className="font-mono">{value.length > 40 ? `${value.slice(0, 40)}…` : value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Blocking first, then warnings, then information, then what did not run. */
export function QaFindingsSection({ results }: { results: QaResultView[] }) {
  const grouped = groupFindings(results.flatMap((result) => result.findings));
  const sections: [string, string, QaFinding[]][] = [
    ["Blocking", "These cannot be accepted. The draft has to change.", grouped.blocking],
    [
      "Warnings",
      "A person can accept these by approving, and that acceptance is recorded.",
      grouped.warning,
    ],
    ["For information", "Nothing here stops anything.", grouped.info],
  ];

  return (
    <div className="space-y-6">
      {sections.map(([title, note, findings]) => (
        <section key={title} className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-sm font-medium">
              {title}{" "}
              <span className="text-muted-foreground tabular-nums">({findings.length})</span>
            </h3>
            <p className="text-muted-foreground text-xs">{note}</p>
          </div>
          {findings.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing.</p>
          ) : (
            <ul className="space-y-2">
              {findings.map((finding, index) => (
                <FindingCard key={`${finding.code}-${index}`} finding={finding} />
              ))}
            </ul>
          )}
        </section>
      ))}
      <NotCheckedSection results={results} />
    </div>
  );
}

/** A check that did not run never reads as a pass. */
export function NotCheckedSection({ results }: { results: QaResultView[] }) {
  const rows = results.flatMap((result) =>
    result.coverage
      .filter((entry) => entry.status === "NOT_CHECKED")
      .map((entry) => ({
        qaType: result.qaType,
        check: entry.check,
        reason: entry.reason ?? null,
        whole: result.status === "NOT_CHECKED",
      })),
  );

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-medium">
          Not checked <span className="text-muted-foreground tabular-nums">({rows.length})</span>
        </h3>
        <p className="text-muted-foreground text-xs">
          These were not checked at all. They are not passes.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Everything was checked.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={`${row.qaType}-${row.check}`}
              className="border-border space-y-1 rounded-lg border border-dashed p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{qaTypeLabel(row.qaType)}</span>
                <span className="text-muted-foreground text-xs">
                  {row.whole ? "not checked" : `partly: ${row.check.replace(/_/g, " ")}`}
                </span>
                <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
                  {notCheckedKind(row.reason)}
                </span>
              </div>
              <p className="text-sm">{notCheckedReasonLabel(row.reason)}</p>
              <p className="text-muted-foreground text-xs">{notCheckedNext(row.reason)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2 py-1">
      <dt className="text-muted-foreground w-40 shrink-0 text-xs">{label}</dt>
      <dd className="text-xs">{children}</dd>
    </div>
  );
}

/** What produced this report, read from the run rather than assumed. */
export function QaProvenanceBlock({
  provenance,
  run,
}: {
  provenance: QaProvenance;
  run: QaRunSummary;
}) {
  return (
    <dl className="divide-border divide-y">
      <Row label="QA run">
        <span className="font-mono">{provenance.runId}</span>
      </Row>
      <Row label="Revision">
        {run.revisionNumber} · <span className="font-mono">{shortHash(run.revisionHash)}</span>
      </Row>
      <Row label="Brief version">v{run.briefVersion}</Row>
      <Row label="Business Context">
        {provenance.contextVersionId ? (
          <span className="font-mono">{provenance.contextVersionId}</span>
        ) : (
          "Not recorded"
        )}
      </Row>
      <Row label="Checker version">
        <span className="font-mono">{provenance.checkerVersion}</span>
      </Row>
      <Row label="Inputs fingerprint">
        <span className="font-mono">{shortFingerprint(provenance.inputsFingerprint)}</span>
        <span className="text-muted-foreground">
          {" "}
          · the facts, rules and context judged against
        </span>
      </Row>
      <Row label="Evidence package">
        {provenance.evidencePackage ? (
          <>
            <span className="font-mono">{provenance.evidencePackage.contentHash}</span>
            <span className="text-muted-foreground">
              {" "}
              · {provenance.evidencePackage.evidenceCount} records ·{" "}
              {provenance.evidencePackage.sealedAt ? "sealed" : "not sealed"}
              {provenance.evidencePackage.retrievalPolicy
                ? ` · ${provenance.evidencePackage.retrievalPolicy.name} v${provenance.evidencePackage.retrievalPolicy.version}`
                : ""}
            </span>
          </>
        ) : (
          "No package is attached to this run."
        )}
      </Row>
      <Row label="AI judge">
        {provenance.aiRun ? (
          <>
            {provenance.aiRun.provider} · {provenance.aiRun.model} · prompt v
            {provenance.aiRun.promptTemplateVersion ?? "?"} · schema v
            {provenance.aiRun.outputSchemaVersion}
            <span className="text-muted-foreground">
              {" "}
              · {provenance.aiRun.status.toLowerCase()}
              {provenance.aiRun.inputTokens !== null
                ? ` · ${provenance.aiRun.inputTokens} in / ${provenance.aiRun.outputTokens ?? 0} out`
                : ""}
            </span>
          </>
        ) : (
          "No AI judge ran for this report; the judged checks were not checked."
        )}
      </Row>
      <Row label="Requested by">{provenance.requestedBy}</Row>
      <Row label="Started">{provenance.startedAt.toLocaleString("en-GB")}</Row>
      <Row label="Completed">
        {provenance.completedAt ? provenance.completedAt.toLocaleString("en-GB") : "Not completed"}
      </Row>
    </dl>
  );
}

/** Every run this work item has had. A re-run adds; it never overwrites. */
export function QaRunHistory({
  runs,
  websiteId,
  workItemId,
  selectedRunId,
  currentRunId,
}: {
  runs: QaRunSummary[];
  websiteId: string;
  workItemId: string;
  selectedRunId: string;
  currentRunId: string | null;
}) {
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">Every QA run for this work item</caption>
        <thead className="bg-muted/40 text-muted-foreground text-left text-xs tracking-wide uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Run
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Revision
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Outcome
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
              Checker
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              State
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {runs.map((run) => (
            <tr key={run.id} className="align-top">
              <td className="px-3 py-2">
                <Link
                  href={`/websites/${websiteId}/content/${workItemId}/qa?run=${run.id}`}
                  className="hover:underline"
                  aria-current={run.id === selectedRunId ? "page" : undefined}
                >
                  {(run.completedAt ?? run.startedAt).toLocaleString("en-GB")}
                </Link>
                <p className="text-muted-foreground text-xs">by {run.requestedBy}</p>
              </td>
              <td className="px-3 py-2 tabular-nums">
                {run.revisionNumber}
                <span className="text-muted-foreground font-mono text-xs">
                  {" "}
                  {shortHash(run.revisionHash)}
                </span>
              </td>
              <td className="px-3 py-2">
                {run.status === "COMPLETED" && run.outcome ? (
                  <QaStatusBadge status={run.outcome} />
                ) : (
                  <span className="text-muted-foreground text-xs">
                    {qaRunStatusLabel(run.status)}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 tabular-nums">{run.blockingCount}</td>
              <td className="px-3 py-2 tabular-nums">{run.warningCount}</td>
              <td className="px-3 py-2 tabular-nums">{run.notCheckedCount}</td>
              <td className="text-muted-foreground px-3 py-2 font-mono text-xs">
                {run.checkerVersion ?? "—"}
              </td>
              <td className="text-muted-foreground px-3 py-2 text-xs">
                {run.id === currentRunId ? "Current" : "Historical"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A run that could not finish is a run failure, never a set of passes. */
export function QaRunFailureNotice({ run }: { run: QaRunSummary }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-red-600/40 p-4 text-sm text-red-700 dark:text-red-400"
    >
      <p className="font-medium">QA could not be completed</p>
      <p className="mt-1">
        {run.errorCode === "revision_changed"
          ? "The approved revision changed while QA was running. Nothing was recorded; run QA again."
          : "A check could not finish, so nothing was recorded as passed. Run QA again."}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        Run <span className="font-mono">{run.id}</span> · started{" "}
        {run.startedAt.toLocaleString("en-GB")}
      </p>
    </div>
  );
}

/** Whether a report still speaks for the work, in words. */
export function FreshnessNotice({
  currency,
  runStatus,
}: {
  currency: Currency;
  runStatus: string;
}) {
  const label = freshnessLabel(currency, runStatus);
  const reason = freshnessReason(currency);
  if (label === "Current") {
    return (
      <p className="text-muted-foreground text-sm">
        Current: this report is the latest for the approved revision, and the facts and rules behind
        it have not changed.
      </p>
    );
  }
  return (
    <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
      <span className="font-medium">{label}.</span> {reason} Run QA again before approving.
    </p>
  );
}

/**
 * The approval, and separately whether it may still authorize execution
 * (M5.4 §13, §14). A stale approval is never presented as ready.
 */
export function ApprovalPanel({ view }: { view: CmsApprovalView }) {
  const { approval, executable, staleReasons } = view;
  const acknowledged = (approval.acknowledgedJson ?? null) as {
    notChecked?: { qaType: string }[];
    needsHumanConfirmation?: unknown[];
  } | null;

  return (
    <section className="border-border space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">Approved for CMS</h2>
        {approval.selfDecided ? (
          <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
            Self-approval recorded
          </span>
        ) : null}
      </div>
      <dl className="divide-border divide-y">
        <Row label="Revision">
          {approval.revisionNumber} ·{" "}
          <span className="font-mono">{shortHash(approval.revisionHash)}</span>
        </Row>
        <Row label="QA run">
          <span className="font-mono">{approval.qaRunId}</span>
        </Row>
        <Row label="Brief version">v{approval.briefVersion}</Row>
        <Row label="Approved by">
          {approval.approvedBy.email} on {approval.approvedAt.toLocaleString("en-GB")}
        </Row>
        {approval.note ? <Row label="Note">{approval.note}</Row> : null}
        <Row label="Acknowledged">
          {approval.notCheckedAcknowledged
            ? `${acknowledged?.notChecked?.length ?? 0} check${(acknowledged?.notChecked?.length ?? 0) === 1 ? "" : "s"} that did not run`
            : "No unchecked checks"}
          {approval.briefSupersededAcknowledged ? " · a newer brief version" : ""}
          {acknowledged?.needsHumanConfirmation?.length
            ? ` · ${acknowledged.needsHumanConfirmation.length} judgment${acknowledged.needsHumanConfirmation.length === 1 ? "" : "s"} needing confirmation`
            : ""}
        </Row>
      </dl>

      {executable ? (
        <p className="text-muted-foreground text-sm">
          No CMS action has been performed. Nothing is published; execution comes later.
        </p>
      ) : (
        <div
          role="status"
          className="space-y-1 rounded-md border border-amber-600/40 p-3 text-sm text-amber-700 dark:text-amber-400"
        >
          <p className="font-medium">QA is now stale</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {staleReasons.map((reason) => (
              <li key={reason}>{staleReasonLabel(reason)}</li>
            ))}
          </ul>
          <p className="text-xs">
            This approval stays on the record as what it was. It cannot authorize execution now: run
            QA again and obtain a fresh human approval first.
          </p>
        </div>
      )}
    </section>
  );
}
