import type { Evidence } from "@/lib/evidence/types";
import { RELIABILITY_LABELS } from "@/lib/evidence/types";
import {
  describeOmitted,
  describeQueryCoverage,
  formatChange,
  formatMetric,
  formatPeriod,
  type EvidenceView,
  type MeasuredSubject,
  type MetricRow,
  type SourceGroup,
} from "@/lib/evidence/presentation";

/**
 * Small, server-safe pieces for the P3 screens (docs/P3_SPEC.md §31).
 *
 * Two rules hold across all of them. Every enum is shown as words a person
 * would say — "Keyword ownership conflict", not KEYWORD_OWNERSHIP_CONFLICT —
 * and every piece of evidence carries its provenance on its face: where it came
 * from and how much weight that source carries, because §10 says an inferred
 * record and a measured one must never look the same.
 */

export function humanize(value: string | null | undefined): string {
  if (!value) return "";
  const lower = value.toLowerCase().replaceAll("_", " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const badge = "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium";

const VERDICT_TONE: Record<string, string> = {
  CONFIRMED: "border-emerald-700/40 text-emerald-700 dark:text-emerald-400",
  STRONGLY_SUPPORTED: "border-emerald-700/40 text-emerald-700 dark:text-emerald-400",
  SUSPECT: "border-amber-700/40 text-amber-700 dark:text-amber-400",
  CLEAR: "border-border text-muted-foreground",
  UNKNOWN: "border-border text-muted-foreground",
  NOT_APPLICABLE: "border-border text-muted-foreground",
};

export function VerdictBadge({ verdict }: { verdict: string }) {
  return (
    <span className={`${badge} ${VERDICT_TONE[verdict] ?? "border-border"}`}>
      {humanize(verdict)}
    </span>
  );
}

const LEVEL_TONE: Record<string, string> = {
  HIGH: "border-foreground/40",
  MEDIUM: "border-border",
  LOW: "border-border text-muted-foreground",
  UNKNOWN: "border-dashed border-border text-muted-foreground",
  CRITICAL: "border-red-700/40 text-red-700 dark:text-red-400",
};

export function ConfidenceBadge({ level }: { level: string }) {
  return (
    <span className={`${badge} ${LEVEL_TONE[level] ?? "border-border"}`}>
      Confidence {humanize(level).toLowerCase()}
    </span>
  );
}

/** Effort, risk, priority: one shape, labelled. */
export function LevelBadge({ label, level }: { label: string; level: string }) {
  return (
    <span className={`${badge} ${LEVEL_TONE[level] ?? "border-border"}`}>
      {label} {humanize(level).toLowerCase()}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  AWAITING_REVIEW: "border-amber-700/40 text-amber-700 dark:text-amber-400",
  NEEDS_EVIDENCE: "border-dashed border-border text-muted-foreground",
  APPROVED: "border-emerald-700/40 text-emerald-700 dark:text-emerald-400",
  MODIFIED: "border-emerald-700/40 text-emerald-700 dark:text-emerald-400",
  REJECTED: "border-border text-muted-foreground",
  REVIEWED: "border-emerald-700/40 text-emerald-700 dark:text-emerald-400",
  SUPERSEDED: "border-border text-muted-foreground",
  ARCHIVED: "border-border text-muted-foreground",
  DRAFT: "border-border text-muted-foreground",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`${badge} ${STATUS_TONE[status] ?? "border-border"}`}>{humanize(status)}</span>
  );
}

function formatValue(evidence: Evidence): string | null {
  if (evidence.numericValue !== null) {
    const number = Number(evidence.numericValue);
    const shown = Number.isInteger(number) ? number.toLocaleString("en-GB") : number.toFixed(2);
    return evidence.metricKey ? `${humanize(evidence.metricKey)}: ${shown}` : shown;
  }
  return evidence.metricKey ? humanize(evidence.metricKey) : null;
}

function truncate(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One evidence record, provenance first.
 *
 * The reliability label sits beside the source on purpose. "Reported by a
 * connected provider" and "Inferred by a model" are different kinds of claim,
 * and a reader should not have to know the enum to tell them apart.
 */
export function EvidenceCard({
  evidence,
  relationship,
}: {
  evidence: Evidence;
  relationship?: string;
}) {
  const value = formatValue(evidence);

  return (
    <li className="border-border space-y-1 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{humanize(evidence.type)}</span>
        {relationship ? (
          <span className="text-muted-foreground text-xs">{humanize(relationship)}</span>
        ) : null}
        <span className="text-muted-foreground text-xs">
          {evidence.source} · {RELIABILITY_LABELS[evidence.reliability]}
          {evidence.asOfDate ? ` · as of ${evidence.asOfDate.toISOString().slice(0, 10)}` : ""}
        </span>
      </div>
      {value ? <p className="tabular-nums">{value}</p> : null}
      {evidence.textValue ? (
        <p className="text-muted-foreground leading-relaxed">{truncate(evidence.textValue)}</p>
      ) : null}
    </li>
  );
}

export function EvidenceList({
  evidence,
  emptyText,
  relationships,
}: {
  evidence: Evidence[];
  emptyText: string;
  /** Optional per-id relationship label (SUPPORTS / CONTRADICTS). */
  relationships?: Map<string, string>;
}) {
  if (evidence.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyText}</p>;
  }

  return (
    <ul className="space-y-2">
      {evidence.map((record) => (
        <EvidenceCard
          key={record.id}
          evidence={record}
          relationship={relationships?.get(record.id)}
        />
      ))}
    </ul>
  );
}

/** §20: an unstated unknown becomes an assumption, so these get equal weight. */
export function MissingEvidenceList({ items }: { items: unknown }) {
  const list = Array.isArray(items) ? items.filter((item) => typeof item === "string") : [];

  if (list.length === 0) return null;

  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs font-medium">Missing evidence</p>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {list.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** IDs the screen could not resolve to a record today. Shown, never dropped. */
export function StaleEvidenceNote({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;

  return (
    <p className="text-muted-foreground text-xs">
      {ids.length} cited record{ids.length === 1 ? "" : "s"} no longer resolve
      {ids.length === 1 ? "s" : ""} — the underlying row has since changed or been removed. The
      diagnosis is shown as it was made.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Evidence, grouped
// ---------------------------------------------------------------------------

/**
 * Evidence as measured facts, grouped by where they were measured.
 *
 * A diagnosis is an interpretation; this is what it was interpreting. The
 * separation matters enough to show structurally: findings read as claims, and
 * everything here reads as a table of figures with dates on it.
 *
 * One card per record was the previous shape, which meant a page's clicks and
 * the same page's clicks four weeks earlier sat in two different boxes with the
 * word "window" where the metric name should have been. They belong on one row.
 */
export function EvidenceSummary({ view, stale }: { view: EvidenceView; stale?: string[] }) {
  if (view.groups.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No evidence records resolve for this diagnosis.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {view.groups.map((group) => (
        <SourceGroupCard group={group} key={group.source} />
      ))}
      <TechnicalProvenance stale={stale ?? []} view={view} />
    </div>
  );
}

function periodHeading(group: SourceGroup): string | null {
  const current = formatPeriod(group.current);
  if (!current) return null;
  const previous = formatPeriod(group.previous);
  return previous ? `${current} vs ${previous}` : current;
}

function SourceGroupCard({ group }: { group: SourceGroup }) {
  const heading = periodHeading(group);
  const queries = group.subjects.filter((subject) => subject.kind === "query");
  const totals = group.subjects.filter((subject) => subject.kind !== "query");

  return (
    <section className="border-border space-y-3 rounded-lg border p-4">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{group.source}</h3>
        {/*
          Provenance once for the whole group rather than repeated on every
          record, which is what made the old list unreadable.
        */}
        <p className="text-muted-foreground text-xs">
          {group.reliabilityLabel}
          {group.dataThrough
            ? ` · data through ${group.dataThrough.toISOString().slice(0, 10)}`
            : ""}
        </p>
        {heading ? <p className="text-muted-foreground text-xs">{heading}</p> : null}
      </div>

      {totals.map((subject) => (
        <div className="space-y-1" key={subject.key}>
          {group.subjects.length > 1 ? (
            <p className="text-muted-foreground truncate text-xs" title={subject.label}>
              {subject.label}
            </p>
          ) : null}
          <MetricTable metrics={subject.metrics} showPrevious={group.previous !== null} />
        </div>
      ))}

      {queries.length > 0 ? <QueryTable subjects={queries} /> : null}

      {group.records.length > 0 ? (
        <ul className="space-y-2">
          {group.records.map((record) => (
            <EvidenceCard evidence={record} key={record.id} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function changeClass(direction: "up" | "down" | "flat"): string {
  if (direction === "up") return "text-emerald-600";
  if (direction === "down") return "text-red-600";
  return "text-muted-foreground";
}

function MetricTable({ metrics, showPrevious }: { metrics: MetricRow[]; showPrevious: boolean }) {
  if (metrics.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-left text-xs">
            <th className="py-1.5 pr-3 font-medium">Metric</th>
            <th className="py-1.5 pr-3 text-right font-medium">Current</th>
            {showPrevious ? (
              <>
                <th className="py-1.5 pr-3 text-right font-medium">Previous</th>
                <th className="py-1.5 text-right font-medium">Change</th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {metrics.map((metric) => {
            const change = formatChange(metric);
            return (
              <tr key={metric.key}>
                <td className="py-1.5 pr-3">{metric.label}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatMetric(metric.current, metric.format)}
                </td>
                {showPrevious ? (
                  <>
                    <td className="text-muted-foreground py-1.5 pr-3 text-right tabular-nums">
                      {formatMetric(metric.previous, metric.format)}
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${
                        change ? changeClass(change.direction) : "text-muted-foreground"
                      }`}
                    >
                      {change ? change.text : "—"}
                    </td>
                  </>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Query evidence.
 *
 * One row per query rather than one table per query: the useful comparison is
 * between queries, and a page can easily carry dozens of them.
 */
function QueryTable({ subjects }: { subjects: MeasuredSubject[] }) {
  const cell = (subject: MeasuredSubject, key: string) => {
    const metric = subject.metrics.find((row) => row.key === key);
    return metric ? formatMetric(metric.current, metric.format) : "—";
  };

  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs">{describeQueryCoverage(subjects.length)}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-left text-xs">
              <th className="py-1.5 pr-3 font-medium">Query</th>
              <th className="py-1.5 pr-3 text-right font-medium">Clicks</th>
              <th className="py-1.5 pr-3 text-right font-medium">Impressions</th>
              <th className="py-1.5 text-right font-medium">Average position</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {subjects.map((subject) => (
              <tr key={subject.key}>
                <td className="max-w-xs truncate py-1.5 pr-3" title={subject.label}>
                  {subject.label}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{cell(subject, "clicks")}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {cell(subject, "impressions")}
                </td>
                <td className="py-1.5 text-right tabular-nums">{cell(subject, "position")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The identities behind the figures, folded away by default.
 *
 * Traceability is a requirement, not a nicety: every figure above must lead
 * back to a source, a window and a re-resolvable record ID. It is also not what
 * a person came to the page to read, so it opens on request rather than filling
 * the screen with colon-separated UUIDs.
 */
export function TechnicalProvenance({ view, stale }: { view: EvidenceView; stale: string[] }) {
  const omitted = describeOmitted(view.omitted);

  return (
    <details className="border-border rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">Evidence details</summary>

      <div className="space-y-3 pt-3 text-xs">
        <p className="text-muted-foreground">
          {view.counts.included.toLocaleString("en-GB")} evidence{" "}
          {view.counts.included === 1 ? "record" : "records"} included
          {view.counts.available !== view.counts.included
            ? ` of ${view.counts.available.toLocaleString("en-GB")} available`
            : ""}
          .
        </p>

        {omitted ? <p className="text-muted-foreground">{omitted}</p> : null}

        {view.groups.map((group) => {
          const ids = [
            ...group.subjects.flatMap((subject) => subject.evidenceIds),
            ...group.records.map((record) => record.id),
          ];
          if (ids.length === 0) return null;

          return (
            <div className="space-y-1" key={group.source}>
              <p className="font-medium">{group.source}</p>
              <ul className="text-muted-foreground space-y-0.5 font-mono text-[11px]">
                {ids.map((id) => (
                  <li className="break-all" key={id}>
                    {id}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

        {stale.length > 0 ? (
          <div className="space-y-1">
            <p className="font-medium">No longer resolvable</p>
            <ul className="text-muted-foreground space-y-0.5 font-mono text-[11px]">
              {stale.map((id) => (
                <li className="break-all" key={id}>
                  {id}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}
