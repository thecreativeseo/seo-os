import type { DraftFinding } from "@/lib/content/constraints";
import type { ReconciledClaim } from "@/lib/content/reconcile";
import { describeFinding, groupFindings, reviewBlockers } from "@/lib/content/draft-ux";

/**
 * What the server found in a revision, grouped by severity and explained
 * (M4.4 §5): what happened, why it matters, what to do next, and where the
 * rule comes from. Never the raw JSON. Severity is written as a word on
 * every row, so it never rests on colour alone.
 */

const SEVERITY_LABEL: Record<DraftFinding["severity"], string> = {
  BLOCKING: "Blocking",
  WARNING: "Warning",
  INFO: "Note",
};

const SEVERITY_TONE: Record<DraftFinding["severity"], string> = {
  BLOCKING: "border-red-300 text-red-800 dark:border-red-900 dark:text-red-300",
  WARNING: "border-amber-300 text-amber-800 dark:border-amber-900 dark:text-amber-300",
  INFO: "border-border text-muted-foreground",
};

export function SeverityLabel({ severity }: { severity: DraftFinding["severity"] }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase ${SEVERITY_TONE[severity]}`}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

function FindingItem({ finding }: { finding: DraftFinding }) {
  const explained = describeFinding(finding);
  return (
    <li className="space-y-1 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityLabel severity={finding.severity} />
        <span className="font-medium">{explained.title}</span>
        {finding.field ? (
          <span className="text-muted-foreground text-xs">
            in {finding.field.replace(/_/g, " ")}
          </span>
        ) : null}
      </div>
      <p>{explained.what}</p>
      {finding.excerpt ? (
        <p className="text-muted-foreground text-xs break-words">“{finding.excerpt}”</p>
      ) : null}
      {finding.url ? <p className="font-mono text-xs break-all">{finding.url}</p> : null}
      <dl className="text-muted-foreground grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[6rem_1fr]">
        <dt>Why it matters</dt>
        <dd>{explained.why}</dd>
        <dt>What to do</dt>
        <dd className="text-foreground">{explained.next}</dd>
        {explained.source ? (
          <>
            <dt>Comes from</dt>
            <dd>
              {explained.source}
              {finding.ruleId ? (
                <span className="font-mono"> · rule {finding.ruleId.slice(0, 8)}…</span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
    </li>
  );
}

export function FindingsPanel({
  findings,
  staleClaims = [],
}: {
  findings: DraftFinding[];
  staleClaims?: ReconciledClaim[];
}) {
  const groups = groupFindings(findings);
  const order: DraftFinding["severity"][] = ["BLOCKING", "WARNING", "INFO"];
  const empty = findings.length === 0 && staleClaims.length === 0;

  return (
    <section aria-labelledby="findings-heading" className="space-y-3">
      <h2 id="findings-heading" className="text-sm font-medium">
        Findings
        <span className="text-muted-foreground font-normal">
          {" "}
          · {groups.BLOCKING.length} blocking · {groups.WARNING.length} warning ·{" "}
          {groups.INFO.length} note
        </span>
      </h2>

      {empty ? (
        <p className="text-muted-foreground text-sm">
          Nothing to report. The revision met every check the server runs.
        </p>
      ) : null}

      {order.map((severity) =>
        groups[severity].length > 0 ? (
          <div key={severity} className="space-y-1.5">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {SEVERITY_LABEL[severity]}
              {severity === "BLOCKING"
                ? " — must be resolved before review"
                : severity === "WARNING"
                  ? " — QA will look at these"
                  : ""}
            </h3>
            <ul className="divide-border border-border divide-y rounded-lg border">
              {groups[severity].map((finding, index) => (
                <FindingItem key={`${finding.kind}-${index}`} finding={finding} />
              ))}
            </ul>
          </div>
        ) : null,
      )}

      {staleClaims.length > 0 ? (
        <div className="border-border rounded-lg border border-dashed p-3 text-sm">
          <p className="font-medium">
            {staleClaims.length} brief claim{staleClaims.length === 1 ? "" : "s"} no longer
            supported
          </p>
          <p className="text-muted-foreground text-xs">
            A fact the approved brief relied on has since been revoked. These were not offered to
            the writer and must not appear in the draft.
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {staleClaims.map((claim) => (
              <li key={claim.evidenceId}>
                “{claim.text}” — {claim.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** Exactly what must change before Request review is offered. */
export function ReviewBlockers({ findings }: { findings: DraftFinding[] }) {
  const blockers = reviewBlockers(findings);
  if (blockers.length === 0) return null;
  return (
    <div role="status" className="rounded-lg border border-red-300 p-3 text-sm dark:border-red-900">
      <p className="font-medium">
        Request review is not available: {blockers.length} thing
        {blockers.length === 1 ? "" : "s"} to fix in a new revision.
      </p>
      <ol className="mt-1 list-decimal pl-5 text-xs">
        {blockers.map((blocker) => (
          <li key={blocker}>{blocker}</li>
        ))}
      </ol>
    </div>
  );
}
