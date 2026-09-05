import { createHash } from "node:crypto";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { buildEvidenceId, parseEvidenceId } from "@/lib/evidence/id";
import { reliabilityRank, renderEvidence, type Evidence } from "@/lib/evidence/types";
import {
  CONTENT_BRIEF_POLICY,
  CONTENT_DRAFT_POLICY,
  PAGE_DIAGNOSIS_POLICY,
  type RetrievalPolicyDefinition,
} from "@/lib/evidence/retrieval-policy";
import { resolveEvidence } from "@/server/services/evidence";
import { resolveWebsiteWindows } from "@/server/services/metrics";
import type { EvidenceCategory, EvidencePackage } from "@/generated/prisma/client";

/**
 * The Evidence Assembler (docs/P3_SPEC.md §12).
 *
 * "The LLM does not browse arbitrary tenant records itself." This is the service
 * that makes that sentence true. It decides what a diagnosis may see, gathers it
 * under tenant scope, caps it, and freezes the result into an EvidencePackage
 * that the run then reasons over and nothing afterwards can change.
 *
 * Two properties are load-bearing.
 *
 * **Deterministic.** Same website, same page, same data, same policy version →
 * same package, same content hash. That is what makes a diagnosis reproducible
 * rather than merely recorded: months later you can show that this package is
 * the package, and that the conclusion followed from it.
 *
 * **Honest about what it left out.** The context window is finite, so a cap is
 * always reached eventually. Capping silently is the dangerous version — a
 * diagnosis can then be confidently wrong because the one contradicting figure
 * did not fit the budget, and nobody can tell. So every omission is counted by
 * category and written into the manifest, and the manifest is stored with the
 * package and shown next to the diagnosis.
 *
 * The gathering below builds evidence IDs and then resolves each one through
 * EvidenceService rather than reading rows directly. That costs an extra query
 * per record and buys something worth more: every record in a package has been
 * through the same website-scoped resolution the model's answers will be checked
 * against. If an ID cannot round-trip, it never enters the package — so a package
 * cannot contain an ID that would later fail validation.
 */

export class EvidenceAssemblyError extends Error {
  constructor(
    message: string,
    readonly code: "target_not_found" | "sealed" | "not_found",
  ) {
    super(message);
    this.name = "EvidenceAssemblyError";
  }
}

export type AssembledPackage = {
  package: EvidencePackage;
  evidence: Evidence[];
  manifest: RetrievalManifest;
};

export type RetrievalManifest = {
  policy: { name: string; version: number };
  window: { start: string; end: string; comparisonStart: string; comparisonEnd: string } | null;
  /** What went in, by category. */
  included: Record<string, number>;
  /**
   * What was found and left out, by category, with the reason. Never silent.
   */
  omitted: { category: string; count: number; reason: string }[];
  /** Categories the policy allows that produced nothing at all. */
  empty: string[];
  /** Sources with no data — the difference between "nothing happened" and "we never looked". */
  notes: string[];
};

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Assembles the evidence for diagnosing one page.
 *
 * Ordering within the package is by reliability then category then ID, so the
 * hash does not depend on which query finished first.
 */
export async function assemblePageDiagnosisPackage(
  context: TenantContext,
  pageId: string,
  options: { policy?: RetrievalPolicyDefinition } = {},
): Promise<AssembledPackage> {
  const policy = options.policy ?? PAGE_DIAGNOSIS_POLICY;

  const page = await prisma.page.findFirst({
    where: { id: pageId, ...websiteScope(context) },
  });

  if (!page) {
    throw new EvidenceAssemblyError("That page is not available.", "target_not_found");
  }

  const { windows } = await resolveWebsiteWindows(context, "28d");

  const candidates: string[] = [];
  const notes: string[] = [];

  // --- Providers that are planned but not connected --------------------------
  //
  // Named as gaps so the model treats them as missing evidence rather than
  // reasoning around their absence. Similarweb is the current case: competitor
  // traffic, audience and market-share figures come from nowhere else, and a
  // diagnosis that wants them must say it wants them. Adding the provider later
  // is a new evidence category and a resolver, not a change to this model.
  const marketIntelligence = await prisma.connection.findFirst({
    where: { ...websiteScope(context), provider: "SIMILARWEB", status: "CONNECTED" },
    select: { id: true },
  });

  if (!marketIntelligence) {
    notes.push(
      "No market intelligence provider is connected (Similarweb is planned). Competitor traffic, audience and market-share figures are unavailable and must be treated as missing evidence, not estimated.",
    );
  }

  // --- Governance: what the business said it is doing -----------------------

  const contextVersion = await prisma.businessContextVersion.findFirst({
    where: { status: "APPROVED", businessContext: { websiteId: context.website.id } },
    orderBy: { versionNumber: "desc" },
  });

  if (contextVersion) {
    candidates.push(buildEvidenceId({ kind: "ctx", contextVersionId: contextVersion.id }));
  } else {
    notes.push(
      "No approved Business Context. The diagnosis has no statement of what this site is for.",
    );
  }

  const goals = await prisma.businessGoal.findMany({
    where: { ...websiteScope(context), status: "ACTIVE", archivedAt: null },
    orderBy: { createdAt: "desc" },
    take: policy.budgets.BUSINESS_GOAL?.max ?? 5,
  });
  candidates.push(...goals.map((goal) => buildEvidenceId({ kind: "goal", goalId: goal.id })));

  const facts = await prisma.brandFact.findMany({
    where: { ...websiteScope(context), approvalStatus: "APPROVED", archivedAt: null },
    orderBy: { updatedAt: "desc" },
    take: policy.budgets.BRAND_FACT?.max ?? 10,
  });
  candidates.push(...facts.map((fact) => buildEvidenceId({ kind: "fact", brandFactId: fact.id })));

  const rules = await prisma.seoRule.findMany({
    where: { ...websiteScope(context), active: true, archivedAt: null },
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    take: policy.budgets.SEO_RULE?.max ?? 10,
  });
  candidates.push(...rules.map((rule) => buildEvidenceId({ kind: "rule", seoRuleId: rule.id })));

  // --- Measurements: both windows, so movement is visible -------------------

  for (const window of [windows.current, windows.previous]) {
    candidates.push(
      buildEvidenceId({
        kind: "gsc",
        subject: "page",
        subjectId: page.id,
        start: window.start,
        end: window.end,
      }),
      buildEvidenceId({
        kind: "ga4",
        subject: "page",
        subjectId: page.id,
        start: window.start,
        end: window.end,
      }),
    );
  }

  // Top queries for this page in the current window, by impressions.
  const topQueries = await prisma.$queryRaw<{ query_id: string }[]>`
    SELECT m.query_id
    FROM gsc_metric_daily m
    WHERE m.website_id = ${context.website.id}::uuid
      AND m.page_id = ${page.id}::uuid
      AND m.query_id IS NOT NULL
      AND m.date >= ${windows.current.start}::date
      AND m.date <= ${windows.current.end}::date
    GROUP BY m.query_id
    ORDER BY SUM(m.impressions) DESC
    LIMIT ${Math.max(0, (policy.budgets.GSC_METRIC?.max ?? 20) - 4)}
  `;

  for (const row of topQueries) {
    for (const window of [windows.current, windows.previous]) {
      candidates.push(
        buildEvidenceId({
          kind: "gsc",
          subject: "query",
          subjectId: row.query_id,
          start: window.start,
          end: window.end,
        }),
      );
    }
  }

  if (topQueries.length === 0) {
    notes.push("No Search Console queries recorded for this page in the current window.");
  }

  // --- What this page is supposed to rank for -------------------------------

  const ownerships = await prisma.keywordPageOwnership.findMany({
    where: { ...websiteScope(context), pageId: page.id, status: "ACTIVE", archivedAt: null },
    orderBy: [{ ownershipType: "asc" }, { assignedAt: "desc" }],
    take: policy.budgets.KEYWORD_OWNERSHIP?.max ?? 15,
  });

  candidates.push(
    ...ownerships.map((own) => buildEvidenceId({ kind: "own", ownershipId: own.id })),
  );

  const keywordIds = ownerships.map((own) => own.keywordId);

  if (keywordIds.length === 0) {
    notes.push(
      "This page owns no keywords. Nothing states what it is supposed to rank for, so intent cannot be assessed.",
    );
  }

  if (keywordIds.length > 0) {
    // Demand: the most recent snapshot per keyword and provider.
    const metrics = await prisma.keywordMetricsSnapshot.findMany({
      where: { ...websiteScope(context), keywordId: { in: keywordIds } },
      orderBy: { capturedAt: "desc" },
      take: policy.budgets.KEYWORD_METRIC?.max ?? 15,
    });

    candidates.push(
      ...metrics.map((metric) =>
        buildEvidenceId({
          kind: "kwm",
          keywordId: metric.keywordId,
          provider: metric.sourceProvider,
          capturedAt: isoDate(metric.capturedAt),
        }),
      ),
    );

    if (metrics.length === 0) {
      notes.push("No keyword demand data. Import a Semrush or Ahrefs export to supply it.");
    }

    // Rankings: latest and previous per keyword, so movement is a fact rather
    // than an inference from a single point.
    const rankings = await prisma.rankingSnapshot.findMany({
      where: { ...websiteScope(context), keywordId: { in: keywordIds } },
      orderBy: { capturedAt: "desc" },
      take: policy.budgets.RANKING_SNAPSHOT?.max ?? 20,
    });

    candidates.push(
      ...rankings.map((rank) =>
        buildEvidenceId({
          kind: "rank",
          keywordId: rank.keywordId,
          provider: rank.sourceProvider,
          capturedAt: isoDate(rank.capturedAt),
        }),
      ),
    );

    if (rankings.length === 0) {
      notes.push("No ranking data for this page's keywords.");
    }

    // Topics these keywords belong to.
    const topicKeywords = await prisma.topicKeyword.findMany({
      where: { keywordId: { in: keywordIds }, topic: { websiteId: context.website.id } },
      take: policy.budgets.TOPIC_MAPPING?.max ?? 5,
    });

    candidates.push(
      ...topicKeywords.map((mapping) =>
        buildEvidenceId({
          kind: "topic",
          topicId: mapping.topicId,
          keywordId: mapping.keywordId,
        }),
      ),
    );

    // Competitors, on these keywords only. Overlap is the whole relevance test:
    // a competitor's position on a keyword this page does not own says nothing
    // about this page.
    const competitors = await prisma.competitorKeywordSnapshot.findMany({
      where: { ...websiteScope(context), keywordId: { in: keywordIds } },
      orderBy: { capturedAt: "desc" },
      take: policy.budgets.COMPETITOR_OBSERVATION?.max ?? 15,
    });

    candidates.push(
      ...competitors.map((snapshot) =>
        buildEvidenceId({
          kind: "comp",
          competitorId: snapshot.competitorId,
          keywordId: snapshot.keywordId,
          provider: snapshot.sourceProvider,
          capturedAt: isoDate(snapshot.capturedAt),
        }),
      ),
    );
  }

  // --- What the page actually says ------------------------------------------

  const content = await prisma.pageContentSnapshot.findFirst({
    where: { pageId: page.id, ...websiteScope(context) },
    orderBy: { capturedAt: "desc" },
  });

  if (content) {
    candidates.push(
      buildEvidenceId({ kind: "content", pageId: page.id, contentHash: content.contentHash }),
    );
  } else {
    notes.push(
      "No content captured for this page. Nothing can be concluded about what it says, only about how it performs.",
    );
  }

  // --- History ---------------------------------------------------------------

  const signals = await prisma.signal.findMany({
    where: { ...websiteScope(context), pageId: page.id, status: { not: "RESOLVED" } },
    orderBy: { detectedAt: "desc" },
    take: policy.budgets.TECHNICAL_FINDING?.max ?? 10,
  });
  candidates.push(
    ...signals.map((signal) => buildEvidenceId({ kind: "signal", signalId: signal.id })),
  );

  const opportunities = await prisma.opportunity.findMany({
    where: { ...websiteScope(context), pageId: page.id, archivedAt: null },
    orderBy: { identifiedAt: "desc" },
    take: policy.budgets.PREVIOUS_CHANGE?.max ?? 10,
  });
  candidates.push(
    ...opportunities.map((opportunity) =>
      buildEvidenceId({ kind: "opp", opportunityId: opportunity.id }),
    ),
  );

  // Previous diagnoses of this page, excluding ones already superseded: a chain
  // of replaced opinions is noise, and the newest is the one that stands.
  const previous = await prisma.diagnosis.findMany({
    where: {
      ...websiteScope(context),
      targetType: "PAGE",
      targetId: page.id,
      archivedAt: null,
      supersededBy: null,
    },
    orderBy: { createdAt: "desc" },
    take: policy.budgets.PREVIOUS_DIAGNOSIS?.max ?? 3,
  });
  candidates.push(
    ...previous.map((diagnosis) => buildEvidenceId({ kind: "diag", diagnosisId: diagnosis.id })),
  );

  return finalise(context, {
    policy,
    target: { type: "PAGE", id: page.id },
    purpose: "DIAGNOSE_PAGE",
    candidates,
    notes,
    contextVersionId: contextVersion?.id ?? null,
    windows,
  });
}

/** What the brief assembler needs to know about a work item. */
export type BriefSubject = {
  id: string;
  type: string;
  recommendationId: string;
  decisionId: string;
  pageId: string | null;
  keywordId: string | null;
  topicId: string | null;
};

/**
 * Assembles the evidence for briefing one work item (docs/P4_SPEC.md §8).
 *
 * The same discipline as the diagnosis package - deterministic candidate IDs,
 * website-scoped resolution, budgets from a named policy, a manifest of what
 * was left out - over a different selection: governance in full, the keyword
 * and topic the work serves, the target page as it stands, and the diagnosis,
 * opportunity and decision the work item was started from. Brand facts enter
 * only when APPROVED; nothing PROPOSED or INFERRED is in a brief's evidence.
 */
export async function assembleContentBriefPackage(
  context: TenantContext,
  item: BriefSubject,
  options: { policy?: RetrievalPolicyDefinition } = {},
): Promise<AssembledPackage> {
  const policy = options.policy ?? CONTENT_BRIEF_POLICY;
  const { windows } = await resolveWebsiteWindows(context, "28d");

  const candidates: string[] = [];
  const notes: string[] = [];

  // --- Governance, in full ---------------------------------------------------
  const contextVersion = await prisma.businessContextVersion.findFirst({
    where: { status: "APPROVED", businessContext: { websiteId: context.website.id } },
    orderBy: { versionNumber: "desc" },
  });

  if (contextVersion) {
    candidates.push(buildEvidenceId({ kind: "ctx", contextVersionId: contextVersion.id }));
  } else {
    notes.push(
      "No approved Business Context. The brief has no canonical audience, claims or prohibited claims to draw on.",
    );
  }

  const goals = await prisma.businessGoal.findMany({
    where: { ...websiteScope(context), status: "ACTIVE", archivedAt: null },
    orderBy: { createdAt: "desc" },
    take: policy.budgets.BUSINESS_GOAL?.max ?? 5,
  });
  candidates.push(...goals.map((goal) => buildEvidenceId({ kind: "goal", goalId: goal.id })));

  const facts = await prisma.brandFact.findMany({
    where: { ...websiteScope(context), approvalStatus: "APPROVED", archivedAt: null },
    orderBy: { updatedAt: "desc" },
    take: policy.budgets.BRAND_FACT?.max ?? 20,
  });
  candidates.push(...facts.map((fact) => buildEvidenceId({ kind: "fact", brandFactId: fact.id })));
  if (facts.length === 0) {
    notes.push(
      "No approved Brand Facts. The piece may make no business claims until some are approved.",
    );
  }

  const rules = await prisma.seoRule.findMany({
    where: { ...websiteScope(context), active: true, archivedAt: null },
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    take: policy.budgets.SEO_RULE?.max ?? 15,
  });
  candidates.push(...rules.map((rule) => buildEvidenceId({ kind: "rule", seoRuleId: rule.id })));

  // --- What this work came from ----------------------------------------------
  const recommendation = await prisma.recommendation.findFirst({
    where: { id: item.recommendationId, ...websiteScope(context) },
    select: { diagnosisId: true, opportunityId: true },
  });

  if (recommendation?.diagnosisId) {
    candidates.push(buildEvidenceId({ kind: "diag", diagnosisId: recommendation.diagnosisId }));
  } else {
    notes.push(
      "The recommendation did not come from a diagnosis; there are no findings to answer.",
    );
  }
  if (recommendation?.opportunityId) {
    candidates.push(buildEvidenceId({ kind: "opp", opportunityId: recommendation.opportunityId }));
  }
  candidates.push(buildEvidenceId({ kind: "dec", decisionId: item.decisionId }));

  // --- The keyword, the topic, the page ---------------------------------------
  const keywordIds = new Set<string>();
  if (item.keywordId) keywordIds.add(item.keywordId);

  if (item.pageId) {
    const page = await prisma.page.findFirst({
      where: { id: item.pageId, ...websiteScope(context) },
    });

    if (page) {
      for (const window of [windows.current, windows.previous]) {
        candidates.push(
          buildEvidenceId({
            kind: "gsc",
            subject: "page",
            subjectId: page.id,
            start: window.start,
            end: window.end,
          }),
        );
      }

      const content = await prisma.pageContentSnapshot.findFirst({
        where: { pageId: page.id, ...websiteScope(context) },
        orderBy: { capturedAt: "desc" },
      });
      if (content) {
        candidates.push(
          buildEvidenceId({ kind: "content", pageId: page.id, contentHash: content.contentHash }),
        );
      } else {
        notes.push(
          "No content captured for the target page. A brief cannot say what stays and what changes without it.",
        );
      }

      const owned = await prisma.keywordPageOwnership.findMany({
        where: { ...websiteScope(context), pageId: page.id, status: "ACTIVE", archivedAt: null },
        orderBy: [{ ownershipType: "asc" }, { assignedAt: "desc" }],
        take: policy.budgets.KEYWORD_OWNERSHIP?.max ?? 12,
      });
      candidates.push(...owned.map((own) => buildEvidenceId({ kind: "own", ownershipId: own.id })));
      for (const own of owned) keywordIds.add(own.keywordId);
    } else {
      notes.push("The target page is no longer available.");
    }
  } else {
    notes.push(
      "No target page: this is new content, so there is nothing to refresh and no baseline.",
    );
  }

  if (item.topicId) {
    candidates.push(buildEvidenceId({ kind: "topic", topicId: item.topicId, keywordId: null }));
    const mapped = await prisma.topicKeyword.findMany({
      where: { topicId: item.topicId, topic: { websiteId: context.website.id } },
      take: policy.budgets.TOPIC_MAPPING?.max ?? 6,
    });
    candidates.push(
      ...mapped.map((mapping) =>
        buildEvidenceId({ kind: "topic", topicId: mapping.topicId, keywordId: mapping.keywordId }),
      ),
    );
    for (const mapping of mapped) keywordIds.add(mapping.keywordId);
  }

  if (keywordIds.size === 0) {
    notes.push(
      "No keyword is named for this work. Demand, ownership and link targets cannot be shown.",
    );
  } else {
    const ids = [...keywordIds];

    // Who owns these keywords: the target page, and the pages a link can point at.
    const ownerships = await prisma.keywordPageOwnership.findMany({
      where: {
        ...websiteScope(context),
        keywordId: { in: ids },
        status: "ACTIVE",
        archivedAt: null,
      },
      orderBy: [{ ownershipType: "asc" }, { assignedAt: "desc" }],
      take: policy.budgets.KEYWORD_OWNERSHIP?.max ?? 12,
    });
    candidates.push(
      ...ownerships.map((own) => buildEvidenceId({ kind: "own", ownershipId: own.id })),
    );

    const metrics = await prisma.keywordMetricsSnapshot.findMany({
      where: { ...websiteScope(context), keywordId: { in: ids } },
      orderBy: { capturedAt: "desc" },
      take: policy.budgets.KEYWORD_METRIC?.max ?? 10,
    });
    candidates.push(
      ...metrics.map((metric) =>
        buildEvidenceId({
          kind: "kwm",
          keywordId: metric.keywordId,
          provider: metric.sourceProvider,
          capturedAt: isoDate(metric.capturedAt),
        }),
      ),
    );
    if (metrics.length === 0) {
      notes.push("No keyword demand data. Import a Semrush or Ahrefs export to supply it.");
    }

    const rankings = await prisma.rankingSnapshot.findMany({
      where: { ...websiteScope(context), keywordId: { in: ids } },
      orderBy: { capturedAt: "desc" },
      take: policy.budgets.RANKING_SNAPSHOT?.max ?? 6,
    });
    candidates.push(
      ...rankings.map((rank) =>
        buildEvidenceId({
          kind: "rank",
          keywordId: rank.keywordId,
          provider: rank.sourceProvider,
          capturedAt: isoDate(rank.capturedAt),
        }),
      ),
    );

    const competitors = await prisma.competitorKeywordSnapshot.findMany({
      where: { ...websiteScope(context), keywordId: { in: ids } },
      orderBy: { capturedAt: "desc" },
      take: policy.budgets.COMPETITOR_OBSERVATION?.max ?? 6,
    });
    candidates.push(
      ...competitors.map((snapshot) =>
        buildEvidenceId({
          kind: "comp",
          competitorId: snapshot.competitorId,
          keywordId: snapshot.keywordId,
          provider: snapshot.sourceProvider,
          capturedAt: isoDate(snapshot.capturedAt),
        }),
      ),
    );
  }

  return finalise(context, {
    policy,
    target: { type: "CONTENT_WORK_ITEM", id: item.id },
    purpose: "GENERATE_BRIEF",
    candidates,
    notes,
    contextVersionId: contextVersion?.id ?? null,
    windows,
  });
}

/** What the draft assembler needs to know about the work and its brief. */
export type DraftSubject = {
  workItemId: string;
  pageId: string | null;
  keywordId: string | null;
  topicId: string | null;
  /** Pages the approved brief named as internal link targets. */
  linkTargetPageIds: string[];
};

/**
 * Assembles the evidence for writing one draft (docs/P4_SPEC.md §11; M4
 * plan, D-M4-2). Purpose GENERATE_DRAFT, target the work item. Brand facts
 * enter only when APPROVED as of now; the reconciliation of the pinned brief
 * against this package happens in the draft service, not here.
 */
export async function assembleContentDraftPackage(
  context: TenantContext,
  subject: DraftSubject,
  options: { policy?: RetrievalPolicyDefinition } = {},
): Promise<AssembledPackage> {
  const policy = options.policy ?? CONTENT_DRAFT_POLICY;
  const { windows } = await resolveWebsiteWindows(context, "28d");

  const candidates: string[] = [];
  const notes: string[] = [];

  const contextVersion = await prisma.businessContextVersion.findFirst({
    where: { status: "APPROVED", businessContext: { websiteId: context.website.id } },
    orderBy: { versionNumber: "desc" },
  });
  if (contextVersion) {
    candidates.push(buildEvidenceId({ kind: "ctx", contextVersionId: contextVersion.id }));
  } else {
    notes.push(
      "No approved Business Context. The draft has no canonical voice, claims or prohibitions.",
    );
  }

  const goals = await prisma.businessGoal.findMany({
    where: { ...websiteScope(context), status: "ACTIVE", archivedAt: null },
    orderBy: { createdAt: "desc" },
    take: policy.budgets.BUSINESS_GOAL?.max ?? 3,
  });
  candidates.push(...goals.map((goal) => buildEvidenceId({ kind: "goal", goalId: goal.id })));

  const facts = await prisma.brandFact.findMany({
    where: { ...websiteScope(context), approvalStatus: "APPROVED", archivedAt: null },
    orderBy: { updatedAt: "desc" },
    take: policy.budgets.BRAND_FACT?.max ?? 25,
  });
  candidates.push(...facts.map((fact) => buildEvidenceId({ kind: "fact", brandFactId: fact.id })));
  if (facts.length === 0) {
    notes.push("No approved Brand Facts. The draft may make no business claims.");
  }

  const rules = await prisma.seoRule.findMany({
    where: { ...websiteScope(context), active: true, archivedAt: null },
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    take: policy.budgets.SEO_RULE?.max ?? 15,
  });
  candidates.push(...rules.map((rule) => buildEvidenceId({ kind: "rule", seoRuleId: rule.id })));

  // The target page as it stands, and its keywords.
  if (subject.pageId) {
    const page = await prisma.page.findFirst({
      where: { id: subject.pageId, ...websiteScope(context) },
      select: { id: true },
    });
    if (page) {
      const content = await prisma.pageContentSnapshot.findFirst({
        where: { pageId: page.id, ...websiteScope(context) },
        orderBy: { capturedAt: "desc" },
      });
      if (content) {
        candidates.push(
          buildEvidenceId({ kind: "content", pageId: page.id, contentHash: content.contentHash }),
        );
      } else {
        notes.push(
          "No content captured for the target page. A refresh cannot keep what it has not seen.",
        );
      }
    } else {
      notes.push("The target page is no longer available.");
    }
  } else {
    notes.push("No target page: this is new content.");
  }

  // Pages a link may point at: the target's own ownerships, the brief's link
  // targets, and whoever owns the primary keyword.
  const pageIds = [
    ...new Set(
      [subject.pageId, ...subject.linkTargetPageIds].filter((id): id is string => Boolean(id)),
    ),
  ];
  const ownershipWhere = [];
  if (pageIds.length > 0) ownershipWhere.push({ pageId: { in: pageIds } });
  if (subject.keywordId) ownershipWhere.push({ keywordId: subject.keywordId });
  if (ownershipWhere.length > 0) {
    const ownerships = await prisma.keywordPageOwnership.findMany({
      where: { ...websiteScope(context), status: "ACTIVE", archivedAt: null, OR: ownershipWhere },
      orderBy: [{ ownershipType: "asc" }, { assignedAt: "desc" }],
      take: policy.budgets.KEYWORD_OWNERSHIP?.max ?? 12,
    });
    candidates.push(
      ...ownerships.map((own) => buildEvidenceId({ kind: "own", ownershipId: own.id })),
    );
  }

  if (subject.keywordId) {
    const metrics = await prisma.keywordMetricsSnapshot.findMany({
      where: { ...websiteScope(context), keywordId: subject.keywordId },
      orderBy: { capturedAt: "desc" },
      take: policy.budgets.KEYWORD_METRIC?.max ?? 5,
    });
    candidates.push(
      ...metrics.map((metric) =>
        buildEvidenceId({
          kind: "kwm",
          keywordId: metric.keywordId,
          provider: metric.sourceProvider,
          capturedAt: isoDate(metric.capturedAt),
        }),
      ),
    );
  }

  if (subject.topicId) {
    candidates.push(buildEvidenceId({ kind: "topic", topicId: subject.topicId, keywordId: null }));
  }

  return finalise(context, {
    policy,
    target: { type: "CONTENT_WORK_ITEM", id: subject.workItemId },
    purpose: "GENERATE_DRAFT",
    candidates,
    notes,
    contextVersionId: contextVersion?.id ?? null,
    windows,
  });
}

type FinaliseInput = {
  policy: RetrievalPolicyDefinition;
  target: { type: string; id: string };
  purpose: string;
  candidates: string[];
  notes: string[];
  contextVersionId: string | null;
  windows: { current: { start: string; end: string }; previous: { start: string; end: string } };
};

/**
 * The part every package shares: resolve each candidate under the tenant's
 * scope, drop what does not round-trip, order deterministically, apply the
 * policy's budgets, write the manifest, persist. Which records are candidates
 * is the assembler's business; what happens to them is not.
 */
async function finalise(context: TenantContext, input: FinaliseInput): Promise<AssembledPackage> {
  const { policy, candidates, notes, windows } = input;

  const seen = new Set<string>();
  const evidence: Evidence[] = [];
  const droppedByCategory = new Map<EvidenceCategory, number>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    // Everything goes through the same website-scoped resolution the model's
    // answers will face. A record that cannot round-trip does not go in.
    const parsed = await resolveEvidence(context, parseOwnId(candidate));
    if (!parsed) continue;

    evidence.push(trimContent(parsed, policy));
  }

  evidence.sort(compareEvidence);

  const capped: Evidence[] = [];
  const perCategory = new Map<EvidenceCategory, number>();

  for (const record of evidence) {
    const budget = policy.budgets[record.type]?.max ?? policy.maxEvidence;
    const used = perCategory.get(record.type) ?? 0;

    if (used >= budget || capped.length >= policy.maxEvidence) {
      droppedByCategory.set(record.type, (droppedByCategory.get(record.type) ?? 0) + 1);
      continue;
    }

    perCategory.set(record.type, used + 1);
    capped.push(record);
  }

  const manifest = buildManifest(policy, windows, capped, droppedByCategory, notes, perCategory);

  const stored = await persist(context, {
    target: input.target,
    purpose: input.purpose,
    policy,
    evidence: capped,
    manifest,
    contextVersionId: input.contextVersionId,
    periodStart: windows.previous.start,
    periodEnd: windows.current.end,
  });

  return { package: stored, evidence: capped, manifest };
}

/**
 * Every candidate here was produced by buildEvidenceId a few lines earlier, so a
 * failure to parse means build and parse have drifted apart — a bug in the
 * keystone module, not bad input. It throws rather than skipping, because
 * silently dropping evidence would turn that bug into a quietly thinner package.
 */
function parseOwnId(raw: string) {
  const parsed = parseEvidenceId(raw);

  if (!parsed) {
    throw new EvidenceAssemblyError(
      `Built an evidence id that does not parse: ${raw}`,
      "not_found",
    );
  }

  return parsed;
}

/** Page text is capped separately: it is the one record that can be enormous. */
function trimContent(evidence: Evidence, policy: RetrievalPolicyDefinition): Evidence {
  if (evidence.type !== "PAGE_CONTENT" || evidence.textValue === null) return evidence;
  if (evidence.textValue.length <= policy.maxContentChars) return evidence;

  return {
    ...evidence,
    textValue: evidence.textValue.slice(0, policy.maxContentChars),
    contextJson: {
      ...(evidence.contextJson ?? {}),
      truncated: true,
      truncatedTo: policy.maxContentChars,
    },
  };
}

/** Most direct first, then category, then ID — so ordering never depends on timing. */
function compareEvidence(a: Evidence, b: Evidence): number {
  const byReliability = reliabilityRank(a.reliability) - reliabilityRank(b.reliability);
  if (byReliability !== 0) return byReliability;

  const byType = a.type.localeCompare(b.type);
  if (byType !== 0) return byType;

  return a.id.localeCompare(b.id);
}

function buildManifest(
  policy: RetrievalPolicyDefinition,
  windows: { current: { start: string; end: string }; previous: { start: string; end: string } },
  included: Evidence[],
  dropped: Map<EvidenceCategory, number>,
  notes: string[],
  perCategory: Map<EvidenceCategory, number>,
): RetrievalManifest {
  const includedCounts: Record<string, number> = {};
  for (const [category, count] of perCategory) includedCounts[category] = count;

  return {
    policy: { name: policy.name, version: policy.version },
    window: {
      start: windows.current.start,
      end: windows.current.end,
      comparisonStart: windows.previous.start,
      comparisonEnd: windows.previous.end,
    },
    included: includedCounts,
    omitted: [...dropped.entries()].map(([category, count]) => ({
      category,
      count,
      reason:
        policy.budgets[category]?.rationale ??
        `Package limit of ${policy.maxEvidence} records reached.`,
    })),
    empty: Object.keys(policy.budgets).filter((category) => !(category in includedCounts)),
    notes,
  };
}

/**
 * The content hash.
 *
 * Over the sorted evidence IDs plus the policy identity — not over the rendered
 * text. Two packages built from the same records under the same rules are the
 * same package even if a label was reworded between them, and a package whose
 * records changed is a different package even if it reads similarly.
 */
export function hashPackage(policy: RetrievalPolicyDefinition, evidence: Evidence[]): string {
  const material = [
    `${policy.name}@${policy.version}`,
    ...evidence.map((record) => record.id).sort(),
  ].join("\n");

  return createHash("sha256").update(material).digest("hex");
}

async function persist(
  context: TenantContext,
  input: {
    target: { type: string; id: string };
    purpose: string;
    policy: RetrievalPolicyDefinition;
    evidence: Evidence[];
    manifest: RetrievalManifest;
    contextVersionId: string | null;
    periodStart: string;
    periodEnd: string;
  },
): Promise<EvidencePackage> {
  const policyRow = await ensurePolicyRow(input.policy);

  return prisma.$transaction(async (tx) => {
    const created = await tx.evidencePackage.create({
      data: {
        websiteId: context.website.id,
        targetType: input.target.type,
        targetId: input.target.id,
        purpose: input.purpose,
        contextVersionId: input.contextVersionId,
        periodStart: new Date(`${input.periodStart}T00:00:00.000Z`),
        periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
        evidenceCount: input.evidence.length,
        retrievalPolicyId: policyRow.id,
        retrievalPolicyVersion: input.policy.version,
        retrievalManifestJson: input.manifest as never,
        contentHash: hashPackage(input.policy, input.evidence),
      },
    });

    if (input.evidence.length > 0) {
      await tx.evidenceRef.createMany({
        data: input.evidence.map((record) => ({
          packageId: created.id,
          evidenceId: record.id,
          evidenceType: record.type,
          reliability: record.reliability,
          sourceEntityType: record.sourceEntityType,
          sourceEntityId: record.sourceEntityId,
          capturedAt: record.capturedAt,
          asOfDate: record.asOfDate,
          metricKey: record.metricKey,
          numericValue: record.numericValue,
          textValue: record.textValue,
          contextJson: (record.contextJson ?? undefined) as never,
        })),
      });
    }

    await recordAudit(tx, context, {
      entityType: "EvidencePackage",
      entityId: created.id,
      action: "CREATE",
      after: {
        targetType: input.target.type,
        targetId: input.target.id,
        evidenceCount: input.evidence.length,
        policy: `${input.policy.name}@${input.policy.version}`,
        contentHash: created.contentHash,
        omitted: input.manifest.omitted.length,
      },
    });

    return created;
  });
}

/** The policy row a package points at, created on first use. */
async function ensurePolicyRow(policy: RetrievalPolicyDefinition) {
  return prisma.retrievalPolicy.upsert({
    where: { name_version: { name: policy.name, version: policy.version } },
    update: {},
    create: {
      name: policy.name,
      version: policy.version,
      description: policy.description,
      policyJson: {
        windowDays: policy.windowDays,
        maxEvidence: policy.maxEvidence,
        maxContentChars: policy.maxContentChars,
        budgets: policy.budgets,
        rules: policy.rules,
      } as never,
      active: true,
    },
  });
}

/**
 * Marks a package as final.
 *
 * Called when the run that used it finishes. Nothing modifies a sealed package —
 * it is the record of what a diagnosis was actually shown.
 */
export async function sealPackage(
  context: TenantContext,
  packageId: string,
): Promise<EvidencePackage | null> {
  const existing = await prisma.evidencePackage.findFirst({
    where: { id: packageId, ...websiteScope(context) },
  });

  if (!existing) return null;
  if (existing.sealedAt !== null) return existing;

  return prisma.evidencePackage.update({
    where: { id: existing.id },
    data: { sealedAt: new Date() },
  });
}

export async function getPackage(
  context: TenantContext,
  packageId: string,
): Promise<(EvidencePackage & { refs: { evidenceId: string }[] }) | null> {
  return prisma.evidencePackage.findFirst({
    where: { id: packageId, ...websiteScope(context) },
    include: { refs: { select: { evidenceId: true } } },
  });
}

/**
 * The package as the model will see it.
 *
 * Grouped by reliability so the ordering itself carries the message that a
 * measurement and a previous model opinion are not the same kind of thing.
 */
export function renderPackage(evidence: Evidence[]): string {
  const groups = new Map<string, Evidence[]>();

  for (const record of evidence) {
    const existing = groups.get(record.reliability);
    if (existing) existing.push(record);
    else groups.set(record.reliability, [record]);
  }

  const sections: string[] = [];

  for (const reliability of [...groups.keys()].sort(
    (a, b) =>
      reliabilityRank(a as Evidence["reliability"]) - reliabilityRank(b as Evidence["reliability"]),
  )) {
    sections.push(`## ${reliability}`);
    for (const record of groups.get(reliability) ?? []) {
      sections.push(renderEvidence(record));
    }
    sections.push("");
  }

  return sections.join("\n");
}
