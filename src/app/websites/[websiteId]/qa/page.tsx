import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { listQaQueue } from "@/server/services/content-qa";
import {
  QA_STATE_FILTERS,
  QA_STATE_FILTER_LABELS,
  applyQaFilters,
  parseQaFilters,
  qaQueueRank,
} from "@/lib/content/qa-ux";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { humanize } from "@/components/diagnosis/primitives";
import { QaQueueTable } from "@/components/execution/qa-queue-table";

export const metadata = { title: "QA · SEO OS" };

/**
 * Execution → QA (M5.4 §2). Every work item at or past the gate: what QA
 * found on the exact approved revision, whether that report still speaks for
 * it, and whether a person has approved it for the CMS. Most actionable
 * first - something blocking, then a decision waiting, then work ready to
 * check.
 */
export default async function QaPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { websiteId } = await params;
  const query = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const filters = parseQaFilters(query);
  const all = await listQaQueue(context);
  const rows = applyQaFilters(all, filters).sort(
    (a, b) => qaQueueRank(a) - qaQueueRank(b) || b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  const contentTypes = [...new Set(all.map((row) => row.contentType).filter(Boolean))] as string[];
  const filtering = JSON.stringify(filters) !== JSON.stringify(parseQaFilters({}));

  const blocked = all.filter((row) => row.outcome === "FAIL").length;
  const awaiting = all.filter((row) => row.itemStatus === "AWAITING_EDITOR_REVIEW").length;
  const approved = all.filter((row) => row.itemStatus === "APPROVED_FOR_CMS").length;
  const stale = all.filter(
    (row) => row.approvalStale || (row.runStatus === "COMPLETED" && !row.runCurrent),
  ).length;
  const select = "border-border bg-background h-9 rounded-md border px-2 text-sm";

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="QA"
          description="What QA found on the exact approved revision of each piece, what a person still has to accept, and who approved it for the CMS. Nothing here publishes anything."
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap gap-4 text-sm" aria-label="Execution">
        <Link href={`/websites/${websiteId}/content`} className="hover:underline">
          Content Work
        </Link>
        <Link href={`/websites/${websiteId}/briefs`} className="hover:underline">
          Briefs
        </Link>
        <Link href={`/websites/${websiteId}/drafts`} className="hover:underline">
          Drafts
        </Link>
        <span aria-current="page" className="text-foreground font-medium">
          QA
        </span>
      </nav>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["QA blockers", blocked, "state=blocked"],
          ["Awaiting final approval", awaiting, "state=awaiting"],
          ["Approved for CMS", approved, "state=approved"],
          ["Stale", stale, "stale=1"],
        ].map(([label, count, href]) => (
          <Link
            key={label as string}
            href={`/websites/${websiteId}/qa?${href}`}
            className="border-border hover:bg-accent/40 flex flex-col gap-1 rounded-lg border p-4"
          >
            <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{count}</dd>
          </Link>
        ))}
      </dl>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <div className="space-y-1">
          <label htmlFor="state" className="text-muted-foreground block text-xs font-medium">
            State
          </label>
          <select id="state" name="state" defaultValue={filters.state} className={select}>
            {QA_STATE_FILTERS.map((value) => (
              <option key={value} value={value}>
                {QA_STATE_FILTER_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="type" className="text-muted-foreground block text-xs font-medium">
            Content type
          </label>
          <select id="type" name="type" defaultValue={filters.contentType} className={select}>
            <option value="all">All</option>
            {contentTypes.map((type) => (
              <option key={type} value={type}>
                {humanize(type)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="stale" value="1" defaultChecked={filters.stale} />
          Stale only
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="notChecked" value="1" defaultChecked={filters.notChecked} />
          Has unchecked checks
        </label>
        <button
          type="submit"
          className="border-border h-9 rounded-md border px-4 text-sm font-medium"
        >
          Apply
        </button>
        {filtering ? (
          <Link href={`/websites/${websiteId}/qa`} className="text-muted-foreground text-xs">
            Clear
          </Link>
        ) : null}
      </form>

      {all.length === 0 ? (
        <EmptyState>
          Nothing is at QA yet. A work item arrives here once a person approves a draft: the
          approved revision is what QA checks.
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>
          No work matches these filters. <Link href={`/websites/${websiteId}/qa`}>Clear them</Link>{" "}
          to see all {all.length}.
        </EmptyState>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            {rows.length} of {all.length} shown, most actionable first.
          </p>
          <QaQueueTable rows={rows} websiteId={websiteId} isDemo={context.website.isDemo} />
        </>
      )}
    </main>
  );
}
