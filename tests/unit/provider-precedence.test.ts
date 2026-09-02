import { describe, expect, it } from "vitest";

import {
  DISAGREEMENT_THRESHOLD,
  PROVIDER_ORDER,
  pickPrimary,
  providersDisagree,
  relativeGap,
} from "@/lib/keyword/provider-precedence";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("choosing between providers", () => {
  it("prefers the most recent reading", () => {
    const picked = pickPrimary([
      { provider: "SEMRUSH", capturedAt: day("2026-08-01"), value: 2400 },
      { provider: "AHREFS", capturedAt: day("2026-08-30"), value: 1900 },
    ]);

    expect(picked?.provider).toBe("AHREFS");
    expect(picked?.value).toBe(1900);
  });

  it("breaks a same-day tie the same way every time", () => {
    // A volume that flickers between two values on refresh destroys trust in
    // every other number on the screen, so the order is fixed rather than
    // whatever the database returned first.
    const readings = [
      { provider: "AHREFS" as const, capturedAt: day("2026-08-30"), value: 1900 },
      { provider: "SEMRUSH" as const, capturedAt: day("2026-08-30"), value: 2400 },
    ];

    const first = pickPrimary(readings);
    const reversed = pickPrimary([...readings].reverse());

    expect(first?.provider).toBe(PROVIDER_ORDER[0]);
    expect(reversed?.provider).toBe(first?.provider);
    expect(reversed?.value).toBe(first?.value);
  });

  it("returns nothing when there is nothing to pick", () => {
    expect(pickPrimary([])).toBeNull();
  });

  it("never averages two providers", () => {
    // The mean of two different estimation models estimates nothing, and would
    // launder two honest disagreeing numbers into one confident wrong one.
    const picked = pickPrimary([
      { provider: "SEMRUSH", capturedAt: day("2026-08-30"), value: 2400 },
      { provider: "AHREFS", capturedAt: day("2026-08-29"), value: 1000 },
    ]);

    expect(picked?.value).toBe(2400);
    expect(picked?.value).not.toBe(1700);
  });
});

describe("disagreement", () => {
  it("measures the gap relative to the larger number", () => {
    expect(relativeGap(100, 75)).toBeCloseTo(0.25);
    expect(relativeGap(2400, 2400)).toBe(0);
  });

  it("distinguishes agreement from nothing to compare", () => {
    // "They agree" and "one of them is missing" must never render the same way.
    expect(relativeGap(100, null)).toBeNull();
    expect(relativeGap(null, null)).toBeNull();

    // Both measured zero: they agree, and that is a real answer.
    expect(relativeGap(0, 0)).toBe(0);
  });

  it("treats a measured zero against a real number as total disagreement", () => {
    // One provider says nobody searches this and the other says five hundred do.
    // That is the largest disagreement there is, not an absence of one.
    expect(relativeGap(0, 500)).toBe(1);
    expect(
      providersDisagree([
        { provider: "SEMRUSH", capturedAt: day("2026-08-30"), value: 0 },
        { provider: "AHREFS", capturedAt: day("2026-08-30"), value: 500 },
      ]),
    ).toBe(true);
  });

  it("flags providers that differ materially", () => {
    const readings = [
      { provider: "SEMRUSH" as const, capturedAt: day("2026-08-30"), value: 2400 },
      { provider: "AHREFS" as const, capturedAt: day("2026-08-30"), value: 1200 },
    ];

    expect(providersDisagree(readings)).toBe(true);
  });

  it("tolerates the routine difference between two sampling models", () => {
    // Providers differ by 10–20% on volume through sampling alone; flagging that
    // would make the warning meaningless.
    const readings = [
      { provider: "SEMRUSH" as const, capturedAt: day("2026-08-30"), value: 2400 },
      { provider: "AHREFS" as const, capturedAt: day("2026-08-30"), value: 2100 },
    ];

    expect(relativeGap(2400, 2100)).toBeLessThan(DISAGREEMENT_THRESHOLD);
    expect(providersDisagree(readings)).toBe(false);
  });

  it("cannot disagree with itself", () => {
    expect(
      providersDisagree([
        { provider: "SEMRUSH", capturedAt: day("2026-08-30"), value: 2400 },
      ]),
    ).toBe(false);

    expect(
      providersDisagree([
        { provider: "SEMRUSH", capturedAt: day("2026-08-30"), value: 2400 },
        { provider: "AHREFS", capturedAt: day("2026-08-30"), value: null },
      ]),
    ).toBe(false);
  });
});
