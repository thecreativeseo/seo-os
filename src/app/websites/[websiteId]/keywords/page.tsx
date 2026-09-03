import Link from "next/link";

import { prisma } from "@/server/db/prisma";
import { requireWebsiteAccess } from "@/server/auth/guards";
import { countKeywords, listKeywords } from "@/server/services/keyword";
import { getOwnershipCounts } from "@/server/services/ownership";
import { listOpportunities } from "@/server/services/opportunity";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import {
  DisagreementFlag,
  PriorityBadge,
  ProviderTag,
} from "@/components/opportunity/primitives";
import type { KeywordIntent } from "@/generated/prisma/client";

export const metadata = { title: "Keywords · SEO OS" };

const PAGE_SIZE = 50;

const INTENTS: KeywordIntent[] = [
  "COMMERCIAL",
  "TRANSACTIONAL",
  "INFORMATIONAL",
  "NAVIGATIONAL",
  "LOCAL",
  "MIXED",
  "UNKNOWN",
];

/**
 * Keyword Explorer.
 *
 * The intended owner and the page actually ranking sit next to each other,
 * because their disagreement is the thing worth noticing and putting them in
 * distant columns would hide it.
 */
export default async function KeywordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<{ q?: string; intent?: string; page?: string }>;
}) {
  const { websiteId } = await params;
  const { q, intent: intentParam, page: pageParam } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const pageNumber = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const intent = INTENTS.find((value) => value === intentParam);

  const [rows, total, ownershipCounts, opportunities, topicMap] = await Promise.all([
    listKeywords(context, {
      search: q,
      intent,
      limit: PAGE_SIZE + 1,
      offset: (pageNumber - 1) * PAGE_SIZE,
    }),
    countKeywords(context, { search: q, intent }),
    getOwnershipCounts(context),
    // Which keywords already have work queued against them. Shown as a marker
    // rather than a count: the explorer answers "what is here", the queue
    // answers "what should I do".
    listOpportunities(context, { limit: 500 }),
    prisma.topicKeyword.findMany({
      where: { topic: { websiteId: context.website.id, status: "ACTIVE" } },
      select: { keywordId: true, topic: { select: { id: true, name: true } } },
    }),
  ]);

  const opportunityByKeyword = new Map(
    opportunities
      .filter((row) => row.keywordId !== null)
      .map((row) => [row.keywordId!, row]),
  );
  const topicByKeyword = new Map(topicMap.map((row) => [row.keywordId, row.topic]));

  const hasNext = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const divergences = ownershipCounts.RANKING_URL_DIVERGENCE ?? 0;

  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Keywords"
          description="What the market searches for, what this site ranks for, and which page was meant to."
        />
        {/* Synthetic market data must be recognisable as synthetic on every
            screen that shows it, not only the ones built first. */}
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {total.toLocaleString("en-GB")} keywords
          {divergences > 0
            ? ` · ${divergences} where the ranking page is not the intended owner`
            : ""}
        </p>

        <form method="get" className="flex items-center gap-2">
          <label htmlFor="keyword-search" className="sr-only">
            Search keywords
          </label>
          <input
            id="keyword-search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search keywords"
            className="border-border h-9 w-56 rounded-md border px-3 text-sm"
          />
          {intent ? <input type="hidden" name="intent" value={intent} /> : null}
          <button
            type="submit"
            className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-3 text-sm"
          >
            Search
          </button>
        </form>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">Intent</span>
        <Link
          href={`/websites/${websiteId}/keywords${q ? `?q=${encodeURIComponent(q)}` : ""}`}
          className={`rounded border px-2 py-0.5 text-xs ${intent ? "border-border" : "border-foreground"}`}
        >
          All
        </Link>
        {INTENTS.map((value) => (
          <Link
            key={value}
            href={`/websites/${websiteId}/keywords?intent=${value}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className={`rounded border px-2 py-0.5 text-xs ${
              intent === value ? "border-foreground" : "border-border"
            }`}
          >
            {value.charAt(0) + value.slice(1).toLowerCase()}
          </Link>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState>
          {total === 0
            ? "No keywords yet. Import a Semrush or Ahrefs export from Connections → Imports."
            : "No keywords match this search."}
        </EmptyState>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left">
                <th className="px-4 py-2 font-medium">Keyword</th>
                <th className="px-3 py-2 font-medium">Intent</th>
                <th className="px-3 py-2 text-right font-medium">Volume</th>
                <th className="px-3 py-2 text-right font-medium">KD</th>
                <th className="px-3 py-2 text-right font-medium">Position</th>
                <th className="px-3 py-2 text-right font-medium">Previous</th>
                <th className="px-3 py-2 font-medium">Intended owner</th>
                <th className="px-3 py-2 font-medium">Ranking page</th>
                <th className="px-3 py-2 font-medium">Topic</th>
                <th className="px-3 py-2 text-right font-medium">Relevance</th>
                <th className="px-3 py-2 font-medium">Opportunity</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {visible.map((row) => {
                // The disagreement this screen exists to surface: a page was
                // nominated, and Google ranked a different one.
                const diverges =
                  row.ownerPageId !== null &&
                  row.rankingPageId !== null &&
                  row.ownerPageId !== row.rankingPageId;

                return (
                  <tr key={row.id}>
                    <td className="max-w-xs px-4 py-3">
                      <Link
                        href={`/websites/${websiteId}/keywords/${row.id}`}
                        className="underline underline-offset-4"
                      >
                        {row.keyword}
                      </Link>
                      <span className="text-muted-foreground ml-1.5 text-xs">
                        {row.market}
                      </span>
                    </td>
                    <td className="text-muted-foreground px-3 py-3 text-xs">
                      {row.intent.charAt(0) + row.intent.slice(1).toLowerCase()}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {row.searchVolume === null
                        ? "—"
                        : row.searchVolume.toLocaleString("en-GB")}
                      <ProviderTag provider={row.searchVolumeProvider} />
                      <DisagreementFlag show={row.volumeDisagreement} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {row.keywordDifficulty === null ? "—" : row.keywordDifficulty}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {row.position === null ? "—" : row.position}
                    </td>
                    <td className="text-muted-foreground px-3 py-3 text-right text-xs tabular-nums">
                      {/* Only when the provider supplied it. Deriving it from our
                          own history would mix two different claims. */}
                      {row.previousPosition === null ? "—" : row.previousPosition}
                    </td>
                    <td className="text-muted-foreground max-w-[12rem] truncate px-3 py-3 text-xs">
                      {row.ownerPath ?? (
                        <span className="italic">not nominated</span>
                      )}
                    </td>
                    <td
                      className={`max-w-[12rem] truncate px-3 py-3 text-xs ${
                        diverges
                          ? "font-medium text-amber-700 dark:text-amber-400"
                          : "text-muted-foreground"
                      }`}
                      title={
                        diverges
                          ? "The page ranking is not the page nominated to own this keyword."
                          : undefined
                      }
                    >
                      {row.rankingPagePath ?? row.rankingUrl ?? "—"}
                    </td>
                    <td className="text-muted-foreground max-w-[9rem] truncate px-3 py-3 text-xs">
                      {topicByKeyword.get(row.id)?.name ?? "—"}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {row.businessRelevance ?? (
                        <span className="text-muted-foreground text-xs">not set</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {opportunityByKeyword.has(row.id) ? (
                        <Link
                          href={`/websites/${websiteId}/opportunities/${opportunityByKeyword.get(row.id)!.id}`}
                          className="underline underline-offset-4"
                        >
                          <PriorityBadge
                            priority={opportunityByKeyword.get(row.id)!.priority}
                          />
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(pageNumber > 1 || hasNext) && (
        <div className="flex items-center gap-4 text-sm">
          {pageNumber > 1 ? (
            <Link
              href={`/websites/${websiteId}/keywords?page=${pageNumber - 1}`}
              className="underline underline-offset-4"
            >
              Previous
            </Link>
          ) : null}
          {hasNext ? (
            <Link
              href={`/websites/${websiteId}/keywords?page=${pageNumber + 1}`}
              className="underline underline-offset-4"
            >
              Next
            </Link>
          ) : null}
        </div>
      )}
    </main>
  );
}
