import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getQueryMetrics, resolveWebsiteWindows } from "@/server/services/metrics";
import { listSignals } from "@/server/services/signals";
import { formatCount, formatDateRange, formatPercent, formatPosition } from "@/lib/metrics/format";
import { Delta, TableEmpty } from "@/components/metrics/primitives";
import { PageHeader } from "@/components/governance/primitives";

export const metadata = { title: "Queries · SEO OS" };

const PAGE_SIZE = 40;

export default async function QueriesPage({
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

  const [rows, signals] = await Promise.all([
    // One extra row tells us whether a next page exists without a second count query.
    getQueryMetrics(context, windows, { limit: PAGE_SIZE + 1, offset, search: q }),
    listSignals(context, { limit: 300 }),
  ]);

  const hasNext = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);

  const strikingQueryIds = new Set(
    signals
      .filter((signal) => signal.type === "STRIKING_DISTANCE" && signal.status !== "RESOLVED")
      .map((signal) => signal.queryId),
  );

  return (
    <main className="space-y-6">
      <PageHeader
        title="Queries"
        description="Search performance by query. Queries ranking just outside stronger visibility are marked."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {latestDataDate
            ? `${formatDateRange(windows.current)} vs ${formatDateRange(windows.previous)}`
            : "No data yet."}
        </p>

        <form method="get" className="flex items-center gap-2">
          <label htmlFor="query-search" className="sr-only">
            Search queries
          </label>
          <input
            id="query-search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Filter queries"
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
              <th className="px-4 py-2 font-medium">Query</th>
              <th className="px-3 py-2 text-right font-medium">Clicks</th>
              <th className="px-3 py-2 text-right font-medium">Δ</th>
              <th className="px-3 py-2 text-right font-medium">Impressions</th>
              <th className="px-3 py-2 text-right font-medium">CTR</th>
              <th className="px-3 py-2 text-right font-medium">Position</th>
              <th className="px-4 py-2 font-medium">Top page</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {visible.length === 0 ? (
              <TableEmpty>{q ? "No queries match that filter." : "No query data yet."}</TableEmpty>
            ) : (
              visible.map((row) => (
                <tr key={row.queryId} className="hover:bg-accent/40">
                  <td className="px-4 py-2">
                    {row.query}
                    {strikingQueryIds.has(row.queryId) ? (
                      <span className="border-border text-muted-foreground ml-2 rounded border px-1.5 py-0.5 font-mono text-[10px]">
                        STRIKING DISTANCE
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCount(row.clicks)}</td>
                  <td className="px-3 py-2 text-right">
                    <Delta current={row.clicks} previous={row.previousClicks} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCount(row.impressions)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.ctr)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPosition(row.position)}
                  </td>
                  <td className="text-muted-foreground max-w-xs truncate px-4 py-2 font-mono text-xs">
                    {row.topPagePath ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageNumber > 1 || hasNext ? (
        <nav className="flex items-center justify-end gap-2" aria-label="Pagination">
          {pageNumber > 1 ? (
            <Link
              href={`/websites/${websiteId}/queries?${new URLSearchParams({ ...(q ? { q } : {}), page: String(pageNumber - 1) })}`}
              className="border-border hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
            >
              Previous
            </Link>
          ) : null}
          {hasNext ? (
            <Link
              href={`/websites/${websiteId}/queries?${new URLSearchParams({ ...(q ? { q } : {}), page: String(pageNumber + 1) })}`}
              className="border-border hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}
