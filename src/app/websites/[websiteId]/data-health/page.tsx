import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import {
  getDataHealth,
  listSyncRunPage,
  runFailureNote,
  runsPageWindow,
  type LatestAttempt,
} from "@/server/services/data-health";
import { SITEMAP_ERROR_MESSAGES, type SitemapFetchError } from "@/server/connectors/sitemap/fetch";
import { listSitemaps } from "@/server/services/sitemap";
import { Badge, EmptyState, PageHeader } from "@/components/governance/primitives";
import { AddSitemapForm, SitemapRowActions } from "@/components/connections/sitemap-controls";
import { SyncButton } from "@/components/connections/sync-controls";

export const metadata = { title: "Data Health · SEO OS" };

/**
 * Data Health.
 *
 * Answers one question: can the numbers elsewhere be trusted right now. Everything
 * here is a fact about the pipeline — no secrets, and no reassurance the pipeline
 * cannot support.
 */
/** A stored sitemap error code becomes a sentence; the code stays as a hint. */
function sitemapErrorMessage(code: string): string {
  return SITEMAP_ERROR_MESSAGES[code as SitemapFetchError] ?? "That sitemap could not be fetched.";
}

function clock(value: Date | null): string {
  return value ? value.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
}

/**
 * Paging through the run history.
 *
 * Every page is a plain link, so the table works before any JavaScript arrives
 * and a particular page can be linked to or reloaded. The current page is a
 * span rather than a link: there is nowhere for it to go, and a link that does
 * nothing is a small lie to anyone navigating by keyboard.
 */
function RunsPagination({
  page,
  pageCount,
  total,
  perPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  perPage: number;
}) {
  if (total === 0) return null;

  const first = (page - 1) * perPage + 1;
  const last = Math.min(page * perPage, total);
  const pages = runsPageWindow(page, pageCount);
  const href = (target: number) => (target === 1 ? "?" : `?runsPage=${target}`);

  const step = "border-border rounded-md border px-2 py-1";
  const muted = "text-muted-foreground cursor-not-allowed opacity-50";

  return (
    <nav
      aria-label="Recent runs pages"
      className="text-muted-foreground flex flex-wrap items-center justify-between gap-3 text-xs"
    >
      <p>
        Showing {first.toLocaleString("en-GB")}–{last.toLocaleString("en-GB")} of{" "}
        {total.toLocaleString("en-GB")} {total === 1 ? "run" : "runs"}
      </p>

      <div className="flex flex-wrap items-center gap-1">
        {page > 1 ? (
          <Link className={step} href={href(page - 1)} rel="prev">
            Previous
          </Link>
        ) : (
          <span aria-disabled="true" className={`${step} ${muted}`}>
            Previous
          </span>
        )}

        {pages.map((target, index) =>
          target === "gap" ? (
            <span className="px-1" key={`gap-${index}`}>
              …
            </span>
          ) : target === page ? (
            <span
              aria-current="page"
              className={`${step} text-foreground font-medium`}
              key={target}
            >
              {target}
            </span>
          ) : (
            <Link aria-label={`Page ${target}`} className={step} href={href(target)} key={target}>
              {target}
            </Link>
          ),
        )}

        {page < pageCount ? (
          <Link className={step} href={href(page + 1)} rel="next">
            Next
          </Link>
        ) : (
          <span aria-disabled="true" className={`${step} ${muted}`}>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

/**
 * The newest attempt, said plainly and never as successful freshness. A queued
 * sync says so, and says when — the worker picks it up within seconds, so one
 * still waiting after minutes is a worker that is not running. A live run says
 * when it began; an interrupted one says it will retry rather than masquerading
 * as still running.
 */
function AttemptCell({ attempt }: { attempt: LatestAttempt }) {
  if (attempt.state === "queued") {
    return (
      <span className="text-foreground">
        Queued since {clock(attempt.queuedAt)}
        {attempt.unattended ? (
          <span className="text-amber-700 dark:text-amber-400">
            {" "}
            · not picked up yet — is the worker running?
          </span>
        ) : null}
      </span>
    );
  }
  if (attempt.state === "starting") {
    return <span className="text-foreground">Sync starting</span>;
  }
  if (attempt.state === "running") {
    return <span className="text-foreground">Syncing since {clock(attempt.startedAt)}</span>;
  }
  if (attempt.state === "stale") {
    return (
      <span className="text-amber-700 dark:text-amber-400">
        Interrupted · will retry on next sync
      </span>
    );
  }
  if (attempt.state === "succeeded" || attempt.state === "partial") {
    return (
      <>
        {attempt.state === "succeeded" ? "Succeeded" : "Partial"}
        {attempt.finishedAt ? ` · ${attempt.finishedAt.toLocaleDateString("en-GB")}` : ""}
      </>
    );
  }
  if (attempt.state === "failed") {
    return (
      <span className="text-red-600">
        Failed{attempt.errorCode ? ` · ${attempt.errorCode}` : ""}
      </span>
    );
  }
  return <>Never run</>;
}

export default async function DataHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<{ runsPage?: string | string[] }>;
}) {
  const { websiteId } = await params;
  const { runsPage } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);
  const [health, sitemaps, runPage] = await Promise.all([
    getDataHealth(context),
    listSitemaps(context),
    listSyncRunPage(context, runsPage),
  ]);
  const runs = runPage.runs;

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
            No source is connected yet, so SEO OS is reporting no search metrics at all.
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
                  <th className="px-3 py-2 font-medium">Latest attempt</th>
                  <th className="px-3 py-2 text-right font-medium">Rows</th>
                  {canWrite ? <th className="px-3 py-2 font-medium">Sync</th> : null}
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
                        <span className="text-muted-foreground">None yet</span>
                      )}
                    </td>
                    <td className="text-muted-foreground px-3 py-3 text-xs">
                      {/* The latest attempt — distinct from the successful data
                          date in the previous column. An error code is from our
                          own vocabulary, never the provider's message. */}
                      <AttemptCell attempt={source.attempt} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {source.rowCount.toLocaleString("en-GB")}
                    </td>
                    {canWrite ? (
                      <td className="px-3 py-3">
                        {/* Only a connection with a chosen property can be read.
                            Offering the button otherwise would promise something
                            the sync would immediately refuse. */}
                        {source.status === "CONNECTED" &&
                        source.propertyName &&
                        (source.provider === "GOOGLE_SEARCH_CONSOLE" ||
                          source.provider === "GOOGLE_ANALYTICS") ? (
                          <SyncButton websiteId={websiteId} provider={source.provider} />
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {active.some((source) => source.stale) ? (
          <p className="rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            At least one source is further behind than the two to three days Search Console normally
            reports. Figures for recent days are incomplete.
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Recent runs</h2>
        {/*
          Said once, here, instead of on every failed row. The table below then
          only has to name the kind of failure, which is what differs between
          one row and the next.
        */}
        <p className="text-muted-foreground text-sm">
          Every attempt is preserved. Failed or incomplete runs do not change the latest successful
          data shown above.
        </p>

        {runs.length === 0 ? (
          <EmptyState>No sync has been run for this website yet.</EmptyState>
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-muted-foreground border-b text-left">
                  <th className="px-4 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Period</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Received</th>
                  <th className="px-3 py-2 text-right font-medium">Written</th>
                  <th className="px-3 py-2 text-right font-medium">Skipped</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="px-4 py-3 text-xs">
                      {(run.startedAt ?? run.createdAt).toLocaleString("en-GB")}
                    </td>
                    <td className="text-muted-foreground px-3 py-3 text-xs">{run.syncType}</td>
                    <td className="text-muted-foreground px-3 py-3 text-xs">
                      {run.periodStart && run.periodEnd
                        ? `${run.periodStart.toISOString().slice(0, 10)} → ${run.periodEnd
                            .toISOString()
                            .slice(0, 10)}`
                        : "—"}
                    </td>
                    <td className="px-3 py-3">
                      <Badge>{run.status}</Badge>
                      {runFailureNote(run) ? (
                        <p className="mt-1 text-xs text-red-600">{runFailureNote(run)}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {run.recordsReceived.toLocaleString("en-GB")}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {run.recordsWritten.toLocaleString("en-GB")}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {run.recordsSkipped.toLocaleString("en-GB")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <RunsPagination
          page={runPage.page}
          pageCount={runPage.pageCount}
          perPage={runPage.perPage}
          total={runPage.total}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Coverage</h2>
        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[16rem_1fr] sm:gap-4">
            <dt className="text-muted-foreground">Search Console breakdown</dt>
            <dd>
              Date, page and query
              <p className="text-muted-foreground text-xs">
                Country and device are recorded as ALL in this phase. Ingesting the full breakdown
                multiplies row count roughly fiftyfold; the columns and unique key already carry the
                documented grain, so widening it later is a configuration change and a backfill.
              </p>
            </dd>
          </div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[16rem_1fr] sm:gap-4">
            <dt className="text-muted-foreground">Raw payload retention</dt>
            <dd>
              Not retained
              <p className="text-muted-foreground text-xs">
                Each sync records what it received — period, row counts, a checksum — but the
                response body itself is not stored yet.
              </p>
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Sitemaps</h2>
        <p className="text-muted-foreground text-sm">
          A sitemap is what the site says exists. It is evidence of intent, not of indexation, and
          SEO OS never presents it as the latter.
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
                        {sitemapErrorMessage(sitemap.lastError)}
                        <span className="text-muted-foreground"> ({sitemap.lastError})</span>
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
