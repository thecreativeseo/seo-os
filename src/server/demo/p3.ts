import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
// Aliased: the registry names it like a React hook, and the hooks lint rule
// judges by name. This is a seed, not a component.
import { resetProvider, useStubProvider as installStubProvider } from "@/server/ai/registry";
import type { GenerateStructuredRequest } from "@/lib/ai/provider";
import type {
  FindingOutput,
  PageDiagnosisOutput,
  RecommendationOutput,
} from "@/lib/ai/schemas/page-diagnosis";
import { buildEvidenceId } from "@/lib/evidence/id";
import { requestPageDiagnosis } from "@/server/services/diagnosis";
import { decide } from "@/server/services/decision";

/**
 * P3 Demo Mode (docs/P3_SPEC.md §33, §34; blueprint "Demo Mode").
 *
 * The five investor stories, produced by the real pipeline. Nothing here writes
 * a diagnosis, a finding, or a recommendation directly. Each story is a scripted
 * model answer handed to the stub provider; the answer then goes through the
 * assembler, the citation validator, the verdict rules and the recommendation
 * guardrails exactly as a live answer would. That is the honest way to seed
 * synthetic AI records: every evidence ID a demo finding cites was genuinely
 * assembled from the demo website's own data and re-resolved under its tenant
 * scope, and every AiRun says "stub" where a real run would say "anthropic".
 *
 * The scripts pick their citations from the package the stub is shown, by kind
 * - ownership records for the ownership story, Search Console days for the CTR
 * story - so a story cannot cite something the page does not have.
 *
 * Two guards, and they are not decorative. The website must be flagged as a
 * demo, and its domain must not be a real workspace's. The second check is on
 * the domain rather than only on the flag, because a flag is something a person
 * can flip and a domain is not.
 */

export const PROTECTED_DOMAINS = ["thecreativeseo.com"];

export class DemoSeedError extends Error {
  constructor(
    message: string,
    readonly code: "not_demo" | "protected" | "target_missing" | "run_failed",
  ) {
    super(message);
    this.name = "DemoSeedError";
  }
}

export type P3DemoTargets = {
  /** The commercial page nominated to own a keyword that a guide actually ranks for. */
  commercial: string;
  /** The guide that ranks instead. */
  guide: string;
  /** The pricing page, where a BLOCKING rule bites. */
  pricing: string;
  /** A comparison landing page with a CTR story. */
  compare: string;
  /** A page with almost nothing measured about it. */
  thin: string;
  /** The BLOCKING rule the pricing recommendation conflicts with. */
  blockingRuleId: string;
};

export type P3DemoResult = {
  diagnoses: number;
  findings: number;
  recommendations: number;
  decisions: number;
  blocked: number;
  needsEvidence: number;
  reviewed: number;
};

type Story = "commercial" | "guide" | "pricing" | "compare" | "thin";

/** The evidence IDs as the model sees them, pulled from the rendered block. */
function citableIds(request: GenerateStructuredRequest<unknown>): string[] {
  return [...(request.untrustedData ?? "").matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]!);
}

/**
 * Citations of a kind, with a fallback to anything at all.
 *
 * The fallback matters for the thin page, which may hold nothing but the
 * governance records every page shares. A story that cited nothing would be
 * lowered by the server - correctly - and the demo would show a diagnosis
 * about a page the product admits it knows nothing about, which is the point of
 * that story, but its findings still need to be legible.
 */
function pick(ids: string[], prefixes: string[], count: number): string[] {
  const chosen = ids.filter((id) => prefixes.some((prefix) => id.startsWith(`${prefix}:`)));
  const pool = chosen.length > 0 ? chosen : ids;
  return pool.slice(0, count);
}

function finding(
  category: FindingOutput["category"],
  verdict: FindingOutput["verdict"],
  confidence: FindingOutput["confidence"],
  title: string,
  summary: string,
  supporting: string[],
  missing: string[] = [],
  contradicting: string[] = [],
): FindingOutput {
  return {
    category,
    verdict,
    confidence,
    title,
    summary,
    supporting_evidence_ids: supporting,
    contradicting_evidence_ids: contradicting,
    missing_evidence: missing,
  };
}

function proposal(
  input: Partial<RecommendationOutput> & Pick<RecommendationOutput, "type" | "title">,
): RecommendationOutput {
  return {
    summary: input.summary ?? input.title,
    rationale: input.rationale ?? input.title,
    priority: input.priority ?? "MEDIUM",
    confidence: input.confidence ?? "MEDIUM",
    effort: input.effort ?? "MEDIUM",
    risk: input.risk ?? "LOW",
    evidence_ids: input.evidence_ids ?? [],
    expected_effect_description: input.expected_effect_description ?? null,
    conflicting_rule_ids: input.conflicting_rule_ids ?? [],
    missing_evidence: input.missing_evidence ?? [],
    ...input,
  };
}

/** The scripted answer for one story, built from what the package actually holds. */
function scriptFor(
  story: Story,
  ids: string[],
  blockingRuleEvidenceId: string,
): PageDiagnosisOutput {
  switch (story) {
    case "commercial":
      return {
        executive_summary:
          "This page was nominated to own a commercial keyword that a blog guide ranks for instead. Search Console shows the commercial page losing clicks while impressions hold, and the ownership record names it as the intended owner. The strongest reading is an ownership conflict; the snippet may also be under-performing. Nothing can be said about indexation without crawl evidence.",
        overall_confidence: "HIGH",
        findings: [
          finding(
            "KEYWORD_OWNERSHIP_CONFLICT",
            "STRONGLY_SUPPORTED",
            "HIGH",
            "A guide ranks for the keyword this page is meant to own",
            "The ownership record nominates this page for the commercial keyword, but the ranking snapshot shows the cohort-analysis guide holding the position. Two pages competing for one commercial query is the pattern behind the click decline.",
            pick(ids, ["own", "rank", "gsc"], 4),
          ),
          finding(
            "CTR_SERP_MISMATCH",
            "SUSPECT",
            "MEDIUM",
            "Impressions steady, clicks falling",
            "Search Console shows impressions holding while clicks fall, which points at the listing rather than the ranking. This is a reading of the daily figures, not a measurement of the SERP itself.",
            pick(ids, ["gsc"], 3),
            ["No SERP snapshot for this query, so the competing listings cannot be compared."],
          ),
          finding(
            "TECHNICAL_INDEXATION",
            "UNKNOWN",
            "UNKNOWN",
            "Indexation cannot be assessed",
            "The package holds no crawl or indexation evidence. A sitemap entry is what the site claims about itself, not what the index holds.",
            [],
            ["No crawl or indexation evidence is available for this page."],
          ),
        ],
        recommendations: [
          proposal({
            type: "KEYWORD_OWNERSHIP_FIX",
            title: "Make the product page the single owner of the commercial keyword",
            summary:
              "Consolidate the commercial intent on the product page and point the guide at it, so one URL competes for the query instead of two.",
            rationale:
              "The ownership record and the ranking snapshot disagree about which page should hold this keyword. Resolving that removes the internal competition the click decline sits on.",
            priority: "HIGH",
            confidence: "HIGH",
            effort: "MEDIUM",
            risk: "MEDIUM",
            evidence_ids: pick(ids, ["own", "rank", "goal"], 3),
            expected_effect_description:
              "One page accumulates the signals for the query instead of two splitting them.",
          }),
          proposal({
            type: "INTERNAL_LINK_UPDATE",
            title: "Link from the guide to the product page with the commercial anchor",
            summary:
              "Add a prominent internal link from the guide to the product page for the commercial query.",
            rationale:
              "The ranking page currently carries the authority; a clear link passes intent to the page meant to convert.",
            priority: "MEDIUM",
            confidence: "MEDIUM",
            effort: "LOW",
            risk: "LOW",
            evidence_ids: pick(ids, ["rank", "gsc"], 2),
          }),
        ],
      };

    case "compare":
      return {
        executive_summary:
          "A comparison page holds a stable position while its clicks lag its impressions. The evidence supports a listing problem more than a ranking problem; whether a SERP feature is absorbing clicks cannot be said without a snapshot.",
        overall_confidence: "HIGH",
        findings: [
          finding(
            "CTR_SERP_MISMATCH",
            "STRONGLY_SUPPORTED",
            "HIGH",
            "Clicks lag impressions at a stable position",
            "Across the window the page keeps its position while the click-through falls short of what the impression volume would suggest. The listing, not the rank, is the variable.",
            pick(ids, ["gsc"], 3),
          ),
          finding(
            "SERP_FEATURE_CHANGE",
            "UNKNOWN",
            "UNKNOWN",
            "SERP layout unknown",
            "Nothing in the package describes what the results page looks like.",
            [],
            ["No SERP snapshot, so a feature absorbing clicks cannot be confirmed or ruled out."],
          ),
        ],
        recommendations: [
          proposal({
            type: "TITLE_META_UPDATE",
            title: "Rewrite the title and description around the comparison intent",
            summary:
              "Lead with the comparison the searcher is making rather than the product name.",
            rationale:
              "The click-through gap at a stable position is the pattern a snippet mismatch produces.",
            priority: "HIGH",
            confidence: "HIGH",
            effort: "LOW",
            risk: "LOW",
            evidence_ids: pick(ids, ["gsc"], 2),
            expected_effect_description:
              "A listing that reads as the comparison people searched for.",
          }),
        ],
      };

    case "guide":
      return {
        executive_summary:
          "The guide ranks for a commercial term but the package holds no snapshot of what the guide actually says, so a content gap is suspected rather than shown. Capturing the page would let the next diagnosis say more.",
        overall_confidence: "MEDIUM",
        findings: [
          finding(
            "CONTENT_GAP",
            "SUSPECT",
            "MEDIUM",
            "Ranking for a commercial term with informational content",
            "The keyword the guide ranks for carries commercial intent while the page is a how-to. That mismatch is suspected from the keyword and ranking records; the page's own words are not in the package.",
            pick(ids, ["kwm", "topic", "rank"], 3),
            ["No content snapshot has been captured for this page."],
          ),
          finding(
            "CONTENT_STALENESS",
            "UNKNOWN",
            "UNKNOWN",
            "Freshness cannot be judged",
            "Without the page content there is nothing to date.",
            [],
            ["No content snapshot has been captured for this page."],
          ),
        ],
        recommendations: [
          proposal({
            type: "CONTENT_REFRESH",
            title: "Refresh the guide with a commercial section that hands off to the product",
            summary:
              "Keep the guide informational but add a section that answers the buying question and links to the product page.",
            rationale:
              "The guide has the ranking; the product page has the intent. A refresh lets the guide serve both without competing.",
            priority: "MEDIUM",
            confidence: "MEDIUM",
            effort: "MEDIUM",
            risk: "LOW",
            evidence_ids: pick(ids, ["rank", "kwm"], 2),
          }),
          proposal({
            type: "REQUEST_MORE_EVIDENCE",
            title: "Capture the guide's content before deciding on the refresh",
            summary: "A content snapshot is needed to see what the guide says today.",
            rationale:
              "The content-gap finding rests on the keyword and ranking records only; the page's words would confirm or dissolve it.",
            priority: "MEDIUM",
            confidence: "MEDIUM",
            effort: "LOW",
            risk: "LOW",
            evidence_ids: pick(ids, ["rank"], 1),
            missing_evidence: ["A content snapshot of this page."],
          }),
        ],
      };

    case "pricing":
      return {
        executive_summary:
          "The pricing page brings in sessions that do not convert at the rate the rest of the site does. The evidence supports a conversion mismatch; the obvious fix touches pricing figures, which a BLOCKING rule reserves for finance.",
        overall_confidence: "MEDIUM",
        findings: [
          finding(
            "CONVERSION_MISMATCH",
            "SUSPECT",
            "MEDIUM",
            "Sessions arrive, conversions do not follow",
            "The analytics and search records show the page attracting visits without a matching conversion rate. Whether the cause is the offer or the page cannot be told from this package.",
            pick(ids, ["ga4", "gsc"], 3),
            ["No conversion evidence configured against a business goal for this page."],
          ),
        ],
        recommendations: [
          proposal({
            type: "TITLE_META_UPDATE",
            title: "Put the starting price in the title and description",
            summary:
              "State the entry price in the listing so the click is qualified before it lands.",
            rationale:
              "Visitors arriving without a price expectation are the ones who leave without converting.",
            priority: "HIGH",
            confidence: "MEDIUM",
            effort: "LOW",
            risk: "MEDIUM",
            evidence_ids: pick(ids, ["gsc", "ga4"], 2),
            conflicting_rule_ids: [blockingRuleEvidenceId],
            expected_effect_description:
              "Clicks that already know the price, and fewer that bounce on it.",
          }),
          proposal({
            type: "MONITOR_ONLY",
            title: "Watch the pricing page for one more window before changing it",
            summary: "Hold and measure; the mismatch may be seasonal.",
            rationale: "One window of divergence is a signal, not a trend.",
            priority: "LOW",
            confidence: "LOW",
            effort: "LOW",
            risk: "LOW",
            evidence_ids: pick(ids, ["gsc"], 1),
          }),
        ],
      };

    case "thin":
      return {
        executive_summary:
          "Almost nothing is measured about this page. The package holds the site's governance records and little else, so no cause can be assessed. That is the answer, not a gap in it.",
        overall_confidence: "UNKNOWN",
        findings: [
          finding(
            "INSUFFICIENT_EVIDENCE",
            "UNKNOWN",
            "UNKNOWN",
            "Not enough evidence to diagnose this page",
            "No search, analytics, ranking or content records exist for this page in the window.",
            [],
            [
              "No Search Console rows for this page in the window.",
              "No Analytics sessions attributed to this page.",
              "No ranking snapshot names this page.",
              "No content snapshot has been captured.",
            ],
          ),
          finding(
            "TECHNICAL_RENDERING",
            "UNKNOWN",
            "UNKNOWN",
            "Rendering cannot be assessed",
            "No crawl evidence is available.",
            [],
            ["No crawl or rendering evidence is available for this page."],
          ),
        ],
        recommendations: [
          proposal({
            type: "REQUEST_MORE_EVIDENCE",
            title: "Connect a data source that covers this page before diagnosing it",
            summary: "Nothing measured means nothing to reason from.",
            rationale:
              "A diagnosis built on the absence of evidence would be a guess with a confidence score.",
            priority: "LOW",
            confidence: "UNKNOWN",
            effort: "LOW",
            risk: "LOW",
            missing_evidence: ["Search Console rows", "Analytics sessions", "A content snapshot"],
          }),
        ],
      };
  }
}

/** Removes every P3 record for a demo website, so the seed is repeatable. */
async function resetP3(websiteId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.decision.deleteMany({ where: { websiteId } });
    await tx.recommendation.deleteMany({ where: { websiteId } });
    await tx.diagnosis.deleteMany({ where: { websiteId } });
    await tx.diagnosisRequest.deleteMany({ where: { websiteId } });
    await tx.evidencePackage.deleteMany({ where: { websiteId } });
    await tx.aiRun.deleteMany({ where: { websiteId } });
  });
}

/**
 * Seeds the five P3 stories into a demo website and records the decisions the
 * blueprint asks for.
 *
 * Repeatable: prior P3 records for the website are removed first. The stub
 * provider is installed for the duration and reset afterwards, so a process that
 * goes on to serve real requests is not left answering from a script.
 */
export async function seedP3Demo(
  context: TenantContext,
  targets: P3DemoTargets,
): Promise<P3DemoResult> {
  if (PROTECTED_DOMAINS.includes(context.website.normalizedDomain)) {
    throw new DemoSeedError(
      `Refusing to write synthetic P3 records into ${context.website.normalizedDomain}: it is a real website.`,
      "protected",
    );
  }

  if (!context.website.isDemo) {
    throw new DemoSeedError(
      `${context.website.normalizedDomain} is not flagged as a demo website. Refusing to write synthetic P3 records.`,
      "not_demo",
    );
  }

  const stories: Story[] = ["commercial", "compare", "guide", "pricing", "thin"];

  const pages = await prisma.page.findMany({
    where: { websiteId: context.website.id, id: { in: stories.map((story) => targets[story]) } },
    select: { id: true, url: true },
  });

  for (const story of stories) {
    if (!pages.some((page) => page.id === targets[story])) {
      throw new DemoSeedError(`The ${story} page for the demo is missing.`, "target_missing");
    }
  }

  const storyByUrl = new Map(
    stories.map((story) => [pages.find((page) => page.id === targets[story])!.url, story]),
  );
  const blockingRuleEvidenceId = buildEvidenceId({
    kind: "rule",
    seoRuleId: targets.blockingRuleId,
  });

  await resetP3(context.website.id);

  installStubProvider({
    respond: (request) => {
      // The task names the target page by URL; that is how the script knows
      // which story it is telling.
      const story = [...storyByUrl.entries()].find(([url]) => request.task.includes(url))?.[1];
      if (!story) return undefined;
      return scriptFor(story, citableIds(request), blockingRuleEvidenceId);
    },
  });

  try {
    const outcomes = new Map<Story, Awaited<ReturnType<typeof requestPageDiagnosis>>>();

    for (const story of stories) {
      const outcome = await requestPageDiagnosis(context, { pageId: targets[story] });
      if (!outcome.ok) {
        throw new DemoSeedError(
          `The ${story} diagnosis failed: ${outcome.error.message}`,
          "run_failed",
        );
      }
      outcomes.set(story, outcome);
    }

    const recommendationsOf = (story: Story, type: RecommendationOutput["type"]) => {
      const outcome = outcomes.get(story);
      if (!outcome || !outcome.ok) return null;
      return outcome.recommendations.find((row) => row.type === type) ?? null;
    };

    // The decisions the blueprint asks for, one of each kind.
    const ownership = recommendationsOf("commercial", "KEYWORD_OWNERSHIP_FIX");
    if (ownership) {
      await decide(context, ownership.id, {
        decision: "APPROVED",
        reason: "The ownership record and the ranking snapshot agree on the conflict. Consolidate.",
      });
    }

    const link = recommendationsOf("commercial", "INTERNAL_LINK_UPDATE");
    if (link) {
      await decide(context, link.id, {
        decision: "REJECTED",
        reason: "Superseded by the ownership fix; a link alone would keep both pages competing.",
      });
    }

    const title = recommendationsOf("compare", "TITLE_META_UPDATE");
    if (title) {
      await decide(context, title.id, {
        decision: "MODIFIED",
        reason: "Keep the product name; lead with the comparison.",
        modifications: {
          title: "Lead the title with the comparison, keep the product name second",
          effort: "LOW",
        },
      });
    }

    const refresh = recommendationsOf("guide", "CONTENT_REFRESH");
    if (refresh) {
      await decide(context, refresh.id, {
        decision: "NEEDS_EVIDENCE",
        reason: "Capture the guide's content first; the gap is suspected, not shown.",
      });
    }

    const monitor = recommendationsOf("pricing", "MONITOR_ONLY");
    if (monitor) {
      await decide(context, monitor.id, {
        decision: "REJECTED",
        reason: "Waiting is not a plan while the conversion gap is open.",
      });
    }
    // The pricing title change is left awaiting review, blocked by the rule:
    // that is the rule-constrained story, and the override is for a person.

    const [diagnoses, findings, recommendations, decisions, blocked, needsEvidence, reviewed] =
      await Promise.all([
        prisma.diagnosis.count({ where: { websiteId: context.website.id } }),
        prisma.diagnosisFinding.count({ where: { diagnosis: { websiteId: context.website.id } } }),
        prisma.recommendation.count({ where: { websiteId: context.website.id } }),
        prisma.decision.count({ where: { websiteId: context.website.id } }),
        prisma.recommendation.count({
          where: { websiteId: context.website.id, blockedByRuleId: { not: null } },
        }),
        prisma.recommendation.count({
          where: { websiteId: context.website.id, status: "NEEDS_EVIDENCE" },
        }),
        prisma.diagnosis.count({ where: { websiteId: context.website.id, status: "REVIEWED" } }),
      ]);

    return { diagnoses, findings, recommendations, decisions, blocked, needsEvidence, reviewed };
  } finally {
    resetProvider();
  }
}
