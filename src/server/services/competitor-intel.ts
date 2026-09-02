import { Prisma } from "@/generated/prisma/client";
import type { Competitor, ConnectionProvider } from "@/generated/prisma/client";

import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";

/**
 * Competitor search intelligence (docs/P2_SPEC.md §16).
 *
 * Two rules from the spec shape everything here, and both are about restraint:
 *
 *   "Do not present third-party estimates as first-party truth."
 *   "Do not claim exact market share."
 *
 * So every row this module returns carries the provider that produced it and the
 * date they produced it, and nothing here computes a share, a visibility index or
 * an estimated traffic figure. Those numbers are the easiest thing in SEO to
 * generate and the hardest to defend: they are model output presented with the
 * confidence of a measurement, and a competitor "owning 34% of the market" is a
 * sentence no data we hold can support.
 *
 * What can be supported is counting. They rank for this and we do not. They rank
 * above us here and below us there. Those are facts about stored snapshots, and
 * they are enough to decide where to work.
 */

/** How far down a competitor has to rank before their position is interesting. */
export const COMPETITOR_GAP_DEPTH = 10;

/**
 * Attribution carried by every figure in this module.
 *
 * Not decoration: the same number means different things depending on who
 * measured it and when, and a competitor's position from three months ago is not
 * evidence about today.
 */
export type ThirdPartyAttribution = {
  provider: ConnectionProvider;
  capturedAt: Date;
  /** Always false here. Present so a component cannot forget to ask. */
  firstParty: false;
};

export type CompetitorSummary = {
  competitor: Competitor;
  /** Keywords where both we and they have a ranking snapshot. */
  sharedKeywords: number;
  /** Keywords they rank for and we do not. */
  theirKeywordsOnly: number;
  /** Of the shared keywords, how many they place above us on. */
  aheadOfUs: number;
  behindUs: number;
  latestCapturedAt: Date | null;
  provider: ConnectionProvider | null;
};

type SummaryRow = {
  competitor_id: string;
  shared_keywords: bigint;
  their_only: bigint;
  ahead_of_us: bigint;
  behind_us: bigint;
  latest_captured_at: Date | null;
  provider: ConnectionProvider | null;
};

/**
 * Counts per competitor.
 *
 * Positions are only ever compared within the same capture date. Comparing our
 * position from August to theirs from June would produce a number that looks like
 * a comparison and is not one — the SERP moved in between, and neither figure is
 * evidence about the other's day.
 */
export async function getCompetitorSummaries(
  context: TenantContext,
): Promise<CompetitorSummary[]> {
  const competitors = await prisma.competitor.findMany({
    where: { ...websiteScope(context), status: "ACTIVE" },
    orderBy: { name: "asc" },
  });

  if (competitors.length === 0) return [];

  const rows = await prisma.$queryRaw<SummaryRow[]>`
    WITH ours AS (
      SELECT DISTINCT ON (keyword_id, captured_at)
        keyword_id, captured_at, position
      FROM ranking_snapshot
      WHERE website_id = ${context.website.id}::uuid
      ORDER BY keyword_id, captured_at, position ASC
    ),
    theirs AS (
      SELECT DISTINCT ON (competitor_id, keyword_id, captured_at)
        competitor_id, keyword_id, captured_at, position, source_provider
      FROM competitor_keyword_snapshot
      WHERE website_id = ${context.website.id}::uuid
      ORDER BY competitor_id, keyword_id, captured_at, position ASC
    )
    SELECT
      t.competitor_id,
      COUNT(DISTINCT CASE WHEN o.keyword_id IS NOT NULL THEN t.keyword_id END) AS shared_keywords,
      COUNT(DISTINCT CASE WHEN o.keyword_id IS NULL THEN t.keyword_id END) AS their_only,
      -- Same capture date on both sides, or the comparison is meaningless.
      COUNT(DISTINCT CASE WHEN o.position IS NOT NULL AND t.position < o.position THEN t.keyword_id END) AS ahead_of_us,
      COUNT(DISTINCT CASE WHEN o.position IS NOT NULL AND t.position > o.position THEN t.keyword_id END) AS behind_us,
      MAX(t.captured_at) AS latest_captured_at,
      MIN(t.source_provider::text)::"ConnectionProvider" AS provider
    FROM theirs t
    LEFT JOIN ours o
      ON o.keyword_id = t.keyword_id
     AND o.captured_at = t.captured_at
    GROUP BY t.competitor_id
  `;

  const byCompetitor = new Map(rows.map((row) => [row.competitor_id, row]));

  return competitors.map((competitor) => {
    const row = byCompetitor.get(competitor.id);

    return {
      competitor,
      sharedKeywords: Number(row?.shared_keywords ?? 0),
      theirKeywordsOnly: Number(row?.their_only ?? 0),
      aheadOfUs: Number(row?.ahead_of_us ?? 0),
      behindUs: Number(row?.behind_us ?? 0),
      latestCapturedAt: row?.latest_captured_at ?? null,
      provider: row?.provider ?? null,
    };
  });
}

export type CompetitorGap = {
  keywordId: string;
  keyword: string;
  competitorId: string;
  competitorName: string;
  theirPosition: number | null;
  ourPosition: number | null;
  /** Whether we rank at all, or rank behind them. */
  kind: "no_ranking" | "outranked";
  hasOwningPage: boolean;
  searchVolume: number | null;
  attribution: ThirdPartyAttribution;
};

type GapRow = {
  keyword_id: string;
  keyword: string;
  competitor_id: string;
  competitor_name: string;
  their_position: Prisma.Decimal | null;
  our_position: Prisma.Decimal | null;
  has_owner: boolean;
  search_volume: number | null;
  captured_at: Date;
  source_provider: ConnectionProvider;
};

/**
 * Keywords a competitor ranks well for that we do not.
 *
 * Two kinds, kept apart because they call for different work: one where we do not
 * appear at all, and one where we appear behind them. Merging them would hide
 * which of the two a person is looking at.
 */
export async function listCompetitorGaps(
  context: TenantContext,
  options: { competitorId?: string; depth?: number; limit?: number } = {},
): Promise<CompetitorGap[]> {
  const depth = options.depth ?? COMPETITOR_GAP_DEPTH;

  const rows = await prisma.$queryRaw<GapRow[]>`
    WITH theirs AS (
      SELECT DISTINCT ON (c.competitor_id, c.keyword_id)
        c.competitor_id, c.keyword_id, c.position, c.captured_at, c.source_provider
      FROM competitor_keyword_snapshot c
      WHERE c.website_id = ${context.website.id}::uuid
        ${options.competitorId ? Prisma.sql`AND c.competitor_id = ${options.competitorId}::uuid` : Prisma.empty}
      ORDER BY c.competitor_id, c.keyword_id, c.captured_at DESC
    ),
    ours AS (
      SELECT DISTINCT ON (keyword_id)
        keyword_id, position
      FROM ranking_snapshot
      WHERE website_id = ${context.website.id}::uuid
      ORDER BY keyword_id, captured_at DESC
    ),
    volume AS (
      SELECT DISTINCT ON (keyword_id)
        keyword_id, search_volume
      FROM keyword_metrics_snapshot
      WHERE website_id = ${context.website.id}::uuid
      ORDER BY keyword_id, captured_at DESC
    )
    SELECT
      t.keyword_id,
      k.keyword,
      t.competitor_id,
      comp.name AS competitor_name,
      t.position AS their_position,
      o.position AS our_position,
      EXISTS (
        SELECT 1 FROM keyword_page_ownership own
        WHERE own.keyword_id = k.id
          AND own.ownership_type = 'PRIMARY'
          AND own.status = 'ACTIVE'
      ) AS has_owner,
      v.search_volume,
      t.captured_at,
      t.source_provider
    FROM theirs t
    JOIN keyword k ON k.id = t.keyword_id
    JOIN competitor comp ON comp.id = t.competitor_id
    LEFT JOIN ours o ON o.keyword_id = t.keyword_id
    LEFT JOIN volume v ON v.keyword_id = t.keyword_id
    WHERE t.position IS NOT NULL
      AND t.position <= ${depth}
      AND (o.position IS NULL OR o.position > t.position)
    ORDER BY v.search_volume DESC NULLS LAST, t.position ASC
    LIMIT ${options.limit ?? 100}
  `;

  return rows.map((row) => ({
    keywordId: row.keyword_id,
    keyword: row.keyword,
    competitorId: row.competitor_id,
    competitorName: row.competitor_name,
    theirPosition: row.their_position === null ? null : Number(row.their_position),
    ourPosition: row.our_position === null ? null : Number(row.our_position),
    kind: row.our_position === null ? "no_ranking" : "outranked",
    hasOwningPage: row.has_owner,
    searchVolume: row.search_volume,
    attribution: {
      provider: row.source_provider,
      capturedAt: row.captured_at,
      firstParty: false,
    },
  }));
}

export type KeywordCompetitor = {
  competitorId: string;
  competitorName: string;
  domain: string | null;
  position: number | null;
  rankingUrl: string | null;
  attribution: ThirdPartyAttribution;
};

/** Who else ranks for one keyword, for the keyword detail screen. */
export async function getKeywordCompetitors(
  context: TenantContext,
  keywordId: string,
): Promise<KeywordCompetitor[]> {
  const rows = await prisma.competitorKeywordSnapshot.findMany({
    where: { keywordId, ...websiteScope(context) },
    orderBy: [{ capturedAt: "desc" }, { position: "asc" }],
    include: { competitor: { select: { id: true, name: true, domain: true } } },
    distinct: ["competitorId"],
  });

  return rows.map((row) => ({
    competitorId: row.competitor.id,
    competitorName: row.competitor.name,
    domain: row.competitor.domain,
    position: row.position === null ? null : Number(row.position),
    rankingUrl: row.rankingUrl,
    attribution: {
      provider: row.sourceProvider,
      capturedAt: row.capturedAt,
      firstParty: false,
    },
  }));
}

/**
 * Topics where competitors rank and we are thin.
 *
 * Joins competitor evidence to the topic map, which is the only place in P2 where
 * third-party data touches something a person authored. It stays a count of
 * keywords rather than a judgement about the topic.
 */
export type TopicCompetitorOverlap = {
  topicId: string;
  topicName: string;
  keywordsInTopic: number;
  keywordsCompetitorsRankFor: number;
  keywordsWeRankFor: number;
};

type TopicOverlapRow = {
  topic_id: string;
  topic_name: string;
  keywords_in_topic: bigint;
  competitor_keywords: bigint;
  our_keywords: bigint;
};

export async function getTopicCompetitorOverlap(
  context: TenantContext,
): Promise<TopicCompetitorOverlap[]> {
  const rows = await prisma.$queryRaw<TopicOverlapRow[]>`
    SELECT
      t.id AS topic_id,
      t.name AS topic_name,
      COUNT(DISTINCT tk.keyword_id) AS keywords_in_topic,
      COUNT(DISTINCT c.keyword_id) AS competitor_keywords,
      COUNT(DISTINCT r.keyword_id) AS our_keywords
    FROM topic t
    LEFT JOIN topic_keyword tk ON tk.topic_id = t.id
    LEFT JOIN competitor_keyword_snapshot c ON c.keyword_id = tk.keyword_id
    LEFT JOIN ranking_snapshot r ON r.keyword_id = tk.keyword_id
    WHERE t.website_id = ${context.website.id}::uuid
      AND t.status = 'ACTIVE'
    GROUP BY t.id, t.name
    ORDER BY COUNT(DISTINCT c.keyword_id) DESC
  `;

  return rows.map((row) => ({
    topicId: row.topic_id,
    topicName: row.topic_name,
    keywordsInTopic: Number(row.keywords_in_topic),
    keywordsCompetitorsRankFor: Number(row.competitor_keywords),
    keywordsWeRankFor: Number(row.our_keywords),
  }));
}

/**
 * The sentence shown wherever competitor figures appear.
 *
 * Stated rather than implied: a reader should never have to work out which
 * numbers on a screen we measured and which we were told.
 */
export const THIRD_PARTY_NOTICE =
  "Competitor figures come from a third-party provider and describe what that provider observed, not what this website measured.";
