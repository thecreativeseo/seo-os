/**
 * Signal detection (docs/P1_SPEC.md §14–§16).
 *
 * Signals are observations. They say what changed, for which page or query, over
 * which period, and from which numbers. They never say why.
 *
 * That restraint is the product's whole argument — an LLM can always produce a
 * plausible cause, and a plausible cause presented as a finding is worse than
 * silence because someone will act on it. Diagnosis is P3, and it is meant to be
 * evidence-controlled. So the templates in templates.ts contain no causal
 * vocabulary and a test enforces it.
 *
 * Pure and deterministic: same inputs, same signals, same order. That is what lets
 * the demo be reproducible and the thresholds be argued about with examples.
 */

export const SCORING_MODEL_VERSION = "signals-v1";

export type SignalTypeName =
  | "TRAFFIC_DECLINE"
  | "TRAFFIC_GROWTH"
  | "IMPRESSION_GROWTH"
  | "CTR_OPPORTUNITY"
  | "STRIKING_DISTANCE"
  | "PAGE_WINNER"
  | "PAGE_LOSER"
  | "QUERY_WINNER"
  | "QUERY_LOSER"
  | "DATA_FRESHNESS_RISK";

export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

export type PageInput = {
  pageId: string;
  path: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  previousClicks: number;
  previousImpressions: number;
  previousCtr: number | null;
};

export type QueryInput = {
  queryId: string;
  query: string;
  topPagePath: string | null;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  previousClicks: number;
};

export type EvidenceInput = {
  metricKey: string;
  currentValue: number | null;
  previousValue: number | null;
};

export type DetectionResult = {
  signals: DetectedSignal[];
  /**
   * How many candidates met each rule, before the per-type cap below.
   *
   * Reported separately so the interface can say "12 of 63" rather than either
   * showing an unusable list or quietly understating what was found.
   */
  totalsByType: Partial<Record<SignalTypeName, number>>;
};

export type DetectedSignal = {
  type: SignalTypeName;
  severity: Severity;
  /** Higher sorts first. Used only for ordering, never shown as a metric. */
  score: number;
  pageId?: string;
  queryId?: string;
  /** Substituted into the template. */
  subject: string;
  evidence: EvidenceInput[];
};

/**
 * Thresholds, gathered here so they can be argued about in one place.
 *
 * Every rule pairs a relative change with an absolute floor. Relative change alone
 * makes noise look like news — a page going from 2 clicks to 1 is a 50% decline
 * that nobody should be shown.
 */
/**
 * How many signals of each type are worth surfacing.
 *
 * A rule can legitimately match sixty queries; an Attention list with sixty items
 * is not attention, it is a second inbox. The cap is a presentation limit applied
 * after detection, and the true count is preserved in totalsByType so nothing is
 * hidden — only deferred to the full list.
 */
export const MAX_PER_TYPE: Partial<Record<SignalTypeName, number>> = {
  STRIKING_DISTANCE: 12,
  CTR_OPPORTUNITY: 10,
  TRAFFIC_DECLINE: 10,
  TRAFFIC_GROWTH: 10,
  IMPRESSION_GROWTH: 10,
};

export const THRESHOLDS = {
  trafficDecline: { relative: -0.25, absoluteClicks: 20 },
  trafficGrowth: { relative: 0.3, absoluteClicks: 20 },
  impressionGrowth: { relative: 0.3, minImpressions: 500 },
  ctrOpportunity: { minImpressions: 1000, belowMedianBy: 0.75 },
  strikingDistance: { minPosition: 8, maxPosition: 20, minImpressions: 100 },
  winners: { count: 3, minClicks: 25 },
  losers: { count: 3, minClicks: 25 },
  freshness: { staleAfterDays: 4 },
} as const;

function relativeChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

/** Position bands, because CTR is only comparable within one. */
export function positionBand(position: number | null): string {
  if (position === null) return "unknown";
  if (position <= 3) return "1-3";
  if (position <= 10) return "4-10";
  if (position <= 20) return "11-20";
  return "21+";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

/**
 * Severity bands are aligned with the detection thresholds above.
 *
 * A decline has to clear 25% to be detected at all, so if these bands started
 * MEDIUM at 30% then almost everything detected would be filed as LOW — the
 * severity would carry no information, and the one thing a reader looks at first
 * would be wrong. Anything that clears the detection bar is at least MEDIUM.
 */
function severityFromMagnitude(magnitude: number): Severity {
  const size = Math.abs(magnitude);
  if (size >= 0.5) return "HIGH";
  if (size >= 0.25) return "MEDIUM";
  if (size >= 0.12) return "LOW";
  return "INFO";
}

export type DetectionInput = {
  pages: PageInput[];
  queries: QueryInput[];
  /** Whole days between the latest data and now. Null when never synced. */
  freshnessDays: number | null;
  lastSyncFailed: boolean;
};

export function detectSignals(input: DetectionInput): DetectionResult {
  const candidates: DetectedSignal[] = [
    ...detectTrafficChanges(input.pages),
    ...detectImpressionGrowth(input.pages),
    ...detectCtrOpportunities(input.pages),
    ...detectStrikingDistance(input.queries),
    ...detectWinnersAndLosers(input.pages, input.queries),
    ...detectFreshnessRisk(input.freshnessDays, input.lastSyncFailed),
  ];

  // Deterministic order: severity, then score, then subject as a stable tiebreak.
  const severityRank: Record<Severity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };

  const ordered = candidates.sort((a, b) => {
    const bySeverity = severityRank[b.severity] - severityRank[a.severity];
    if (bySeverity !== 0) return bySeverity;
    if (b.score !== a.score) return b.score - a.score;
    return a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;
  });

  const totalsByType: Partial<Record<SignalTypeName, number>> = {};
  for (const signal of ordered) {
    totalsByType[signal.type] = (totalsByType[signal.type] ?? 0) + 1;
  }

  // Cap per type, keeping the highest-scoring. Because `ordered` is already sorted,
  // taking the first N of each type takes the most significant ones.
  const kept: DetectedSignal[] = [];
  const seenPerType = new Map<SignalTypeName, number>();

  for (const signal of ordered) {
    const cap = MAX_PER_TYPE[signal.type];
    const seen = seenPerType.get(signal.type) ?? 0;
    if (cap !== undefined && seen >= cap) continue;
    seenPerType.set(signal.type, seen + 1);
    kept.push(signal);
  }

  return { signals: kept, totalsByType };
}

function detectTrafficChanges(pages: PageInput[]): DetectedSignal[] {
  const signals: DetectedSignal[] = [];

  for (const page of pages) {
    const change = relativeChange(page.clicks, page.previousClicks);
    if (change === null) continue;

    const absolute = page.clicks - page.previousClicks;

    if (
      change <= THRESHOLDS.trafficDecline.relative &&
      Math.abs(absolute) >= THRESHOLDS.trafficDecline.absoluteClicks
    ) {
      signals.push({
        type: "TRAFFIC_DECLINE",
        severity: severityFromMagnitude(change),
        score: Math.abs(absolute),
        pageId: page.pageId,
        subject: page.path,
        evidence: [
          { metricKey: "clicks", currentValue: page.clicks, previousValue: page.previousClicks },
          {
            metricKey: "impressions",
            currentValue: page.impressions,
            previousValue: page.previousImpressions,
          },
          { metricKey: "ctr", currentValue: page.ctr, previousValue: page.previousCtr },
        ],
      });
      continue;
    }

    if (
      change >= THRESHOLDS.trafficGrowth.relative &&
      absolute >= THRESHOLDS.trafficGrowth.absoluteClicks
    ) {
      signals.push({
        type: "TRAFFIC_GROWTH",
        severity: severityFromMagnitude(change),
        score: absolute,
        pageId: page.pageId,
        subject: page.path,
        evidence: [
          { metricKey: "clicks", currentValue: page.clicks, previousValue: page.previousClicks },
          {
            metricKey: "impressions",
            currentValue: page.impressions,
            previousValue: page.previousImpressions,
          },
        ],
      });
    }
  }

  return signals;
}

function detectImpressionGrowth(pages: PageInput[]): DetectedSignal[] {
  const signals: DetectedSignal[] = [];

  for (const page of pages) {
    if (page.impressions < THRESHOLDS.impressionGrowth.minImpressions) continue;

    const change = relativeChange(page.impressions, page.previousImpressions);
    if (change === null || change < THRESHOLDS.impressionGrowth.relative) continue;

    signals.push({
      type: "IMPRESSION_GROWTH",
      severity: severityFromMagnitude(change),
      score: page.impressions - page.previousImpressions,
      pageId: page.pageId,
      subject: page.path,
      evidence: [
        {
          metricKey: "impressions",
          currentValue: page.impressions,
          previousValue: page.previousImpressions,
        },
        { metricKey: "clicks", currentValue: page.clicks, previousValue: page.previousClicks },
      ],
    });
  }

  return signals;
}

/**
 * A page with real visibility whose click-through rate sits well below what other
 * pages achieve at the same position band.
 *
 * Comparing across bands would be meaningless — a page at position 15 always earns
 * a lower CTR than one at position 2, and flagging that as an opportunity would
 * just rediscover how search results work.
 */
function detectCtrOpportunities(pages: PageInput[]): DetectedSignal[] {
  const byBand = new Map<string, number[]>();

  for (const page of pages) {
    if (page.ctr === null || page.impressions <= 0) continue;
    const band = positionBand(page.position);
    if (band === "unknown") continue;
    byBand.set(band, [...(byBand.get(band) ?? []), page.ctr]);
  }

  const medians = new Map<string, number | null>();
  for (const [band, values] of byBand) {
    // A median over one or two pages is not a benchmark.
    medians.set(band, values.length >= 3 ? median(values) : null);
  }

  const signals: DetectedSignal[] = [];

  for (const page of pages) {
    if (page.ctr === null) continue;
    if (page.impressions < THRESHOLDS.ctrOpportunity.minImpressions) continue;

    const band = positionBand(page.position);
    const bandMedian = medians.get(band);
    if (bandMedian === null || bandMedian === undefined || bandMedian === 0) continue;

    const ratio = page.ctr / bandMedian;
    if (ratio >= THRESHOLDS.ctrOpportunity.belowMedianBy) continue;

    signals.push({
      type: "CTR_OPPORTUNITY",
      severity: severityFromMagnitude(1 - ratio),
      // Clicks this page would have earned at the band median. An estimate of
      // headroom for ordering only — never displayed as a forecast.
      score: Math.round(page.impressions * (bandMedian - page.ctr)),
      pageId: page.pageId,
      subject: page.path,
      evidence: [
        { metricKey: "ctr", currentValue: page.ctr, previousValue: page.previousCtr },
        { metricKey: "ctr_band_median", currentValue: bandMedian, previousValue: null },
        { metricKey: "impressions", currentValue: page.impressions, previousValue: page.previousImpressions },
        { metricKey: "position", currentValue: page.position, previousValue: null },
      ],
    });
  }

  return signals;
}

function detectStrikingDistance(queries: QueryInput[]): DetectedSignal[] {
  const signals: DetectedSignal[] = [];

  for (const query of queries) {
    if (query.position === null) continue;
    if (query.impressions < THRESHOLDS.strikingDistance.minImpressions) continue;
    if (
      query.position < THRESHOLDS.strikingDistance.minPosition ||
      query.position > THRESHOLDS.strikingDistance.maxPosition
    ) {
      continue;
    }

    signals.push({
      type: "STRIKING_DISTANCE",
      // Closer to the first page is more actionable, and more impressions matter
      // more. Both are inputs to ordering, not a claim about outcome.
      severity: query.position <= 12 ? "MEDIUM" : "LOW",
      score: query.impressions / query.position,
      queryId: query.queryId,
      subject: query.query,
      evidence: [
        { metricKey: "position", currentValue: query.position, previousValue: null },
        { metricKey: "impressions", currentValue: query.impressions, previousValue: null },
        { metricKey: "clicks", currentValue: query.clicks, previousValue: query.previousClicks },
      ],
    });
  }

  return signals;
}

function detectWinnersAndLosers(
  pages: PageInput[],
  queries: QueryInput[],
): DetectedSignal[] {
  const signals: DetectedSignal[] = [];

  const pageDeltas = pages
    .filter(
      (page) =>
        page.clicks >= THRESHOLDS.winners.minClicks ||
        page.previousClicks >= THRESHOLDS.winners.minClicks,
    )
    .map((page) => ({ page, delta: page.clicks - page.previousClicks }));

  const risingPages = [...pageDeltas].sort((a, b) => b.delta - a.delta);
  const fallingPages = [...pageDeltas].sort((a, b) => a.delta - b.delta);

  for (const { page, delta } of risingPages.slice(0, THRESHOLDS.winners.count)) {
    if (delta <= 0) break;
    signals.push({
      type: "PAGE_WINNER",
      severity: "INFO",
      score: delta,
      pageId: page.pageId,
      subject: page.path,
      evidence: [
        { metricKey: "clicks", currentValue: page.clicks, previousValue: page.previousClicks },
      ],
    });
  }

  for (const { page, delta } of fallingPages.slice(0, THRESHOLDS.losers.count)) {
    if (delta >= 0) break;
    signals.push({
      type: "PAGE_LOSER",
      severity: "INFO",
      score: Math.abs(delta),
      pageId: page.pageId,
      subject: page.path,
      evidence: [
        { metricKey: "clicks", currentValue: page.clicks, previousValue: page.previousClicks },
      ],
    });
  }

  const queryDeltas = queries
    .filter(
      (query) =>
        query.clicks >= THRESHOLDS.winners.minClicks ||
        query.previousClicks >= THRESHOLDS.winners.minClicks,
    )
    .map((query) => ({ query, delta: query.clicks - query.previousClicks }));

  const risingQueries = [...queryDeltas].sort((a, b) => b.delta - a.delta);
  const fallingQueries = [...queryDeltas].sort((a, b) => a.delta - b.delta);

  for (const { query, delta } of risingQueries.slice(0, THRESHOLDS.winners.count)) {
    if (delta <= 0) break;
    signals.push({
      type: "QUERY_WINNER",
      severity: "INFO",
      score: delta,
      queryId: query.queryId,
      subject: query.query,
      evidence: [
        { metricKey: "clicks", currentValue: query.clicks, previousValue: query.previousClicks },
      ],
    });
  }

  for (const { query, delta } of fallingQueries.slice(0, THRESHOLDS.losers.count)) {
    if (delta >= 0) break;
    signals.push({
      type: "QUERY_LOSER",
      severity: "INFO",
      score: Math.abs(delta),
      queryId: query.queryId,
      subject: query.query,
      evidence: [
        { metricKey: "clicks", currentValue: query.clicks, previousValue: query.previousClicks },
      ],
    });
  }

  return signals;
}

function detectFreshnessRisk(
  freshnessDays: number | null,
  lastSyncFailed: boolean,
): DetectedSignal[] {
  if (freshnessDays === null) {
    return [
      {
        type: "DATA_FRESHNESS_RISK",
        severity: "MEDIUM",
        score: 0,
        subject: "No data has been received yet",
        evidence: [{ metricKey: "freshness_days", currentValue: null, previousValue: null }],
      },
    ];
  }

  if (lastSyncFailed || freshnessDays > THRESHOLDS.freshness.staleAfterDays) {
    return [
      {
        type: "DATA_FRESHNESS_RISK",
        severity: freshnessDays > 7 ? "HIGH" : "MEDIUM",
        score: freshnessDays,
        subject: `Data is ${freshnessDays} days behind`,
        evidence: [
          { metricKey: "freshness_days", currentValue: freshnessDays, previousValue: null },
        ],
      },
    ];
  }

  return [];
}
