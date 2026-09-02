import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import {
  countPagesWithMetrics,
  getPageMetrics,
  resolveWebsiteWindows,
} from "@/server/services/metrics";
import { formatCount, formatDateRange, formatPercent, formatPosition } from "@/lib/metrics/format";
import { Delta, TableEmpty } from "@/components/metrics/primitives";
import { PageHeader } from "@/components/governance/primitives";

export const metadata = { title: "Pages · SEO OS" };

const PAGE_SIZE = 25;

export default async function PagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { websiteId } = await params;
  const { q, page: pageParam } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const { windows, latestDataDate } = await resolveWebsiteWindows(context, "28d");
  const pageNumber = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const offset = (pageNumber - 1) * PAGE_SIZE;

  const [rows, total] = await Promise.all([
    getPageMetrics(context, windows, { limit: PAGE_SIZE, offset, search: q }),
    countPagesWithMetrics(context, windows, q),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="space-y-6">
      <PageHeader
        title="Pages"
        description="Search performance by page, comparing the last 28 days with the 28 before."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {latestDataDate ? (
            <>
              {formatDateRange(windows.current)} vs {formatDateRange(windows.previous)}
            </>
          ) : (
            "No data yet."
          )}
        </p>

        <form method="get" className="flex items-center gap-2">
          <label htmlFor="page-search" className="sr-only">
            Search pages by path
          </label>
          <input
            id="page-search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Filter by path"
            className="border-border h-9 w-56 rounded-md border px-3 text-sm"
          />
          <button
            type="submit"
            className="border-border hover:bg-accent h-9 rounded-md border px-3 text-sm"
          >
            Search
          </button>
        </form>
      </div>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border text-muted-foreground border-b text-left">
              <th className="px-4 py-2 font-medium">Page</th>
              <th className="px-3 py-2 text-right font-medium">Clicks</th>
              <th className="px-3 py-2 text-right font-medium">Δ</th>
              <th className="px-3 py-2 text-right font-medium">Impressions</th>
              <th className="px-3 py-2 text-right font-medium">Δ</th>
              <th className="px-3 py-2 text-right font-medium">CTR</th>
              <th className="px-3 py-2 text-right font-medium">Position</th>
              <th className="px-3 py-2 text-right font-medium">Sessions</th>
              <th className="px-3 py-2 text-right font-medium">Key events</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {rows.length === 0 ? (
              <TableEmpty>
                {q ? "No pages match that filter." : "No page data yet."}
              </TableEmpty>
            ) : (
              rows.map((row) => (
                <tr key={row.pageId} className="hover:bg-accent/40">
                  <td className="max-w-xs truncate px-4 py-2">
                    <Link
                      href={`/websites/${websiteId}/pages/${row.pageId}`}
                      className="font-mono text-xs hover:underline"
                      title={row.path}
                    >
                      {row.path}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCount(row.clicks)}</td>
                  <td className="px-3 py-2 text-right">
                    <Delta current={row.clicks} previous={row.previousClicks} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCount(row.impressions)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Delta current={row.impressions} previous={row.previousImpressions} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.ctr)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPosition(row.position)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-right tabular-nums">
                    {formatCount(row.sessions)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-right tabular-nums">
                    {formatCount(row.keyEvents)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE ? (
        <nav className="flex items-center justify-between gap-4" aria-label="Pagination">
          <p className="text-muted-foreground text-sm">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <Link
                href={`/websites/${websiteId}/pages?${new URLSearchParams({ ...(q ? { q } : {}), page: String(pageNumber - 1) })}`}
                className="border-border hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
              >
                Previous
              </Link>
            ) : null}
            {pageNumber < lastPage ? (
              <Link
                href={`/websites/${websiteId}/pages?${new URLSearchParams({ ...(q ? { q } : {}), page: String(pageNumber + 1) })}`}
                className="border-border hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
              >
                Next
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </main>
  );
}
