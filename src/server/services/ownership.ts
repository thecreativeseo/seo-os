import { Prisma } from "@/generated/prisma/client";
import type { KeywordPageOwnership, OwnershipType } from "@/generated/prisma/client";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import {
  detectOwnershipCandidates,
  SWITCH_WINDOW_DAYS,
  type OwnershipCandidate,
  type RankingObservation,
} from "@/lib/ownership/candidates";
import { renderOwnershipCandidate, type OwnershipCopy } from "@/lib/ownership/templates";

/**
 * Keyword ownership (docs/P2_SPEC.md §12, §13).
 *
 * Ownership is a human judgement — which page *should* rank — recorded separately
 * from what Google actually does. Everything else in P2 that is interesting comes
 * from comparing the two.
 *
 * One active PRIMARY owner per keyword and market is enforced by a partial unique
 * index (migration 20260902110000), not by this file. That ordering matters: this
 * file retires the previous owner before nominating a new one so the normal path
 * never collides, but if a future code path forgets to, the database refuses
 * rather than quietly allowing two owners and making every divergence check
 * ambiguous.
 */

export type OwnershipErrorCode =
  | "keyword_not_found"
  | "page_not_found"
  | "ownership_not_found"
  | "duplicate_primary";

export class OwnershipError extends Error {
  constructor(
    message: string,
    readonly code: OwnershipErrorCode,
  ) {
    super(message);
    this.name = "OwnershipError";
  }
}

export type OwnershipWithPage = KeywordPageOwnership & {
  page: { id: string; path: string; url: string };
};

export async function listOwnerships(
  context: TenantContext,
  keywordId: string,
): Promise<OwnershipWithPage[]> {
  return prisma.keywordPageOwnership.findMany({
    where: { keywordId, ...websiteScope(context) },
    include: { page: { select: { id: true, path: true, url: true } } },
    orderBy: [{ status: "asc" }, { assignedAt: "desc" }],
  });
}

/**
 * Nominates a page as the owner of a keyword.
 *
 * A PRIMARY assignment retires whatever held that role before, rather than
 * updating it. The old row stays as history: "who decided this page should own
 * this keyword, and when" is a question people ask months later, and an updated
 * row cannot answer it.
 */
export async function assignOwnership(
  context: TenantContext,
  input: {
    keywordId: string;
    pageId: string;
    ownershipType?: OwnershipType;
    notes?: string;
  },
): Promise<OwnershipWithPage> {
  const keyword = await prisma.keyword.findFirst({
    where: { id: input.keywordId, ...websiteScope(context) },
  });

  if (!keyword) {
    throw new OwnershipError("That keyword is not available.", "keyword_not_found");
  }

  const page = await prisma.page.findFirst({
    where: { id: input.pageId, ...websiteScope(context) },
  });

  if (!page) {
    // Scoped, so another tenant's page is indistinguishable from a page that
    // does not exist — a keyword can never be assigned to somebody else's page.
    throw new OwnershipError("That page is not available.", "page_not_found");
  }

  const ownershipType = input.ownershipType ?? "PRIMARY";

  return prisma.$transaction(async (tx) => {
    if (ownershipType === "PRIMARY") {
      const previous = await tx.keywordPageOwnership.findFirst({
        where: {
          keywordId: keyword.id,
          ownershipType: "PRIMARY",
          status: "ACTIVE",
          market: keyword.market,
          language: keyword.language,
          locale: keyword.locale,
        },
      });

      if (previous) {
        if (previous.pageId === input.pageId) {
          // Already the owner. Re-assigning would retire and recreate an
          // identical row, losing the original assignment date for no reason.
          const unchanged = await tx.keywordPageOwnership.findUniqueOrThrow({
            where: { id: previous.id },
            include: { page: { select: { id: true, path: true, url: true } } },
          });
          return unchanged;
        }

        await tx.keywordPageOwnership.update({
          where: { id: previous.id },
          data: { status: "RETIRED" },
        });

        await recordAudit(tx, context, {
          entityType: "KeywordPageOwnership",
          entityId: previous.id,
          action: "RETIRE",
          before: { pageId: previous.pageId, status: previous.status },
          after: { status: "RETIRED" },
        });
      }
    }

    const created = await tx.keywordPageOwnership.create({
      data: {
        websiteId: context.website.id,
        keywordId: keyword.id,
        pageId: page.id,
        ownershipType,
        status: "ACTIVE",
        market: keyword.market,
        language: keyword.language,
        locale: keyword.locale,
        assignedByUserId: context.user.id,
        notes: input.notes ?? null,
      },
      include: { page: { select: { id: true, path: true, url: true } } },
    });

    await recordAudit(tx, context, {
      entityType: "KeywordPageOwnership",
      entityId: created.id,
      action: "ASSIGN",
      after: {
        keyword: keyword.keyword,
        pageId: page.id,
        path: page.path,
        ownershipType,
        market: keyword.market,
      },
    });

    return created;
  });
}

export async function retireOwnership(
  context: TenantContext,
  ownershipId: string,
): Promise<KeywordPageOwnership> {
  const existing = await prisma.keywordPageOwnership.findFirst({
    where: { id: ownershipId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new OwnershipError("That assignment is not available.", "ownership_not_found");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.keywordPageOwnership.update({
      where: { id: existing.id },
      data: { status: "RETIRED" },
    });

    await recordAudit(tx, context, {
      entityType: "KeywordPageOwnership",
      entityId: updated.id,
      action: "RETIRE",
      before: { status: existing.status },
      after: { status: "RETIRED" },
    });

    return updated;
  });
}

/** The page currently nominated to own a keyword, if any. */
export async function getPrimaryOwner(
  context: TenantContext,
  keywordId: string,
): Promise<OwnershipWithPage | null> {
  return prisma.keywordPageOwnership.findFirst({
    where: {
      keywordId,
      ownershipType: "PRIMARY",
      status: "ACTIVE",
      ...websiteScope(context),
    },
    include: { page: { select: { id: true, path: true, url: true } } },
  });
}

export type RenderedCandidate = OwnershipCandidate & {
  keyword: string;
  copy: OwnershipCopy;
};

type CandidateRow = {
  keyword_id: string;
  keyword: string;
  has_demand: boolean;
  owner_page_id: string | null;
  owner_path: string | null;
};

/**
 * Ownership observations across the website.
 *
 * One query assembles the inputs and the rules run in memory, which keeps the
 * detection itself pure and testable without a database — the same shape as P1's
 * signal engine, and for the same reason.
 */
export async function detectOwnershipIssues(
  context: TenantContext,
  options: { limit?: number } = {},
): Promise<RenderedCandidate[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - SWITCH_WINDOW_DAYS);

  const keywords = await prisma.$queryRaw<CandidateRow[]>`
    SELECT
      k.id AS keyword_id,
      k.keyword,
      EXISTS (
        SELECT 1 FROM keyword_metrics_snapshot m
        WHERE m.keyword_id = k.id AND m.search_volume IS NOT NULL AND m.search_volume > 0
      ) AS has_demand,
      o.page_id AS owner_page_id,
      p.path AS owner_path
    FROM keyword k
    LEFT JOIN keyword_page_ownership o
      ON o.keyword_id = k.id
     AND o.ownership_type = 'PRIMARY'
     AND o.status = 'ACTIVE'
    LEFT JOIN page p ON p.id = o.page_id
    WHERE k.website_id = ${context.website.id}::uuid
      AND k.status = 'ACTIVE'
  `;

  if (keywords.length === 0) return [];

  const rankings = await prisma.rankingSnapshot.findMany({
    where: {
      ...websiteScope(context),
      keywordId: { in: keywords.map((row) => row.keyword_id) },
      capturedAt: { gte: since },
    },
    orderBy: { capturedAt: "desc" },
    include: { page: { select: { path: true } } },
  });

  const byKeyword = new Map<string, RankingObservation[]>();

  for (const row of rankings) {
    const list = byKeyword.get(row.keywordId) ?? [];
    list.push({
      capturedAt: row.capturedAt,
      pageId: row.pageId,
      path: row.page?.path ?? null,
      rankingUrl: row.rankingUrl,
      position: row.position === null ? null : Number(row.position),
    });
    byKeyword.set(row.keywordId, list);
  }

  const results: RenderedCandidate[] = [];

  for (const row of keywords) {
    const candidates = detectOwnershipCandidates({
      keywordId: row.keyword_id,
      keyword: row.keyword,
      ownerPageId: row.owner_page_id,
      ownerPath: row.owner_path,
      rankings: byKeyword.get(row.keyword_id) ?? [],
      hasDemand: row.has_demand,
    });

    for (const candidate of candidates) {
      results.push({
        ...candidate,
        keyword: row.keyword,
        copy: renderOwnershipCandidate(candidate),
      });
    }
  }

  return results.slice(0, options.limit ?? 200);
}

/** Counts by candidate type, for the Command Center's ownership section. */
export async function getOwnershipCounts(
  context: TenantContext,
): Promise<Record<string, number>> {
  const candidates = await detectOwnershipIssues(context, { limit: 1000 });

  return candidates.reduce<Record<string, number>>((counts, candidate) => {
    counts[candidate.type] = (counts[candidate.type] ?? 0) + 1;
    return counts;
  }, {});
}

/** The partial index from migration 20260902110000. */
export const PRIMARY_OWNER_INDEX = "keyword_primary_owner_key";

/**
 * Every place Prisma might name the offending index.
 *
 * Where the name lands depends on how the constraint was declared and which
 * driver is underneath. A schema-level `@@unique` puts it in `meta.target`; this
 * partial index, through the pg driver adapter, buries it in
 * `meta.driverAdapterError.cause.constraint.index`. Checking one location looks
 * correct and silently never matches, which is how a guard ends up asserting
 * nothing — so the search covers all of them and falls back to the message.
 */
function constraintNames(error: Prisma.PrismaClientKnownRequestError): string[] {
  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const names: string[] = [];

  const collect = (value: unknown) => {
    if (typeof value === "string") names.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
  };

  collect(meta.target);
  collect(meta.constraint);

  const adapter = meta.driverAdapterError as
    | { cause?: { constraint?: { index?: unknown }; originalMessage?: unknown } }
    | undefined;

  collect(adapter?.cause?.constraint?.index);
  collect(adapter?.cause?.originalMessage);
  collect(error.message);

  return names;
}

/** True when the database refused a second active primary owner. */
export function isDuplicatePrimary(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }

  return constraintNames(error).some((name) => name.includes(PRIMARY_OWNER_INDEX));
}
