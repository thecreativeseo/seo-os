import type { GenerateStructuredRequest } from "@/lib/ai/provider";
import type { ContentBriefOutput } from "@/lib/ai/schemas/content-brief";
import type { ContentDraftOutput } from "@/lib/ai/schemas/content-draft";
import { useStubProvider as installStubProvider, resetProvider } from "@/server/ai/registry";
import type { TenantContext } from "@/server/auth/guards";
import { prisma } from "@/server/db/prisma";
import { DemoSeedError, PROTECTED_DOMAINS } from "@/server/demo/p3";
import { approveForCms, runQa } from "@/server/services/content-qa";
import type { ContentQaOutput } from "@/lib/ai/schemas/content-qa";
import { decide } from "@/server/services/decision";
import { startFromRecommendation } from "@/server/services/content-work";
import {
  approveBrief,
  generateBrief,
  requestBriefReview,
  saveBrief,
  type BriefInput,
} from "@/server/services/content-brief";
import {
  ContentDraftError,
  generateRevision,
  approveDraft,
  reopenDraft,
  requestDraftReview,
  saveRevision,
  startDraft,
  startDraftFromBrief,
} from "@/server/services/content-draft";
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
 *
 * Stories (M4.2, M4.3):
 *   the refresh item's draft: a deliberately bad AI revision v1, stored and
 *   flagged, which blocks review; a hand-written v2 that clears it; review
 *   requested, so the draft is AWAITING_EDITOR_REVIEW;
 *   a third item whose brief v1 was approved and drafted (AI v1), then edited
 *   into v2 and approved - the mismatch - and a person started a draft from
 *   v2: the first draft is SUPERSEDED and inspectable, the second generated
 *   from v2 and a fresh package.
 *
 * Stories (M4.5):
 *   the refresh brief v1 goes through review before approval; the refresh
 *   draft is approved for QA on its hand-written v2 (work item Ready for QA);
 *   the third item's draft on v2 is approved, then reopened with a reason and
 *   revised by hand - the approval stays in history, no longer current.
 */

export type P4DemoOptions = {
  /** The demo page a refresh is briefed for. */
  refreshPagePath?: string;
};

export type P4DemoResult = {
  refreshItemId: string;
  newContentItemId: string;
  compareItemId: string;
  startedFromP3: number;
  briefs: { version: number; status: string; workItemId: string }[];
  /** The refresh draft's revisions: AI v1 flagged and blocking, human v2 clean. */
  revisions: { revisionNumber: number; blocking: boolean; author: "AI" | "HUMAN" }[];
  /** The refresh draft, approved for QA on its hand-written revision. */
  reviewDraftId: string;
  /** The draft on the newer brief: approved, then reopened with a reason and revised. */
  reopenedDraftId: string;
  /** The supersession story: the old draft kept, the new one pinned to v2. */
  supersession: { oldDraftId: string; newDraftId: string };
  /** The three M5 stories, by work item and QA run. */
  qa: {
    /** Passed QA, then a person approved it for the CMS. */
    approved: { workItemId: string; runId: string; approvalId: string } | null;
    /** Blocked: the fact a claim rests on was revoked before QA. */
    blocked: { workItemId: string; runId: string } | null;
    /** Passed with warnings, with a check that could not run at all. */
    notChecked: { workItemId: string; runId: string; types: string[] } | null;
  };
};

const DEFAULT_REFRESH_PATH = "/blog/cohort-analysis-guide";
const REFRESH_TITLE = "Refresh the cohort analysis guide for teams choosing a tool";
const COMPARE_TITLE = "Compare cohort analysis tools for teams outgrowing spreadsheets";
const EXPORT_TITLE = "Explain how cohort exports work for analysts who live in spreadsheets";

/**
 * The claim story B rests on, and the fact behind it. The fact is approved
 * while the piece is written and reviewed, and revoked before QA - which is
 * exactly how a business changes its mind, and exactly what QA has to catch.
 */
const EXPORT_CLAIM = "Cohort reports export to CSV";
const EXPORT_FACT_KEY = "cohort-export-format";

const EXPORT_BODY = [
  "# Exporting cohort reports",
  "",
  "## What exports look like",
  "",
  "Cohort reports export to CSV. Every cohort, every period, and the counts behind each cell, in the same shape you see on screen.",
  "",
  "## When to export",
  "",
  "Export when the question has moved past the tool: a board pack, a model that mixes cohorts with revenue, or a colleague who works in a spreadsheet and always will.",
  "",
  "## What to check afterwards",
  "",
  "Check the period boundaries and the cohort definition before anyone builds on the numbers. A cohort that starts on a different day is a different cohort.",
].join("\n");

/** Story C: a title and description change. No questions to answer, by nature. */
const TITLE_META_BODY = [
  "# Cohort analysis tools: the comparison, up front",
  "",
  "## What changes",
  "",
  "The page keeps its content. The title and the description change, so that the comparison a reader came for is the first thing they see and the product name comes second.",
  "",
  "The current title leads with the product. Someone comparing tools reads past it, because nothing in it says the page compares anything. The new title leads with the comparison and keeps the product name where it still earns the click.",
  "",
  "The description does the same work in a sentence: what the page compares, and who it is for. Nothing in the body of the page changes, so nothing a reader has already found moves.",
  "",
  "## Why it is worth doing",
  "",
  "The page already appears for the comparison; it just does not read like a comparison in the result. A title and a description that match the search are the cheapest change on the page, and the one whose effect is easiest to read afterwards.",
].join("\n");

/** The good draft of the refresh story - what the stub writes, and what the person restores. */
const GOOD_REFRESH_BODY = [
  "# Cohort analysis, from first cohort to first decision",
  "",
  "## What a cohort is",
  "",
  "A cohort is a group of users who share a starting moment. Comparing cohorts shows whether the product is getting better at keeping people, week by week.",
  "",
  "## Walkthrough",
  "",
  "Pick a start event, group users by the week they did it, and count how many come back in each following week. The curve that falls and flattens is your retention.",
  "",
  "## Choosing a tool",
  "",
  "A spreadsheet works for one product and one question. Past that, a tool that refreshes cohorts on its own saves the week you would spend rebuilding them. See [cohort reports](/product/cohort-reports).",
].join("\n");

function citableIds(request: GenerateStructuredRequest<unknown>): string[] {
  return [...(request.untrustedData ?? "").matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]!);
}

/** The evidence id of the record whose rendered block holds this text. */
function idHolding(request: GenerateStructuredRequest<unknown>, needle: string): string | null {
  const blocks = (request.untrustedData ?? "").split(/\n(?=\[)/);
  const hit = blocks.find((block) => block.startsWith("[fact:") && block.includes(needle));
  return hit ? (/^\[([^\]]+)\]/.exec(hit)?.[1] ?? null) : null;
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
  const isCompare = request.task.includes(COMPARE_TITLE);
  const isExport = request.task.includes(EXPORT_TITLE);
  const isTitleMeta = request.task.includes("Work item type: TITLE_META_UPDATE");
  const exportFact = idHolding(request, EXPORT_CLAIM);

  if (isExport) {
    return {
      title: "How cohort exports work",
      content_type: "GUIDE",
      search_intent: "INFORMATIONAL",
      primary_conversion: "Start a free trial",
      audience: "Analysts who take numbers out of tools and into spreadsheets",
      customer_problem: "They cannot tell what an export contains until they have run one.",
      desired_outcome: "The reader knows what they get and what to check before using it.",
      recommended_angle: "Say what the file holds, then when exporting is the right move.",
      key_questions: ["What does an export contain?"],
      required_sections: [
        { heading: "What exports look like", purpose: "The file, described." },
        { heading: "When to export", purpose: "The judgement call." },
      ],
      optional_sections: [],
      internal_link_targets: [],
      external_evidence_requirements: [],
      approved_claims: exportFact
        ? [{ text: EXPORT_CLAIM, evidence_id: exportFact }]
        : facts.slice(0, 1).map((evidence_id) => ({ text: EXPORT_CLAIM, evidence_id })),
      prohibited_claims: ctx.slice(0, 1).map((evidence_id) => ({
        text: "Do not quote customer counts",
        evidence_id,
      })),
      seo_rule_constraints: rules.slice(0, 2).map((evidence_id) => ({
        evidence_id,
        constraint: "Applies to the title, the headings and the body.",
      })),
      secondary_keyword_evidence_ids: [],
      brand_voice_notes: "Direct, specific, no hype.",
      missing_evidence: [],
    };
  }

  if (isTitleMeta) {
    // A title and description change answers no reader questions: the brief
    // says so rather than inventing some, and QA reports honestly that
    // answer readiness could not be checked.
    return {
      title: "Title and description for the comparison page",
      content_type: "GUIDE",
      search_intent: "COMMERCIAL",
      primary_conversion: null,
      audience: "Readers comparing cohort analysis tools",
      customer_problem: "The result does not read like the comparison the page actually is.",
      desired_outcome: "The title and description say what the page compares, and for whom.",
      recommended_angle: "Lead with the comparison, keep the product name second.",
      key_questions: [],
      required_sections: [
        { heading: "What changes", purpose: "The title and the description, and why." },
        { heading: "Why it is worth doing", purpose: "The case, in a paragraph." },
      ],
      optional_sections: [],
      internal_link_targets: [],
      external_evidence_requirements: [],
      approved_claims: [],
      prohibited_claims: ctx.slice(0, 1).map((evidence_id) => ({
        text: "Do not quote customer counts",
        evidence_id,
      })),
      seo_rule_constraints: rules.slice(0, 2).map((evidence_id) => ({
        evidence_id,
        constraint: "Applies to the title and the description.",
      })),
      secondary_keyword_evidence_ids: [],
      brand_voice_notes: "Direct, specific, no hype.",
      missing_evidence: [],
    };
  }

  return {
    title: isCompare
      ? "Cohort analysis tools compared: spreadsheet, product analytics, or a dedicated tool"
      : isNew
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

/**
 * The scripted draft. For the refresh story the model is deliberately bad -
 * a figure nobody approved, a topic the context says to avoid, a link off
 * the site - so the stored, flagged revision shows what the server catches
 * on the way in, and why review is refused until a person fixes it. For any
 * other item it writes what a good model does with the brief.
 */
function draftScriptFor(request: GenerateStructuredRequest<unknown>): ContentDraftOutput {
  const ids = citableIds(request);
  const facts = byKind(ids, "fact");
  const owns = byKind(ids, "own");
  const good = !request.task.includes(REFRESH_TITLE);
  const isExport = request.task.includes(EXPORT_TITLE);
  const isTitleMeta = request.task.includes("Type: TITLE_META_UPDATE");
  const exportFact = idHolding(request, EXPORT_CLAIM);

  if (isExport) {
    return {
      title: "Exporting cohort reports",
      slug: "exporting-cohort-reports",
      excerpt: "What a cohort export contains, when to run one, and what to check afterwards.",
      meta_title: "Exporting Cohort Reports | Investor Demo",
      meta_description: "What a cohort export contains, when to run one, and what to check.",
      body_markdown: EXPORT_BODY,
      claims: [
        {
          text: EXPORT_CLAIM,
          evidence_id: exportFact ?? facts[0] ?? null,
        },
      ],
      internal_links_used: [],
      sections_covered: ["What exports look like", "When to export"],
      open_questions: [],
      change_summary: "First draft from the approved brief.",
    };
  }

  if (isTitleMeta) {
    return {
      title: "Cohort analysis tools compared: spreadsheet, product analytics, or a dedicated tool",
      slug: "cohort-analysis-tools",
      excerpt: "Which cohort analysis tool fits, and when a spreadsheet is still the right answer.",
      meta_title: "Cohort Analysis Tools Compared | Investor Demo",
      meta_description:
        "Compare cohort analysis tools: spreadsheet, product analytics, or a dedicated tool.",
      body_markdown: TITLE_META_BODY,
      claims: [],
      internal_links_used: [],
      sections_covered: ["What changes", "Why it is worth doing"],
      open_questions: [],
      change_summary: "First draft from the approved brief.",
    };
  }

  const body = good
    ? GOOD_REFRESH_BODY
    : [
        "# Cohort analysis, guaranteed to lift retention",
        "",
        "## What a cohort is",
        "",
        "Trusted by 10,000 businesses, our cohort reports cut churn by 40% in the first month. Unlike the competitor teardowns you will read elsewhere, this one is honest - see [this study](https://research.example/cohorts) for proof.",
        "",
        "## Walkthrough",
        "",
        "Pick a start event and group users by the week they did it.",
      ].join("\n");

  return {
    title: good
      ? "Cohort analysis, from first cohort to first decision"
      : "Cohort analysis, guaranteed to lift retention",
    slug: "cohort-analysis-guide",
    excerpt: "How to run a cohort analysis and decide whether you need a tool for it.",
    meta_title: good
      ? "Cohort Analysis Guide | Investor Demo"
      : "Cohort Analysis Guide, Guaranteed Results, Trusted by Thousands of Teams",
    meta_description: "Set up a cohort, read the retention curve, and choose a tool.",
    body_markdown: body,
    claims: good
      ? facts.slice(0, 1).map((evidence_id) => ({
          text: "Claim as stated in the approved brand fact",
          evidence_id,
        }))
      : [
          { text: "Trusted by 10,000 businesses", evidence_id: null },
          {
            text: "Cut churn by 40% in the first month",
            evidence_id: "fact:00000000-0000-4000-8000-0000000000ff",
          },
        ],
    internal_links_used: good
      ? owns.slice(0, 1).map((evidence_id) => ({ evidence_id, anchor_text: "cohort reports" }))
      : [],
    sections_covered: ["What a cohort is", "Walkthrough", "Choosing a tool"],
    open_questions: good ? [] : ["A verified customer count, if one is ever to be quoted."],
    change_summary: good
      ? "First draft from the approved brief."
      : "First draft from the approved brief.",
  };
}

/**
 * The scripted QA judge. It answers what the task asks - the questions and
 * the rules it was given, by their exact text and ids - and, for the refresh
 * story, reports the two things a person should see a model report: an intent
 * that only partly matches, and a missing call to action. Everything it says
 * is capped and verified by the server before it counts.
 */
function qaScriptFor(request: GenerateStructuredRequest<unknown>): ContentQaOutput {
  const task = request.task;
  const questions = [...task.matchAll(/^- Q\d+: (.+)$/gm)].map((match) => match[1]!.trim());
  const rules = [...task.matchAll(/\[rule:([^\]]+)\]/g)].map((match) => match[1]!);
  const isRefresh = task.includes(REFRESH_TITLE);
  const hasConversion = !/^Primary conversion: not stated$/m.test(task);
  const hasKeyword = !/^Primary keyword: not stated$/m.test(task);

  return {
    intent_alignment: isRefresh
      ? {
          status: "PARTIAL",
          rationale:
            "The walkthrough serves the reader well; the tool comparison stops short of the decision the brief asks for.",
          excerpts: ["A spreadsheet works for one product and one question."],
        }
      : { status: "ALIGNED", rationale: "It answers the search the brief names.", excerpts: [] },
    answer_readiness: questions.map((question, index) => ({
      question,
      status: isRefresh && index === questions.length - 1 ? "PARTIAL" : "ANSWERED",
      heading: null,
      form: "DIRECT",
      excerpt: null,
    })),
    rule_judgments: rules.map((rule_id) => ({
      rule_id: `rule:${rule_id}`,
      status: "RESPECTED",
      rationale: "The text reads as the rule asks.",
      excerpt: null,
    })),
    unlisted_claims: [],
    prohibited_paraphrases: [],
    call_to_action: hasConversion
      ? isRefresh
        ? {
            status: "ABSENT",
            rationale: "Nothing invites the reader to start a trial.",
            excerpt: null,
          }
        : { status: "PRESENT", rationale: "The close asks for the next step.", excerpt: null }
      : null,
    keyword_use: hasKeyword
      ? { status: "NATURAL", rationale: "It sits where a reader expects it.", excerpt: null }
      : null,
    brand_voice: { status: "MATCHES", rationale: "Direct and specific.", excerpt: null },
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

  // A third, for the superseded-brief story.
  const compareRecommendation = await prisma.recommendation.create({
    data: {
      websiteId: context.website.id,
      type: "CONTENT_CREATE",
      status: "AWAITING_REVIEW",
      priority: "MEDIUM",
      title: COMPARE_TITLE,
      summary: "A comparison page for teams deciding whether they need a cohort tool at all.",
      rationale: "The commercial question the guide raises has no page that answers it.",
      createdByUserId: context.user.id,
    },
  });
  await decide(context, compareRecommendation.id, {
    decision: "APPROVED",
    reason: "Approved; keep it honest about when a spreadsheet is enough.",
  });

  const refreshItem = await startFromRecommendation(context, refreshRecommendation.id);
  const newItem = await startFromRecommendation(context, newRecommendation.id);
  const compareItem = await startFromRecommendation(context, compareRecommendation.id);

  // The P3 stories' approved recommendations, started so the queue has depth.
  const p3Started: ContentWorkItem[] = [];
  const p3Approved = await prisma.recommendation.findMany({
    where: {
      websiteId: context.website.id,
      status: { in: ["APPROVED", "MODIFIED"] },
      id: { notIn: [refreshRecommendation.id, newRecommendation.id, compareRecommendation.id] },
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

  installStubProvider({
    respond: (request) => {
      if (request.schemaName === "content_draft") return draftScriptFor(request);
      if (request.schemaName === "content_qa") return qaScriptFor(request);
      return scriptFor(request);
    },
  });

  let reviewDraftId = "";
  let reopenedDraftId = "";
  let qa: P4DemoResult["qa"] = { approved: null, blocked: null, notChecked: null };
  let supersession = { oldDraftId: "", newDraftId: "" };

  try {
    // Story 1: refresh - v1 approved, edited into v2, v2 approved, v1 superseded.
    const refreshV1 = await generateBrief(context, refreshItem.id);
    if (!refreshV1.ok) {
      throw new DemoSeedError(`The refresh brief failed: ${refreshV1.error.message}`, "run_failed");
    }
    // Story A: the generated brief goes through review before approval.
    await requestBriefReview(context, refreshV1.brief.id);
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

    // M4.2 / M4.3, story A: the refresh draft. AI v1 is deliberately bad and
    // stored flagged; review is refused; a person writes v2 and clears it;
    // review is requested.
    const { draft: refreshDraft } = await startDraft(context, refreshItem.id);
    const bad = await generateRevision(context, refreshDraft.id, {
      generationToken: "demo-refresh-1",
    });
    if (!bad.ok) {
      throw new DemoSeedError(`The refresh draft failed: ${bad.message}`, "run_failed");
    }
    try {
      await requestDraftReview(context, refreshDraft.id);
      throw new DemoSeedError(
        "The flagged revision was accepted for review; the demo expects it refused.",
        "run_failed",
      );
    } catch (error) {
      if (!(error instanceof ContentDraftError) || error.code !== "blocked") throw error;
    }
    await saveRevision(context, refreshDraft.id, {
      title: "Cohort analysis, from first cohort to first decision",
      slug: "cohort-analysis-guide",
      excerpt: "How to run a cohort analysis and decide whether you need a tool for it.",
      metaTitle: "Cohort Analysis Guide | Investor Demo",
      metaDescription: "Set up a cohort, read the retention curve, and choose a tool.",
      bodyMarkdown: GOOD_REFRESH_BODY,
      changeSummary:
        "Removed the customer count and the external study nobody approved; rebuilt the walkthrough and the tool section from the brief.",
    });
    await requestDraftReview(context, refreshDraft.id);
    // Story B ends approved for QA: exactly revision 2, by the demo owner.
    await approveDraft(context, refreshDraft.id, {
      note: "The walkthrough is real and every claim is backed. Ready for QA.",
    });
    reviewDraftId = refreshDraft.id;

    // Story B: the compare item. Brief v1 approved and drafted; then v2
    // approved, so the draft is on a superseded brief; a person starts a
    // draft from v2 - the old one is kept, superseded; the new one is
    // generated from v2 and a fresh package.
    const compareV1 = await generateBrief(context, compareItem.id);
    if (!compareV1.ok) {
      throw new DemoSeedError(`The compare brief failed: ${compareV1.error.message}`, "run_failed");
    }
    await approveBrief(context, compareV1.brief.id);
    const { draft: compareDraftA } = await startDraft(context, compareItem.id);
    const firstPass = await generateRevision(context, compareDraftA.id, {
      generationToken: "demo-compare-a-1",
    });
    if (!firstPass.ok) {
      throw new DemoSeedError(`The compare draft failed: ${firstPass.message}`, "run_failed");
    }
    const compareV2 = await saveBrief(context, compareV1.brief.id, {
      title: compareV1.brief.title,
      contentType: compareV1.brief.contentType,
      searchIntent: compareV1.brief.searchIntent,
      primaryConversion: compareV1.brief.primaryConversion,
      audience: compareV1.brief.audience,
      customerProblem: compareV1.brief.customerProblem,
      desiredOutcome: compareV1.brief.desiredOutcome,
      recommendedAngle:
        "Lead with the honest case for a spreadsheet, then the point where it breaks.",
      keyQuestions: [
        "When is a spreadsheet enough?",
        "What does a dedicated tool add?",
        "How do the options compare on cost?",
      ],
      requiredSections:
        (compareV1.brief.requiredSectionsJson as BriefInput["requiredSections"]) ?? [],
      optionalSections:
        (compareV1.brief.optionalSectionsJson as BriefInput["optionalSections"]) ?? [],
      externalEvidenceRequirements:
        (compareV1.brief.externalEvidenceRequirementsJson as string[]) ?? [],
      brandVoiceNotes: compareV1.brief.brandVoiceNotes,
    });
    await approveBrief(context, compareV2.brief.id);
    const { draft: compareDraftB } = await startDraftFromBrief(
      context,
      compareItem.id,
      compareV2.brief.id,
    );
    const secondPass = await generateRevision(context, compareDraftB.id, {
      generationToken: "demo-compare-b-1",
    });
    if (!secondPass.ok) {
      throw new DemoSeedError(`The compare draft failed: ${secondPass.message}`, "run_failed");
    }
    supersession = { oldDraftId: compareDraftA.id, newDraftId: compareDraftB.id };

    // Story C: the draft on v2 is approved, then reopened with a reason and
    // revised by hand. The approval stays in history, no longer current.
    await requestDraftReview(context, compareDraftB.id);
    await approveDraft(context, compareDraftB.id, { note: "Approved against Brief v2." });
    await reopenDraft(
      context,
      compareDraftB.id,
      "Pricing for the dedicated tools changed after approval; the cost comparison must be rewritten.",
    );
    await saveRevision(context, compareDraftB.id, {
      title: "Cohort analysis tools compared: when a spreadsheet stops being enough",
      slug: "cohort-analysis-tools-compared",
      excerpt:
        "The honest case for a spreadsheet, and the point where a dedicated tool earns its cost.",
      metaTitle: "Cohort Analysis Tools Compared | Investor Demo",
      metaDescription: "Spreadsheet, product analytics, or a dedicated cohort tool: how to decide.",
      bodyMarkdown: GOOD_REFRESH_BODY.replace(
        "## Choosing a tool",
        "## Choosing a tool, with today's prices",
      ),
      changeSummary: "Rewrote the cost comparison with the current prices; the rest stands.",
    });
    reopenedDraftId = compareDraftB.id;

    // ---- M5 stories ------------------------------------------------------
    // Story B needs a fact that is true while the piece is written and
    // reviewed, and revoked before QA. Re-running the seed puts it back.
    const existingFact = await prisma.brandFact.findFirst({
      where: { websiteId: context.website.id, factKey: EXPORT_FACT_KEY },
    });
    const exportFact = existingFact
      ? await prisma.brandFact.update({
          where: { id: existingFact.id },
          data: { approvalStatus: "APPROVED", value: EXPORT_CLAIM, archivedAt: null },
        })
      : await prisma.brandFact.create({
          data: {
            websiteId: context.website.id,
            category: "Product",
            factKey: EXPORT_FACT_KEY,
            value: EXPORT_CLAIM,
            approvalStatus: "APPROVED",
            source: "USER_PROVIDED",
          },
        });

    const exportRecommendation = await prisma.recommendation.create({
      data: {
        websiteId: context.website.id,
        type: "CONTENT_CREATE",
        status: "AWAITING_REVIEW",
        priority: "MEDIUM",
        title: EXPORT_TITLE,
        summary: "Analysts keep asking what an export contains before they run one.",
        rationale: "Support answers this by hand every week; the answer belongs on the site.",
        createdByUserId: context.user.id,
      },
    });
    await decide(context, exportRecommendation.id, {
      decision: "APPROVED",
      reason: "One page, one question, and we already know the answer.",
    });
    const exportItem = await startFromRecommendation(context, exportRecommendation.id);

    const exportBrief = await generateBrief(context, exportItem.id);
    if (!exportBrief.ok) {
      throw new DemoSeedError(
        `The export brief failed: ${exportBrief.error.message}`,
        "run_failed",
      );
    }
    await approveBrief(context, exportBrief.brief.id);
    const { draft: exportDraft } = await startDraft(context, exportItem.id);
    const exportRevision = await generateRevision(context, exportDraft.id, {
      generationToken: "demo-export-1",
    });
    if (!exportRevision.ok) {
      throw new DemoSeedError(`The export draft failed: ${exportRevision.message}`, "run_failed");
    }
    await requestDraftReview(context, exportDraft.id);
    await approveDraft(context, exportDraft.id, {
      note: "Accurate as written, and the fact behind it is approved.",
    });

    // Story C: a title and description change. Its brief asks no reader
    // questions, so answer readiness has nothing to check - which the report
    // has to say rather than pass over.
    const titleMetaItem = p3Started.find((item) => item.type === "TITLE_META_UPDATE") ?? null;
    let notCheckedRunId: string | null = null;
    if (titleMetaItem) {
      const brief = await generateBrief(context, titleMetaItem.id);
      if (!brief.ok) {
        throw new DemoSeedError(`The title brief failed: ${brief.error.message}`, "run_failed");
      }
      await approveBrief(context, brief.brief.id);
      const { draft } = await startDraft(context, titleMetaItem.id);
      const written = await generateRevision(context, draft.id, {
        generationToken: "demo-title-meta-1",
      });
      if (!written.ok) {
        throw new DemoSeedError(`The title draft failed: ${written.message}`, "run_failed");
      }
      await requestDraftReview(context, draft.id);
      await approveDraft(context, draft.id, { note: "Reads as the brief asks." });
    }

    // Every editorial approval is done. Now the business changes its mind
    // about one fact - and QA, not a person, is what catches the piece that
    // still rests on it.
    await prisma.brandFact.update({
      where: { id: exportFact.id },
      data: { approvalStatus: "REJECTED" },
    });

    // QA runs last, in this order, so the approved story stays current: the
    // facts and rules behind it do not move again after it is approved.
    const blockedRun = await runQa(context, exportItem.id);
    if (!blockedRun.ok) {
      throw new DemoSeedError(`QA on the export story failed: ${blockedRun.message}`, "run_failed");
    }
    if (titleMetaItem) {
      const run = await runQa(context, titleMetaItem.id);
      if (!run.ok) {
        throw new DemoSeedError(`QA on the title story failed: ${run.message}`, "run_failed");
      }
      notCheckedRunId = run.run.id;
    }
    const passedRun = await runQa(context, refreshItem.id);
    if (!passedRun.ok) {
      throw new DemoSeedError(`QA on the refresh story failed: ${passedRun.message}`, "run_failed");
    }
    const approval = await approveForCms(context, refreshItem.id, {
      note: "Read the warnings and the checks that could not run. Nothing blocking; ready for the CMS.",
      acknowledgeNotChecked: true,
    });

    const notCheckedTypes = notCheckedRunId
      ? (
          await prisma.contentQaResult.findMany({
            where: { qaRunId: notCheckedRunId, status: "NOT_CHECKED" },
            select: { qaType: true },
          })
        ).map((row) => String(row.qaType))
      : [];

    qa = {
      approved: {
        workItemId: refreshItem.id,
        runId: passedRun.run.id,
        approvalId: approval.approval.id,
      },
      blocked: { workItemId: exportItem.id, runId: blockedRun.run.id },
      notChecked:
        titleMetaItem && notCheckedRunId
          ? { workItemId: titleMetaItem.id, runId: notCheckedRunId, types: notCheckedTypes }
          : null,
    };
  } finally {
    resetProvider();
  }

  const briefs = await prisma.contentBrief.findMany({
    where: { websiteId: context.website.id },
    orderBy: [{ contentWorkItemId: "asc" }, { version: "asc" }],
    select: { version: true, status: true, contentWorkItemId: true },
  });

  const revisions = await prisma.contentRevision.findMany({
    where: { websiteId: context.website.id, contentDraftId: reviewDraftId },
    orderBy: { revisionNumber: "asc" },
    select: { revisionNumber: true, constraintFindingsJson: true, createdByAiRunId: true },
  });

  return {
    refreshItemId: refreshItem.id,
    newContentItemId: newItem.id,
    compareItemId: compareItem.id,
    startedFromP3: p3Started.length,
    briefs: briefs.map((row) => ({
      version: row.version,
      status: row.status,
      workItemId: row.contentWorkItemId,
    })),
    revisions: revisions.map((row) => ({
      revisionNumber: row.revisionNumber,
      blocking: Boolean((row.constraintFindingsJson as { blocking?: boolean } | null)?.blocking),
      author: row.createdByAiRunId ? "AI" : "HUMAN",
    })),
    reviewDraftId,
    reopenedDraftId,
    supersession,
    qa,
  };
}
