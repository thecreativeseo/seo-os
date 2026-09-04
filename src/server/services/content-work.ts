import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import {
  TenantAccessError,
  requireTenantMember,
  websiteScope,
  type TenantContext,
} from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { SYSTEM_AUTH_USER_ID } from "@/server/jobs/system-context";
import type { RecommendationModifications } from "@/server/services/decision";
import { OPEN_WORK_ITEM_STATUSES } from "@/lib/execution/statuses";
import { Prisma } from "@/generated/prisma/client";
import type {
  ContentWorkItem,
  ContentWorkItemStatus,
  ContentWorkItemType,
  Decision,
  OpportunityPriority,
  Recommendation,
  RecommendationType,
} from "@/generated/prisma/client";

/**
 * ContentWorkService (docs/P4_SPEC.md §5, §6, §31).
 *
 * The only door into P4. A work item exists because a person, holding a
 * recommendation that another person approved, chose to start the work. The
 * service proves both halves from rows, not from the request: the
 * recommendation's status, and the latest Decision on it - which must be a
 * human's APPROVED or MODIFIED. Nothing is created on the decision itself
 * (D1); nothing is created for a recommendation whose type P4 cannot execute.
 *
 * What a MODIFIED decision changed is what was approved. The item is built
 * from the recommendation as modified, so a reviewer who retyped a technical
 * finding into a content refresh, or lowered a priority, gets exactly that.
 */

export class ContentWorkError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "forbidden"
      | "not_approved"
      | "no_decision"
      | "not_eligible"
      | "already_started",
    /** For already_started: the item that already exists, so the screen can link to it. */
    readonly existingItemId?: string,
  ) {
    super(message);
    this.name = "ContentWorkError";
  }
}

/**
 * Which P3 recommendation types become P4 content work (§5, §6). Everything
 * else is refused with the reason beside it: technical work is P5's ticket
 * and fix workflow, reviews and monitoring change nothing on the site, and a
 * page split becomes separate new-content recommendations.
 */
export const WORK_TYPE_FOR: Record<RecommendationType, ContentWorkItemType | null> = {
  CONTENT_CREATE: "NEW_CONTENT",
  CONTENT_REFRESH: "CONTENT_REFRESH",
  TITLE_META_UPDATE: "TITLE_META_UPDATE",
  INTENT_REALIGNMENT: "INTENT_REALIGNMENT",
  KEYWORD_OWNERSHIP_FIX: "KEYWORD_OWNERSHIP_FIX",
  INTERNAL_LINK_UPDATE: "INTERNAL_LINK_UPDATE",
  PAGE_CONSOLIDATION: "PAGE_CONSOLIDATION_PREP",
  PAGE_SPLIT: null,
  TECHNICAL_INVESTIGATION: null,
  TECHNICAL_FIX: null,
  SERP_REVIEW: null,
  CONVERSION_REVIEW: null,
  MONITOR_ONLY: null,
  REQUEST_MORE_EVIDENCE: null,
  OTHER: null,
};

const INELIGIBLE_REASON: Partial<Record<RecommendationType, string>> = {
  PAGE_SPLIT:
    "A page split is planned as separate new-content recommendations, one per resulting page; approve those to start work.",
  TECHNICAL_INVESTIGATION:
    "Technical investigation belongs to the P5 technical workflow, not to content execution.",
  TECHNICAL_FIX:
    "Technical fixes belong to the P5 ticket and fix workflow, not to content execution.",
  SERP_REVIEW: "A SERP review asks a person to look, not for a change on the site.",
  CONVERSION_REVIEW: "A conversion review asks a person to look, not for a change on the site.",
  MONITOR_ONLY: "Monitoring changes nothing on the site; there is no content work to start.",
  REQUEST_MORE_EVIDENCE:
    "This recommendation asks for more evidence rather than a change; diagnose again when it is available.",
  OTHER:
    "Its type does not name a content change. Modify the recommendation to a specific content type first.",
};

export type Eligibility =
  { eligible: true; workType: ContentWorkItemType } | { eligible: false; reason: string };

export function eligibilityFor(type: RecommendationType): Eligibility {
  const workType = WORK_TYPE_FOR[type];
  if (workType) return { eligible: true, workType };
  return {
    eligible: false,
    reason:
      INELIGIBLE_REASON[type] ?? "This recommendation type cannot be executed as content work.",
  };
}

/** The recommendation as the reviewer approved it (§5): MODIFIED decisions carry the changes. */
export type EffectiveRecommendation = {
  title: string;
  summary: string;
  type: RecommendationType;
  priority: OpportunityPriority;
};

export function effectiveRecommendation(
  recommendation: Pick<Recommendation, "title" | "summary" | "type" | "priority">,
  decision: Pick<Decision, "decision" | "modifiedRecommendationJson"> | null,
): EffectiveRecommendation {
  const base = {
    title: recommendation.title,
    summary: recommendation.summary,
    type: recommendation.type,
    priority: recommendation.priority,
  };

  if (!decision || decision.decision !== "MODIFIED" || !decision.modifiedRecommendationJson) {
    return base;
  }

  // decide() stores { before, after }: only the fields the reviewer changed
  // are in `after`, and the recommendation row itself keeps the model's text.
  const stored = decision.modifiedRecommendationJson as { after?: RecommendationModifications };
  const changes: RecommendationModifications =
    stored && typeof stored === "object" && stored.after && typeof stored.after === "object"
      ? stored.after
      : {};

  return {
    title: changes.title ?? base.title,
    summary: changes.summary ?? base.summary,
    type: changes.type ?? base.type,
    priority: changes.priority ?? base.priority,
  };
}

const APPROVING = new Set<Decision["decision"]>(["APPROVED", "MODIFIED"]);

type LatestDecision = Decision & { decidedBy: { id: string; email: string; authUserId: string } };

/** The decision that stands: decisions are append-only, so the newest is the verdict. */
async function latestDecision(
  context: TenantContext,
  recommendationId: string,
): Promise<LatestDecision | null> {
  return prisma.decision.findFirst({
    where: { recommendationId, ...websiteScope(context) },
    orderBy: { decidedAt: "desc" },
    include: { decidedBy: { select: { id: true, email: true, authUserId: true } } },
  });
}

/**
 * A decision counts as a human approval when a person - not the system actor
 * a job runs as - recorded APPROVED or MODIFIED. The recommendation's own
 * status is checked too; the row is the proof, the status is the summary.
 */
function approvedByAPerson(decision: LatestDecision | null): decision is LatestDecision {
  return (
    decision !== null &&
    APPROVING.has(decision.decision) &&
    decision.decidedBy.authUserId !== SYSTEM_AUTH_USER_ID
  );
}

export type StartContentWorkOptions = {
  /** Defaults to the recommendation's owner. Must be an active member of this organization. */
  ownerUserId?: string;
};

/**
 * Turns a human-approved recommendation into a work item (§5). Refuses, with
 * a sentence, anything that is not: an undecided or rejected recommendation,
 * one approved only by status without a decision row behind it, a type P4
 * cannot execute, or one whose work has already started.
 */
export async function startFromRecommendation(
  context: TenantContext,
  recommendationId: string,
  options: StartContentWorkOptions = {},
): Promise<ContentWorkItem> {
  if (!hasRole(context.membership.role, REQUIRED.WRITE)) {
    throw new ContentWorkError("You do not have permission to start content work.", "forbidden");
  }

  const recommendation = await prisma.recommendation.findFirst({
    where: { id: recommendationId, ...websiteScope(context) },
  });

  if (!recommendation) {
    throw new ContentWorkError("That recommendation is not available.", "not_found");
  }

  if (recommendation.status !== "APPROVED" && recommendation.status !== "MODIFIED") {
    throw new ContentWorkError(
      recommendation.status === "AWAITING_REVIEW" || recommendation.status === "NEEDS_EVIDENCE"
        ? "This recommendation has not been decided yet. Decide on it in the Review Queue first."
        : "Only an approved or modified recommendation can become content work.",
      "not_approved",
    );
  }

  const decision = await latestDecision(context, recommendation.id);

  if (!approvedByAPerson(decision)) {
    throw new ContentWorkError(
      "No human decision approves this recommendation, so no work can start from it.",
      "no_decision",
    );
  }

  const effective = effectiveRecommendation(recommendation, decision);
  const eligibility = eligibilityFor(effective.type);

  if (!eligibility.eligible) {
    throw new ContentWorkError(eligibility.reason, "not_eligible");
  }

  const existing = await prisma.contentWorkItem.findFirst({
    where: {
      recommendationId: recommendation.id,
      status: { in: [...OPEN_WORK_ITEM_STATUSES] },
      ...websiteScope(context),
    },
    select: { id: true },
  });

  if (existing) {
    throw new ContentWorkError(
      "Content work has already started for this recommendation.",
      "already_started",
      existing.id,
    );
  }

  let ownerUserId = recommendation.ownerUserId;
  if (options.ownerUserId) {
    // Ownership can only be given to a member of this organization.
    try {
      await requireTenantMember(context, options.ownerUserId);
    } catch (error) {
      if (error instanceof TenantAccessError) {
        throw new ContentWorkError(
          "That person is not a member of this organization.",
          "forbidden",
        );
      }
      throw error;
    }
    ownerUserId = options.ownerUserId;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const item = await tx.contentWorkItem.create({
        data: {
          websiteId: context.website.id,
          recommendationId: recommendation.id,
          decisionId: decision.id,
          type: eligibility.workType,
          priority: effective.priority,
          pageId: recommendation.pageId,
          keywordId: recommendation.keywordId,
          topicId: recommendation.topicId,
          title: effective.title,
          objective: effective.summary,
          ownerUserId,
        },
      });

      // CONTENT_WORK_ITEM_CREATED (§36), in the same transaction as the row.
      await recordAudit(tx, context, {
        entityType: "ContentWorkItem",
        entityId: item.id,
        action: "CREATE",
        after: {
          recommendationId: item.recommendationId,
          decisionId: item.decisionId,
          type: item.type,
          priority: item.priority,
          title: item.title,
          pageId: item.pageId,
          keywordId: item.keywordId,
          topicId: item.topicId,
          ownerUserId: item.ownerUserId,
        },
      });

      return item;
    });
  } catch (error) {
    // Two people pressing Start at once: the partial unique index decides, and
    // the loser is told the truth rather than shown a database error.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.contentWorkItem.findFirst({
        where: {
          recommendationId: recommendation.id,
          status: { in: [...OPEN_WORK_ITEM_STATUSES] },
          ...websiteScope(context),
        },
        select: { id: true },
      });
      throw new ContentWorkError(
        "Content work has already started for this recommendation.",
        "already_started",
        winner?.id,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reading for the screens (§31)
// ---------------------------------------------------------------------------

const QUEUE_INCLUDE = {
  recommendation: { select: { id: true, title: true, type: true, status: true } },
  page: { select: { id: true, path: true, url: true } },
  keyword: { select: { id: true, keyword: true } },
  topic: { select: { id: true, name: true, slug: true } },
  owner: { select: { id: true, email: true, displayName: true } },
} satisfies Prisma.ContentWorkItemInclude;

export type ContentWorkQueueItem = Prisma.ContentWorkItemGetPayload<{
  include: typeof QUEUE_INCLUDE;
}>;

export type QueueFilter = { status?: "open" | "all" | ContentWorkItemStatus[] };

/** The Content Work Queue (§31): open items by default, highest priority first. */
export async function listContentWorkItems(
  context: TenantContext,
  filter: QueueFilter = {},
  limit = 100,
): Promise<ContentWorkQueueItem[]> {
  const status = filter.status ?? "open";
  const statusWhere =
    status === "all"
      ? {}
      : status === "open"
        ? { status: { in: [...OPEN_WORK_ITEM_STATUSES] } }
        : { status: { in: status } };

  return prisma.contentWorkItem.findMany({
    where: { ...websiteScope(context), ...statusWhere },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: limit,
    include: QUEUE_INCLUDE,
  });
}

export type ContentWorkItemDetail = Prisma.ContentWorkItemGetPayload<{
  include: typeof QUEUE_INCLUDE & {
    decision: {
      select: {
        id: true;
        decision: true;
        decidedAt: true;
        reason: true;
        decidedBy: { select: { id: true; email: true } };
      };
    };
  };
}>;

export async function getContentWorkItem(
  context: TenantContext,
  itemId: string,
): Promise<ContentWorkItemDetail | null> {
  return prisma.contentWorkItem.findFirst({
    where: { id: itemId, ...websiteScope(context) },
    include: {
      ...QUEUE_INCLUDE,
      decision: {
        select: {
          id: true,
          decision: true,
          decidedAt: true,
          reason: true,
          decidedBy: { select: { id: true, email: true } },
        },
      },
    },
  });
}

/** The open work item for a recommendation, if a person has started one. */
export async function contentWorkForRecommendation(
  context: TenantContext,
  recommendationId: string,
): Promise<ContentWorkItem | null> {
  return prisma.contentWorkItem.findFirst({
    where: {
      recommendationId,
      status: { in: [...OPEN_WORK_ITEM_STATUSES] },
      ...websiteScope(context),
    },
    orderBy: { createdAt: "desc" },
  });
}

export type ApprovedNotStarted = {
  recommendation: Recommendation & { page: { id: string; path: string } | null };
  decision: LatestDecision;
  effective: EffectiveRecommendation;
  eligibility: Eligibility;
};

/**
 * Approved recommendations nobody has started work on (§31, "Approved, not
 * started"). Those P4 can execute come first, with the button; the rest are
 * listed with the reason they cannot, so an approved technical fix is not
 * mistaken for something the content queue forgot.
 */
export async function listApprovedNotStarted(
  context: TenantContext,
  limit = 100,
): Promise<ApprovedNotStarted[]> {
  const recommendations = await prisma.recommendation.findMany({
    where: {
      ...websiteScope(context),
      status: { in: ["APPROVED", "MODIFIED"] },
      archivedAt: null,
    },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    take: limit,
    include: {
      page: { select: { id: true, path: true } },
      decisions: {
        orderBy: { decidedAt: "desc" },
        take: 1,
        include: { decidedBy: { select: { id: true, email: true, authUserId: true } } },
      },
    },
  });

  if (recommendations.length === 0) return [];

  const started = await prisma.contentWorkItem.findMany({
    where: {
      recommendationId: { in: recommendations.map((row) => row.id) },
      status: { in: [...OPEN_WORK_ITEM_STATUSES] },
      ...websiteScope(context),
    },
    select: { recommendationId: true },
  });
  const startedIds = new Set(started.map((row) => row.recommendationId));

  const rows: ApprovedNotStarted[] = [];

  for (const recommendation of recommendations) {
    if (startedIds.has(recommendation.id)) continue;

    const { decisions, ...rest } = recommendation;
    const decision = decisions[0] ?? null;
    // Status says approved; only a person's decision row makes it so.
    if (!approvedByAPerson(decision)) continue;

    const effective = effectiveRecommendation(rest, decision);
    rows.push({
      recommendation: rest,
      decision,
      effective,
      eligibility: eligibilityFor(effective.type),
    });
  }

  // Eligible first, then by the priority they were approved with.
  const rank: Record<OpportunityPriority, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  return rows.sort(
    (a, b) =>
      Number(b.eligibility.eligible) - Number(a.eligibility.eligible) ||
      rank[b.effective.priority] - rank[a.effective.priority],
  );
}
