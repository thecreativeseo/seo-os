import { Prisma } from "@/generated/prisma/client";
import type { ConnectionProvider } from "@/generated/prisma/client";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { normalizeUrl } from "@/lib/url/normalize-url";
import {
  bandFor,
  isMaterial,
  movementBetween,
  type Movement,
  type PositionBand,
} from "@/lib/ranking/movement";

/**
 * Ranking reads (docs/P2_SPEC.md §11).
 *
 * Snapshots are append-only and this module never writes one except to attach a
 * Page that has since become known. History is the whole value: a position on its
 * own says where something ranks, and only the sequence says whether that is good
 * news.
 */

export type RankingPoint = {
  capturedAt: Date;
  provider: ConnectionProvider;
  position: number | null;
  rankingUrl: string | null;
  pageId: string | null;
  pagePath: string | null;
};

const toNumber = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : Number(value);

/** Every snapshot for one keyword, oldest first, ready to plot. */
export async function getRankingHistory(
  context: TenantContext,
  keywordId: string,
  options: { provider?: ConnectionProvider; limit?: number } = {},
): Promise<RankingPoint[]> {
  const rows = await prisma.rankingSnapshot.findMany({
    where: {
      keywordId,
      ...websiteScope(context),
      ...(options.provider ? { sourceProvider: options.provider } : {}),
    },
    orderBy: { capturedAt: "asc" },
    take: options.limit ?? 180,
    include: { page: { select: { path: true } } },
  });

  return rows.map((row) => ({
    capturedAt: row.capturedAt,
    provider: row.sourceProvider,
    position: toNumber(row.position),
    rankingUrl: row.rankingUrl,
    pageId: row.pageId,
    pagePath: row.page?.path ?? null,
  }));
}

export type RankingChange = {
  keywordId: string;
  keyword: string;
  provider: ConnectionProvider;
  current: number | null;
  previous: number | null;
  currentCapturedAt: Date;
  previousCapturedAt: Date | null;
  band: PositionBand;
  movement: Movement;
  /** The page ranking now, and the one ranking before, if they differ. */
  currentUrl: string | null;
  previousUrl: string | null;
  urlChanged: boolean;
};

type ChangeRow = {
  keyword_id: string;
  keyword: string;
  source_provider: ConnectionProvider;
  captured_at: Date;
  position: Prisma.Decimal | null;
  ranking_url: string | null;
  prev_captured_at: Date | null;
  prev_position: Prisma.Decimal | null;
  prev_url: string | null;
};

/**
 * What moved between the two most recent captures.
 *
 * Compares our own consecutive snapshots rather than the provider's
 * previous_position column. The two answer different questions — theirs compares
 * against whenever they last looked, ours against when we last recorded — and
 * mixing them would produce a movement figure nobody could reproduce.
 */
export async function listRankingChanges(
  context: TenantContext,
  options: { limit?: number; materialOnly?: boolean } = {},
): Promise<RankingChange[]> {
  const rows = await prisma.$queryRaw<ChangeRow[]>`
    WITH ranked AS (
      SELECT
        r.keyword_id,
        k.keyword,
        r.source_provider,
        r.captured_at,
        r.position,
        r.ranking_url,
        LAG(r.captured_at) OVER w AS prev_captured_at,
        LAG(r.position) OVER w AS prev_position,
        LAG(r.ranking_url) OVER w AS prev_url,
        ROW_NUMBER() OVER (
          PARTITION BY r.keyword_id, r.source_provider ORDER BY r.captured_at DESC
        ) AS recency
      FROM ranking_snapshot r
      JOIN keyword k ON k.id = r.keyword_id
      WHERE r.website_id = ${context.website.id}::uuid
      WINDOW w AS (
        PARTITION BY r.keyword_id, r.source_provider ORDER BY r.captured_at ASC
      )
    )
    SELECT keyword_id, keyword, source_provider, captured_at, position, ranking_url,
           prev_captured_at, prev_position, prev_url
    FROM ranked
    WHERE recency = 1
    ORDER BY captured_at DESC
  `;

  const changes = rows.map((row) => {
    const current = toNumber(row.position);
    const previous = toNumber(row.prev_position);

    return {
      keywordId: row.keyword_id,
      keyword: row.keyword,
      provider: row.source_provider,
      current,
      previous,
      currentCapturedAt: row.captured_at,
      previousCapturedAt: row.prev_captured_at,
      band: bandFor(current),
      movement: movementBetween(current, previous),
      currentUrl: row.ranking_url,
      previousUrl: row.prev_url,
      // The page Google ranks changing is a different event from the position
      // changing, and often the more interesting one.
      urlChanged:
        row.prev_url !== null && row.ranking_url !== null && row.prev_url !== row.ranking_url,
    };
  });

  const filtered = options.materialOnly
    ? changes.filter((change) => isMaterial(change.movement) || change.urlChanged)
    : changes;

  return filtered.slice(0, options.limit ?? 50);
}

export type RankingPageObservation = {
  pageId: string | null;
  path: string | null;
  rankingUrl: string | null;
  captures: number;
  bestPosition: number | null;
  lastSeenAt: Date;
};

/**
 * Every page that has ranked for a keyword in the window.
 *
 * Two or more is the observation behind MULTIPLE_RANKING_PAGES in O5. It is an
 * observation and stays one: pages legitimately trade places on a SERP, and
 * calling that cannibalization is a diagnosis P2 has not earned.
 */
export async function getRankingPages(
  context: TenantContext,
  keywordId: string,
  options: { sinceDays?: number } = {},
): Promise<RankingPageObservation[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (options.sinceDays ?? 90));

  const rows = await prisma.rankingSnapshot.findMany({
    where: {
      keywordId,
      ...websiteScope(context),
      capturedAt: { gte: since },
      // A snapshot with no URL says the keyword ranked, not which page did.
      rankingUrl: { not: null },
    },
    orderBy: { capturedAt: "desc" },
    include: { page: { select: { path: true } } },
  });

  const byUrl = new Map<string, RankingPageObservation>();

  for (const row of rows) {
    const key = row.rankingUrl!;
    const position = toNumber(row.position);
    const existing = byUrl.get(key);

    if (!existing) {
      byUrl.set(key, {
        pageId: row.pageId,
        path: row.page?.path ?? null,
        rankingUrl: row.rankingUrl,
        captures: 1,
        bestPosition: position,
        lastSeenAt: row.capturedAt,
      });
      continue;
    }

    existing.captures += 1;
    // Lower is better, so the best position is the minimum.
    if (position !== null && (existing.bestPosition === null || position < existing.bestPosition)) {
      existing.bestPosition = position;
    }
  }

  return [...byUrl.values()].sort((a, b) => b.captures - a.captures);
}

export type RankingCoverage = {
  total: number;
  mapped: number;
  unmapped: number;
  /** Distinct URLs Google ranks that are not in the Page inventory. */
  unmappedUrls: string[];
};

/**
 * How much of what Google ranks we can actually account for.
 *
 * An unmapped ranking URL is not a defect to hide. It usually means Google is
 * ranking a page Search Console has not reported and no sitemap lists, which is
 * worth knowing — so it is counted and the URLs are shown.
 */
export async function getRankingCoverage(context: TenantContext): Promise<RankingCoverage> {
  const [total, mapped, unmappedRows] = await Promise.all([
    prisma.rankingSnapshot.count({ where: websiteScope(context) }),
    prisma.rankingSnapshot.count({ where: { ...websiteScope(context), pageId: { not: null } } }),
    prisma.rankingSnapshot.findMany({
      where: { ...websiteScope(context), pageId: null, rankingUrl: { not: null } },
      select: { rankingUrl: true },
      distinct: ["rankingUrl"],
      take: 100,
    }),
  ]);

  return {
    total,
    mapped,
    unmapped: total - mapped,
    unmappedUrls: unmappedRows.map((row) => row.rankingUrl!).filter(Boolean),
  };
}

export type RemapResult = { examined: number; attached: number };

/**
 * Attaches Pages to snapshots that had none when they were imported.
 *
 * Ordering is the reason this exists: a Semrush export can arrive before the
 * Search Console sync that first reports the page it names. The snapshot is
 * correct either way — it recorded a URL — but the link to our inventory can only
 * be made once the Page exists.
 *
 * This is the single exception to snapshots being append-only, and it changes no
 * measurement: only the pageId that was always meant to point somewhere.
 */
export async function remapUnresolvedRankings(
  context: TenantContext,
): Promise<RemapResult> {
  const unresolved = await prisma.rankingSnapshot.findMany({
    where: { ...websiteScope(context), pageId: null, rankingUrl: { not: null } },
    select: { id: true, rankingUrl: true },
  });

  if (unresolved.length === 0) return { examined: 0, attached: 0 };

  const normalizedByUrl = new Map<string, string>();

  for (const snapshot of unresolved) {
    const normalized = normalizeUrl(snapshot.rankingUrl!, context.website.normalizedDomain);
    if (normalized.ok) normalizedByUrl.set(snapshot.rankingUrl!, normalized.value.normalized);
  }

  const pages = await prisma.page.findMany({
    where: {
      websiteId: context.website.id,
      normalizedUrl: { in: [...new Set(normalizedByUrl.values())] },
    },
    select: { id: true, normalizedUrl: true },
  });

  const pageByUrl = new Map(pages.map((page) => [page.normalizedUrl, page.id]));
  let attached = 0;

  for (const snapshot of unresolved) {
    const normalized = normalizedByUrl.get(snapshot.rankingUrl!);
    const pageId = normalized ? pageByUrl.get(normalized) : undefined;

    if (!pageId) continue;

    await prisma.rankingSnapshot.update({ where: { id: snapshot.id }, data: { pageId } });
    attached += 1;
  }

  if (attached > 0) {
    await prisma.$transaction(async (tx) => {
      await recordAudit(tx, context, {
        entityType: "RankingSnapshot",
        entityId: context.website.id,
        action: "UPDATE",
        after: { attachedToPages: attached, examined: unresolved.length },
      });
    });
  }

  return { examined: unresolved.length, attached };
}
