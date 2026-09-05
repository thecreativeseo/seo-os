import type { GenerateStructuredRequest } from "@/lib/ai/provider";
import type { ContentBriefOutput } from "@/lib/ai/schemas/content-brief";
import { useStubProvider as installStubProvider, resetProvider } from "@/server/ai/registry";
import type { TenantContext } from "@/server/auth/guards";
import { prisma } from "@/server/db/prisma";
import { DemoSeedError, PROTECTED_DOMAINS } from "@/server/demo/p3";
import { decide } from "@/server/services/decision";
import { startFromRecommendation } from "@/server/services/content-work";
import {
  approveBrief,
  generateBrief,
  requestBriefReview,
  saveBrief,
  type BriefInput,
} from "@/server/services/content-brief";
import type { ContentWorkItem } from "@/generated/prisma/client";

/**
 * P4 demo data - SYNTHETIC, isolated, repeatable (docs/P4_SPEC.md §34, §35).
 *
 * Produced by the real services under the stub provider, never written
 * directly: recommendations a demo owner approves, work items started from
 * them, briefs generated from sealed packages, reviewed and approved. What
 * the seed scripts is the model's answers; everything else - versions,
 * supersession, audit events, the work item's statuses - is what the product
 * does with them.
 *
 * Stories (M3):
 *   a CONTENT_REFRESH work item whose brief v1 was approved, edited into v2,
 *   and v2 approved - so v1 is SUPERSEDED and inspectable;
 *   a NEW_CONTENT work item whose brief v1 is AWAITING_REVIEW;
 *   the P3 stories' approved recommendations started, one with a draft brief.
 */

export type P4DemoOptions = {
  /** The demo page a refresh is briefed for. */
  refreshPagePath?: string;
};

export type P4DemoResult = {
  refreshItemId: string;
  newContentItemId: string;
  startedFromP3: number;
  briefs: { version: number; status: string; workItemId: string }[];
};

const DEFAULT_REFRESH_PATH = "/blog/cohort-analysis-guide";

function citableIds(request: GenerateStructuredRequest<unknown>): string[] {
  return [...(request.untrustedData ?? "").matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]!);
}

function byKind(ids: string[], kind: string): string[] {
  return ids.filter((id) => id.startsWith(`${kind}:`));
}

/** The scripted brief for a request, built from the IDs the package actually holds. */
function scriptFor(request: GenerateStructuredRequest<unknown>): ContentBriefOutput {
  const ids = citableIds(request);
  const facts = byKind(ids, "fact");
  const rules = byKind(ids, "rule");
  const ctx = byKind(ids, "ctx");
  const owns = byKind(ids, "own");
  const isNew = request.task.includes("Target page: none");

  return {
    title: isNew
      ? "Cohort retention benchmarks: what good looks like by stage"
      : "Cohort analysis guide, refreshed for teams choosing a tool",
    content_type: "GUIDE",
    search_intent: isNew ? "INFORMATIONAL" : "COMMERCIAL",
    primary_conversion: "Start a free trial",
    audience: isNew
      ? "Product and growth leads comparing their retention to peers"
      : "Analysts and product managers evaluating cohort analysis tools",
    customer_problem: isNew
      ? "Teams see their own retention curve but have no benchmark to judge it against."
      : "The guide explains the concept but not how to run a cohort analysis in practice.",
    desired_outcome: isNew
      ? "The reader knows whether their retention is healthy and what to look at next."
      : "The reader can run their first cohort analysis and sees why a tool helps.",
    recommended_angle: isNew
      ? "Benchmarks by stage, with the caveats a careful analyst would add."
      : "Keep the concept section, rebuild the walkthrough around a real example.",
    key_questions: isNew
      ? ["What is a good retention rate by stage?", "How do I compare cohorts fairly?"]
      : ["How do I set up a cohort?", "How do I read a retention curve?", "Which tool fits?"],
    required_sections: isNew
      ? [
          { heading: "How benchmarks are built", purpose: "Method before numbers." },
          { heading: "Benchmarks by stage", purpose: "The reader's reason for coming." },
        ]
      : [
          { heading: "What a cohort is", purpose: "Kept from the current page." },
          { heading: "Walkthrough", purpose: "New: one real example, start to finish." },
          { heading: "Choosing a tool", purpose: "New: the commercial step." },
        ],
    optional_sections: [{ heading: "Glossary", purpose: "Terms a first-time reader meets." }],
    internal_link_targets: owns.slice(0, 2).map((evidence_id) => ({
      evidence_id,
      anchor_text: "cohort reports",
      reason: "The product page that answers the commercial question.",
    })),
    external_evidence_requirements: isNew
      ? ["Benchmark figures from an approved source; none are in the evidence."]
      : [],
    approved_claims: facts.slice(0, 3).map((evidence_id) => ({
      text: "Claim as stated in the approved brand fact",
      evidence_id,
    })),
    prohibited_claims: ctx.slice(0, 1).map((evidence_id) => ({
      text: "Do not quote customer counts",
      evidence_id,
    })),
    seo_rule_constraints: rules.slice(0, 3).map((evidence_id) => ({
      evidence_id,
      constraint: "Applies to the title, the headings and the body.",
    })),
    secondary_keyword_evidence_ids: owns.slice(0, 1),
    brand_voice_notes: "Direct, specific, no hype.",
    missing_evidence: isNew ? ["No page exists yet, so there is no baseline to refresh."] : [],
  };
}

async function resetP4(websiteId: string): Promise<void> {
  // Approved briefs are immutable, including against cascade deletes; the
  // seed tears its own history down with the same switch operators use.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
    await tx.contentWorkItem.deleteMany({ where: { websiteId } });
    await tx.recommendation.deleteMany({
      where: { websiteId, createdByAiRunId: null, createdByUserId: { not: null } },
    });
  });
}

/**
 * Seeds the P4 M3 stories into a demo website.
 *
 * Refuses any website that is not a demo, by flag and by name; the
 * `thecreativeseo.com` workspace never receives synthetic execution records.
 */
export async function seedP4Demo(
  context: TenantContext,
  options: P4DemoOptions = {},
): Promise<P4DemoResult> {
  if (!context.website.isDemo || PROTECTED_DOMAINS.includes(context.website.normalizedDomain)) {
    throw new DemoSeedError(
      `Refusing to write synthetic execution records into ${context.website.normalizedDomain}: it is not a demo website.`,
      "not_demo",
    );
  }

  const refreshPath = options.refreshPagePath ?? DEFAULT_REFRESH_PATH;
  const refreshPage = await prisma.page.findFirst({
    where: { websiteId: context.website.id, path: refreshPath, status: "ACTIVE" },
  });
  if (!refreshPage) {
    throw new DemoSeedError(`The ${refreshPath} page for the demo is missing.`, "target_missing");
  }

  await resetP4(context.website.id);

  // Two recommendations a demo owner writes and approves, for the two brief
  // stories M3 asks for. Human-authored, so provenance says so.
  const refreshRecommendation = await prisma.recommendation.create({
    data: {
      websiteId: context.website.id,
      pageId: refreshPage.id,
      type: "CONTENT_REFRESH",
      status: "AWAITING_REVIEW",
      priority: "HIGH",
      title: "Refresh the cohort analysis guide for teams choosing a tool",
      summary:
        "Rebuild the guide's walkthrough around a real example and add the step where a reader chooses a tool.",
      rationale: "The page explains the concept well but loses readers at the practical step.",
      createdByUserId: context.user.id,
    },
  });
  await decide(context, refreshRecommendation.id, {
    decision: "APPROVED",
    reason: "The walkthrough is the gap; the concept section stays.",
  });

  const newRecommendation = await prisma.recommendation.create({
    data: {
      websiteId: context.website.id,
      type: "CONTENT_CREATE",
      status: "AWAITING_REVIEW",
      priority: "MEDIUM",
      title: "Create a cohort retention benchmarks page",
      summary: "A page that lets a product lead judge their retention against peers by stage.",
      rationale: "Buyers ask for benchmarks and nothing on the site answers them.",
      createdByUserId: context.user.id,
    },
  });
  await decide(context, newRecommendation.id, {
    decision: "APPROVED",
    reason: "Approved, with figures to come from an approved source only.",
  });

  const refreshItem = await startFromRecommendation(context, refreshRecommendation.id);
  const newItem = await startFromRecommendation(context, newRecommendation.id);

  // The P3 stories' approved recommendations, started so the queue has depth.
  const p3Started: ContentWorkItem[] = [];
  const p3Approved = await prisma.recommendation.findMany({
    where: {
      websiteId: context.website.id,
      status: { in: ["APPROVED", "MODIFIED"] },
      id: { notIn: [refreshRecommendation.id, newRecommendation.id] },
      createdByAiRunId: { not: null },
    },
  });
  for (const recommendation of p3Approved) {
    try {
      p3Started.push(await startFromRecommendation(context, recommendation.id));
    } catch {
      // Not content work, or already started: the queue explains either.
    }
  }

  installStubProvider({ respond: scriptFor });

  try {
    // Story 1: refresh - v1 approved, edited into v2, v2 approved, v1 superseded.
    const refreshV1 = await generateBrief(context, refreshItem.id);
    if (!refreshV1.ok) {
      throw new DemoSeedError(`The refresh brief failed: ${refreshV1.error.message}`, "run_failed");
    }
    await approveBrief(context, refreshV1.brief.id);

    const edit: BriefInput = {
      title: refreshV1.brief.title,
      contentType: refreshV1.brief.contentType,
      searchIntent: refreshV1.brief.searchIntent,
      primaryConversion: refreshV1.brief.primaryConversion,
      audience: refreshV1.brief.audience,
      customerProblem: refreshV1.brief.customerProblem,
      desiredOutcome: refreshV1.brief.desiredOutcome,
      recommendedAngle:
        "Keep the concept section, rebuild the walkthrough around a real example, and end on the tool decision.",
      keyQuestions: [
        "How do I set up a cohort?",
        "How do I read a retention curve?",
        "Which tool fits, and when is a spreadsheet enough?",
      ],
      requiredSections:
        (refreshV1.brief.requiredSectionsJson as BriefInput["requiredSections"]) ?? [],
      optionalSections:
        (refreshV1.brief.optionalSectionsJson as BriefInput["optionalSections"]) ?? [],
      externalEvidenceRequirements:
        (refreshV1.brief.externalEvidenceRequirementsJson as string[]) ?? [],
      brandVoiceNotes: refreshV1.brief.brandVoiceNotes,
    };
    const refreshV2 = await saveBrief(context, refreshV1.brief.id, edit);
    await approveBrief(context, refreshV2.brief.id);

    // Story 2: new content - v1 generated and waiting for review.
    const newV1 = await generateBrief(context, newItem.id);
    if (!newV1.ok) {
      throw new DemoSeedError(`The new-content brief failed: ${newV1.error.message}`, "run_failed");
    }
    await requestBriefReview(context, newV1.brief.id);

    // A P3-started item with a draft brief, when there is one to brief.
    const firstP3 = p3Started[0];
    if (firstP3) {
      await generateBrief(context, firstP3.id);
    }
  } finally {
    resetProvider();
  }

  const briefs = await prisma.contentBrief.findMany({
    where: { websiteId: context.website.id },
    orderBy: [{ contentWorkItemId: "asc" }, { version: "asc" }],
    select: { version: true, status: true, contentWorkItemId: true },
  });

  return {
    refreshItemId: refreshItem.id,
    newContentItemId: newItem.id,
    startedFromP3: p3Started.length,
    briefs: briefs.map((row) => ({
      version: row.version,
      status: row.status,
      workItemId: row.contentWorkItemId,
    })),
  };
}
