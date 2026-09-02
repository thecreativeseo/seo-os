/**
 * Reading a change in rank (docs/P2_SPEC.md §11, §17).
 *
 * Position arithmetic runs backwards: 4 is better than 11, and an increase in the
 * number is a decline in the product. Every "improvement" bug in every rank
 * tracker ever written is a subtraction done in the intuitive direction, so the
 * comparison lives in one named function with the direction spelled out, and
 * nothing else in P2 subtracts two positions.
 *
 * The output is a state rather than a number, for the same reason P1's comparison
 * returns one: a page that appeared for the first time and a page that improved
 * from 40 to 4 are different events, and "+36" describes neither.
 */

export type MovementState =
  | "improved"
  | "declined"
  | "unchanged"
  | "new"
  | "lost"
  | "unknown";

export type Movement = {
  state: MovementState;
  /**
   * Places gained, positive for improvement. Null unless both positions are
   * known — a movement from nothing is not a distance.
   */
  placesGained: number | null;
};

export function movementBetween(
  current: number | null,
  previous: number | null,
): Movement {
  if (current === null && previous === null) return { state: "unknown", placesGained: null };

  // Ranked now, not before. Not an improvement of infinity — an appearance.
  if (previous === null) return { state: "new", placesGained: null };

  // Ranked before, not now. The page may have fallen out of the tracked depth
  // rather than off the internet, which is why this is "lost" and not "removed".
  if (current === null) return { state: "lost", placesGained: null };

  const placesGained = previous - current;

  if (placesGained > 0) return { state: "improved", placesGained };
  if (placesGained < 0) return { state: "declined", placesGained };

  return { state: "unchanged", placesGained: 0 };
}

/**
 * Where a position sits, in the terms an SEO team actually uses.
 *
 * The bands are named constants because O8's opportunity rules key off them, and
 * a threshold that exists in two places will eventually exist as two different
 * numbers.
 */
export type PositionBand =
  | "TOP_THREE"
  | "PAGE_ONE"
  | "STRIKING_DISTANCE"
  | "PAGE_TWO"
  | "DEEP"
  | "UNRANKED";

export const BANDS = {
  TOP_THREE: 3,
  PAGE_ONE: 10,
  /**
   * Close enough that a page could plausibly reach the first page with work, and
   * far enough that it is not there now. This is the band the whole "striking
   * distance" idea rests on.
   */
  STRIKING_DISTANCE: 20,
  PAGE_TWO: 30,
} as const;

export function bandFor(position: number | null): PositionBand {
  if (position === null) return "UNRANKED";
  if (position <= BANDS.TOP_THREE) return "TOP_THREE";
  if (position <= BANDS.PAGE_ONE) return "PAGE_ONE";
  if (position <= BANDS.STRIKING_DISTANCE) return "STRIKING_DISTANCE";
  if (position <= BANDS.PAGE_TWO) return "PAGE_TWO";
  return "DEEP";
}

/** Ranked, but not on the first page and near enough to matter. */
export function isStrikingDistance(position: number | null): boolean {
  return position !== null && position > BANDS.PAGE_ONE && position <= BANDS.STRIKING_DISTANCE;
}

export const BAND_LABELS: Record<PositionBand, string> = {
  TOP_THREE: "Top 3",
  PAGE_ONE: "Page 1",
  STRIKING_DISTANCE: "Striking distance",
  PAGE_TWO: "Page 2",
  DEEP: "Beyond page 3",
  UNRANKED: "Not ranking",
};

export const MOVEMENT_LABELS: Record<MovementState, string> = {
  improved: "Improved",
  declined: "Declined",
  unchanged: "Unchanged",
  new: "Newly ranking",
  lost: "No longer ranking",
  unknown: "Not measured",
};

/**
 * How much movement is worth mentioning.
 *
 * Positions wobble by a place or two between crawls without anything having
 * happened. Reporting that as movement would fill the Command Center with noise
 * and teach people to ignore it.
 */
export const MATERIAL_MOVEMENT = 3;

export function isMaterial(movement: Movement): boolean {
  if (movement.state === "new" || movement.state === "lost") return true;
  if (movement.placesGained === null) return false;

  return Math.abs(movement.placesGained) >= MATERIAL_MOVEMENT;
}
