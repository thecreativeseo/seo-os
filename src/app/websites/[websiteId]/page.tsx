import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getReadiness } from "@/server/services/readiness";
import { getWebsiteSummary } from "@/server/services/metrics";
import { listSignals } from "@/server/services/signals";
import { engagementRate } from "@/lib/metrics/aggregate";
import { freshnessInDays, isStale } from "@/lib/metrics/compare";
import {
  formatCount,
  formatDateRange,
  formatPercent,
  formatPosition,
} from "@/lib/metrics/format";
import { MetricCard, SeverityBadge } from "@/components/metrics/primitives";

export const metadata = { title: "Command Center · SEO OS" };

/**
 * Command Center.
 *
 * In P0 this answered "what is missing from setup?". Once first-party data exists
 * it answers "what changed?" — the setup view moves below, still available, because
 * it is still true and still occasionally the thing you need.
 *
 * Nothing here explains a change. Attention lists what moved; Signals carries the
 * evidence; the cause is P3's job.
 */
export default async function CommandCenterPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const summary = await getWebsiteSummary(context, "28d");
  const hasData = summary.latestDataDate !== null;

  if (!hasData) {
    return <SetupOnly websiteId={websiteId} />;
  }

  const [signals, readiness] = await Promise.all([
    listSignals(context, { status: "DETECTED", limit: 200 }),
    getReadiness(context),
  ]);

  const byType = (type: string) => signals.filter((signal) => signal.type === type);
  const winners = byType("PAGE_WINNER").slice(0, 4);
  const losers = byType("PAGE_LOSER").slice(0, 4);

  const stale = isStale(summary.latestDataDate, new Date());
  const behind = freshnessInDays(summary.latestDataDate, new Date());

  const attention = [
    { label: "Traffic declines", type: "TRAFFIC_DECLINE", note: "pages" },
    { label: "CTR opportunities", type: "CTR_OPPORTUNITY", note: "pages" },
    { label: "Striking distance", type: "STRIKING_DISTANCE", note: "queries" },
    { label: "Impression growth", type: "IMPRESSION_GROWTH", note: "pages" },
  ];

  const nextStep = signals[0];

  return (
    <main className="space-y-10">
      <header className="space-y-1">
        <p className="text-muted-foreground font-mono text-sm">
          {context.website.normalizedDomain}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Command Center</h1>
        <p className="text-muted-foreground text-sm">
          {formatDateRange(summary.windows.current)} compared with{" "}
          {formatDateRange(summary.windows.previous)}
        </p>
      </header>

      {/* Freshness first: every number below is only as current as this. */}
      <section
        className={`rounded-lg border p-4 ${
          stale ? "border-amber-400 bg-amber-50 dark:border-amber-800 dark:bg-amber-950" : "border-border"
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium">Data freshness</p>
          <p className="text-muted-foreground text-sm">
            Latest data {summary.latestDataDate}
            {behind !== null ? ` · ${behind} days behind` : ""}
          </p>
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          {stale
            ? "Search Console normally reports two to three days behind. This is further behind than that, so recent figures are incomplete."
            : "Search Console reports two to three days behind, so the most recent days are always partial."}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Executive snapshot</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard
            label="Organic clicks"
            source="GSC"
            value={formatCount(summary.gsc.current.clicks)}
            current={summary.gsc.current.clicks}
            previous={summary.gsc.previous.clicks}
          />
          <MetricCard
            label="Impressions"
            source="GSC"
            value={formatCount(summary.gsc.current.impressions)}
            current={summary.gsc.current.impressions}
            previous={summary.gsc.previous.impressions}
          />
          <MetricCard
            label="CTR"
            source="GSC"
            value={formatPercent(summary.gsc.current.ctr)}
            current={summary.gsc.current.ctr}
            previous={summary.gsc.previous.ctr}
          />
          <MetricCard
            label="Average position"
            source="GSC"
            value={formatPosition(summary.gsc.current.position)}
            current={summary.gsc.current.position}
            previous={summary.gsc.previous.position}
            lowerIsBetter
            note="Impression-weighted"
          />
          <MetricCard
            label="Organic sessions"
            source="GA4"
            value={formatCount(summary.ga4.current.sessions)}
            current={summary.ga4.current.sessions}
            previous={summary.ga4.previous.sessions}
          />
          {/* Conversions appear only if the property reports them. */}
          {summary.ga4.current.keyEvents !== null ? (
            <MetricCard
              label="Key events"
              source="GA4"
              value={formatCount(summary.ga4.current.keyEvents)}
              current={summary.ga4.current.keyEvents}
              previous={summary.ga4.previous.keyEvents}
            />
          ) : (
            <MetricCard
              label="Engagement rate"
              source="GA4"
              value={formatPercent(engagementRate(summary.ga4.current))}
              current={engagementRate(summary.ga4.current)}
              previous={engagementRate(summary.ga4.previous)}
            />
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Attention</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {attention.map((entry) => {
            const count = byType(entry.type).length;
            return (
              <Link
                key={entry.type}
                href={`/websites/${websiteId}/signals?status=DETECTED`}
                className="border-border hover:bg-accent/40 flex flex-col gap-1 rounded-lg border p-4"
              >
                <p className="text-muted-foreground text-xs font-medium">{entry.label}</p>
                <p className="text-xl font-semibold tabular-nums">{count}</p>
                <p className="text-muted-foreground text-xs">
                  {count === 0 ? "None detected" : `${entry.note} to review`}
                </p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <MoversList
          title="Winners"
          websiteId={websiteId}
          signals={winners}
          empty="No page gained enough clicks to stand out."
        />
        <MoversList
          title="Losers"
          websiteId={websiteId}
          signals={losers}
          empty="No page lost enough clicks to stand out."
        />
      </section>

      {nextStep ? (
        <section className="border-border space-y-3 rounded-lg border p-5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Next best step
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={nextStep.severity} />
            <p className="text-base">{nextStep.headline}</p>
          </div>
          <p className="text-muted-foreground text-sm">{nextStep.summary}</p>
          <Link
            href={
              nextStep.page
                ? `/websites/${websiteId}/pages/${nextStep.page.id}`
                : `/websites/${websiteId}/signals`
            }
            className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
          >
            {nextStep.page ? "View page" : "View signals"}
          </Link>
        </section>
      ) : null}

      {/* Setup readiness is still true; it is just no longer the headline. */}
      <details className="border-border border-t pt-4">
        <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm">
          Setup completion ({readiness.percentage}%)
        </summary>
        <ul className="divide-border border-border mt-3 divide-y rounded-lg border">
          {readiness.items.map((item) => (
            <li
              key={item.key}
              className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
            >
              {item.path ? (
                <Link
                  href={`/websites/${websiteId}/${item.path}`}
                  className="hover:underline"
                >
                  {item.label}
                </Link>
              ) : (
                <span>{item.label}</span>
              )}
              <span
                className={
                  item.state === "NEEDS_ATTENTION" ? "font-medium" : "text-muted-foreground"
                }
              >
                {item.detail}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}

function MoversList({
  title,
  websiteId,
  signals,
  empty,
}: {
  title: string;
  websiteId: string;
  signals: { id: string; summary: string | null; page: { id: string; path: string } | null }[];
  empty: string;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {signals.length === 0 ? (
        <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
          {empty}
        </p>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {signals.map((signal) => (
            <li key={signal.id} className="px-4 py-3 text-sm">
              {signal.page ? (
                <Link
                  href={`/websites/${websiteId}/pages/${signal.page.id}`}
                  className="font-mono text-xs hover:underline"
                >
                  {signal.page.path}
                </Link>
              ) : null}
              <p className="text-muted-foreground mt-1 text-xs">{signal.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Before any first-party data exists, the Command Center is still the P0 view. */
async function SetupOnly({ websiteId }: { websiteId: string }) {
  const context = await requireWebsiteAccess(websiteId);
  const readiness = await getReadiness(context);

  return (
    <main className="space-y-10">
      <header className="space-y-1">
        <p className="text-muted-foreground font-mono text-sm">
          {context.website.normalizedDomain}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Command Center</h1>
      </header>

      <section className="border-border space-y-2 rounded-lg border border-dashed p-5">
        <p className="text-sm font-medium">No first-party data yet</p>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
          Once Search Console and Analytics are connected, this becomes a view of what
          changed. Until then it shows how completely the business has been described —
          and SEO OS reports no search metric it has not been given.
        </p>
        <Link
          href={`/websites/${websiteId}/connections`}
          className="border-border hover:bg-accent mt-1 inline-flex h-9 items-center rounded-md border px-4 text-sm"
        >
          View connections
        </Link>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium">Setup completion</h2>
          <p className="text-sm tabular-nums">
            <span className="font-medium">{readiness.percentage}%</span>
            <span className="text-muted-foreground">
              {" "}
              · {readiness.countedComplete} of {readiness.countedTotal}
            </span>
          </p>
        </div>

        <div
          role="progressbar"
          aria-valuenow={readiness.percentage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Setup completion"
          className="bg-accent h-2 w-full overflow-hidden rounded-full"
        >
          <div
            className="bg-foreground h-full rounded-full"
            style={{ width: `${readiness.percentage}%` }}
          />
        </div>

        <ul className="divide-border border-border divide-y rounded-lg border">
          {readiness.items.map((item) => (
            <li
              key={item.key}
              className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
            >
              {item.path ? (
                <Link href={`/websites/${websiteId}/${item.path}`} className="hover:underline">
                  {item.label}
                </Link>
              ) : (
                <span>{item.label}</span>
              )}
              <span
                className={
                  item.state === "NEEDS_ATTENTION" ? "font-medium" : "text-muted-foreground"
                }
              >
                {item.detail}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {readiness.nextBestStep ? (
        <section className="border-border space-y-3 rounded-lg border p-5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Next best step
          </h2>
          <p className="text-base">{readiness.nextBestStep.action}</p>
          <Link
            href={`/websites/${websiteId}/${readiness.nextBestStep.path}`}
            className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
          >
            Go to {readiness.nextBestStep.label}
          </Link>
        </section>
      ) : null}
    </main>
  );
}
