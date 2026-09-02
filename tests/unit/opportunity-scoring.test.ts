import { describe, expect, it } from "vitest";

import {
  MAX_CRITERION,
  MAX_RAW,
  PRIORITY_BANDS,
  SCORE_CAVEAT,
  SCORING_MODEL_VERSION,
  WEIGHTS,
  assemble,
  priorityFor,
  rescore,
  scoreBusinessRelevance,
  scoreConfidence,
  scoreCurrentVisibility,
  scoreSearchDemand,
} from "@/lib/opportunity/scoring";
import {
  MAX_PER_TYPE,
  MIN_DEMAND_FOR_NEW_PAGE,
  detectOpportunities,
  type KeywordFact,
} from "@/lib/opportunity/rules";
import { CAUSAL_VOCABULARY, PRESCRIPTIVE_VOCABULARY } from "@/lib/signals/templates";
import { DIAGNOSTIC_VOCABULARY } from "@/lib/ownership/templates";

function keyword(overrides: Partial<KeywordFact> = {}): KeywordFact {
  return {
    keywordId: "kw-1",
    keyword: "payroll software philippines",
    intent: "COMMERCIAL",
    intentKnown: true,
    businessRelevance: 4,
    commercialValue: 4,
    searchVolume: 2400,
    providersDisagree: false,
    position: 11,
    freshnessDays: 3,
    ownerPageId: "page-owner",
    ownerPath: "/payroll-software",
    rankingPageId: "page-owner",
    rankingPath: "/payroll-software",
    distinctRankingPages: 1,
    topicId: "topic-1",
    topicName: "Payroll",
    isCommercialDestination: true,
    competitorsRanking: 2,
    competitorsAhead: 1,
    businessGoalId: "goal-1",
    ...overrides,
  };
}

/**
 * "Hidden/untraceable priority scoring = P2 FAIL."
 *
 * The requirement is not that the weights are visible in source — it is that the
 * queue can be explained months later, by somebody who was not here, from what the
 * database holds. These tests hold the code to that reading.
 */
describe("a score can be rebuilt from what was stored", () => {
  it("reproduces the total from the sub-scores alone", () => {
    const { opportunities } = detectOpportunities({
      keywords: [keyword()],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    expect(opportunities[0]).toBeDefined();

    // Nothing but the stored breakdown goes in.
    const rebuilt = rescore(opportunities[0]!.scoring.subScores);

    expect(rebuilt.score).toBe(opportunities[0]!.scoring.score);
    expect(rebuilt.raw).toBe(opportunities[0]!.scoring.raw);
  });

  it("stores a reason for every criterion", () => {
    const { opportunities } = detectOpportunities({
      keywords: [keyword()],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    for (const subScore of opportunities[0]!.scoring.subScores) {
      // A number with no sentence beside it is exactly what the rule forbids.
      expect(subScore.basis.length).toBeGreaterThan(0);
      expect(subScore.label.length).toBeGreaterThan(0);
      expect(subScore.score).toBeGreaterThanOrEqual(0);
      expect(subScore.score).toBeLessThanOrEqual(MAX_CRITERION);
    }
  });

  it("scores all eight criteria, including the one the spec left unweighted", () => {
    const { opportunities } = detectOpportunities({
      keywords: [keyword()],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    const keys = opportunities[0]!.scoring.subScores.map((entry) => entry.key).sort();

    expect(keys).toEqual(Object.keys(WEIGHTS).sort());
    expect(keys).toContain("competitiveGap");
  });

  it("carries the model version, so a reweighting does not rewrite history", () => {
    const { opportunities } = detectOpportunities({
      keywords: [keyword()],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    expect(opportunities[0]!.scoring.modelVersion).toBe(SCORING_MODEL_VERSION);
  });

  it("is deterministic", () => {
    const facts = { keywords: [keyword()], topics: [], signals: [], decliningPages: [] };

    const first = detectOpportunities(facts);
    const second = detectOpportunities(facts);

    expect(second.opportunities.map((o) => o.scoring.score)).toEqual(
      first.opportunities.map((o) => o.scoring.score),
    );
    expect(second.opportunities.map((o) => o.type)).toEqual(
      first.opportunities.map((o) => o.type),
    );
  });
});

describe("bands", () => {
  it("maps a score to a priority at the documented thresholds", () => {
    expect(priorityFor(PRIORITY_BANDS.CRITICAL)).toBe("CRITICAL");
    expect(priorityFor(PRIORITY_BANDS.CRITICAL - 0.1)).toBe("HIGH");
    expect(priorityFor(PRIORITY_BANDS.HIGH)).toBe("HIGH");
    expect(priorityFor(PRIORITY_BANDS.MEDIUM)).toBe("MEDIUM");
    expect(priorityFor(PRIORITY_BANDS.MEDIUM - 0.1)).toBe("LOW");
  });

  it("normalises to 0–100", () => {
    const perfect = Object.entries(WEIGHTS).map(([key, weight]) => ({
      key: key as keyof typeof WEIGHTS,
      label: key,
      score: MAX_CRITERION,
      weight,
      basis: "maximum",
    }));

    const result = assemble(perfect);

    expect(result.score).toBe(100);
    expect(result.raw).toBe(MAX_RAW);
    expect(result.priority).toBe("CRITICAL");
  });
});

describe("criteria that could quietly lie", () => {
  it("does not invent a business relevance nobody set", () => {
    // This criterion carries the joint heaviest weight; a confident number
    // derived from nothing would move the whole queue.
    const unrated = scoreBusinessRelevance({ businessRelevance: null, linkedGoal: false });

    expect(unrated.score).toBe(2);
    expect(unrated.basis).toMatch(/nobody has rated/i);

    const rated = scoreBusinessRelevance({ businessRelevance: 5, linkedGoal: false });
    expect(rated.basis).toMatch(/set to 5 by your team/i);
  });

  it("treats missing volume as unknown rather than as no demand", () => {
    const missing = scoreSearchDemand({ searchVolume: null });
    const zero = scoreSearchDemand({ searchVolume: 0 });

    // Scoring an unmeasured keyword as zero demand would bury everything no
    // provider happens to cover.
    expect(missing.score).toBe(2);
    expect(missing.basis).toMatch(/no provider/i);
    expect(zero.score).toBe(0);
  });

  it("scores visibility as headroom, not as success", () => {
    const second = scoreCurrentVisibility({ position: 2 });
    const eleventh = scoreCurrentVisibility({ position: 11 });

    // Position 2 is a good place to be and a poor place to spend effort.
    expect(eleventh.score).toBeGreaterThan(second.score);
  });

  it("lowers confidence when providers disagree", () => {
    const agreeing = scoreConfidence({
      evidenceCount: 3,
      freshnessDays: 2,
      providersDisagree: false,
    });
    const disagreeing = scoreConfidence({
      evidenceCount: 3,
      freshnessDays: 2,
      providersDisagree: true,
    });

    expect(disagreeing.subScore.score).toBeLessThan(agreeing.subScore.score);
    expect(disagreeing.subScore.basis).toMatch(/disagree/i);
  });

  it("lowers confidence when the evidence is old", () => {
    const fresh = scoreConfidence({
      evidenceCount: 2,
      freshnessDays: 3,
      providersDisagree: false,
    });
    const stale = scoreConfidence({
      evidenceCount: 2,
      freshnessDays: 200,
      providersDisagree: false,
    });

    expect(stale.subScore.score).toBeLessThan(fresh.subScore.score);
  });
});

/**
 * The wording rules, now three deep: no causes, no instructions, no claims that
 * pages harm each other — and no invented forecasts, which is the temptation
 * specific to a screen that ranks work by value.
 */
describe("opportunity wording", () => {
  const { opportunities: everything } = detectOpportunities({
    keywords: [
      keyword(),
      keyword({
        keywordId: "kw-2",
        rankingPageId: "page-blog",
        rankingPath: "/blog/payroll-guide",
        distinctRankingPages: 2,
      }),
      keyword({
        keywordId: "kw-3",
        ownerPageId: null,
        ownerPath: null,
        position: null,
        rankingPageId: null,
      }),
    ],
    topics: [
      {
        topicId: "topic-1",
        topicName: "Payroll",
        keywordCount: 12,
        pageCount: 1,
        coverage: "PARTIAL",
        keywordsWithDemand: 8,
        totalVolume: 9000,
        businessGoalId: null,
      },
    ],
    signals: [
      {
        signalId: "sig-1",
        type: "CTR_OPPORTUNITY",
        pageId: "page-a",
        pagePath: "/pricing",
        keywordId: null,
        impressions: 12000,
        ctr: 0.004,
        businessGoalId: null,
      },
    ],
    decliningPages: [
      {
        pageId: "page-b",
        path: "/guides/payroll",
        currentClicks: 120,
        previousClicks: 400,
        keywordId: null,
        searchVolume: 2000,
        businessGoalId: null,
      },
    ],
  });

  it("covers several types", () => {
    expect(new Set(everything.map((o) => o.type)).size).toBeGreaterThanOrEqual(5);
  });

  it("never explains why, instructs, or claims pages harm each other", () => {
    for (const opportunity of everything) {
      const text = `${opportunity.title} ${opportunity.summary} ${opportunity.expectedEffectDescription}`;

      expect(text).not.toMatch(CAUSAL_VOCABULARY);
      expect(text).not.toMatch(PRESCRIPTIVE_VOCABULARY);
      expect(text).not.toMatch(DIAGNOSTIC_VOCABULARY);
    }
  });

  it("never predicts a number of visits, rankings or revenue", () => {
    // The specific temptation of a screen that ranks work by value: "this will
    // generate 1,000 extra visits". Forbidden outright by the spec.
    const forecast =
      /\b(will (generate|bring|increase|add|earn|deliver)|expect(ed)? to (gain|generate|add)|projected|forecast|estimated (traffic|revenue|visits)|\+\s?\d+%\s*(traffic|clicks|revenue))\b/i;

    for (const opportunity of everything) {
      const text = `${opportunity.title} ${opportunity.summary} ${opportunity.expectedEffectDescription}`;
      expect(text).not.toMatch(forecast);
    }

    expect("This will generate 1,000 extra visits.").toMatch(forecast);
  });

  it("labels the score as a heuristic wherever it is shown", () => {
    expect(SCORE_CAVEAT).toMatch(/not a traffic forecast/i);
    expect(SCORE_CAVEAT).toMatch(/does not predict/i);
  });
});

describe("rules", () => {
  it("raises a commercial ranking opportunity just off page one", () => {
    const { opportunities: found } = detectOpportunities({
      keywords: [keyword({ position: 11 })],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    expect(found.map((o) => o.type)).toContain("COMMERCIAL_RANKING");
  });

  it("does not raise one for a keyword already at the top", () => {
    const { opportunities: found } = detectOpportunities({
      keywords: [keyword({ position: 2 })],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    expect(found.map((o) => o.type)).not.toContain("COMMERCIAL_RANKING");
  });

  it("does not raise one for informational intent", () => {
    const { opportunities: found } = detectOpportunities({
      keywords: [keyword({ intent: "INFORMATIONAL" })],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    expect(found.map((o) => o.type)).not.toContain("COMMERCIAL_RANKING");
  });

  it("raises ownership divergence when the ranking page is not the owner", () => {
    const { opportunities: found } = detectOpportunities({
      keywords: [keyword({ rankingPageId: "page-blog", rankingPath: "/blog/guide" })],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    const divergence = found.find((o) => o.type === "KEYWORD_OWNERSHIP");

    expect(divergence).toBeDefined();
    expect(divergence?.summary).toContain("/payroll-software");
    expect(divergence?.summary).toContain("/blog/guide");
  });

  it("ignores a topic with too few keywords to judge", () => {
    const { opportunities: found } = detectOpportunities({
      keywords: [],
      topics: [
        {
          topicId: "t",
          topicName: "Tiny",
          keywordCount: 2,
          pageCount: 0,
          coverage: "UNMAPPED",
          keywordsWithDemand: 2,
          totalVolume: 100,
          businessGoalId: null,
        },
      ],
      signals: [],
      decliningPages: [],
    });

    expect(found).toHaveLength(0);
  });

  it("ignores a page whose decline is within normal movement", () => {
    const { opportunities: found } = detectOpportunities({
      keywords: [],
      topics: [],
      signals: [],
      decliningPages: [
        {
          pageId: "p",
          path: "/steady",
          currentClicks: 95,
          previousClicks: 100,
          keywordId: null,
          searchVolume: null,
          businessGoalId: null,
        },
      ],
    });

    expect(found).toHaveLength(0);
  });

  it("returns the highest-scoring opportunity first", () => {
    const { opportunities: found } = detectOpportunities({
      keywords: [keyword(), keyword({ keywordId: "kw-low", businessRelevance: 0, commercialValue: 0, searchVolume: 10 })],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    for (let index = 1; index < found.length; index += 1) {
      expect(found[index - 1]!.scoring.score).toBeGreaterThanOrEqual(
        found[index]!.scoring.score,
      );
    }
  });
});

/**
 * Caps.
 *
 * P1 learned this with signals: 143 findings is not more useful than 12, it is
 * less, because a queue nobody can read is a queue nobody uses. The demo dataset
 * proved the same for opportunities — 85 of them, 52 of one type.
 */
describe("per-type caps", () => {
  const manyUnowned = Array.from({ length: 40 }, (_, index) =>
    keyword({
      keywordId: `kw-${index}`,
      keyword: `unowned keyword ${index}`,
      ownerPageId: null,
      ownerPath: null,
      rankingPageId: null,
      rankingPath: null,
      position: null,
      searchVolume: 1000 + index * 10,
      competitorsRanking: 0,
      competitorsAhead: 0,
    }),
  );

  it("keeps a readable number of each type", () => {
    const { opportunities } = detectOpportunities({
      keywords: manyUnowned,
      topics: [],
      signals: [],
      decliningPages: [],
    });

    const noOwner = opportunities.filter((o) => o.type === "NO_OWNING_PAGE");

    expect(noOwner.length).toBe(MAX_PER_TYPE.NO_OWNING_PAGE);
    expect(noOwner.length).toBeLessThan(manyUnowned.length);
  });

  it("reports the true count alongside, so nothing is hidden", () => {
    const { opportunities, totalsByType } = detectOpportunities({
      keywords: manyUnowned,
      topics: [],
      signals: [],
      decliningPages: [],
    });

    // A person can always see they are looking at 10 of 40.
    expect(totalsByType.NO_OWNING_PAGE).toBe(manyUnowned.length);
    expect(opportunities.filter((o) => o.type === "NO_OWNING_PAGE").length).toBeLessThan(
      totalsByType.NO_OWNING_PAGE!,
    );
  });

  it("keeps the highest-scoring of each type, not the first found", () => {
    const { opportunities } = detectOpportunities({
      keywords: manyUnowned,
      topics: [],
      signals: [],
      decliningPages: [],
    });

    const kept = opportunities.filter((o) => o.type === "NO_OWNING_PAGE");
    const scores = kept.map((o) => o.scoring.score);

    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("does not raise a new page for demand too small to justify one", () => {
    // A page is real work. Below the threshold, an unowned keyword is normal
    // rather than a finding.
    const { opportunities } = detectOpportunities({
      keywords: [
        keyword({
          ownerPageId: null,
          ownerPath: null,
          position: null,
          rankingPageId: null,
          searchVolume: MIN_DEMAND_FOR_NEW_PAGE - 1,
          competitorsRanking: 0,
        }),
      ],
      topics: [],
      signals: [],
      decliningPages: [],
    });

    expect(opportunities.map((o) => o.type)).not.toContain("NO_OWNING_PAGE");
  });
});
