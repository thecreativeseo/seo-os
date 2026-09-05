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
import { REVISION_FIELD_LABELS, type RevisionFields } from "@/lib/content/diff";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";

export const metadata = { title: "Compare revisions · SEO OS" };

/**
 * Two revisions of one draft (docs/P4_SPEC.md §10; M4.3): which fields
 * changed, the word and line deltas, and a line diff of the body. Both
 * revisions must belong to the draft; anything else is not found.
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

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Compare revisions"
          description={`${humanize(item.type)} · ${item.title} · brief v${view.brief.version}`}
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm">
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
          <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
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
                : "Those revisions could not be compared."}
            </EmptyState>
          ) : (
            <>
              <section className="space-y-3">
                <h2 className="text-sm font-medium">
                  v{comparison.from.revisionNumber} → v{comparison.to.revisionNumber}
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
                  <Row label="Lines">
                    +{comparison.changes.linesAdded} / −{comparison.changes.linesRemoved}
                  </Row>
                  <Row label="Change summary of v{n}">{comparison.to.changeSummary}</Row>
                </dl>
              </section>

              {(["title", "slug", "excerpt", "metaTitle", "metaDescription"] as const)
                .filter((field) => comparison.changes.changed.includes(field))
                .map((field) => (
                  <section key={field} className="space-y-2">
                    <h3 className="text-sm font-medium">{REVISION_FIELD_LABELS[field]}</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="border-border rounded-lg border p-3 text-sm">
                        <p className="text-muted-foreground mb-1 text-xs">
                          v{comparison.from.revisionNumber}
                        </p>
                        <p>{comparison.from[field] ?? "—"}</p>
                      </div>
                      <div className="border-border rounded-lg border p-3 text-sm">
                        <p className="text-muted-foreground mb-1 text-xs">
                          v{comparison.to.revisionNumber}
                        </p>
                        <p>{comparison.to[field] ?? "—"}</p>
                      </div>
                    </div>
                  </section>
                ))}

              <section className="space-y-2">
                <h3 className="text-sm font-medium">Body</h3>
                {comparison.changes.changed.includes("bodyMarkdown") ? (
                  <div className="border-border overflow-x-auto rounded-lg border">
                    <pre className="p-3 font-mono text-xs leading-5">
                      {comparison.diff.map((line, index) => (
                        <div
                          key={index}
                          className={
                            line.type === "added"
                              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100"
                              : line.type === "removed"
                                ? "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100"
                                : "text-muted-foreground"
                          }
                        >
                          <span className="inline-block w-5 select-none">
                            {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
                          </span>
                          {line.text || " "}
                        </div>
                      ))}
                    </pre>
                  </div>
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
      <label htmlFor={id} className="text-muted-foreground text-xs">
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
      <dt className="text-muted-foreground w-44 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
