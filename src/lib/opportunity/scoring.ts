import type {
  ConfidenceLevel,
  EffortLevel,
  OpportunityPriority,
} from "@/generated/prisma/client";

/**
 * Opportunity scoring (docs/P2_SPEC.md §20).
 *
 * P2's release rule adds a fourth blocking item to the usual three, and this
 * module is the whole of it: "Hidden/untraceable priority scoring = P2 FAIL."
 *
 * That requirement is stronger than it first sounds. It is not enough for the
 * weights to be visible in source — the queue must be explicable months later, by
 * somebody who was not here, from what the database holds. So every score stores
 * the eight sub-scores that produced it *and the sentence explaining each*, and
 * `rescore` can rebuild the total from that stored record alone. If the two ever
 * disagree, the stored record wins, because it is what the person saw.
 *
 * The number is a prioritization heuristic. It is not a prediction, it does not
 * estimate traffic, and nothing downstream is allowed to imply otherwise.
 */

export const SCORING_MODEL_VERSION = "opportunity-scoring-v1";

/**
 * Weights, as data.
 *
 * §20 lists eight criteria but gives weights for only seven — competitive gap has
 * none. Rather than drop a criterion to match an incomplete example, it is
 * weighted 2: it is one of the inputs that distinguishes P2 from a keyword tool,
 * and the omission reads as an oversight rather than an intention.
 */
export const WEIGHTS = {
  businessRelevance: 3,
  intentMatch: 3,
  commercialImportance: 3,
  searchDemand: 2,
  currentVisibility: 2,
  competitiveGap: 2,
  confidence: 2,
  effortInverse: 1,
} as const;

export type ScoreKey = keyof typeof WEIGHTS;

/** Each criterion is scored 0–5 before weighting. */
export const MAX_CRITERION = 5;

export const MAX_RAW = Object.values(WEIGHTS).reduce((total, weight) => total + weight, 0) *
  MAX_CRITERION;

/** Where each priority band begins, on the normalised 0–100 scale. */
export const PRIORITY_BANDS = {
  CRITICAL: 80,
  HIGH: 65,
  MEDIUM: 45,
} as const;

export const CRITERION_LABELS: Record<ScoreKey, string> = {
  businessRelevance: "Business relevance",
  intentMatch: "Intent match",
  commercialImportance: "Commercial importance",
  searchDemand: "Search demand",
  currentVisibility: "Current visibility",
  competitiveGap: "Competitive gap",
  confidence: "Confidence",
  effortInverse: "Effort (inverse)",
};

export type SubScore = {
  key: ScoreKey;
  label: string;
  /** 0–5. */
  score: number;
  weight: number;
  /** Why this score, in words. Stored, not recomputed at render time. */
  basis: string;
};

export type ScoreResult = {
  /** 0–100. */
  score: number;
  raw: number;
  maxRaw: number;
  priority: OpportunityPriority;
  modelVersion: string;
  subScores: SubScore[];
};

function clamp(value: number): number {
  return Math.max(0, Math.min(MAX_CRITERION, value));
}

export function priorityFor(score: number): OpportunityPriority {
  if (score >= PRIORITY_BANDS.CRITICAL) return "CRITICAL";
  if (score >= PRIORITY_BANDS.HIGH) return "HIGH";
  if (score >= PRIORITY_BANDS.MEDIUM) return "MEDIUM";
  return "LOW";
}

/**
 * Rebuilds the total from stored sub-scores.
 *
 * This is the function that makes the release rule true rather than aspirational:
 * given only what was written to the database, the score comes back. A test
 * asserts it matches what was stored at detection time.
 */
export function rescore(subScores: Pick<SubScore, "score" | "weight">[]): {
  score: number;
  raw: number;
} {
  const raw = subScores.reduce(
    (total, entry) => total + clamp(entry.score) * entry.weight,
    0,
  );
  const maxRaw = subScores.reduce(
    (total, entry) => total + MAX_CRITERION * entry.weight,
    0,
  );

  return {
    raw,
    score: maxRaw === 0 ? 0 : Math.round((raw / maxRaw) * 1000) / 10,
  };
}

export function assemble(subScores: SubScore[]): ScoreResult {
  const { score, raw } = rescore(subScores);

  return {
    score,
    raw,
    maxRaw: MAX_RAW,
    priority: priorityFor(score),
    modelVersion: SCORING_MODEL_VERSION,
    subScores,
  };
}

/* ------------------------------------------------------------------ */
/* Criterion derivation                                                */
/* ------------------------------------------------------------------ */

/**
 * Business relevance.
 *
 * The one input only a person can supply. When nobody has set it the score is a
 * neutral 2 and the basis says so, rather than a confident number derived from
 * nothing — the difference matters, because this criterion carries the joint
 * heaviest weight.
 */
export function scoreBusinessRelevance(input: {
  businessRelevance: number | null;
  linkedGoal: boolean;
}): SubScore {
  if (input.businessRelevance !== null) {
    const bonus = input.linkedGoal ? 1 : 0;

    return {
      key: "businessRelevance",
      label: CRITERION_LABELS.businessRelevance,
      score: clamp(input.businessRelevance + bonus),
      weight: WEIGHTS.businessRelevance,
      basis: input.linkedGoal
        ? `Set to ${input.businessRelevance} by your team, and linked to a business goal.`
        : `Set to ${input.businessRelevance} by your team.`,
    };
  }

  return {
    key: "businessRelevance",
    label: CRITERION_LABELS.businessRelevance,
    score: input.linkedGoal ? 3 : 2,
    weight: WEIGHTS.businessRelevance,
    basis: input.linkedGoal
      ? "Nobody has rated this keyword; it is linked to a business goal."
      : "Nobody has rated this keyword yet.",
  };
}

const INTENT_SCORES: Record<string, number> = {
  TRANSACTIONAL: 5,
  COMMERCIAL: 4,
  LOCAL: 3,
  MIXED: 2,
  NAVIGATIONAL: 1,
  INFORMATIONAL: 2,
  UNKNOWN: 2,
};

export function scoreIntentMatch(input: { intent: string; intentKnown: boolean }): SubScore {
  return {
    key: "intentMatch",
    label: CRITERION_LABELS.intentMatch,
    score: clamp(INTENT_SCORES[input.intent] ?? 2),
    weight: WEIGHTS.intentMatch,
    basis: input.intentKnown
      ? `Intent recorded as ${input.intent.toLowerCase()}.`
      : "Intent has not been established; scored neutrally.",
  };
}

export function scoreCommercialImportance(input: {
  commercialValue: number | null;
  isCommercialDestination: boolean;
}): SubScore {
  if (input.commercialValue !== null) {
    return {
      key: "commercialImportance",
      label: CRITERION_LABELS.commercialImportance,
      score: clamp(input.commercialValue),
      weight: WEIGHTS.commercialImportance,
      basis: `Commercial value set to ${input.commercialValue} by your team.`,
    };
  }

  return {
    key: "commercialImportance",
    label: CRITERION_LABELS.commercialImportance,
    score: input.isCommercialDestination ? 4 : 2,
    weight: WEIGHTS.commercialImportance,
    basis: input.isCommercialDestination
      ? "The page involved is a topic's commercial destination."
      : "No commercial value recorded; scored neutrally.",
  };
}

/** Volume bands. Deliberately coarse: a band is honest, a curve would not be. */
export const DEMAND_BANDS = [
  { min: 5000, score: 5 },
  { min: 1500, score: 4 },
  { min: 500, score: 3 },
  { min: 100, score: 2 },
  { min: 1, score: 1 },
] as const;

export function scoreSearchDemand(input: { searchVolume: number | null }): SubScore {
  if (input.searchVolume === null) {
    return {
      key: "searchDemand",
      label: CRITERION_LABELS.searchDemand,
      score: 2,
      weight: WEIGHTS.searchDemand,
      // Not zero: no volume data is an absence of evidence, and scoring it as
      // zero demand would bury every keyword no provider has measured.
      basis: "No provider has reported search volume; scored neutrally.",
    };
  }

  const band = DEMAND_BANDS.find((entry) => input.searchVolume! >= entry.min);

  return {
    key: "searchDemand",
    label: CRITERION_LABELS.searchDemand,
    score: band?.score ?? 0,
    weight: WEIGHTS.searchDemand,
    basis: `Search volume reported as ${input.searchVolume.toLocaleString("en-GB")}.`,
  };
}

/**
 * Current visibility, scored as headroom rather than success.
 *
 * A keyword already at position 2 scores low here — not because ranking second is
 * bad, but because there is little left to gain. Position 11 scores highest: on
 * the edge of the first page is where work pays.
 */
export function scoreCurrentVisibility(input: { position: number | null }): SubScore {
  const { position } = input;

  if (position === null) {
    return {
      key: "currentVisibility",
      label: CRITERION_LABELS.currentVisibility,
      score: 3,
      weight: WEIGHTS.currentVisibility,
      basis: "Not currently ranking, so there is everything to gain and no foothold.",
    };
  }

  let score: number;
  if (position <= 3) score = 1;
  else if (position <= 10) score = 3;
  else if (position <= 20) score = 5;
  else if (position <= 30) score = 4;
  else score = 2;

  return {
    key: "currentVisibility",
    label: CRITERION_LABELS.currentVisibility,
    score,
    weight: WEIGHTS.currentVisibility,
    basis: `Currently at position ${position}; scored on how much is left to gain.`,
  };
}

export function scoreCompetitiveGap(input: {
  competitorsAhead: number;
  competitorsRanking: number;
}): SubScore {
  if (input.competitorsRanking === 0) {
    return {
      key: "competitiveGap",
      label: CRITERION_LABELS.competitiveGap,
      score: 2,
      weight: WEIGHTS.competitiveGap,
      basis: "No competitor evidence for this keyword.",
    };
  }

  const score = clamp(1 + input.competitorsAhead * 2);

  return {
    key: "competitiveGap",
    label: CRITERION_LABELS.competitiveGap,
    score,
    weight: WEIGHTS.competitiveGap,
    basis: `${input.competitorsAhead} of ${input.competitorsRanking} tracked competitors rank above this site.`,
  };
}

export const CONFIDENCE_SCORES: Record<ConfidenceLevel, number> = {
  HIGH: 5,
  MEDIUM: 3,
  LOW: 1,
  UNKNOWN: 2,
};

/**
 * Confidence in the evidence, not in the outcome.
 *
 * Built from how much evidence there is, how recent it is, and whether the
 * providers agree. Two vendors disagreeing sharply lowers confidence rather than
 * being averaged away.
 */
export function scoreConfidence(input: {
  evidenceCount: number;
  freshnessDays: number | null;
  providersDisagree: boolean;
}): { subScore: SubScore; level: ConfidenceLevel } {
  let points = 0;

  if (input.evidenceCount >= 3) points += 2;
  else if (input.evidenceCount >= 1) points += 1;

  if (input.freshnessDays !== null && input.freshnessDays <= 14) points += 2;
  else if (input.freshnessDays !== null && input.freshnessDays <= 45) points += 1;

  if (input.providersDisagree) points -= 1;

  const score = clamp(Math.max(1, points));
  const level: ConfidenceLevel = score >= 4 ? "HIGH" : score >= 3 ? "MEDIUM" : "LOW";

  const reasons = [
    `${input.evidenceCount} piece${input.evidenceCount === 1 ? "" : "s"} of evidence`,
    input.freshnessDays === null
      ? "no capture date"
      : `newest evidence ${input.freshnessDays} day${input.freshnessDays === 1 ? "" : "s"} old`,
    input.providersDisagree ? "providers disagree materially" : "providers broadly agree",
  ];

  return {
    subScore: {
      key: "confidence",
      label: CRITERION_LABELS.confidence,
      score,
      weight: WEIGHTS.confidence,
      basis: `${reasons.join("; ")}.`,
    },
    level,
  };
}

export const EFFORT_SCORES: Record<EffortLevel, number> = {
  LOW: 5,
  MEDIUM: 3,
  HIGH: 1,
  UNKNOWN: 2,
};

export function scoreEffort(input: { effort: EffortLevel; basis: string }): SubScore {
  return {
    key: "effortInverse",
    label: CRITERION_LABELS.effortInverse,
    score: EFFORT_SCORES[input.effort],
    weight: WEIGHTS.effortInverse,
    basis: input.basis,
  };
}

/** Shown wherever a score appears. The spec's wording, kept verbatim in spirit. */
export const SCORE_CAVEAT =
  "Prioritization heuristic — not a traffic forecast. The score ranks work against other work; it does not predict an outcome.";
