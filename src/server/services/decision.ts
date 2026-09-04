import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { resolveEvidenceIds } from "@/server/services/evidence";
import type { Evidence } from "@/lib/evidence/types";
import { Prisma } from "@/generated/prisma/client";
import type {
  AuditAction,
  Decision,
  DecisionValue,
  Diagnosis,
  DiagnosisFinding,
  Recommendation,
  RecommendationStatus,
  SeoRule,
} from "@/generated/prisma/client";

/**
 * DecisionService (docs/P3_SPEC.md §24, §25, §36).
 *
 * The one place in P3 where a person's judgement is written down. Three things
 * hold here and nowhere weaker:
 *
 *   - Authorization is checked in this service, not only in the action that calls
 *     it. §36 lists "human Decision authorization server-side" as release
 *     blocking, and a service that trusted its caller to have checked would be
 *     one missed call away from an unauthorized approval.
 *   - A model cannot reach this. There is no code path from an AiRun to a
 *     Decision; the row's actor is a User foreign key, and the only function that
 *     creates one takes a TenantContext, which only a signed-in person has.
 *   - Decisions are appended, never edited. A recommendation that has been
 *     decided stays decided; changing one's mind is a new recommendation, not a
 *     rewrite of the record of the old one.
 *
 * MODIFIED keeps the reviewer's changes as a diff beside the proposal rather
 * than overwriting it (§25). Both the model's version and the person's survive,
 * which is the difference between a record and a story.
 */

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "forbidden"
      | "already_decided"
      | "needs_evidence"
      | "override_required"
      | "override_mismatch"
      | "reason_required"
      | "nothing_modified",
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

/** The fields a reviewer may change. Everything else is the model's record. */
export type RecommendationModifications = Partial<
  Pick<
    Recommendation,
    "title" | "summary" | "rationale" | "type" | "priority" | "effort" | "risk"
  > & { expectedEffectDescription: string | null }
>;

const MODIFIABLE = [
  "title",
  "summary",
  "rationale",
  "type",
  "priority",
  "effort",
  "risk",
  "expectedEffectDescription",
] as const;

export type DecisionInput =
  | {
      decision: "APPROVED";
      reason?: string;
      /** Required when the recommendation is blocked by a BLOCKING rule (§23). */
      override?: { ruleId: string; reason: string };
    }
  | { decision: "MODIFIED"; reason?: string; modifications: RecommendationModifications }
  | { decision: "REJECTED"; reason: string }
  | { decision: "NEEDS_EVIDENCE"; reason: string };

const STATUS_FOR: Record<DecisionValue, RecommendationStatus> = {
  APPROVED: "APPROVED",
  MODIFIED: "MODIFIED",
  REJECTED: "REJECTED",
  NEEDS_EVIDENCE: "NEEDS_EVIDENCE",
};

/** §35: one verb per verdict, so the audit screen says what was decided. */
const AUDIT_FOR: Record<DecisionValue, AuditAction> = {
  APPROVED: "APPROVE",
  MODIFIED: "MODIFY",
  REJECTED: "REJECT",
  NEEDS_EVIDENCE: "REQUEST_EVIDENCE",
};

/** Statuses a reviewer can still act on. */
const REVIEWABLE: RecommendationStatus[] = ["AWAITING_REVIEW", "NEEDS_EVIDENCE"];

function requireReason(reason: string | undefined, what: string): string {
  const trimmed = reason?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new DecisionError(`Give a reason for ${what}.`, "reason_required");
  }
  return trimmed;
}

/**
 * Records a reviewer's decision on a recommendation.
 *
 * Returns the decision and the recommendation as it now stands. Throws
 * DecisionError for anything the reviewer needs to hear about; the action layer
 * turns those into sentences.
 */
export async function decide(
  context: TenantContext,
  recommendationId: string,
  input: DecisionInput,
): Promise<{ decision: Decision; recommendation: Recommendation }> {
  // Checked here regardless of what the caller checked. See the file comment.
  if (!hasRole(context.membership.role, REQUIRED.APPROVE)) {
    throw new DecisionError("Only an owner or admin can decide on a recommendation.", "forbidden");
  }

  const existing = await prisma.recommendation.findFirst({
    where: { id: recommendationId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new DecisionError("That recommendation is not available.", "not_found");
  }

  if (!REVIEWABLE.includes(existing.status)) {
    throw new DecisionError(
      `This recommendation was already decided (${existing.status}).`,
      "already_decided",
    );
  }

  let reason: string | null = null;
  let override: { ruleId: string; reason: string } | null = null;
  let modifications: Prisma.InputJsonValue | undefined;

  switch (input.decision) {
    case "APPROVED": {
      // §23: a recommendation must cite evidence. One that is still waiting for
      // it cannot be approved, whoever asks.
      if (existing.status === "NEEDS_EVIDENCE") {
        throw new DecisionError(
          "This recommendation needs evidence before it can be approved.",
          "needs_evidence",
        );
      }

      // §23: a BLOCKING rule blocks, or requires an explicit, authorized override
      // that names the rule. Silence is not consent.
      if (existing.blockedByRuleId) {
        if (!input.override) {
          throw new DecisionError(
            "A BLOCKING SEO rule applies. Approving requires an explicit override naming the rule.",
            "override_required",
          );
        }
        if (input.override.ruleId !== existing.blockedByRuleId) {
          throw new DecisionError(
            "The override names a different rule from the one blocking this recommendation.",
            "override_mismatch",
          );
        }
        override = {
          ruleId: input.override.ruleId,
          reason: requireReason(input.override.reason, "overriding a BLOCKING rule"),
        };
      }

      reason = input.reason?.trim() || null;
      break;
    }

    case "MODIFIED": {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      for (const field of MODIFIABLE) {
        if (!(field in input.modifications)) continue;
        const next = input.modifications[field];
        if (next === undefined || next === existing[field]) continue;
        before[field] = existing[field];
        after[field] = next;
      }

      if (Object.keys(after).length === 0) {
        throw new DecisionError("Change something, or approve it as it is.", "nothing_modified");
      }

      // §23 applies to the reviewer too: a number in the expected effect is a
      // forecast whoever wrote it.
      if (
        typeof after.expectedEffectDescription === "string" &&
        /\d/.test(after.expectedEffectDescription)
      ) {
        throw new DecisionError(
          "The expected effect is descriptive only. Remove the figures.",
          "nothing_modified",
        );
      }

      modifications = { before, after } as Prisma.InputJsonValue;
      reason = input.reason?.trim() || null;
      break;
    }

    case "REJECTED":
      reason = requireReason(input.reason, "rejecting");
      break;

    case "NEEDS_EVIDENCE":
      reason = requireReason(input.reason, "requesting more evidence");
      break;
  }

  const status = STATUS_FOR[input.decision];

  return prisma.$transaction(async (tx) => {
    const decision = await tx.decision.create({
      data: {
        websiteId: context.website.id,
        recommendationId: existing.id,
        decision: input.decision,
        reason,
        modifiedRecommendationJson: modifications,
        overriddenRuleId: override?.ruleId ?? null,
        overrideReason: override?.reason ?? null,
        decidedByUserId: context.user.id,
      },
    });

    // Only the status moves. The proposal's text is the model's record and a
    // modification lives on the decision, not over the top of it.
    const recommendation = await tx.recommendation.update({
      where: { id: existing.id },
      data: { status },
    });

    // Section 19: a diagnosis is reviewed once every proposal on it has been
    // decided. Reached here rather than left to a person to remember, and only
    // moved forward - a superseded or archived diagnosis stays what it is.
    if (existing.diagnosisId) {
      const open = await tx.recommendation.count({
        where: { diagnosisId: existing.diagnosisId, status: { in: REVIEWABLE } },
      });

      if (open === 0) {
        const closed = await tx.diagnosis.updateMany({
          where: {
            id: existing.diagnosisId,
            websiteId: context.website.id,
            status: { in: ["DRAFT", "AWAITING_REVIEW"] },
          },
          data: { status: "REVIEWED", reviewedByUserId: context.user.id, reviewedAt: new Date() },
        });

        if (closed.count > 0) {
          await recordAudit(tx, context, {
            entityType: "Diagnosis",
            entityId: existing.diagnosisId,
            action: "COMPLETE",
            after: { status: "REVIEWED", via: "last recommendation decided" },
          });
        }
      }
    }

    // DECISION_RECORDED and RECOMMENDATION_<verdict> (§35).
    await recordAudit(tx, context, {
      entityType: "Decision",
      entityId: decision.id,
      action: "CREATE",
      after: {
        recommendationId: existing.id,
        decision: input.decision,
        overriddenRuleId: decision.overriddenRuleId,
        modifiedFields: modifications
          ? Object.keys((modifications as { after: object }).after)
          : [],
      },
    });

    await recordAudit(tx, context, {
      entityType: "Recommendation",
      entityId: existing.id,
      action: AUDIT_FOR[input.decision],
      before: { status: existing.status },
      after: { status, decisionId: decision.id },
    });

    return { decision, recommendation };
  });
}

// ---------------------------------------------------------------------------
// What a reviewer sees before deciding (§24)
// ---------------------------------------------------------------------------

export type ReviewQueueItem = Recommendation & {
  diagnosis: Pick<Diagnosis, "id" | "executiveSummary" | "overallConfidence" | "createdAt"> | null;
  page: { id: string; url: string; path: string } | null;
  blockedByRule: Pick<SeoRule, "id" | "rule" | "severity"> | null;
};

/** Everything not yet decided, newest first. */
export async function listReviewQueue(
  context: TenantContext,
  limit = 50,
): Promise<ReviewQueueItem[]> {
  return prisma.recommendation.findMany({
    where: { ...websiteScope(context), status: { in: REVIEWABLE }, archivedAt: null },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: limit,
    include: {
      diagnosis: {
        select: { id: true, executiveSummary: true, overallConfidence: true, createdAt: true },
      },
      page: { select: { id: true, url: true, path: true } },
      blockedByRule: { select: { id: true, rule: true, severity: true } },
    },
  });
}

export type RecommendationReview = {
  recommendation: Recommendation & {
    page: { id: string; url: string; path: string } | null;
    blockedByRule: SeoRule | null;
  };
  /** The evidence the recommendation cites, re-resolved now. */
  evidence: Evidence[];
  /** Cited IDs that no longer resolve — shown, so a reviewer knows the ground moved. */
  staleEvidenceIds: string[];
  diagnosis:
    | (Diagnosis & {
        findings: (DiagnosisFinding & {
          evidence: { evidenceId: string; relationship: string }[];
        })[];
      })
    | null;
  /** Every active rule, BLOCKING first. Constraints are shown whether or not they bite. */
  rules: SeoRule[];
  decisions: (Decision & { decidedBy: { id: string; email: string } })[];
};

/**
 * The review screen's data (§24): diagnosis, evidence, confidence, missing
 * evidence, the recommendation, its risk and effort, and the rules in force.
 *
 * Evidence is resolved again here rather than read back from the link table,
 * so what the reviewer sees is what the record says today. An ID that resolved
 * at diagnosis time and does not now is listed as stale rather than dropped.
 */
export async function getRecommendationForReview(
  context: TenantContext,
  recommendationId: string,
): Promise<RecommendationReview | null> {
  const recommendation = await prisma.recommendation.findFirst({
    where: { id: recommendationId, ...websiteScope(context) },
    include: {
      page: { select: { id: true, url: true, path: true } },
      blockedByRule: true,
      evidence: { select: { evidenceId: true }, orderBy: { evidenceId: "asc" } },
      decisions: {
        orderBy: { decidedAt: "asc" },
        include: { decidedBy: { select: { id: true, email: true } } },
      },
    },
  });

  if (!recommendation) return null;

  const [resolution, diagnosis, rules] = await Promise.all([
    resolveEvidenceIds(
      context,
      recommendation.evidence.map((link) => link.evidenceId),
    ),
    recommendation.diagnosisId
      ? prisma.diagnosis.findFirst({
          where: { id: recommendation.diagnosisId, ...websiteScope(context) },
          include: {
            findings: {
              orderBy: [{ verdict: "asc" }, { category: "asc" }],
              include: {
                evidence: {
                  select: { evidenceId: true, relationship: true },
                  orderBy: { evidenceId: "asc" },
                },
              },
            },
          },
        })
      : Promise.resolve(null),
    prisma.seoRule.findMany({
      where: { ...websiteScope(context), active: true, archivedAt: null },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  const { evidence: links, decisions, ...rest } = recommendation;
  void links;

  return {
    recommendation: rest,
    evidence: resolution.resolved,
    staleEvidenceIds: [...resolution.unresolved, ...resolution.invalid],
    diagnosis,
    rules,
    decisions,
  };
}

export type RecommendationListItem = Recommendation & {
  page: { id: string; url: string; path: string } | null;
  diagnosis: Pick<Diagnosis, "id" | "executiveSummary" | "overallConfidence"> | null;
  blockedByRule: Pick<SeoRule, "id" | "rule" | "severity"> | null;
};

/** Recommendations for the website, optionally by status, newest first. */
export async function listRecommendations(
  context: TenantContext,
  filter: { status?: RecommendationStatus[] } = {},
  limit = 100,
): Promise<RecommendationListItem[]> {
  return prisma.recommendation.findMany({
    where: {
      ...websiteScope(context),
      archivedAt: null,
      ...(filter.status && filter.status.length > 0 ? { status: { in: filter.status } } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
    include: {
      page: { select: { id: true, url: true, path: true } },
      diagnosis: { select: { id: true, executiveSummary: true, overallConfidence: true } },
      blockedByRule: { select: { id: true, rule: true, severity: true } },
    },
  });
}
