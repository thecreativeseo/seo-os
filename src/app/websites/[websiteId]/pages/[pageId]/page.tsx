import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getPageDetail, resolveWebsiteWindows } from "@/server/services/metrics";
import { listSignals } from "@/server/services/signals";
import { engagementRate } from "@/lib/metrics/aggregate";
import { formatCount, formatDateRange, formatPercent, formatPosition } from "@/lib/metrics/format";
import { MetricCard, SeverityBadge } from "@/components/metrics/primitives";
import { CaptureControls } from "@/components/content/capture-controls";
import { latestSnapshot } from "@/server/services/page-content";
import { latestDiagnosisForPage, latestOpenRequestForPage } from "@/server/services/diagnosis";
import { resolveDiagnosisRunner } from "@/server/services/diagnosis-runner";
import { DiagnoseButton } from "@/components/diagnosis/controls";
import {
  ConfidenceBadge,
  StatusBadge,
  VerdictBadge,
  humanize,
} from "@/components/diagnosis/primitives";
import { REQUIRED, hasRole } from "@/server/auth/roles";

export const metadata = { title: "Page detail · SEO OS" };

/**
 * Page detail.
 *
 * Shows what was measured, over which period, from which source. It does not
 * explain the movement: that is P3's job, and the demo script's closing point is
 * precisely that SEO OS has not claimed a cause here.
 */
export default async function PageDetailPage({
  params,
}: {
  params: Promise<{ websiteId: string; pageId: string }>;
}) {
  const { websiteId, pageId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const { windows } = await resolveWebsiteWindows(context, "28d");

  const detail = await getPageDetail(context, pageId, windows);

  if (!detail) {
    notFound();
  }

  const signals = (await listSignals(context, { limit: 200 })).filter(
    (signal) => signal.pageId === detail.page.id && signal.status !== "RESOLVED",
  );

  const snapshot = await latestSnapshot(context, detail.page.id);
  const diagnosis = await latestDiagnosisForPage(context, detail.page.id);
  const openRequest = await latestOpenRequestForPage(context, detail.page.id);
  const runner = resolveDiagnosisRunner();
  const canCapture = hasRole(context.membership.role, REQUIRED.WRITE);

  const maxClicks = Math.max(1, ...detail.series.map((point) => point.clicks));

  return (
    <main className="space-y-8">
      <div>
        <Link
          href={`/websites/${websiteId}/pages`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Pages
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="font-mono text-xl font-semibold tracking-tight">{detail.page.path}</h1>
        <p className="text-muted-foreground text-sm">
          {detail.page.pageType.toLowerCase().replace("_", " ")} ·{" "}
          {formatDateRange(windows.current)} vs {formatDateRange(windows.previous)}
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Search performance</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Clicks"
            source="GSC"
            value={formatCount(detail.gsc.current.clicks)}
            current={detail.gsc.current.clicks}
            previous={detail.gsc.previous.clicks}
          />
          <MetricCard
            label="Impressions"
            source="GSC"
            value={formatCount(detail.gsc.current.impressions)}
            current={detail.gsc.current.impressions}
            previous={detail.gsc.previous.impressions}
          />
          <MetricCard
            label="CTR"
            source="GSC"
            value={formatPercent(detail.gsc.current.ctr)}
            current={detail.gsc.current.ctr}
            previous={detail.gsc.previous.ctr}
          />
          <MetricCard
            label="Average position"
            source="GSC"
            value={formatPosition(detail.gsc.current.position)}
            current={detail.gsc.current.position}
            previous={detail.gsc.previous.position}
            lowerIsBetter
            note="Impression-weighted"
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Clicks and impressions by day</h2>
        <div className="border-border rounded-lg border p-4">
          {detail.series.length === 0 ? (
            <p className="text-muted-foreground text-sm">No daily data in this period.</p>
          ) : (
            <div className="flex h-32 items-end gap-px" role="img" aria-label="Daily clicks">
              {detail.series.map((point) => (
                <div
                  key={point.date}
                  className="bg-foreground/70 min-h-px flex-1 rounded-t-sm"
                  style={{ height: `${(point.clicks / maxClicks) * 100}%` }}
                  title={`${point.date}: ${point.clicks} clicks, ${point.impressions} impressions`}
                />
              ))}
            </div>
          )}
          <p className="text-muted-foreground mt-2 text-xs">
            Daily clicks across {formatDateRange(windows.current)}. Hover a bar for the exact
            figures.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Analytics</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Sessions"
            source="GA4"
            value={formatCount(detail.ga4.current.sessions)}
            current={detail.ga4.current.sessions}
            previous={detail.ga4.previous.sessions}
          />
          <MetricCard
            label="Engagement rate"
            source="GA4"
            value={formatPercent(engagementRate(detail.ga4.current))}
            current={engagementRate(detail.ga4.current)}
            previous={engagementRate(detail.ga4.previous)}
          />
          <MetricCard
            label="Key events"
            source="GA4"
            value={formatCount(detail.ga4.current.keyEvents)}
            current={detail.ga4.current.keyEvents}
            previous={detail.ga4.previous.keyEvents}
          />
          <MetricCard
            label="Revenue"
            source="GA4"
            value={formatCount(detail.ga4.current.revenue)}
            current={detail.ga4.current.revenue}
            previous={detail.ga4.previous.revenue}
            note={
              detail.ga4.current.revenue === null ? "This property does not report it" : undefined
            }
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Top queries</h2>
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left">
                <th className="px-4 py-2 font-medium">Query</th>
                <th className="px-3 py-2 text-right font-medium">Clicks</th>
                <th className="px-3 py-2 text-right font-medium">Impressions</th>
                <th className="px-3 py-2 text-right font-medium">CTR</th>
                <th className="px-3 py-2 text-right font-medium">Position</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {detail.topQueries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-muted-foreground px-4 py-6 text-center">
                    No queries recorded for this page in this period.
                  </td>
                </tr>
              ) : (
                detail.topQueries.map((query) => (
                  <tr key={query.queryId}>
                    <td className="px-4 py-2">{query.query}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCount(query.clicks)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCount(query.impressions)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatPercent(query.ctr)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatPosition(query.position)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Active signals</h2>
        {signals.length === 0 ? (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-5 text-sm">
            Nothing detected for this page in this period.
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {signals.map((signal) => (
              <li key={signal.id} className="space-y-1 px-4 py-3">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={signal.severity} />
                  <span className="text-sm font-medium">{signal.headline}</span>
                </div>
                <p className="text-muted-foreground text-sm">{signal.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Page content</h2>

        {snapshot ? (
          <div className="border-border space-y-3 rounded-lg border p-4">
            <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                Captured {snapshot.capturedAt.toLocaleDateString("en-GB")} by{" "}
                {snapshot.source.replaceAll("_", " ").toLowerCase()}
              </span>
              <span className="tabular-nums">{formatCount(snapshot.wordCount)} words</span>
            </div>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">Title</dt>
                <dd>{snapshot.title ?? "No title found"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Meta description</dt>
                <dd>{snapshot.metaDescription ?? "No meta description found"}</dd>
              </div>
            </dl>
            <p className="text-muted-foreground text-xs">
              Stored as the page&rsquo;s own words. SEO OS makes no claim here about whether they
              are good — that is a diagnosis, and a diagnosis cites this snapshot.
            </p>
          </div>
        ) : (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-5 text-sm">
            No content captured for this page. Without it, nothing can be said about what the page
            says — only about how it performs.
          </p>
        )}

        {canCapture ? (
          <CaptureControls
            websiteId={websiteId}
            pageId={detail.page.id}
            pageUrl={detail.page.url}
          />
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Diagnosis</h2>
          {diagnosis ? (
            <Link
              href={`/websites/${websiteId}/diagnoses/${diagnosis.id}`}
              className="text-sm hover:underline"
            >
              Open the full diagnosis
            </Link>
          ) : null}
        </div>

        {openRequest ? (
          <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4 text-sm">
            <span>
              A diagnosis is in progress ({humanize(openRequest.status).toLowerCase()}), requested{" "}
              {openRequest.createdAt.toLocaleString("en-GB")}.
            </span>
            <Link
              href={`/websites/${websiteId}/diagnoses/requests/${openRequest.id}`}
              className="hover:underline"
            >
              Follow its progress
            </Link>
          </div>
        ) : null}

        {diagnosis ? (
          <div className="border-border space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={diagnosis.status} />
              <ConfidenceBadge level={diagnosis.overallConfidence} />
              <span className="text-muted-foreground text-xs">
                {diagnosis.createdAt.toLocaleDateString("en-GB")}
                {diagnosis.aiRunId ? "" : " \u00b7 no model run"}
              </span>
            </div>
            <p className="text-sm leading-relaxed">{diagnosis.executiveSummary}</p>
            {diagnosis.findings.length > 0 ? (
              <ul className="space-y-1.5">
                {diagnosis.findings.slice(0, 4).map((finding) => (
                  <li key={finding.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{humanize(finding.category)}</span>
                    <VerdictBadge verdict={finding.verdict} />
                    <ConfidenceBadge level={finding.confidence} />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-5 text-sm">
            Not diagnosed yet. A diagnosis reads this page&rsquo;s evidence and says why it performs
            as it does, citing every record it relies on.
          </p>
        )}

        {canCapture && !openRequest ? (
          <DiagnoseButton websiteId={websiteId} pageId={detail.page.id} runner={runner} />
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Evidence and source</h2>
        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          <Row label="URL" value={detail.page.url} mono />
          <Row label="First seen" value={detail.page.firstSeenAt.toLocaleDateString("en-GB")} />
          <Row label="Last seen" value={detail.page.lastSeenAt.toLocaleDateString("en-GB")} />
          <Row
            label="First observed by"
            value={detail.page.sourceFirstSeen.replaceAll("_", " ").toLowerCase()}
          />
          <Row
            label="In sitemap"
            value={detail.page.sitemapPresent ? "Yes" : "No"}
            note="A sitemap is what the site claims. It is not evidence of indexation."
          />
        </dl>
      </section>
    </main>
  );
}

function Row({
  label,
  value,
  mono,
  note,
}: {
  label: string;
  value: string;
  mono?: boolean;
  note?: string;
}) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="space-y-0.5">
        <p className={mono ? "font-mono text-xs break-all" : ""}>{value}</p>
        {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      </dd>
    </div>
  );
}
