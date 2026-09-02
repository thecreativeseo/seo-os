import type { DetectedSignal, SignalTypeName } from "@/lib/signals/rules";

/**
 * Signal wording.
 *
 * Every headline and summary states what was measured and over which period. None
 * of them explains why, and none of them recommends an action — both are P3 work,
 * and a plausible-sounding cause presented as a finding is the specific failure
 * this product exists to avoid.
 *
 * CAUSAL_VOCABULARY is enforced by a test over the rendered output of every signal
 * type, so the rule survives someone rewriting the copy later.
 */

export const CAUSAL_VOCABULARY =
  /\b(because|caused? by|due to|as a result|result(s|ed)? (from|in)|reason|explains?|why|thanks to|owing to|led to|leading to|so that|therefore|hence)\b/i;

/** Words that recommend rather than observe. Also forbidden in P1. */
export const PRESCRIPTIVE_VOCABULARY =
  /\b(you should|we recommend|recommended|fix|improve|optimi[sz]e|must|need to|try)\b/i;

function formatNumber(value: number | null): string {
  if (value === null) return "not available";
  if (Number.isInteger(value)) return value.toLocaleString("en-GB");
  return value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

function formatPercent(value: number | null): string {
  if (value === null) return "not available";
  return `${(value * 100).toFixed(1)}%`;
}

function change(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return "";
  if (previous === 0) return "";
  const delta = (current - previous) / previous;
  const direction = delta >= 0 ? "up" : "down";
  return `${direction} ${Math.abs(delta * 100).toFixed(1)}%`;
}

function evidenceValue(signal: DetectedSignal, key: string) {
  return signal.evidence.find((entry) => entry.metricKey === key);
}

export type SignalCopy = { headline: string; summary: string };

const HEADLINES: Record<SignalTypeName, string> = {
  TRAFFIC_DECLINE: "Clicks decreased",
  TRAFFIC_GROWTH: "Clicks increased",
  IMPRESSION_GROWTH: "Impressions increased",
  CTR_OPPORTUNITY: "Click-through rate below others at this position",
  STRIKING_DISTANCE: "Ranking just outside stronger visibility",
  PAGE_WINNER: "Among the largest click gains",
  PAGE_LOSER: "Among the largest click losses",
  QUERY_WINNER: "Among the largest click gains",
  QUERY_LOSER: "Among the largest click losses",
  DATA_FRESHNESS_RISK: "Data is behind",
};

export function renderSignal(
  signal: DetectedSignal,
  window: { current: { start: string; end: string }; previous: { start: string; end: string } },
): SignalCopy {
  const headline = HEADLINES[signal.type];
  const period = `${window.current.start} to ${window.current.end}, compared with ${window.previous.start} to ${window.previous.end}`;

  const clicks = evidenceValue(signal, "clicks");
  const impressions = evidenceValue(signal, "impressions");
  const ctr = evidenceValue(signal, "ctr");
  const bandMedian = evidenceValue(signal, "ctr_band_median");
  const position = evidenceValue(signal, "position");

  switch (signal.type) {
    case "TRAFFIC_DECLINE":
    case "TRAFFIC_GROWTH":
    case "PAGE_WINNER":
    case "PAGE_LOSER":
    case "QUERY_WINNER":
    case "QUERY_LOSER":
      return {
        headline,
        summary: `${signal.subject}: clicks ${formatNumber(clicks?.previousValue ?? null)} to ${formatNumber(clicks?.currentValue ?? null)}, ${change(clicks?.currentValue ?? null, clicks?.previousValue ?? null)}. Measured over ${period}.`,
      };

    case "IMPRESSION_GROWTH":
      return {
        headline,
        summary: `${signal.subject}: impressions ${formatNumber(impressions?.previousValue ?? null)} to ${formatNumber(impressions?.currentValue ?? null)}, ${change(impressions?.currentValue ?? null, impressions?.previousValue ?? null)}, with clicks ${formatNumber(clicks?.previousValue ?? null)} to ${formatNumber(clicks?.currentValue ?? null)}. Measured over ${period}.`,
      };

    case "CTR_OPPORTUNITY":
      return {
        headline,
        summary: `${signal.subject}: ${formatPercent(ctr?.currentValue ?? null)} click-through rate on ${formatNumber(impressions?.currentValue ?? null)} impressions at average position ${formatNumber(position?.currentValue ?? null)}. Other pages in this position band recorded ${formatPercent(bandMedian?.currentValue ?? null)}. Measured over ${period}.`,
      };

    case "STRIKING_DISTANCE":
      return {
        headline,
        summary: `${signal.subject}: average position ${formatNumber(position?.currentValue ?? null)} on ${formatNumber(impressions?.currentValue ?? null)} impressions, with ${formatNumber(clicks?.currentValue ?? null)} clicks. Measured over ${period}.`,
      };

    case "DATA_FRESHNESS_RISK":
      return {
        headline,
        summary: `${signal.subject}. Search Console normally reports two to three days behind; beyond that, figures for the most recent days are incomplete.`,
      };
  }
}
