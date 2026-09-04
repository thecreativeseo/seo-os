import type { Evidence } from "@/lib/evidence/types";
import { RELIABILITY_LABELS } from "@/lib/evidence/types";

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
      <p className="text-muted-foreground font-mono text-[11px]">{evidence.id}</p>
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
