import { describe, expect, it } from "vitest";

import {
  BANDS,
  MATERIAL_MOVEMENT,
  bandFor,
  isMaterial,
  isStrikingDistance,
  movementBetween,
} from "@/lib/ranking/movement";

/**
 * Position arithmetic runs backwards: 4 is better than 11. Every "improvement"
 * bug in every rank tracker is a subtraction done in the intuitive direction, so
 * the direction is asserted rather than assumed.
 */
describe("movement", () => {
  it("calls a smaller position an improvement", () => {
    const movement = movementBetween(4, 11);

    expect(movement.state).toBe("improved");
    expect(movement.placesGained).toBe(7);
  });

  it("calls a larger position a decline", () => {
    const movement = movementBetween(18, 6);

    expect(movement.state).toBe("declined");
    expect(movement.placesGained).toBe(-12);
  });

  it("recognises no change", () => {
    expect(movementBetween(7, 7)).toEqual({ state: "unchanged", placesGained: 0 });
  });

  it("treats an appearance as an appearance, not an infinite gain", () => {
    const movement = movementBetween(12, null);

    expect(movement.state).toBe("new");
    // A movement from nothing is not a distance.
    expect(movement.placesGained).toBeNull();
  });

  it("treats a disappearance as lost rather than removed", () => {
    // The page may have fallen out of the tracked depth rather than off the
    // internet, and the two are not distinguishable from a snapshot.
    const movement = movementBetween(null, 8);

    expect(movement.state).toBe("lost");
    expect(movement.placesGained).toBeNull();
  });

  it("says nothing when there is nothing to compare", () => {
    expect(movementBetween(null, null).state).toBe("unknown");
  });
});

describe("bands", () => {
  it("places positions in the terms a team uses", () => {
    expect(bandFor(1)).toBe("TOP_THREE");
    expect(bandFor(3)).toBe("TOP_THREE");
    expect(bandFor(4)).toBe("PAGE_ONE");
    expect(bandFor(10)).toBe("PAGE_ONE");
    expect(bandFor(11)).toBe("STRIKING_DISTANCE");
    expect(bandFor(20)).toBe("STRIKING_DISTANCE");
    expect(bandFor(21)).toBe("PAGE_TWO");
    expect(bandFor(60)).toBe("DEEP");
    expect(bandFor(null)).toBe("UNRANKED");
  });

  it("puts striking distance off page one but within reach", () => {
    // The whole idea rests on this band: close enough to be worth work, far
    // enough that the work has not already been done.
    expect(isStrikingDistance(10)).toBe(false);
    expect(isStrikingDistance(11)).toBe(true);
    expect(isStrikingDistance(BANDS.STRIKING_DISTANCE)).toBe(true);
    expect(isStrikingDistance(BANDS.STRIKING_DISTANCE + 1)).toBe(false);
    expect(isStrikingDistance(null)).toBe(false);
  });
});

describe("materiality", () => {
  it("ignores the wobble between crawls", () => {
    // Positions move a place or two without anything having happened. Reporting
    // that as movement fills the Command Center with noise and teaches people to
    // ignore it.
    expect(isMaterial(movementBetween(8, 9))).toBe(false);
    expect(isMaterial(movementBetween(9, 8))).toBe(false);
  });

  it("reports a real move", () => {
    expect(isMaterial(movementBetween(8, 8 + MATERIAL_MOVEMENT))).toBe(true);
    expect(isMaterial(movementBetween(4, 22))).toBe(true);
  });

  it("always reports appearing and disappearing", () => {
    expect(isMaterial(movementBetween(30, null))).toBe(true);
    expect(isMaterial(movementBetween(null, 30))).toBe(true);
  });

  it("reports nothing when nothing was measured", () => {
    expect(isMaterial(movementBetween(null, null))).toBe(false);
  });
});
