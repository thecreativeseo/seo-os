import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/server/db/prisma";
import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { getKeyword } from "@/server/services/keyword";
import { getKeywordCompetitors, THIRD_PARTY_NOTICE } from "@/server/services/competitor-intel";
import { listOpportunities } from "@/server/services/opportunity";
import { listOwnerships } from "@/server/services/ownership";
import { formatPercent } from "@/lib/metrics/format";
import { PageHeader } from "@/components/governance/primitives";
import {
  DisagreementFlag,
  PriorityBadge,
  ProviderTag,
  ScorePill,
} from "@/components/opportunity/primitives";
import {
  AssignOwnershipForm,
  KeywordJudgementForm,
} from "@/components/opportunity/controls";

export const metadata = { title: "Keyword · SEO OS" };

/**
 * Keyword detail.
 *
 * Market demand on one side, our own clicks on the other, for the same words.
 * That join only works because queries and keywords share one folding rule, and
 * it is the single most useful thing on this screen: a keyword with demand and no
 * clicks reads very differently from one with neither.
 */
export default async function KeywordDetailPage({
  params,
}: {
  params: Promise<{ websiteId: string; keywordId: string }>;
}) {
  const { websiteId, keywordId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const detail = await getKeyword(context, keywordId);

  if (!detail) notFound();

  const canWrite = hasRole(context.membership.role, "MEMBER");

  const [competitors, ownerships, opportunities, goals, pages] = await Promise.all([
    getKeywordCompetitors(context, keywordId),
    listOwnerships(context, keywordId),
    listOpportunities(context, { limit: 100 }),
    prisma.businessGoal.findMany({
      // A retired goal should not be offered for new work, but a draft one
      // should: teams link keywords while the goal is still being written.
      where: { websiteId: context.website.id, status: { not: "RETIRED" } },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    }),
    canWrite
      ? prisma.page.findMany({
          where: { websiteId: context.website.id, status: "ACTIVE" },
          select: { id: true, path: true },
          orderBy: { path: "asc" },
          take: 500,
        })
      : [],
  ]);

  const related = opportunities.filter((row) => row.keywordId === keywordId);
  const activeOwner = ownerships.find(
    (row) => row.ownershipType === "PRIMARY" && row.status === "ACTIVE",
  );
  const { row, keyword } = detail;

  return (
    <main className="space-y-8">
      <div className="space-y-2">
        <Link
          href={`/websites/${websiteId}/keywords`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Keywords
        </Link>
        <PageHeader
          title={keyword.keyword}
          description={`${keyword.locale} · intent ${keyword.intent.toLowerCase()} (${keyword.intentProvenance.replace("_", " ").toLowerCase()})`}
        />
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Search volume",
            value:
              row.searchVolume === null ? "—" : row.searchVolume.toLocaleString("en-GB"),
            provider: row.searchVolumeProvider,
            flag: row.volumeDisagreement,
          },
          {
            label: "Difficulty",
            value: row.keywordDifficulty === null ? "—" : String(row.keywordDifficulty),
            provider: row.keywordDifficultyProvider,
            flag: false,
          },
          {
            label: "Position",
            value: row.position === null ? "—" : String(row.position),
            provider: row.positionProvider,
            flag: false,
          },
          {
            label: "Business relevance",
            value: row.businessRelevance === null ? "Not set" : `${row.businessRelevance} / 5`,
            provider: null,
            flag: false,
          },
        ].map((card) => (
          <div key={card.label} className="border-border rounded-lg border p-4">
            <p className="text-muted-foreground text-xs">{card.label}</p>
            <p className="mt-1 text-xl font-medium tabular-nums">
              {card.value}
              <ProviderTag provider={card.provider} />
              <DisagreementFlag show={card.flag} />
            </p>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Intended owner and ranking page</h2>

        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
            <dt className="text-muted-foreground">Nominated to own it</dt>
            <dd>
              {activeOwner ? (
                activeOwner.page.path
              ) : (
                <span className="text-muted-foreground">No page nominated</span>
              )}
            </dd>
          </div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
            <dt className="text-muted-foreground">Ranking most recently</dt>
            <dd>
              {row.rankingPagePath ?? row.rankingUrl ?? (
                <span className="text-muted-foreground">Nothing recorded</span>
              )}
              {activeOwner &&
              row.rankingPageId !== null &&
              row.rankingPageId !== activeOwner.pageId ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  {/* Observed, not diagnosed. */}
                  This is not the page nominated to own the keyword.
                </p>
              ) : null}
            </dd>
          </div>
        </dl>

        {canWrite ? (
          <AssignOwnershipForm
            websiteId={websiteId}
            keywordId={keywordId}
            pages={pages}
            currentPageId={activeOwner?.pageId ?? null}
          />
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">What Search Console reports</h2>

        {detail.firstParty ? (
          <dl className="border-border grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
            {[
              {
                label: "Clicks",
                value: detail.firstParty.clicks.toLocaleString("en-GB"),
              },
              {
                label: "Impressions",
                value: detail.firstParty.impressions.toLocaleString("en-GB"),
              },
              { label: "CTR", value: formatPercent(detail.firstParty.ctr) },
              {
                label: "Position",
                value:
                  detail.firstParty.position === null
                    ? "—"
                    : detail.firstParty.position.toFixed(1),
              },
            ].map((stat) => (
              <div key={stat.label} className="bg-background px-4 py-3">
                <dt className="text-muted-foreground text-xs">
                  {stat.label}
                  <ProviderTag provider="GOOGLE_SEARCH_CONSOLE" />
                </dt>
                <dd className="mt-0.5 text-lg font-medium tabular-nums">{stat.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground text-sm">
            Search Console has not reported this exact query in the last 28 days. That
            is different from reporting no clicks for it.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Ranking history</h2>

        {detail.rankingHistory.length === 0 ? (
          <p className="text-muted-foreground text-sm">No ranking snapshots yet.</p>
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-muted-foreground border-b text-left">
                  <th className="px-4 py-2 font-medium">Captured</th>
                  <th className="px-3 py-2 text-right font-medium">Position</th>
                  <th className="px-3 py-2 font-medium">Page</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {detail.rankingHistory.slice(0, 20).map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td className="px-4 py-2.5 text-xs">
                      {snapshot.capturedAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {snapshot.position === null ? "—" : Number(snapshot.position)}
                    </td>
                    <td className="text-muted-foreground max-w-sm truncate px-3 py-2.5 text-xs">
                      {snapshot.pagePath ?? snapshot.rankingUrl ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      <ProviderTag provider={snapshot.sourceProvider} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {competitors.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Who else ranks for this</h2>
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-muted-foreground border-b text-left">
                  <th className="px-4 py-2 font-medium">Competitor</th>
                  <th className="px-3 py-2 text-right font-medium">Position</th>
                  <th className="px-3 py-2 font-medium">Captured</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {competitors.map((competitor) => (
                  <tr key={competitor.competitorId}>
                    <td className="px-4 py-2.5">
                      {competitor.competitorName}
                      <ProviderTag provider={competitor.attribution.provider} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {competitor.position ?? "—"}
                    </td>
                    <td className="text-muted-foreground px-3 py-2.5 text-xs">
                      {competitor.attribution.capturedAt.toISOString().slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground text-xs">{THIRD_PARTY_NOTICE}</p>
        </section>
      ) : null}

      {related.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Opportunities</h2>
          <ul className="divide-border border-border divide-y rounded-lg border">
            {related.map((opportunity) => (
              <li
                key={opportunity.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <Link
                  href={`/websites/${websiteId}/opportunities/${opportunity.id}`}
                  className="text-sm underline underline-offset-4"
                >
                  {opportunity.title}
                </Link>
                <span className="flex items-center gap-3">
                  <PriorityBadge priority={opportunity.priority} />
                  <ScorePill
                    score={opportunity.score === null ? null : Number(opportunity.score)}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canWrite ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Your team&apos;s judgement</h2>
          <div className="border-border rounded-lg border p-5">
            <KeywordJudgementForm
              websiteId={websiteId}
              keywordId={keywordId}
              intent={keyword.intent}
              businessRelevance={keyword.businessRelevance}
              commercialValue={keyword.commercialValue}
              businessGoalId={keyword.businessGoalId}
              goals={goals}
            />
          </div>
        </section>
      ) : null}
    </main>
  );
}
