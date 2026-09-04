import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getReadiness } from "@/server/services/readiness";
import { getWebsiteSummary } from "@/server/services/metrics";
import { listSignals } from "@/server/services/signals";
import {
  getNextBestStep,
  getOpportunityCounts,
  listOpportunities,
} from "@/server/services/opportunity";
import { listRankingChanges } from "@/server/services/ranking";
import { MOVEMENT_LABELS } from "@/lib/ranking/movement";
import { PriorityBadge, ScorePill } from "@/components/opportunity/primitives";
import { engagementRate } from "@/lib/metrics/aggregate";
import { freshnessInDays, isStale } from "@/lib/metrics/compare";
import { formatCount, formatDateRange, formatPercent, formatPosition } from "@/lib/metrics/format";
import { MetricCard, SeverityBadge } from "@/components/metrics/primitives";
import { listDiagnoses } from "@/server/services/diagnosis";
import { listRecommendations, listReviewQueue } from "@/server/services/decision";
import { ConfidenceBadge, VerdictBadge, humanize } from "@/components/diagnosis/primitives";

export const metadata = { title: "Command Center · SEO OS" };

/**
 * Command Center.
 *
 * The question this screen answers has changed once per phase, and each time the
 * previous answer moved down rather than away:
 *
 *   P0  What is missing from setup?
 *   P1  What changed?
 *   P2  What should we work on?
 *
 * Freshness stays at the top through all of it. A prioritized list built on stale
 * data is worse than no list, because it looks exactly as confident.
 *
 * Nothing here explains a change. Opportunities say what is worth doing and what
 * that judgement rests on; the cause of anything is P3's job.
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

  const [signals, readiness, topOpportunities, opportunityCounts, nextBest, movement] =
    await Promise.all([
      listSignals(context, { status: "DETECTED", limit: 200 }),
      getReadiness(context),
      listOpportunities(context, { limit: 5 }),
      getOpportunityCounts(context),
      getNextBestStep(context),
      // Only what actually moved: positions wobble between crawls, and reporting
      // that teaches people to ignore this screen.
      listRankingChanges(context, { materialOnly: true, limit: 6 }),
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

  // P3 (section 30): why, and what should we do? Read after the P1/P2 batch
  // rather than inside it, so a slow AI table never delays the first paint of
  // the numbers people came for.
  const [diagnoses, reviewQueue, approved] = await Promise.all([
    listDiagnoses(context, 20),
    listReviewQueue(context, 20),
    listRecommendations(context, { status: ["APPROVED"] }, 5),
  ]);
  const awaitingDiagnoses = diagnoses.filter((d) => d.status === "AWAITING_REVIEW");
  const awaitingReview = reviewQueue.filter((r) => r.status === "AWAITING_REVIEW");
  const needsEvidence = reviewQueue.filter((r) => r.status === "NEEDS_EVIDENCE");
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2, UNKNOWN: 3 } as const;
  const topFindings = diagnoses
    .flatMap((d) => d.findings.map((f) => ({ ...f, diagnosisId: d.id, page: d.page })))
    .filter((f) => f.verdict === "CONFIRMED" || f.verdict === "STRONGLY_SUPPORTED")
    .sort((a, b) => rank[a.confidence] - rank[b.confidence])
    .slice(0, 4);
  const nextDecision = awaitingReview[0] ?? null;

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
          stale
            ? "border-amber-400 bg-amber-50 dark:border-amber-800 dark:bg-amber-950"
            : "border-border"
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

      {/* The P2 headline: what to work on, before what happened. */}
      {topOpportunities.length > 0 ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">Top opportunities</h2>
            <Link
              href={`/websites/${websiteId}/opportunities`}
              className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
            >
              Full queue ({opportunityCounts.total})
            </Link>
          </div>

          <ul className="divide-border border-border divide-y rounded-lg border">
            {topOpportunities.map((opportunity) => (
              <li key={opportunity.id} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Link
                    href={`/websites/${websiteId}/opportunities/${opportunity.id}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {opportunity.title}
                  </Link>
                  <span className="flex items-center gap-3">
                    <PriorityBadge priority={opportunity.priority} />
                    <ScorePill
                      score={opportunity.score === null ? null : Number(opportunity.score)}
                    />
                  </span>
                </div>
                <p className="text-muted-foreground text-xs">
                  {opportunity.businessGoal ? `${opportunity.businessGoal.title} · ` : ""}
                  effort {opportunity.effort.toLowerCase()} · confidence{" "}
                  {opportunity.confidence.toLowerCase()}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {Object.keys(opportunityCounts.byType).length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Opportunity mix</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(opportunityCounts.byType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <Link
                  key={type}
                  href={`/websites/${websiteId}/opportunities?type=${type}`}
                  className="border-border hover:bg-accent/40 rounded-lg border px-3 py-2 text-sm"
                >
                  <span className="font-medium tabular-nums">{count}</span>{" "}
                  <span className="text-muted-foreground">
                    {type.replace(/_/g, " ").toLowerCase()}
                  </span>
                </Link>
              ))}
          </div>
          <p className="text-muted-foreground text-xs">
            {/* A queue that is all one type is a queue that has stopped looking. */}A varied mix
            suggests the whole picture is being read; a single type dominating usually means one
            source of evidence is doing all the work.
          </p>
        </section>
      ) : null}

      {movement.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Market movement</h2>
          <ul className="divide-border border-border divide-y rounded-lg border">
            {movement.map((change) => (
              <li
                key={`${change.keywordId}-${change.provider}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <Link
                  href={`/websites/${websiteId}/keywords/${change.keywordId}`}
                  className="underline underline-offset-4"
                >
                  {change.keyword}
                </Link>
                <span className="text-muted-foreground text-xs">
                  {MOVEMENT_LABELS[change.movement.state]}
                  {change.movement.placesGained !== null
                    ? ` ${Math.abs(change.movement.placesGained)} places`
                    : ""}
                  {change.previous !== null && change.current !== null
                    ? ` · ${change.previous} → ${change.current}`
                    : ""}
                  {change.urlChanged ? " · ranking page changed" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Why, and what should we do?</h2>
          <Link href={`/websites/${websiteId}/review`} className="text-sm hover:underline">
            Review queue
          </Link>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: "Diagnoses awaiting review",
              count: awaitingDiagnoses.length,
              href: "diagnoses",
            },
            {
              label: "Recommendations awaiting review",
              count: awaitingReview.length,
              href: "review",
            },
            { label: "Needs more evidence", count: needsEvidence.length, href: "review" },
            {
              label: "Approved recommendations",
              count: approved.length,
              href: "recommendations?status=APPROVED",
            },
          ].map((tile) => (
            <Link
              key={tile.label}
              href={`/websites/${websiteId}/${tile.href}`}
              className="border-border hover:bg-accent/40 flex flex-col gap-1 rounded-lg border p-4"
            >
              <p className="text-muted-foreground text-xs font-medium">{tile.label}</p>
              <p className="text-xl font-semibold tabular-nums">{tile.count}</p>
            </Link>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="border-border space-y-3 rounded-lg border p-5">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Highest-confidence findings
            </h3>
            {topFindings.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No supported findings yet. Diagnose a page to get one.
              </p>
            ) : (
              <ul className="space-y-2">
                {topFindings.map((finding) => (
                  <li key={finding.id} className="text-sm">
                    <Link
                      href={`/websites/${websiteId}/diagnoses/${finding.diagnosisId}`}
                      className="hover:underline"
                    >
                      <span className="font-medium">{humanize(finding.category)}</span>
                      {finding.page ? (
                        <span className="text-muted-foreground font-mono text-xs">
                          {" "}
                          {finding.page.path}
                        </span>
                      ) : null}
                    </Link>
                    <span className="ml-2 inline-flex gap-1 align-middle">
                      <VerdictBadge verdict={finding.verdict} />
                      <ConfidenceBadge level={finding.confidence} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-border space-y-3 rounded-lg border p-5">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Next best step
            </h3>
            {nextDecision ? (
              <div className="space-y-1 text-sm">
                <Link
                  href={`/websites/${websiteId}/review/${nextDecision.id}`}
                  className="font-medium hover:underline"
                >
                  {nextDecision.title}
                </Link>
                <p className="text-muted-foreground">
                  {humanize(nextDecision.type)}
                  {nextDecision.page ? ` \u00b7 ${nextDecision.page.path}` : ""}
                  {nextDecision.blockedByRule ? " \u00b7 blocked by an SEO rule" : ""}
                </p>
                <p className="text-muted-foreground text-xs">
                  Waiting for a decision. Nothing is executed in this phase; a person approves,
                  modifies, rejects, or asks for more evidence.
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Nothing waiting for a decision.</p>
            )}
          </div>
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

      {/*
        Next best step prefers a scored opportunity over a signal.
        A signal says something happened; an opportunity says something is worth
        doing and shows the reasoning behind that claim, which is a better place
        to send somebody who has one afternoon.
      */}
      {nextBest ? (
        <section className="border-border space-y-3 rounded-lg border p-5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Next best step
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={nextBest.priority} />
            <p className="text-base">{nextBest.title}</p>
          </div>
          <p className="text-muted-foreground text-sm">{nextBest.summary}</p>
          <Link
            href={`/websites/${websiteId}/opportunities/${nextBest.id}`}
            className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
          >
            See the reasoning
          </Link>
        </section>
      ) : nextStep ? (
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
          Once Search Console and Analytics are connected, this becomes a view of what changed.
          Until then it shows how completely the business has been described — and SEO OS reports no
          search metric it has not been given.
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
