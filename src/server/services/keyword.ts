import { Prisma } from "@/generated/prisma/client";
import type {
  ConnectionProvider,
  Keyword,
  KeywordIntent,
  KeywordMetricsSnapshot,
  RankingSnapshot,
} from "@/generated/prisma/client";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { normalizeKeyword } from "@/lib/keyword/normalize-keyword";
import {
  pickPrimary,
  providersDisagree,
  type Reading,
} from "@/lib/keyword/provider-precedence";

/**
 * Keyword reads (docs/P2_SPEC.md §8, §10, §22, §23).
 *
 * Everything here holds to one rule the acceptance criteria state twice:
 * unavailable metrics remain null. A keyword nobody has volume for shows nothing
 * in that column, never a zero — the difference between "no demand" and "we have
 * not measured the demand" is the difference between a decision and a guess.
 *
 * Where two providers describe the same keyword, both readings are kept and the
 * displayed one carries its provider's name. See provider-precedence for why they
 * are never averaged.
 */

export type KeywordErrorCode = "not_found" | "invalid_relevance" | "duplicate";

export class KeywordError extends Error {
  constructor(
    message: string,
    readonly code: KeywordErrorCode,
  ) {
    super(message);
    this.name = "KeywordError";
  }
}

export type MetricReading = {
  provider: ConnectionProvider;
  capturedAt: Date;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
};

export type RankingReading = {
  provider: ConnectionProvider;
  capturedAt: Date;
  position: number | null;
  previousPosition: number | null;
  rankingUrl: string | null;
  pageId: string | null;
  pagePath: string | null;
};

export type KeywordRow = {
  id: string;
  keyword: string;
  normalizedKeyword: string;
  locale: string;
  market: string;
  intent: KeywordIntent;
  intentProvenance: string;
  businessRelevance: number | null;
  commercialValue: number | null;
  /** The reading shown, and who produced it. Never an average of two. */
  searchVolume: number | null;
  searchVolumeProvider: ConnectionProvider | null;
  keywordDifficulty: number | null;
  keywordDifficultyProvider: ConnectionProvider | null;
  position: number | null;
  previousPosition: number | null;
  positionProvider: ConnectionProvider | null;
  rankingUrl: string | null;
  rankingPageId: string | null;
  rankingPagePath: string | null;
  /** True when providers differ enough on volume to be worth a second look. */
  volumeDisagreement: boolean;
  capturedAt: Date | null;
  lastSeenAt: Date;
};

type LatestMetricRow = {
  keyword_id: string;
  source_provider: ConnectionProvider;
  captured_at: Date;
  search_volume: number | null;
  keyword_difficulty: Prisma.Decimal | null;
  cpc: Prisma.Decimal | null;
};

type LatestRankingRow = {
  keyword_id: string;
  source_provider: ConnectionProvider;
  captured_at: Date;
  position: Prisma.Decimal | null;
  previous_position: Prisma.Decimal | null;
  ranking_url: string | null;
  page_id: string | null;
  page_path: string | null;
};

const toNumber = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : Number(value);

/**
 * The most recent metric reading per keyword per provider.
 *
 * DISTINCT ON rather than a per-keyword query: an explorer page of 50 keywords
 * with two providers would otherwise be 100 round trips, and the answer is one
 * index scan.
 */
async function latestMetrics(keywordIds: string[]): Promise<Map<string, MetricReading[]>> {
  if (keywordIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<LatestMetricRow[]>`
    SELECT DISTINCT ON (keyword_id, source_provider)
      keyword_id, source_provider, captured_at, search_volume, keyword_difficulty, cpc
    FROM keyword_metrics_snapshot
    WHERE keyword_id = ANY(${keywordIds}::uuid[])
    ORDER BY keyword_id, source_provider, captured_at DESC
  `;

  const byKeyword = new Map<string, MetricReading[]>();

  for (const row of rows) {
    const list = byKeyword.get(row.keyword_id) ?? [];
    list.push({
      provider: row.source_provider,
      capturedAt: row.captured_at,
      searchVolume: row.search_volume,
      keywordDifficulty: toNumber(row.keyword_difficulty),
      cpc: toNumber(row.cpc),
    });
    byKeyword.set(row.keyword_id, list);
  }

  return byKeyword;
}

async function latestRankings(keywordIds: string[]): Promise<Map<string, RankingReading[]>> {
  if (keywordIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<LatestRankingRow[]>`
    SELECT DISTINCT ON (r.keyword_id, r.source_provider)
      r.keyword_id, r.source_provider, r.captured_at, r.position, r.previous_position,
      r.ranking_url, r.page_id, p.path AS page_path
    FROM ranking_snapshot r
    LEFT JOIN page p ON p.id = r.page_id
    WHERE r.keyword_id = ANY(${keywordIds}::uuid[])
    ORDER BY r.keyword_id, r.source_provider, r.captured_at DESC
  `;

  const byKeyword = new Map<string, RankingReading[]>();

  for (const row of rows) {
    const list = byKeyword.get(row.keyword_id) ?? [];
    list.push({
      provider: row.source_provider,
      capturedAt: row.captured_at,
      position: toNumber(row.position),
      previousPosition: toNumber(row.previous_position),
      rankingUrl: row.ranking_url,
      pageId: row.page_id,
      pagePath: row.page_path,
    });
    byKeyword.set(row.keyword_id, list);
  }

  return byKeyword;
}

function assembleRow(
  keyword: Keyword,
  metrics: MetricReading[],
  rankings: RankingReading[],
): KeywordRow {
  const volumeReadings: Reading<number | null>[] = metrics.map((reading) => ({
    provider: reading.provider,
    capturedAt: reading.capturedAt,
    value: reading.searchVolume,
  }));

  const primaryMetric = pickPrimary(
    metrics.map((reading) => ({
      provider: reading.provider,
      capturedAt: reading.capturedAt,
      value: reading,
    })),
  );

  const primaryRanking = pickPrimary(
    rankings.map((reading) => ({
      provider: reading.provider,
      capturedAt: reading.capturedAt,
      value: reading,
    })),
  );

  return {
    id: keyword.id,
    keyword: keyword.keyword,
    normalizedKeyword: keyword.normalizedKeyword,
    locale: keyword.locale,
    market: keyword.market,
    intent: keyword.intent,
    intentProvenance: keyword.intentProvenance,
    businessRelevance: keyword.businessRelevance,
    commercialValue: keyword.commercialValue,
    searchVolume: primaryMetric?.value.searchVolume ?? null,
    searchVolumeProvider: primaryMetric?.provider ?? null,
    keywordDifficulty: primaryMetric?.value.keywordDifficulty ?? null,
    keywordDifficultyProvider: primaryMetric?.provider ?? null,
    position: primaryRanking?.value.position ?? null,
    previousPosition: primaryRanking?.value.previousPosition ?? null,
    positionProvider: primaryRanking?.provider ?? null,
    rankingUrl: primaryRanking?.value.rankingUrl ?? null,
    rankingPageId: primaryRanking?.value.pageId ?? null,
    rankingPagePath: primaryRanking?.value.pagePath ?? null,
    volumeDisagreement: providersDisagree(volumeReadings),
    capturedAt: primaryMetric?.capturedAt ?? primaryRanking?.capturedAt ?? null,
    lastSeenAt: keyword.lastSeenAt,
  };
}

export type KeywordListOptions = {
  search?: string;
  intent?: KeywordIntent;
  /** Only keywords this provider has reported on. */
  provider?: ConnectionProvider;
  limit?: number;
  offset?: number;
};

export async function listKeywords(
  context: TenantContext,
  options: KeywordListOptions = {},
): Promise<KeywordRow[]> {
  const limit = Math.min(options.limit ?? 50, 500);
  const search = options.search?.trim();

  const keywords = await prisma.keyword.findMany({
    where: {
      ...websiteScope(context),
      status: "ACTIVE",
      ...(options.intent ? { intent: options.intent } : {}),
      ...(search
        ? // Search the normalized form: somebody typing "Payroll  Software" should
          // find the keyword however it was capitalised in the export.
          { normalizedKeyword: { contains: search.toLowerCase(), mode: "insensitive" as const } }
        : {}),
      ...(options.provider
        ? { metricSnapshots: { some: { sourceProvider: options.provider } } }
        : {}),
    },
    orderBy: [{ lastSeenAt: "desc" }, { normalizedKeyword: "asc" }],
    take: limit,
    skip: options.offset ?? 0,
  });

  const ids = keywords.map((keyword) => keyword.id);
  const [metrics, rankings] = await Promise.all([latestMetrics(ids), latestRankings(ids)]);

  return keywords.map((keyword) =>
    assembleRow(keyword, metrics.get(keyword.id) ?? [], rankings.get(keyword.id) ?? []),
  );
}

export async function countKeywords(
  context: TenantContext,
  options: KeywordListOptions = {},
): Promise<number> {
  const search = options.search?.trim();

  return prisma.keyword.count({
    where: {
      ...websiteScope(context),
      status: "ACTIVE",
      ...(options.intent ? { intent: options.intent } : {}),
      ...(search
        ? { normalizedKeyword: { contains: search.toLowerCase(), mode: "insensitive" as const } }
        : {}),
    },
  });
}

export type FirstPartyEvidence = {
  clicks: number;
  impressions: number;
  /** SUM(clicks) / SUM(impressions), never an average of row CTRs. */
  ctr: number | null;
  /** Impression-weighted, never a naive average. */
  position: number | null;
  days: number;
};

export type KeywordDetail = {
  keyword: Keyword;
  /** Every provider's latest reading, not just the displayed one. */
  metrics: MetricReading[];
  rankings: RankingReading[];
  metricHistory: KeywordMetricsSnapshot[];
  rankingHistory: (RankingSnapshot & { pagePath: string | null })[];
  /**
   * What Search Console says about the same string.
   *
   * This join is the point of sharing one text-folding rule between queries and
   * keywords: market demand on one side, our actual clicks on the other, for the
   * same words. Null when Search Console has never reported the query.
   */
  firstParty: FirstPartyEvidence | null;
  row: KeywordRow;
};

/** How far back the first-party comparison reaches. Matches P1's default window. */
const FIRST_PARTY_DAYS = 28;

export async function getKeyword(
  context: TenantContext,
  keywordId: string,
): Promise<KeywordDetail | null> {
  const keyword = await prisma.keyword.findFirst({
    where: { id: keywordId, ...websiteScope(context) },
  });

  if (!keyword) return null;

  const [metricsMap, rankingsMap, metricHistory, rankingHistoryRows, firstParty] =
    await Promise.all([
      latestMetrics([keyword.id]),
      latestRankings([keyword.id]),
      prisma.keywordMetricsSnapshot.findMany({
        where: { keywordId: keyword.id },
        orderBy: [{ capturedAt: "desc" }, { sourceProvider: "asc" }],
        take: 90,
      }),
      prisma.rankingSnapshot.findMany({
        where: { keywordId: keyword.id },
        orderBy: [{ capturedAt: "desc" }, { sourceProvider: "asc" }],
        take: 90,
        include: { page: { select: { path: true } } },
      }),
      firstPartyEvidence(context, keyword.normalizedKeyword),
    ]);

  const metrics = metricsMap.get(keyword.id) ?? [];
  const rankings = rankingsMap.get(keyword.id) ?? [];

  return {
    keyword,
    metrics,
    rankings,
    metricHistory,
    rankingHistory: rankingHistoryRows.map(({ page, ...snapshot }) => ({
      ...snapshot,
      pagePath: page?.path ?? null,
    })),
    firstParty,
    row: assembleRow(keyword, metrics, rankings),
  };
}

type FirstPartyRow = {
  clicks: bigint | null;
  impressions: bigint | null;
  position: number | null;
};

async function firstPartyEvidence(
  context: TenantContext,
  normalizedKeyword: string,
): Promise<FirstPartyEvidence | null> {
  const query = await prisma.query.findFirst({
    where: { websiteId: context.website.id, normalizedQuery: normalizedKeyword },
    select: { id: true },
  });

  // No Search Console row for this string. Null, not zero: we have not measured
  // it, which is different from having measured no clicks.
  if (!query) return null;

  const rows = await prisma.$queryRaw<FirstPartyRow[]>`
    SELECT
      SUM(m.clicks)::bigint AS clicks,
      SUM(m.impressions)::bigint AS impressions,
      (SUM(m.position * m.impressions) / NULLIF(SUM(m.impressions), 0))::float AS position
    FROM gsc_metric_daily m
    WHERE m.website_id = ${context.website.id}::uuid
      AND m.query_id = ${query.id}::uuid
      AND m.date >= CURRENT_DATE - ${FIRST_PARTY_DAYS}::int
  `;

  const row = rows[0];
  const clicks = Number(row?.clicks ?? 0);
  const impressions = Number(row?.impressions ?? 0);

  if (impressions === 0 && clicks === 0) return null;

  return {
    clicks,
    impressions,
    ctr: impressions === 0 ? null : clicks / impressions,
    position: row?.position ?? null,
    days: FIRST_PARTY_DAYS,
  };
}

export type KeywordPatch = {
  intent?: KeywordIntent;
  businessRelevance?: number | null;
  commercialValue?: number | null;
};

/**
 * A person's judgement about a keyword.
 *
 * Setting an intent marks it USER_PROVIDED, which is what stops the next import
 * overwriting it. Business relevance has no provider and never will: it is the one
 * input to the opportunity score that only somebody who knows the business can
 * supply, and inventing it would make the whole score a guess wearing a number.
 */
export async function updateKeyword(
  context: TenantContext,
  keywordId: string,
  patch: KeywordPatch,
): Promise<Keyword> {
  const existing = await prisma.keyword.findFirst({
    where: { id: keywordId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new KeywordError("That keyword is not available.", "not_found");
  }

  for (const value of [patch.businessRelevance, patch.commercialValue]) {
    if (value !== undefined && value !== null && (value < 0 || value > 5)) {
      throw new KeywordError("Score from 0 to 5.", "invalid_relevance");
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.keyword.update({
      where: { id: existing.id },
      data: {
        ...(patch.intent !== undefined
          ? { intent: patch.intent, intentProvenance: "USER_PROVIDED" }
          : {}),
        ...(patch.businessRelevance !== undefined
          ? { businessRelevance: patch.businessRelevance }
          : {}),
        ...(patch.commercialValue !== undefined
          ? { commercialValue: patch.commercialValue }
          : {}),
      },
    });

    await recordAudit(tx, context, {
      entityType: "Keyword",
      entityId: updated.id,
      action: "UPDATE",
      before: {
        intent: existing.intent,
        businessRelevance: existing.businessRelevance,
        commercialValue: existing.commercialValue,
      },
      after: {
        intent: updated.intent,
        businessRelevance: updated.businessRelevance,
        commercialValue: updated.commercialValue,
      },
    });

    return updated;
  });
}

/**
 * Adds a keyword by hand.
 *
 * No provider metrics attach to it — nobody has measured it yet — and that is a
 * legitimate state: a keyword the business cares about with no demand data is
 * exactly the gap P2 is meant to surface.
 */
export async function createKeyword(
  context: TenantContext,
  input: { keyword: string; intent?: KeywordIntent },
): Promise<Keyword> {
  const normalized = normalizeKeyword(input.keyword, {
    language: context.website.primaryLanguage,
    market: context.website.primaryMarket,
  });

  if (!normalized.ok) {
    throw new KeywordError("Enter a keyword.", "not_found");
  }

  const identity = {
    websiteId: context.website.id,
    normalizedKeyword: normalized.value.normalized,
    locale: normalized.value.locale,
    language: normalized.value.language,
    market: normalized.value.market,
  };

  const existing = await prisma.keyword.findUnique({
    where: { websiteId_normalizedKeyword_locale_language_market: identity },
  });

  if (existing) {
    throw new KeywordError("That keyword already exists for this market.", "duplicate");
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.keyword.create({
      data: {
        ...identity,
        keyword: input.keyword.trim(),
        intent: input.intent ?? "UNKNOWN",
        intentProvenance: input.intent ? "USER_PROVIDED" : "UNKNOWN",
      },
    });

    await recordAudit(tx, context, {
      entityType: "Keyword",
      entityId: created.id,
      action: "CREATE",
      after: { keyword: created.keyword, market: created.market },
    });

    return created;
  });
}

/** Counts for the Command Center, by the states that need attention. */
export async function getKeywordCounts(context: TenantContext): Promise<{
  total: number;
  withoutVolume: number;
  withoutRanking: number;
  unknownIntent: number;
}> {
  const scope = websiteScope(context);

  const [total, withoutVolume, withoutRanking, unknownIntent] = await Promise.all([
    prisma.keyword.count({ where: { ...scope, status: "ACTIVE" } }),
    prisma.keyword.count({
      where: { ...scope, status: "ACTIVE", metricSnapshots: { none: {} } },
    }),
    prisma.keyword.count({
      where: { ...scope, status: "ACTIVE", rankingSnapshots: { none: {} } },
    }),
    prisma.keyword.count({ where: { ...scope, status: "ACTIVE", intent: "UNKNOWN" } }),
  ]);

  return { total, withoutVolume, withoutRanking, unknownIntent };
}
