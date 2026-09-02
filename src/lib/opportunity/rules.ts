import type {
  ConfidenceLevel,
  EffortLevel,
  OpportunityType,
} from "@/generated/prisma/client";

import { BANDS } from "@/lib/ranking/movement";
import {
  assemble,
  scoreBusinessRelevance,
  scoreCommercialImportance,
  scoreCompetitiveGap,
  scoreConfidence,
  scoreCurrentVisibility,
  scoreEffort,
  scoreIntentMatch,
  scoreSearchDemand,
  type ScoreResult,
} from "@/lib/opportunity/scoring";

/**
 * Opportunity detection (docs/P2_SPEC.md §17, §18).
 *
 * Deterministic and pure: the same facts always produce the same opportunities
 * with the same scores. That property is what lets the queue be explained, and it
 * is why detection is a function over plain data rather than a method that
 * queries as it goes.
 *
 * The rules answer "what is worth doing", never "why is this happening". A
 * declining page becomes a refresh candidate; it does not become a page that
 * declined *because of* anything. Causal diagnosis is P3's, with evidence P3 is
 * built to gather.
 */

export type KeywordFact = {
  keywordId: string;
  keyword: string;
  intent: string;
  intentKnown: boolean;
  businessRelevance: number | null;
  commercialValue: number | null;
  searchVolume: number | null;
  providersDisagree: boolean;
  position: number | null;
  freshnessDays: number | null;
  /** The page nominated to own it. */
  ownerPageId: string | null;
  ownerPath: string | null;
  /** The page that actually ranked most recently. */
  rankingPageId: string | null;
  rankingPath: string | null;
  distinctRankingPages: number;
  topicId: string | null;
  topicName: string | null;
  isCommercialDestination: boolean;
  competitorsRanking: number;
  competitorsAhead: number;
  businessGoalId: string | null;
};

export type TopicFact = {
  topicId: string;
  topicName: string;
  keywordCount: number;
  pageCount: number;
  coverage: string;
  /** Keywords in the topic that a provider has reported demand for. */
  keywordsWithDemand: number;
  totalVolume: number | null;
  businessGoalId: string | null;
};

export type SignalFact = {
  signalId: string;
  type: string;
  pageId: string | null;
  pagePath: string | null;
  keywordId: string | null;
  impressions: number | null;
  ctr: number | null;
  businessGoalId: string | null;
};

export type PageDeclineFact = {
  pageId: string;
  path: string;
  currentClicks: number;
  previousClicks: number;
  keywordId: string | null;
  searchVolume: number | null;
  businessGoalId: string | null;
};

export type DetectionInput = {
  keywords: KeywordFact[];
  topics: TopicFact[];
  signals: SignalFact[];
  decliningPages: PageDeclineFact[];
};

export type EvidenceDraft = {
  evidenceType: "METRIC_COMPARISON" | "THRESHOLD" | "RANKING_OBSERVATION" | "KEYWORD_METRIC" | "OWNERSHIP_STATE" | "COMPETITOR_OVERLAP" | "GOAL_ALIGNMENT";
  sourceEntityType: string;
  sourceEntityId: string;
  metricKey: string;
  numericValue: number | null;
  textValue: string | null;
};

export type DetectedOpportunity = {
  type: OpportunityType;
  title: string;
  summary: string;
  keywordId: string | null;
  pageId: string | null;
  topicId: string | null;
  competitorId: string | null;
  businessGoalId: string | null;
  sourceSignalId: string | null;
  effort: EffortLevel;
  confidence: ConfidenceLevel;
  expectedEffectDescription: string;
  scoring: ScoreResult;
  evidence: EvidenceDraft[];
};

/**
 * Demand below this is not worth raising a new page for on its own.
 *
 * Set from what the demo dataset showed: at 100 the rule fired for nearly every
 * unowned keyword in an ordinary 80-keyword market, because most keywords in any
 * market have no nominated owner and that is normal rather than a finding. A page
 * is a real piece of work, and this is roughly the demand that justifies one.
 */
export const MIN_DEMAND_FOR_NEW_PAGE = 500;

/**
 * How many of each type reach the queue.
 *
 * P1 learned this with signals: 143 findings is not more useful than 12, it is
 * less, because a queue nobody can read is a queue nobody uses. The cap keeps the
 * highest-scoring of each type and the true count travels alongside, so nothing is
 * hidden — a person can always see that they are looking at 12 of 52.
 */
export const MAX_PER_TYPE: Partial<Record<OpportunityType, number>> = {
  NO_OWNING_PAGE: 10,
  COMPETITOR_GAP: 10,
  COMMERCIAL_RANKING: 12,
  KEYWORD_OWNERSHIP: 12,
  TOPIC_GAP: 8,
  CTR: 10,
  CONTENT_REFRESH: 10,
};

export const DEFAULT_MAX_PER_TYPE = 10;

/** A topic needs this many keywords before thin coverage is a finding. */
export const MIN_TOPIC_KEYWORDS = 3;

/** Clicks must fall by at least this share before a refresh is suggested. */
export const REFRESH_DECLINE = 0.2;

type EffortChoice = { effort: EffortLevel; basis: string };

const EFFORT: Record<OpportunityType, EffortChoice> = {
  COMMERCIAL_RANKING: {
    effort: "MEDIUM",
    basis: "A page already exists and ranks; the work is improving it.",
  },
  KEYWORD_OWNERSHIP: {
    effort: "MEDIUM",
    basis: "Both pages exist; the work is deciding and consolidating intent.",
  },
  CTR: {
    effort: "LOW",
    basis: "Title and description changes on a page that already ranks.",
  },
  TOPIC_GAP: {
    effort: "HIGH",
    basis: "Covering a topic properly means new pages, not edits.",
  },
  COMPETITOR_GAP: {
    effort: "HIGH",
    basis: "Nothing of ours ranks for this yet.",
  },
  CONTENT_REFRESH: {
    effort: "MEDIUM",
    basis: "An existing page with an existing audience.",
  },
  NO_OWNING_PAGE: {
    effort: "HIGH",
    basis: "No page is nominated to own this keyword.",
  },
  KEYWORD_GAP: { effort: "HIGH", basis: "Nothing of ours ranks for this yet." },
  WEAK_OWNING_PAGE: {
    effort: "MEDIUM",
    basis: "The owning page exists but ranks poorly.",
  },
  RANKING_URL_DIVERGENCE: {
    effort: "MEDIUM",
    basis: "Both pages exist; the work is deciding which should rank.",
  },
};

function scoreFor(
  type: OpportunityType,
  fact: {
    businessRelevance: number | null;
    commercialValue: number | null;
    intent: string;
    intentKnown: boolean;
    searchVolume: number | null;
    position: number | null;
    competitorsAhead: number;
    competitorsRanking: number;
    isCommercialDestination: boolean;
    businessGoalId: string | null;
    evidenceCount: number;
    freshnessDays: number | null;
    providersDisagree: boolean;
  },
): { scoring: ScoreResult; confidence: ConfidenceLevel } {
  const confidence = scoreConfidence({
    evidenceCount: fact.evidenceCount,
    freshnessDays: fact.freshnessDays,
    providersDisagree: fact.providersDisagree,
  });

  const scoring = assemble([
    scoreBusinessRelevance({
      businessRelevance: fact.businessRelevance,
      linkedGoal: fact.businessGoalId !== null,
    }),
    scoreIntentMatch({ intent: fact.intent, intentKnown: fact.intentKnown }),
    scoreCommercialImportance({
      commercialValue: fact.commercialValue,
      isCommercialDestination: fact.isCommercialDestination,
    }),
    scoreSearchDemand({ searchVolume: fact.searchVolume }),
    scoreCurrentVisibility({ position: fact.position }),
    scoreCompetitiveGap({
      competitorsAhead: fact.competitorsAhead,
      competitorsRanking: fact.competitorsRanking,
    }),
    confidence.subScore,
    scoreEffort(EFFORT[type]),
  ]);

  return { scoring, confidence: confidence.level };
}

const isCommercialIntent = (intent: string) =>
  intent === "COMMERCIAL" || intent === "TRANSACTIONAL";

export type DetectionResult = {
  opportunities: DetectedOpportunity[];
  /**
   * Everything the rules found, before the cap.
   *
   * The caller needs this to tell two very different absences apart: an
   * opportunity missing because its condition is gone, which should be closed,
   * and one missing because the cap held it back, which should not.
   */
  all: DetectedOpportunity[];
  /** What each rule found before the cap, so the true figure is never lost. */
  totalsByType: Partial<Record<OpportunityType, number>>;
};

export function detectOpportunities(input: DetectionInput): DetectionResult {
  const found: DetectedOpportunity[] = [];

  for (const keyword of input.keywords) {
    found.push(...keywordOpportunities(keyword));
  }

  for (const topic of input.topics) {
    const opportunity = topicGap(topic);
    if (opportunity) found.push(opportunity);
  }

  for (const signal of input.signals) {
    const opportunity = ctrOpportunity(signal);
    if (opportunity) found.push(opportunity);
  }

  for (const page of input.decliningPages) {
    const opportunity = refreshOpportunity(page);
    if (opportunity) found.push(opportunity);
  }

  const totalsByType = found.reduce<Partial<Record<OpportunityType, number>>>(
    (totals, opportunity) => {
      totals[opportunity.type] = (totals[opportunity.type] ?? 0) + 1;
      return totals;
    },
    {},
  );

  const ranked = found.sort((a, b) => b.scoring.score - a.scoring.score);
  const kept: DetectedOpportunity[] = [];
  const seen: Partial<Record<OpportunityType, number>> = {};

  // Highest-scoring first, so a cap keeps the best of each type rather than
  // whichever the loops happened to reach first.
  for (const opportunity of ranked) {
    const count = seen[opportunity.type] ?? 0;
    const limit = MAX_PER_TYPE[opportunity.type] ?? DEFAULT_MAX_PER_TYPE;

    if (count >= limit) continue;

    seen[opportunity.type] = count + 1;
    kept.push(opportunity);
  }

  return { opportunities: kept, all: ranked, totalsByType };
}

/** The identity an opportunity collides with itself on. */
export function identityOf(opportunity: DetectedOpportunity): string {
  return [
    opportunity.type,
    opportunity.keywordId ?? "",
    opportunity.pageId ?? "",
    opportunity.topicId ?? "",
    opportunity.competitorId ?? "",
  ].join("|");
}

function keywordOpportunities(keyword: KeywordFact): DetectedOpportunity[] {
  const found: DetectedOpportunity[] = [];

  const common = {
    businessRelevance: keyword.businessRelevance,
    commercialValue: keyword.commercialValue,
    intent: keyword.intent,
    intentKnown: keyword.intentKnown,
    searchVolume: keyword.searchVolume,
    position: keyword.position,
    competitorsAhead: keyword.competitorsAhead,
    competitorsRanking: keyword.competitorsRanking,
    isCommercialDestination: keyword.isCommercialDestination,
    businessGoalId: keyword.businessGoalId,
    freshnessDays: keyword.freshnessDays,
    providersDisagree: keyword.providersDisagree,
  };

  const keywordEvidence: EvidenceDraft[] = [
    {
      evidenceType: "KEYWORD_METRIC",
      sourceEntityType: "Keyword",
      sourceEntityId: keyword.keywordId,
      metricKey: "search_volume",
      numericValue: keyword.searchVolume,
      textValue: null,
    },
  ];

  if (keyword.position !== null) {
    keywordEvidence.push({
      evidenceType: "RANKING_OBSERVATION",
      sourceEntityType: "Keyword",
      sourceEntityId: keyword.keywordId,
      metricKey: "position",
      numericValue: keyword.position,
      textValue: keyword.rankingPath,
    });
  }

  // A commercial keyword ranking just off the first page, with a page already
  // behind it. The highest-value shape in the queue: the work is improving
  // something that exists rather than creating something that does not.
  if (
    keyword.position !== null &&
    keyword.position > 3 &&
    keyword.position <= BANDS.STRIKING_DISTANCE &&
    isCommercialIntent(keyword.intent) &&
    keyword.ownerPageId !== null
  ) {
    const { scoring, confidence } = scoreFor("COMMERCIAL_RANKING", {
      ...common,
      evidenceCount: keywordEvidence.length,
    });

    found.push({
      type: "COMMERCIAL_RANKING",
      title: `Commercial keyword at position ${keyword.position}: ${keyword.keyword}`,
      summary: `${keyword.keyword} has ${keyword.intent.toLowerCase()} intent and ranks at position ${keyword.position}. ${keyword.ownerPath ?? "The owning page"} is nominated to own it.`,
      keywordId: keyword.keywordId,
      pageId: keyword.ownerPageId,
      topicId: keyword.topicId,
      competitorId: null,
      businessGoalId: keyword.businessGoalId,
      sourceSignalId: null,
      effort: EFFORT.COMMERCIAL_RANKING.effort,
      confidence,
      expectedEffectDescription:
        "Improving a page already ranking near the first page is where movement is most achievable.",
      scoring,
      evidence: keywordEvidence,
    });
  }

  // The page nominated to own the keyword is not the page ranking for it.
  if (
    keyword.ownerPageId !== null &&
    keyword.rankingPageId !== null &&
    keyword.rankingPageId !== keyword.ownerPageId
  ) {
    const evidence: EvidenceDraft[] = [
      ...keywordEvidence,
      {
        evidenceType: "OWNERSHIP_STATE",
        sourceEntityType: "Page",
        sourceEntityId: keyword.ownerPageId,
        metricKey: "intended_owner",
        numericValue: null,
        textValue: keyword.ownerPath,
      },
      {
        evidenceType: "RANKING_OBSERVATION",
        sourceEntityType: "Page",
        sourceEntityId: keyword.rankingPageId,
        metricKey: "ranking_page",
        numericValue: keyword.position,
        textValue: keyword.rankingPath,
      },
    ];

    const { scoring, confidence } = scoreFor("KEYWORD_OWNERSHIP", {
      ...common,
      evidenceCount: evidence.length,
    });

    found.push({
      type: "KEYWORD_OWNERSHIP",
      title: `Ranking page differs from the intended owner: ${keyword.keyword}`,
      // Observation, not diagnosis. What ranked, and what was meant to.
      summary: `The intended owner is ${keyword.ownerPath ?? "a nominated page"}, and ${keyword.rankingPath ?? "another page"} ranked for this keyword in the latest snapshot.`,
      keywordId: keyword.keywordId,
      pageId: keyword.ownerPageId,
      topicId: keyword.topicId,
      competitorId: null,
      businessGoalId: keyword.businessGoalId,
      sourceSignalId: null,
      effort: EFFORT.KEYWORD_OWNERSHIP.effort,
      confidence,
      expectedEffectDescription:
        "Deciding which page should serve this keyword removes an ambiguity, whatever the current effect of that ambiguity is.",
      scoring,
      evidence,
    });
  }

  // Real demand and nobody has said which page should serve it.
  if (
    keyword.ownerPageId === null &&
    keyword.searchVolume !== null &&
    keyword.searchVolume >= MIN_DEMAND_FOR_NEW_PAGE
  ) {
    const { scoring, confidence } = scoreFor("NO_OWNING_PAGE", {
      ...common,
      evidenceCount: keywordEvidence.length,
    });

    found.push({
      type: "NO_OWNING_PAGE",
      title: `No page owns: ${keyword.keyword}`,
      summary: `${keyword.searchVolume.toLocaleString("en-GB")} monthly searches are reported for this keyword, and no page has been nominated to own it.`,
      keywordId: keyword.keywordId,
      pageId: null,
      topicId: keyword.topicId,
      competitorId: null,
      businessGoalId: keyword.businessGoalId,
      sourceSignalId: null,
      effort: EFFORT.NO_OWNING_PAGE.effort,
      confidence,
      expectedEffectDescription:
        "A keyword with demand and no nominated page has nothing working on it.",
      scoring,
      evidence: keywordEvidence,
    });
  }

  // Competitors rank and we do not.
  if (keyword.competitorsRanking > 0 && keyword.position === null) {
    const evidence: EvidenceDraft[] = [
      ...keywordEvidence,
      {
        evidenceType: "COMPETITOR_OVERLAP",
        sourceEntityType: "Keyword",
        sourceEntityId: keyword.keywordId,
        metricKey: "competitors_ranking",
        numericValue: keyword.competitorsRanking,
        textValue: null,
      },
    ];

    const { scoring, confidence } = scoreFor("COMPETITOR_GAP", {
      ...common,
      evidenceCount: evidence.length,
    });

    found.push({
      type: "COMPETITOR_GAP",
      title: `Competitors rank and this site does not: ${keyword.keyword}`,
      summary: `${keyword.competitorsRanking} tracked competitor${keyword.competitorsRanking === 1 ? "" : "s"} appear for this keyword, according to a third-party provider. No ranking has been recorded for this site.`,
      keywordId: keyword.keywordId,
      pageId: null,
      topicId: keyword.topicId,
      competitorId: null,
      businessGoalId: keyword.businessGoalId,
      sourceSignalId: null,
      effort: EFFORT.COMPETITOR_GAP.effort,
      confidence,
      expectedEffectDescription:
        "A keyword others appear for and this site does not is unclaimed ground.",
      scoring,
      evidence,
    });
  }

  return found;
}

function topicGap(topic: TopicFact): DetectedOpportunity | null {
  const thin = topic.coverage === "UNMAPPED" || topic.coverage === "PARTIAL";

  if (!thin || topic.keywordCount < MIN_TOPIC_KEYWORDS || topic.keywordsWithDemand === 0) {
    return null;
  }

  const evidence: EvidenceDraft[] = [
    {
      evidenceType: "THRESHOLD",
      sourceEntityType: "Topic",
      sourceEntityId: topic.topicId,
      metricKey: "coverage",
      numericValue: topic.pageCount,
      textValue: topic.coverage,
    },
    {
      evidenceType: "KEYWORD_METRIC",
      sourceEntityType: "Topic",
      sourceEntityId: topic.topicId,
      metricKey: "keywords_with_demand",
      numericValue: topic.keywordsWithDemand,
      textValue: null,
    },
  ];

  const { scoring, confidence } = scoreFor("TOPIC_GAP", {
    businessRelevance: null,
    commercialValue: null,
    intent: "UNKNOWN",
    intentKnown: false,
    searchVolume: topic.totalVolume,
    position: null,
    competitorsAhead: 0,
    competitorsRanking: 0,
    isCommercialDestination: false,
    businessGoalId: topic.businessGoalId,
    evidenceCount: evidence.length,
    freshnessDays: null,
    providersDisagree: false,
  });

  return {
    type: "TOPIC_GAP",
    title: `Thin coverage: ${topic.topicName}`,
    summary: `${topic.keywordCount} keywords are mapped to this topic across ${topic.pageCount} page${topic.pageCount === 1 ? "" : "s"}, and ${topic.keywordsWithDemand} of them have reported demand.`,
    keywordId: null,
    pageId: null,
    topicId: topic.topicId,
    competitorId: null,
    businessGoalId: topic.businessGoalId,
    sourceSignalId: null,
    effort: EFFORT.TOPIC_GAP.effort,
    confidence,
    expectedEffectDescription:
      "A topic with more keywords than pages has demand it is not set up to serve.",
    scoring,
    evidence,
  };
}

/**
 * A P1 signal promoted to a P2 opportunity.
 *
 * The demo moment worth having: something observed in the first-party data last
 * phase becomes a piece of prioritized work in this one, carrying its original
 * signal as evidence.
 */
function ctrOpportunity(signal: SignalFact): DetectedOpportunity | null {
  if (signal.type !== "CTR_OPPORTUNITY") return null;

  const evidence: EvidenceDraft[] = [
    {
      evidenceType: "METRIC_COMPARISON",
      sourceEntityType: "Signal",
      sourceEntityId: signal.signalId,
      metricKey: "impressions",
      numericValue: signal.impressions,
      textValue: signal.pagePath,
    },
    {
      evidenceType: "METRIC_COMPARISON",
      sourceEntityType: "Signal",
      sourceEntityId: signal.signalId,
      metricKey: "ctr",
      numericValue: signal.ctr,
      textValue: null,
    },
  ];

  const { scoring, confidence } = scoreFor("CTR", {
    businessRelevance: null,
    commercialValue: null,
    intent: "UNKNOWN",
    intentKnown: false,
    searchVolume: signal.impressions,
    position: null,
    competitorsAhead: 0,
    competitorsRanking: 0,
    isCommercialDestination: false,
    businessGoalId: signal.businessGoalId,
    evidenceCount: evidence.length,
    freshnessDays: 0,
    providersDisagree: false,
  });

  return {
    type: "CTR",
    title: `Impressions without clicks: ${signal.pagePath ?? "a page"}`,
    summary: `Search Console reported ${signal.impressions?.toLocaleString("en-GB") ?? "impressions"} impressions for this page at a click-through rate of ${signal.ctr === null ? "an unreported rate" : `${(signal.ctr * 100).toFixed(1)}%`}.`,
    keywordId: signal.keywordId,
    pageId: signal.pageId,
    topicId: null,
    competitorId: null,
    businessGoalId: signal.businessGoalId,
    sourceSignalId: signal.signalId,
    effort: EFFORT.CTR.effort,
    confidence,
    expectedEffectDescription:
      "A page seen often and clicked rarely has an audience it is already reaching.",
    scoring,
    evidence,
  };
}

function refreshOpportunity(page: PageDeclineFact): DetectedOpportunity | null {
  if (page.previousClicks === 0) return null;

  const decline = (page.previousClicks - page.currentClicks) / page.previousClicks;

  if (decline < REFRESH_DECLINE) return null;

  const evidence: EvidenceDraft[] = [
    {
      evidenceType: "METRIC_COMPARISON",
      sourceEntityType: "Page",
      sourceEntityId: page.pageId,
      metricKey: "clicks",
      numericValue: page.currentClicks,
      textValue: page.path,
    },
    {
      evidenceType: "KEYWORD_METRIC",
      sourceEntityType: "Page",
      sourceEntityId: page.pageId,
      metricKey: "search_volume",
      numericValue: page.searchVolume,
      textValue: null,
    },
  ];

  const { scoring, confidence } = scoreFor("CONTENT_REFRESH", {
    businessRelevance: null,
    commercialValue: null,
    intent: "UNKNOWN",
    intentKnown: false,
    searchVolume: page.searchVolume,
    position: null,
    competitorsAhead: 0,
    competitorsRanking: 0,
    isCommercialDestination: false,
    businessGoalId: page.businessGoalId,
    evidenceCount: evidence.length,
    freshnessDays: 0,
    providersDisagree: false,
  });

  return {
    type: "CONTENT_REFRESH",
    title: `Clicks down while demand holds: ${page.path}`,
    // States both measurements and connects them to nothing.
    summary: `Clicks fell from ${page.previousClicks.toLocaleString("en-GB")} to ${page.currentClicks.toLocaleString("en-GB")} between the two periods, a decrease of ${(decline * 100).toFixed(1)}%.`,
    keywordId: page.keywordId,
    pageId: page.pageId,
    topicId: null,
    competitorId: null,
    businessGoalId: page.businessGoalId,
    sourceSignalId: null,
    effort: EFFORT.CONTENT_REFRESH.effort,
    confidence,
    expectedEffectDescription:
      "A page that used to earn more clicks than it does now still has the audience that found it.",
    scoring,
    evidence,
  };
}
