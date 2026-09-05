import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { listDrafts } from "@/server/services/content-draft";
import {
  DRAFT_AUTHOR_FILTERS,
  DRAFT_STATUS_FILTERS,
  applyDraftFilters,
  parseDraftFilters,
} from "@/lib/content/draft-ux";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { humanize } from "@/components/diagnosis/primitives";
import { DraftsTable } from "@/components/execution/drafts-table";
import { DraftStateNotice } from "@/components/execution/draft-state";

export const metadata = { title: "Drafts · SEO OS" };

/**
 * Execution → Drafts (M4.4 §2): every draft of the website, most recently
 * updated first, with filters a person would actually reach for. On a demo
 * website the two seeded stories are pointed out, so a visitor can find them
 * without knowing where to look.
 */
export default async function DraftsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { websiteId } = await params;
  const query = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const filters = parseDraftFilters(query);
  const all = await listDrafts(context);
  const rows = applyDraftFilters(all, filters);
  const contentTypes = [...new Set(all.map((row) => row.contentType).filter(Boolean))] as string[];
  const filtering = JSON.stringify(filters) !== JSON.stringify(parseDraftFilters({}));

  // The seeded stories, found by what they are rather than by id.
  const storyA = context.website.isDemo ? all.find((row) => row.awaitingReview) : undefined;
  const storyOld = context.website.isDemo
    ? all.find((row) => row.status === "SUPERSEDED")
    : undefined;
  const storyNew = storyOld
    ? all.find((row) => row.workItemId === storyOld.workItemId && row.status !== "SUPERSEDED")
    : undefined;

  const select = "border-border bg-background h-9 rounded-md border px-2 text-sm";

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Drafts"
          description="Every draft of this website: which brief it is pinned to, where it stands, who wrote the current revision, and what the server found in it."
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
        <span aria-current="page" className="text-foreground font-medium">
          Drafts
        </span>
      </nav>

      {context.website.isDemo && (storyA || storyOld) ? (
        <section className="border-border space-y-2 rounded-lg border border-dashed p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">Demo stories</h2>
            <DemoBadge />
          </div>
          <ol className="list-decimal space-y-1 pl-5">
            {storyA ? (
              <li>
                <span className="font-medium">
                  Approved brief → AI revision → blocking finding → human revision → review
                  requested.
                </span>{" "}
                <Link
                  href={`/websites/${websiteId}/content/${storyA.workItemId}/draft?draft=${storyA.id}`}
                  className="hover:underline"
                >
                  Open “{storyA.workItemTitle}” →
                </Link>
              </li>
            ) : null}
            {storyOld ? (
              <li>
                <span className="font-medium">
                  Brief v1 → draft → brief v2 approved → mismatch → explicit restart → old draft
                  superseded, new draft pinned to v2.
                </span>{" "}
                <Link
                  href={`/websites/${websiteId}/content/${storyOld.workItemId}/draft?draft=${storyOld.id}`}
                  className="hover:underline"
                >
                  Open the superseded draft →
                </Link>
                {storyNew ? (
                  <>
                    {" · "}
                    <Link
                      href={`/websites/${websiteId}/content/${storyNew.workItemId}/draft?draft=${storyNew.id}`}
                      className="hover:underline"
                    >
                      Open the draft on v{storyNew.briefVersion} →
                    </Link>
                  </>
                ) : null}
              </li>
            ) : null}
          </ol>
        </section>
      ) : null}

      <form
        method="get"
        className="flex flex-wrap items-end gap-3 text-sm"
        aria-label="Filter drafts"
      >
        <div className="space-y-1">
          <label htmlFor="filter-status" className="text-muted-foreground block text-xs">
            Status
          </label>
          <select id="filter-status" name="status" defaultValue={filters.status} className={select}>
            {DRAFT_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status === "all" ? "All statuses" : humanize(status)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="filter-type" className="text-muted-foreground block text-xs">
            Content type
          </label>
          <select
            id="filter-type"
            name="type"
            defaultValue={filters.contentType}
            className={select}
          >
            <option value="all">All types</option>
            {contentTypes.map((type) => (
              <option key={type} value={type}>
                {humanize(type)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="filter-author" className="text-muted-foreground block text-xs">
            Current revision by
          </label>
          <select id="filter-author" name="author" defaultValue={filters.author} className={select}>
            {DRAFT_AUTHOR_FILTERS.map((author) => (
              <option key={author} value={author}>
                {author === "all"
                  ? "AI or person"
                  : author === "AI"
                    ? "Generated by AI"
                    : "Edited by a person"}
              </option>
            ))}
          </select>
        </div>
        <label className="flex h-9 items-center gap-2">
          <input type="checkbox" name="blocking" value="1" defaultChecked={filters.blocking} />
          Blocking findings
        </label>
        <label className="flex h-9 items-center gap-2">
          <input
            type="checkbox"
            name="awaiting"
            value="1"
            defaultChecked={filters.awaitingReview}
          />
          Awaiting review
        </label>
        <label className="flex h-9 items-center gap-2">
          <input type="checkbox" name="superseded" value="1" defaultChecked={filters.superseded} />
          Superseded
        </label>
        <button
          type="submit"
          className="border-border inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
        >
          Apply
        </button>
        {filtering ? (
          <Link href={`/websites/${websiteId}/drafts`} className="text-xs hover:underline">
            Clear filters
          </Link>
        ) : null}
      </form>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">
            {rows.length} draft{rows.length === 1 ? "" : "s"}
            {filtering ? (
              <span className="text-muted-foreground font-normal"> of {all.length}</span>
            ) : null}
          </h2>
          <span className="text-muted-foreground text-xs">Most recently updated first</span>
        </div>

        {all.length === 0 ? (
          <DraftStateNotice kind="no_drafts">
            <Link href={`/websites/${websiteId}/content`} className="text-sm hover:underline">
              Go to Content Work →
            </Link>
          </DraftStateNotice>
        ) : rows.length === 0 ? (
          <EmptyState>No drafts match these filters.</EmptyState>
        ) : (
          <DraftsTable rows={rows} websiteId={websiteId} isDemo={context.website.isDemo} />
        )}
      </section>
    </main>
  );
}
