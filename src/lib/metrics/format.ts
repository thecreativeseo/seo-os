import type { Change, ChangeState } from "@/lib/metrics/compare";

/**
 * Display formatting for metrics.
 *
 * The whole point is that "we did not measure this" and "this is zero" look
 * different on screen. Every formatter here returns an explicit string for the
 * unknown case rather than falling back to 0 or an em dash that could be read as
 * either.
 */

export const NOT_AVAILABLE = "Not available";

export function formatCount(value: number | null): string {
  if (value === null) return NOT_AVAILABLE;
  return value.toLocaleString("en-GB");
}

export function formatPercent(value: number | null, digits = 2): string {
  if (value === null) return NOT_AVAILABLE;
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatPosition(value: number | null): string {
  if (value === null) return NOT_AVAILABLE;
  return value.toFixed(1);
}

/**
 * How a change reads in a table cell.
 *
 * "New" and "Gone" are words rather than percentages because there is no honest
 * percentage to show: a page going from zero to forty clicks has not grown by
 * infinity, and rendering +100% would be a fabrication.
 */
export function formatChange(change: Change): string {
  switch (change.state) {
    case "unknown":
      return NOT_AVAILABLE;
    case "new":
      return "New";
    case "gone":
      return "Gone";
    case "flat":
      return "No change";
    case "up":
    case "down": {
      if (change.percentage === null) return NOT_AVAILABLE;
      const sign = change.percentage > 0 ? "+" : "";
      return `${sign}${(change.percentage * 100).toFixed(1)}%`;
    }
  }
}

/** Absolute movement, shown alongside the percentage so scale is visible. */
export function formatAbsoluteChange(change: Change): string {
  if (change.absolute === null) return "";
  const sign = change.absolute > 0 ? "+" : "";
  return `${sign}${change.absolute.toLocaleString("en-GB")}`;
}

/**
 * Direction for styling. Deliberately separate from good/bad: a falling average
 * position is an improvement, and the caller decides which way is up.
 */
export function changeDirection(state: ChangeState): "positive" | "negative" | "neutral" {
  if (state === "up" || state === "new") return "positive";
  if (state === "down" || state === "gone") return "negative";
  return "neutral";
}

export function formatDateRange(range: { start: string; end: string }): string {
  const format = (value: string) =>
    new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

  return `${format(range.start)} – ${format(range.end)}`;
}
