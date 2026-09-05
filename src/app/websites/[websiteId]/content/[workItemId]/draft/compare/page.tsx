import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getContentWorkItem } from "@/server/services/content-work";
import {
  compareRevisions,
  getDraft,
  getDraftForWorkItem,
  listRevisions,
} from "@/server/services/content-draft";
import { REVISION_FIELD_LABELS, type DiffLine, type RevisionFields } from "@/lib/content/diff";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";

export const metadata = { title: "Compare revisions · SEO OS" };

const SCALAR_FIELDS = ["title", "slug", "excerpt", "metaTitle", "metaDescription"] as const;
const CONTEXT_LINES = 3;

/**
 * Two revisions of one draft (docs/P4_SPEC.md §10; M4.4 §9): from vN to
 * vM, which fields changed, the word and line deltas, each changed field
 * side by side, and the body as a readable line diff - added and removed
 * lines named as such, long unchanged runs folded. Both revisions must
 * belong to the draft; anything else is not found.
 */
export default async function CompareRevisionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
  searchParams: Promise<{ draft?: string; from?: string; to?: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const query = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();

  const view = query.draft
    ? await getDraft(context, query.draft)
    : await getDraftForWorkItem(context, item.id);
  if (!view || view.draft.contentWorkItemId !== item.id) notFound();

  const revisions = await listRevisions(context, view.draft.id, context.user.id);
  const byNumber = new Map(revisions.map((row) => [row.revisionNumber, row]));

  // Defaults: the current revision against the one it was written from.
  const to = query.to ? revisions.find((row) => row.id === query.to) : (revisions[0] ?? null);
  const from = query.from
    ? revisions.find((row) => row.id === query.from)
    : to?.basedOnRevisionNumber
      ? byNumber.get(to.basedOnRevisionNumber)
      : (revisions[1] ?? null);

  const comparison =
    from && to && from.id !== to.id
      ? await compareRevisions(context, view.draft.id, from.id, to.id)
      : null;
  const base = `/websites/${websiteId}/content/${item.id}/draft`;
  const changedScalars = comparison
    ? SCALAR_FIELDS.filter((field) => comparison.changes.changed.includes(field))
    : [];

  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={
            comparison
              ? `From v${comparison.from.revisionNumber} → To v${comparison.to.revisionNumber}`
              : "Compare revisions"
          }
          description={`${humanize(item.type)} · ${item.title} · draft based on Brief v${view.brief.version}`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav
        className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm"
        aria-label="Compare"
      >
        <Link href={`${base}?draft=${view.draft.id}`} className="hover:underline">
          ← Back to the draft
        </Link>
        <Link href={`${base}/history?draft=${view.draft.id}`} className="hover:underline">
          Revision history
        </Link>
        <StatusBadge status={view.draft.status} />
      </nav>

      {revisions.length < 2 ? (
        <EmptyState>
          Two revisions are needed to compare. This draft has {revisions.length}.
        </EmptyState>
      ) : (
        <>
          <form
            method="get"
            className="flex flex-wrap items-end gap-3 text-sm"
            aria-label="Choose revisions"
          >
            <input type="hidden" name="draft" value={view.draft.id} />
            <Picker name="from" label="From" revisions={revisions} selected={from?.id ?? ""} />
            <Picker name="to" label="To" revisions={revisions} selected={to?.id ?? ""} />
            <button
              type="submit"
              className="border-border inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
            >
              Compare
            </button>
          </form>

          {!comparison ? (
            <EmptyState>
              {from && to && from.id === to.id
                ? "Pick two different revisions."
                : "Those revisions could not be compared. Only revisions of this draft can be."}
            </EmptyState>
          ) : (
            <>
              <section className="space-y-3" aria-labelledby="summary-heading">
                <h2 id="summary-heading" className="text-sm font-medium">
                  What changed from v{comparison.from.revisionNumber} to v
                  {comparison.to.revisionNumber}
                </h2>
                <dl className="divide-border border-border divide-y rounded-lg border text-sm">
                  <Row label="Fields changed">
                    {comparison.changes.changed.length === 0
                      ? "None"
                      : comparison.changes.changed
                          .map((field) => REVISION_FIELD_LABELS[field as keyof RevisionFields])
                          .join(", ")}
                  </Row>
                  <Row label="Words">
                    {comparison.changes.wordsBefore} → {comparison.changes.wordsAfter} (
                    {signed(comparison.changes.wordsAfter - comparison.changes.wordsBefore)})
                  </Row>
                  <Row label="Body lines">
                    {comparison.changes.linesAdded} added, {comparison.changes.linesRemoved} removed
                  </Row>
                  <Row label={`Written by (v${comparison.to.revisionNumber})`}>
                    {to?.author.label ?? "—"}
                    <span className="text-muted-foreground">
                      {" "}
                      · {comparison.to.createdAt.toLocaleString("en-GB")}
                    </span>
                  </Row>
                  <Row label={`Change summary (v${comparison.to.revisionNumber})`}>
                    {comparison.to.changeSummary}
                  </Row>
                </dl>
              </section>

              {changedScalars.length > 0 ? (
                <section className="space-y-3" aria-labelledby="fields-heading">
                  <h2 id="fields-heading" className="text-sm font-medium">
                    Changed fields
                  </h2>
                  {changedScalars.map((field) => (
                    <div key={field} className="space-y-1">
                      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        {REVISION_FIELD_LABELS[field]}
                      </h3>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-lg border border-red-200 p-3 text-sm dark:border-red-900">
                          <p className="text-muted-foreground mb-1 text-xs">
                            Before · v{comparison.from.revisionNumber}
                          </p>
                          <p className="break-words">{comparison.from[field] ?? "—"}</p>
                        </div>
                        <div className="rounded-lg border border-emerald-200 p-3 text-sm dark:border-emerald-900">
                          <p className="text-muted-foreground mb-1 text-xs">
                            After · v{comparison.to.revisionNumber}
                          </p>
                          <p className="break-words">{comparison.to[field] ?? "—"}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </section>
              ) : null}

              <section className="space-y-2" aria-labelledby="body-heading">
                <h2 id="body-heading" className="text-sm font-medium">
                  Body
                </h2>
                {comparison.changes.changed.includes("bodyMarkdown") ? (
                  <>
                    <p className="text-muted-foreground text-xs">
                      Lines marked <span className="font-medium">Added</span> are new in v
                      {comparison.to.revisionNumber}; lines marked{" "}
                      <span className="font-medium">Removed</span> were in v
                      {comparison.from.revisionNumber} only. Unchanged runs are folded.
                    </p>
                    <BodyDiff lines={comparison.diff} />
                  </>
                ) : (
                  <p className="text-muted-foreground text-sm">The body did not change.</p>
                )}
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

type Chunk = { type: "lines"; lines: DiffLine[] } | { type: "fold"; count: number };

/** Keep changed lines with a little context; fold the long unchanged stretches. */
function fold(lines: DiffLine[]): Chunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === "same") return;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + CONTEXT_LINES);
    for (let i = start; i <= end; i++) keep[i] = true;
  });
  const chunks: Chunk[] = [];
  let index = 0;
  while (index < lines.length) {
    if (keep[index]) {
      const run: DiffLine[] = [];
      while (index < lines.length && keep[index]) run.push(lines[index++]!);
      chunks.push({ type: "lines", lines: run });
    } else {
      let count = 0;
      while (index < lines.length && !keep[index]) {
        count++;
        index++;
      }
      chunks.push({ type: "fold", count });
    }
  }
  return chunks;
}

function BodyDiff({ lines }: { lines: DiffLine[] }) {
  const chunks = fold(lines);
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <ol className="p-3 font-mono text-xs leading-5" aria-label="Body, line by line">
        {chunks.map((chunk, chunkIndex) =>
          chunk.type === "fold" ? (
            <li key={`fold-${chunkIndex}`} className="text-muted-foreground list-none py-1 italic">
              … {chunk.count} unchanged line{chunk.count === 1 ? "" : "s"} …
            </li>
          ) : (
            chunk.lines.map((line, lineIndex) => (
              <li
                key={`${chunkIndex}-${lineIndex}`}
                className={`grid list-none grid-cols-[4.5rem_1fr] gap-2 whitespace-pre-wrap ${
                  line.type === "added"
                    ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100"
                    : line.type === "removed"
                      ? "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100"
                      : "text-muted-foreground"
                }`}
              >
                <span className="text-[10px] tracking-wide uppercase select-none">
                  {line.type === "added" ? "Added" : line.type === "removed" ? "Removed" : ""}
                </span>
                <span className="break-words">{line.text || " "}</span>
              </li>
            ))
          ),
        )}
      </ol>
    </div>
  );
}

function Picker({
  name,
  label,
  revisions,
  selected,
}: {
  name: string;
  label: string;
  revisions: { id: string; revisionNumber: number; author: { label: string } }[];
  selected: string;
}) {
  const id = `compare-${name}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-muted-foreground block text-xs">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={selected}
        className="border-border bg-background h-9 rounded-md border px-2 text-sm"
      >
        {revisions.map((row) => (
          <option key={row.id} value={row.id}>
            v{row.revisionNumber} · {row.author.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5">
      <dt className="text-muted-foreground w-52 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}
