import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { getDataHealth } from "@/server/services/data-health";
import { listSitemaps } from "@/server/services/sitemap";
import { Badge, EmptyState, PageHeader } from "@/components/governance/primitives";
import {
  AddSitemapForm,
  SitemapRowActions,
} from "@/components/connections/sitemap-controls";

export const metadata = { title: "Data Health · SEO OS" };

/**
 * Data Health.
 *
 * Answers one question: can the numbers elsewhere be trusted right now. Everything
 * here is a fact about the pipeline — no secrets, and no reassurance the pipeline
 * cannot support.
 */
export default async function DataHealthPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const [health, sitemaps] = await Promise.all([
    getDataHealth(context),
    listSitemaps(context),
  ]);

  const canWrite = hasRole(context.membership.role, "MEMBER");
  const active = health.filter((source) => source.status !== "NOT_CONNECTED");

  return (
    <main className="space-y-10">
      <PageHeader
        title="Data Health"
        description="Where every number in SEO OS comes from, when it last arrived, and whether it can be relied on today."
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Sources</h2>

        {active.length === 0 ? (
          <EmptyState>
            No source is connected yet, so SEO OS is reporting no search metrics at
            all.
          </EmptyState>
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-muted-foreground border-b text-left">
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Property</th>
                  <th className="px-3 py-2 font-medium">Latest data</th>
                  <th className="px-3 py-2 font-medium">Last sync</th>
                  <th className="px-3 py-2 text-right font-medium">Rows</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {active.map((source) => (
                  <tr key={source.provider}>
                    <td className="px-4 py-3">{source.name}</td>
                    <td className="px-3 py-3">
                      <Badge>{source.status}</Badge>
                    </td>
                    <td className="text-muted-foreground max-w-xs truncate px-3 py-3 text-xs">
                      {source.propertyName ?? "Not selected"}
                    </td>
                    <td className="px-3 py-3">
                      {source.latestDataDate ? (
                        <span className={source.stale ? "font-medium" : ""}>
                          {source.latestDataDate.toISOString().slice(0, 10)}
                          {source.freshnessDays !== null ? (
                            <span className="text-muted-foreground">
                              {" "}
                              · {source.freshnessDays}d behind
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Nothing received</span>
                      )}
                    </td>
                    <td className="text-muted-foreground px-3 py-3 text-xs">
                      {source.lastRun ? (
                        <>
                          {source.lastRun.status}
                          {source.lastRun.finishedAt
                            ? ` · ${source.lastRun.finishedAt.toLocaleDateString("en-GB")}`
                            : ""}
                          {/* An error code from our own vocabulary; never the
                              provider's message, which can carry request details. */}
                          {source.lastRun.errorCode ? ` · ${source.lastRun.errorCode}` : ""}
                        </>
                      ) : (
                        "Never run"
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {source.rowCount.toLocaleString("en-GB")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {active.some((source) => source.stale) ? (
          <p className="rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            At least one source is further behind than the two to three days Search
            Console normally reports. Figures for recent days are incomplete.
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Coverage</h2>
        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[16rem_1fr] sm:gap-4">
            <dt className="text-muted-foreground">Search Console breakdown</dt>
            <dd>
              Date, page and query
              <p className="text-muted-foreground text-xs">
                Country and device are recorded as ALL in this phase. Ingesting the
                full breakdown multiplies row count roughly fiftyfold; the columns and
                unique key already carry the documented grain, so widening it later is
                a configuration change and a backfill.
              </p>
            </dd>
          </div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[16rem_1fr] sm:gap-4">
            <dt className="text-muted-foreground">Raw payload retention</dt>
            <dd>
              Not retained
              <p className="text-muted-foreground text-xs">
                Each sync records what it received — period, row counts, a checksum —
                but the response body itself is not stored yet.
              </p>
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Sitemaps</h2>
        <p className="text-muted-foreground text-sm">
          A sitemap is what the site says exists. It is evidence of intent, not of
          indexation, and SEO OS never presents it as the latter.
        </p>

        {sitemaps.length === 0 ? (
          <EmptyState>No sitemap added.</EmptyState>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {sitemaps.map((sitemap) => (
              <li key={sitemap.id} className="space-y-2 px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs break-all">{sitemap.url}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {sitemap.lastSuccessfulFetchAt
                        ? `Last successful fetch ${sitemap.lastSuccessfulFetchAt.toLocaleString("en-GB")}`
                        : "Never fetched successfully"}
                      {sitemap.urlCount !== null ? ` · ${sitemap.urlCount} URLs` : ""}
                    </p>
                    {sitemap.lastError ? (
                      <p className="mt-1 text-xs text-red-600">
                        Last attempt failed: {sitemap.lastError}
                      </p>
                    ) : null}
                  </div>
                  <Badge>{sitemap.fetchStatus}</Badge>
                </div>

                {canWrite ? (
                  <SitemapRowActions websiteId={websiteId} sitemapId={sitemap.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canWrite ? (
          <div className="border-border rounded-lg border p-5">
            <AddSitemapForm websiteId={websiteId} />
          </div>
        ) : null}
      </section>
    </main>
  );
}
