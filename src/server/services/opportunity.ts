import { Prisma } from "@/generated/prisma/client";
import type {
  Opportunity,
  OpportunityEvidence,
  OpportunityPriority,
  OpportunityStatus,
  OpportunityType,
} from "@/generated/prisma/client";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import {
  requireTenantMember,
  websiteScope,
  type TenantContext,
} from "@/server/auth/guards";
import {
  detectOpportunities,
  type KeywordFact,
  type PageDeclineFact,
  type SignalFact,
  type TopicFact,
} from "@/lib/opportunity/rules";
import { rescore, type SubScore } from "@/lib/opportunity/scoring";
import { listTopics } from "@/server/services/topic";

/**
 * Opportunities (docs/P2_SPEC.md §18, §19, §25).
 *
 * Where P2 converges. Keywords, rankings, ownership, topics, competitors and P1's
 * signals are assembled into plain facts, the rules run over them, and what comes
 * out is stored with the evidence and the scoring breakdown that produced it.
 *
 * Two properties this file exists to guarantee:
 *
 *   - **Re-running detection updates rather than duplicates.** The identity index
 *     treats NULLs as equal, so an opportunity with no keyword and no competitor
 *     still collides with itself. P1 learned this the expensive way.
 *   - **A person's judgement outranks a rule.** An opportunity somebody QUALIFIED
 *     or DECLINED keeps that status through every subsequent run and gains fresh
 *     evidence instead. Re-detection is allowed to change what we know; it is not
 *     allowed to overrule what somebody decided.
 */

export type OpportunityErrorCode = "not_found" | "invalid_transition" | "owner_not_member";

export class OpportunityError extends Error {
  constructor(
    message: string,
    readonly code: OpportunityErrorCode,
  ) {
    super(message);
    this.name = "OpportunityError";
  }
}

/** Statuses a rule may set. Everything else belongs to a person. */
const DETECTED_STATUSES: OpportunityStatus[] = ["IDENTIFIED"];

type KeywordRow = {
  keyword_id: string;
  keyword: string;
  intent: string;
  intent_provenance: string;
  business_relevance: number | null;
  commercial_value: number | null;
  search_volume: number | null;
  distinct_providers: bigint;
  min_volume: number | null;
  max_volume: number | null;
  position: Prisma.Decimal | null;
  captured_at: Date | null;
  owner_page_id: string | null;
  owner_path: string | null;
  ranking_page_id: string | null;
  ranking_path: string | null;
  distinct_ranking_pages: bigint;
  topic_id: string | null;
  topic_name: string | null;
  is_commercial_destination: boolean;
  competitors_ranking: bigint;
  competitors_ahead: bigint;
};

const DISAGREEMENT = 0.25;

function daysBetween(from: Date | null, now: Date): number | null {
  if (!from) return null;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

/**
 * One query for every keyword fact the rules need.
 *
 * Assembling this in SQL rather than in loops is what keeps detection over a few
 * thousand keywords a single round trip. The rules themselves stay pure.
 */
async function keywordFacts(
  context: TenantContext,
  now: Date,
): Promise<KeywordFact[]> {
  const rows = await prisma.$queryRaw<KeywordRow[]>`
    WITH latest_metric AS (
      SELECT DISTINCT ON (keyword_id)
        keyword_id, search_volume, captured_at
      FROM keyword_metrics_snapshot
      WHERE website_id = ${context.website.id}::uuid
      ORDER BY keyword_id, captured_at DESC
    ),
    metric_spread AS (
      SELECT keyword_id,
             COUNT(DISTINCT source_provider) AS distinct_providers,
             MIN(search_volume) AS min_volume,
             MAX(search_volume) AS max_volume
      FROM keyword_metrics_snapshot
      WHERE website_id = ${context.website.id}::uuid
        AND search_volume IS NOT NULL
      GROUP BY keyword_id
    ),
    latest_ranking AS (
      SELECT DISTINCT ON (keyword_id)
        keyword_id, position, page_id, captured_at
      FROM ranking_snapshot
      WHERE website_id = ${context.website.id}::uuid
      ORDER BY keyword_id, captured_at DESC
    ),
    ranking_pages AS (
      SELECT keyword_id, COUNT(DISTINCT COALESCE(page_id::text, ranking_url)) AS pages
      FROM ranking_snapshot
      WHERE website_id = ${context.website.id}::uuid
      GROUP BY keyword_id
    ),
    competitors AS (
      SELECT c.keyword_id,
             COUNT(DISTINCT c.competitor_id) AS ranking,
             COUNT(DISTINCT CASE
               WHEN lr.position IS NULL OR c.position < lr.position THEN c.competitor_id
             END) AS ahead
      FROM competitor_keyword_snapshot c
      LEFT JOIN latest_ranking lr ON lr.keyword_id = c.keyword_id
      WHERE c.website_id = ${context.website.id}::uuid
      GROUP BY c.keyword_id
    )
    SELECT
      k.id AS keyword_id,
      k.keyword,
      k.intent::text AS intent,
      k.intent_provenance::text AS intent_provenance,
      k.business_relevance,
      k.commercial_value,
      lm.search_volume,
      COALESCE(ms.distinct_providers, 0) AS distinct_providers,
      ms.min_volume,
      ms.max_volume,
      lr.position,
      GREATEST(lm.captured_at, lr.captured_at) AS captured_at,
      own.page_id AS owner_page_id,
      ownp.path AS owner_path,
      lr.page_id AS ranking_page_id,
      rp.path AS ranking_path,
      COALESCE(rpages.pages, 0) AS distinct_ranking_pages,
      t.id AS topic_id,
      t.name AS topic_name,
      COALESCE(t.commercial_destination_page_id = own.page_id, false) AS is_commercial_destination,
      COALESCE(comp.ranking, 0) AS competitors_ranking,
      COALESCE(comp.ahead, 0) AS competitors_ahead
    FROM keyword k
    LEFT JOIN latest_metric lm ON lm.keyword_id = k.id
    LEFT JOIN metric_spread ms ON ms.keyword_id = k.id
    LEFT JOIN latest_ranking lr ON lr.keyword_id = k.id
    LEFT JOIN ranking_pages rpages ON rpages.keyword_id = k.id
    LEFT JOIN competitors comp ON comp.keyword_id = k.id
    LEFT JOIN keyword_page_ownership own
      ON own.keyword_id = k.id AND own.ownership_type = 'PRIMARY' AND own.status = 'ACTIVE'
    LEFT JOIN page ownp ON ownp.id = own.page_id
    LEFT JOIN page rp ON rp.id = lr.page_id
    LEFT JOIN topic_keyword tk ON tk.keyword_id = k.id
    LEFT JOIN topic t ON t.id = tk.topic_id AND t.status = 'ACTIVE'
    WHERE k.website_id = ${context.website.id}::uuid
      AND k.status = 'ACTIVE'
  `;

  return rows.map((row) => {
    const min = row.min_volume;
    const max = row.max_volume;
    const spread = min !== null && max !== null && max > 0 ? (max - min) / max : 0;

    return {
      keywordId: row.keyword_id,
      keyword: row.keyword,
      intent: row.intent,
      intentKnown: row.intent_provenance !== "UNKNOWN" && row.intent !== "UNKNOWN",
      businessRelevance: row.business_relevance,
      commercialValue: row.commercial_value,
      searchVolume: row.search_volume,
      providersDisagree: Number(row.distinct_providers) > 1 && spread >= DISAGREEMENT,
      position: row.position === null ? null : Number(row.position),
      freshnessDays: daysBetween(row.captured_at, now),
      ownerPageId: row.owner_page_id,
      ownerPath: row.owner_path,
      rankingPageId: row.ranking_page_id,
      rankingPath: row.ranking_path,
      distinctRankingPages: Number(row.distinct_ranking_pages),
      topicId: row.topic_id,
      topicName: row.topic_name,
      isCommercialDestination: row.is_commercial_destination,
      competitorsRanking: Number(row.competitors_ranking),
      competitorsAhead: Number(row.competitors_ahead),
      businessGoalId: null,
    };
  });
}

async function topicFacts(context: TenantContext): Promise<TopicFact[]> {
  const topics = await listTopics(context);

  if (topics.length === 0) return [];

  const demand = await prisma.$queryRaw<
    { topic_id: string; with_demand: bigint; total_volume: number | null }[]
  >`
    WITH latest AS (
      SELECT DISTINCT ON (keyword_id) keyword_id, search_volume
      FROM keyword_metrics_snapshot
      WHERE website_id = ${context.website.id}::uuid
      ORDER BY keyword_id, captured_at DESC
    )
    SELECT tk.topic_id,
           COUNT(*) FILTER (WHERE latest.search_volume > 0) AS with_demand,
           SUM(latest.search_volume)::int AS total_volume
    FROM topic_keyword tk
    JOIN latest ON latest.keyword_id = tk.keyword_id
    GROUP BY tk.topic_id
  `;

  const byTopic = new Map(demand.map((row) => [row.topic_id, row]));

  return topics.map((topic) => ({
    topicId: topic.id,
    topicName: topic.name,
    keywordCount: topic.keywordCount,
    pageCount: topic.pageCount,
    coverage: topic.coverage.status,
    keywordsWithDemand: Number(byTopic.get(topic.id)?.with_demand ?? 0),
    totalVolume: byTopic.get(topic.id)?.total_volume ?? null,
    businessGoalId: null,
  }));
}

async function signalFacts(context: TenantContext): Promise<SignalFact[]> {
  const signals = await prisma.signal.findMany({
    where: { ...websiteScope(context), type: "CTR_OPPORTUNITY", status: "DETECTED" },
    include: {
      page: { select: { id: true, path: true } },
      evidence: true,
    },
    take: 50,
  });

  return signals.map((signal) => {
    const impressions = signal.evidence.find((row) => row.metricKey === "impressions");
    const ctr = signal.evidence.find((row) => row.metricKey === "ctr");

    return {
      signalId: signal.id,
      type: signal.type,
      pageId: signal.pageId,
      pagePath: signal.page?.path ?? null,
      keywordId: signal.queryId,
      impressions: impressions?.currentValue === null || impressions?.currentValue === undefined
        ? null
        : Number(impressions.currentValue),
      ctr: ctr?.currentValue === null || ctr?.currentValue === undefined
        ? null
        : Number(ctr.currentValue),
      businessGoalId: null,
    };
  });
}

async function decliningPageFacts(context: TenantContext): Promise<PageDeclineFact[]> {
  const rows = await prisma.$queryRaw<
    { page_id: string; path: string; current_clicks: bigint; previous_clicks: bigint }[]
  >`
    SELECT
      p.id AS page_id,
      p.path,
      COALESCE(SUM(m.clicks) FILTER (
        WHERE m.date >= CURRENT_DATE - 28
      ), 0)::bigint AS current_clicks,
      COALESCE(SUM(m.clicks) FILTER (
        WHERE m.date >= CURRENT_DATE - 56 AND m.date < CURRENT_DATE - 28
      ), 0)::bigint AS previous_clicks
    FROM page p
    JOIN gsc_metric_daily m ON m.page_id = p.id
    WHERE p.website_id = ${context.website.id}::uuid
      AND m.date >= CURRENT_DATE - 56
    GROUP BY p.id, p.path
    HAVING COALESCE(SUM(m.clicks) FILTER (
      WHERE m.date >= CURRENT_DATE - 56 AND m.date < CURRENT_DATE - 28
    ), 0) > 0
  `;

  return rows.map((row) => ({
    pageId: row.page_id,
    path: row.path,
    currentClicks: Number(row.current_clicks),
    previousClicks: Number(row.previous_clicks),
    keywordId: null,
    searchVolume: null,
    businessGoalId: null,
  }));
}

export type DetectionSummary = {
  detected: number;
  created: number;
  updated: number;
  preserved: number;
};

/**
 * Runs the rules and stores what they found.
 *
 * Deliberately not a transaction over the whole run: a hundred opportunities
 * written one at a time is slower but leaves partial progress on failure, which
 * is preferable to an all-or-nothing detection that a single bad row can undo.
 */
export async function detectAndStoreOpportunities(
  context: TenantContext,
  options: { now?: Date } = {},
): Promise<DetectionSummary> {
  const now = options.now ?? new Date();

  const [keywords, topics, signals, decliningPages] = await Promise.all([
    keywordFacts(context, now),
    topicFacts(context),
    signalFacts(context),
    decliningPageFacts(context),
  ]);

  const detected = detectOpportunities({ keywords, topics, signals, decliningPages });

  let created = 0;
  let updated = 0;
  let preserved = 0;

  for (const opportunity of detected) {
    const existing = await prisma.opportunity.findFirst({
      where: {
        websiteId: context.website.id,
        type: opportunity.type,
        keywordId: opportunity.keywordId,
        pageId: opportunity.pageId,
        topicId: opportunity.topicId,
        competitorId: opportunity.competitorId,
      },
    });

    const scoreData = {
      score: new Prisma.Decimal(opportunity.scoring.score),
      scoreInputsJson: {
        raw: opportunity.scoring.raw,
        maxRaw: opportunity.scoring.maxRaw,
        subScores: opportunity.scoring.subScores,
      } as unknown as Prisma.InputJsonValue,
      scoringModelVersion: opportunity.scoring.modelVersion,
      priority: opportunity.scoring.priority,
      effort: opportunity.effort,
      confidence: opportunity.confidence,
      title: opportunity.title,
      summary: opportunity.summary,
      expectedEffectDescription: opportunity.expectedEffectDescription,
      businessGoalId: opportunity.businessGoalId,
      sourceSignalId: opportunity.sourceSignalId,
    };

    if (existing) {
      // A person's judgement is preserved. Re-detection may change what we know;
      // it may not overrule what somebody decided.
      const humanHandled = !DETECTED_STATUSES.includes(existing.status);

      await prisma.$transaction(async (tx) => {
        await tx.opportunity.update({
          where: { id: existing.id },
          data: scoreData,
        });

        await tx.opportunityEvidence.deleteMany({ where: { opportunityId: existing.id } });
        await tx.opportunityEvidence.createMany({
          data: opportunity.evidence.map((entry) => ({
            opportunityId: existing.id,
            evidenceType: entry.evidenceType,
            sourceEntityType: entry.sourceEntityType,
            sourceEntityId: entry.sourceEntityId,
            metricKey: entry.metricKey,
            numericValue: entry.numericValue,
            textValue: entry.textValue,
            capturedAt: now,
          })),
        });
      });

      if (humanHandled) preserved += 1;
      else updated += 1;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const stored = await tx.opportunity.create({
        data: {
          websiteId: context.website.id,
          type: opportunity.type,
          status: "IDENTIFIED",
          keywordId: opportunity.keywordId,
          pageId: opportunity.pageId,
          topicId: opportunity.topicId,
          competitorId: opportunity.competitorId,
          identifiedAt: now,
          ...scoreData,
        },
      });

      await tx.opportunityEvidence.createMany({
        data: opportunity.evidence.map((entry) => ({
          opportunityId: stored.id,
          evidenceType: entry.evidenceType,
          sourceEntityType: entry.sourceEntityType,
          sourceEntityId: entry.sourceEntityId,
          metricKey: entry.metricKey,
          numericValue: entry.numericValue,
          textValue: entry.textValue,
          capturedAt: now,
        })),
      });
    });

    created += 1;
  }

  return { detected: detected.length, created, updated, preserved };
}

export type OpportunityWithContext = Opportunity & {
  evidence: OpportunityEvidence[];
  keyword: { id: string; keyword: string } | null;
  page: { id: string; path: string } | null;
  topic: { id: string; name: string } | null;
  businessGoal: { id: string; title: string } | null;
  owner: { id: string; email: string; displayName: string | null } | null;
};

export type QueueFilters = {
  status?: OpportunityStatus;
  type?: OpportunityType;
  priority?: OpportunityPriority;
  topicId?: string;
  pageId?: string;
  ownerUserId?: string;
  businessGoalId?: string;
  limit?: number;
  offset?: number;
};

/**
 * The Opportunity Queue.
 *
 * Filters compose into the scoped query rather than being applied after fetching,
 * so pagination stays correct and tenant-safe. Sorting is fixed rather than
 * caller-supplied: a sort parameter is a query fragment, and a free-text one is an
 * injection surface for no benefit anyone asked for.
 */
export async function listOpportunities(
  context: TenantContext,
  filters: QueueFilters = {},
): Promise<OpportunityWithContext[]> {
  return prisma.opportunity.findMany({
    where: {
      ...websiteScope(context),
      archivedAt: null,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.topicId ? { topicId: filters.topicId } : {}),
      ...(filters.pageId ? { pageId: filters.pageId } : {}),
      ...(filters.ownerUserId ? { ownerUserId: filters.ownerUserId } : {}),
      ...(filters.businessGoalId ? { businessGoalId: filters.businessGoalId } : {}),
    },
    include: {
      evidence: true,
      keyword: { select: { id: true, keyword: true } },
      page: { select: { id: true, path: true } },
      topic: { select: { id: true, name: true } },
      businessGoal: { select: { id: true, title: true } },
      owner: { select: { id: true, email: true, displayName: true } },
    },
    orderBy: [{ score: "desc" }, { identifiedAt: "desc" }],
    take: Math.min(filters.limit ?? 50, 200),
    skip: filters.offset ?? 0,
  });
}

export async function getOpportunity(
  context: TenantContext,
  opportunityId: string,
): Promise<OpportunityWithContext | null> {
  return prisma.opportunity.findFirst({
    where: { id: opportunityId, ...websiteScope(context) },
    include: {
      evidence: true,
      keyword: { select: { id: true, keyword: true } },
      page: { select: { id: true, path: true } },
      topic: { select: { id: true, name: true } },
      businessGoal: { select: { id: true, title: true } },
      owner: { select: { id: true, email: true, displayName: true } },
    },
  });
}

/**
 * Rebuilds a stored score from the record alone.
 *
 * The release rule made executable: if this ever disagrees with what is stored,
 * the queue contains a number nobody can reproduce.
 */
export function verifyStoredScore(opportunity: Opportunity): {
  stored: number | null;
  recomputed: number | null;
  matches: boolean;
} {
  const stored = opportunity.score === null ? null : Number(opportunity.score);
  const inputs = opportunity.scoreInputsJson as { subScores?: SubScore[] } | null;

  if (!inputs?.subScores) {
    return { stored, recomputed: null, matches: false };
  }

  const recomputed = rescore(inputs.subScores).score;

  return { stored, recomputed, matches: stored !== null && Math.abs(stored - recomputed) < 0.05 };
}

const ALLOWED_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  IDENTIFIED: ["QUALIFIED", "DECLINED", "ARCHIVED"],
  QUALIFIED: ["SCHEDULED", "DECLINED", "IDENTIFIED", "ARCHIVED"],
  SCHEDULED: ["IN_PROGRESS", "QUALIFIED", "DECLINED", "ARCHIVED"],
  IN_PROGRESS: ["COMPLETED", "SCHEDULED", "DECLINED", "ARCHIVED"],
  DECLINED: ["IDENTIFIED", "ARCHIVED"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

const AUDIT_ACTION: Partial<Record<OpportunityStatus, "QUALIFY" | "SCHEDULE" | "DECLINE" | "COMPLETE" | "ARCHIVE">> =
  {
    QUALIFIED: "QUALIFY",
    SCHEDULED: "SCHEDULE",
    DECLINED: "DECLINE",
    COMPLETED: "COMPLETE",
    ARCHIVED: "ARCHIVE",
  };

export async function setOpportunityStatus(
  context: TenantContext,
  opportunityId: string,
  status: OpportunityStatus,
): Promise<Opportunity> {
  const existing = await prisma.opportunity.findFirst({
    where: { id: opportunityId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new OpportunityError("That opportunity is not available.", "not_found");
  }

  if (!ALLOWED_TRANSITIONS[existing.status].includes(status)) {
    throw new OpportunityError(
      `An opportunity cannot go from ${existing.status} to ${status}.`,
      "invalid_transition",
    );
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.opportunity.update({
      where: { id: existing.id },
      data: {
        status,
        ...(status === "QUALIFIED" ? { qualifiedAt: new Date() } : {}),
        ...(status === "SCHEDULED" ? { scheduledAt: new Date() } : {}),
        ...(status === "DECLINED" || status === "COMPLETED"
          ? { closedAt: new Date() }
          : {}),
        ...(status === "ARCHIVED" ? { archivedAt: new Date() } : {}),
      },
    });

    await recordAudit(tx, context, {
      entityType: "Opportunity",
      entityId: updated.id,
      action: AUDIT_ACTION[status] ?? "UPDATE",
      before: { status: existing.status },
      after: { status, title: updated.title },
    });

    return updated;
  });
}

/** Assigns an owner, validating they belong to this organization. */
export async function assignOpportunityOwner(
  context: TenantContext,
  opportunityId: string,
  ownerUserId: string | null,
): Promise<Opportunity> {
  const existing = await prisma.opportunity.findFirst({
    where: { id: opportunityId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new OpportunityError("That opportunity is not available.", "not_found");
  }

  if (ownerUserId) {
    try {
      // Exists precisely to stop work being assigned to somebody from another
      // tenant whose id happened to be guessed or pasted.
      await requireTenantMember(context, ownerUserId);
    } catch {
      throw new OpportunityError(
        "That person is not a member of this organization.",
        "owner_not_member",
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.opportunity.update({
      where: { id: existing.id },
      data: { ownerUserId },
    });

    await recordAudit(tx, context, {
      entityType: "Opportunity",
      entityId: updated.id,
      action: "ASSIGN",
      before: { ownerUserId: existing.ownerUserId },
      after: { ownerUserId },
    });

    return updated;
  });
}

export async function getOpportunityCounts(
  context: TenantContext,
): Promise<{ byType: Record<string, number>; byPriority: Record<string, number>; total: number }> {
  const [byType, byPriority, total] = await Promise.all([
    prisma.opportunity.groupBy({
      by: ["type"],
      where: { ...websiteScope(context), archivedAt: null },
      _count: { _all: true },
    }),
    prisma.opportunity.groupBy({
      by: ["priority"],
      where: { ...websiteScope(context), archivedAt: null },
      _count: { _all: true },
    }),
    prisma.opportunity.count({ where: { ...websiteScope(context), archivedAt: null } }),
  ]);

  return {
    byType: Object.fromEntries(byType.map((row) => [row.type, row._count._all])),
    byPriority: Object.fromEntries(byPriority.map((row) => [row.priority, row._count._all])),
    total,
  };
}

/** The single highest-scoring piece of work, for the Command Center. */
export async function getNextBestStep(
  context: TenantContext,
): Promise<OpportunityWithContext | null> {
  const qualified = await listOpportunities(context, { status: "QUALIFIED", limit: 1 });

  if (qualified.length > 0) return qualified[0]!;

  const identified = await listOpportunities(context, { status: "IDENTIFIED", limit: 1 });
  return identified[0] ?? null;
}
