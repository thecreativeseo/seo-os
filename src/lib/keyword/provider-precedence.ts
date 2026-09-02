import type { ConnectionProvider } from "@/generated/prisma/client";

/**
 * Choosing between two providers who describe the same keyword.
 *
 * Semrush and Ahrefs can both hold a reading for one keyword on one day, and the
 * snapshot key keeps both — neither overwrites the other, because their
 * disagreement is a fact rather than a conflict to resolve. But a list has one
 * cell per column, so something has to decide which number to show.
 *
 * Three rules, in order, and all three are stated on screen rather than applied
 * quietly:
 *
 *   1. The most recent reading wins. A figure from last week describes the market
 *      better than one from last quarter, whoever produced it.
 *   2. On the same date, a fixed order breaks the tie. Any order is arbitrary;
 *      what matters is that it never changes between two page loads, because a
 *      volume that flickers between 2,400 and 1,900 on refresh destroys trust in
 *      every other number on the screen.
 *   3. Whichever is shown carries its provider's name, and a material
 *      disagreement is flagged rather than hidden.
 *
 * What this deliberately does not do is average them. The mean of two different
 * estimation models is not an estimate of anything, and it would launder two
 * honest disagreeing numbers into one confident wrong one.
 */

/** Stable tie-break. Arbitrary by admission, constant by requirement. */
export const PROVIDER_ORDER: ConnectionProvider[] = ["SEMRUSH", "AHREFS"];

/**
 * How far apart two readings must be before the difference is worth a person's
 * attention. Providers routinely differ by 10–20% on volume through sampling
 * alone; a quarter apart suggests they are measuring different things.
 */
export const DISAGREEMENT_THRESHOLD = 0.25;

export type Reading<T> = {
  provider: ConnectionProvider;
  capturedAt: Date;
  value: T;
};

function providerRank(provider: ConnectionProvider): number {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

/** The reading a single-value column should show, by the rules above. */
export function pickPrimary<T>(readings: Reading<T>[]): Reading<T> | null {
  if (readings.length === 0) return null;

  return [...readings].sort((a, b) => {
    const byDate = b.capturedAt.getTime() - a.capturedAt.getTime();
    if (byDate !== 0) return byDate;

    return providerRank(a.provider) - providerRank(b.provider);
  })[0]!;
}

/**
 * The relative gap between two numbers, or null when it cannot be computed.
 *
 * Null rather than zero when a value is missing or the base is zero: "they agree"
 * and "there is nothing to compare" are different answers, and only one of them
 * should ever be shown as agreement.
 */
export function relativeGap(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;

  const base = Math.max(Math.abs(a), Math.abs(b));
  if (base === 0) return a === b ? 0 : null;

  return Math.abs(a - b) / base;
}

/** True when providers disagree by enough to be worth flagging. */
export function providersDisagree(readings: Reading<number | null>[]): boolean {
  const values = readings
    .map((reading) => reading.value)
    .filter((value): value is number => value !== null);

  if (values.length < 2) return false;

  const gap = relativeGap(Math.min(...values), Math.max(...values));
  return gap !== null && gap >= DISAGREEMENT_THRESHOLD;
}
