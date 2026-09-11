import { describe, expect, it } from "vitest";

import { MAX_PERSISTABLE_SCORE, persistableScore } from "@/lib/signals/rules";

/**
 * Storing a signal's score (P1 signal score overflow).
 *
 * A score is an ordering magnitude in count units — clicks lost, impressions
 * gained, clicks a page could have earned at its band's median CTR — and it is
 * unbounded by design. The column was DECIMAL(9,4), a ceiling of 99,999.9999,
 * and the first complete dataset for a busy property produced a CTR-opportunity
 * score of 188,993. Postgres refused the INSERT, and because detection runs
 * after a sync completes, the whole finished sync job was retried for it.
 *
 * The column is now DECIMAL(18,4). What these tests pin down is the small
 * guard in front of it: a value in the normal range is stored exactly as
 * computed, and only a value the column could never hold — or that is not a
 * number at all — becomes unknown rather than a failed statement or a clamp.
 */

describe("a score in the range rules actually produce", () => {
  it("passes through untouched, to the bit", () => {
    for (const score of [0, 7, 4601, 6008, 31520, 188993, 1234.5678, 99999.9999, 100000]) {
      expect(persistableScore(score)).toBe(score);
    }
  });

  it("keeps the production value that overflowed the old column", () => {
    expect(persistableScore(188993)).toBe(188993);
  });

  it("keeps a very large but representable magnitude", () => {
    // Fourteen integer digits: a hundred trillion is the first value refused.
    expect(persistableScore(99_999_999_999_999)).toBe(99_999_999_999_999);
    expect(persistableScore(MAX_PERSISTABLE_SCORE - 1)).toBe(MAX_PERSISTABLE_SCORE - 1);
  });

  it("keeps a negative value's sign, should a rule ever produce one", () => {
    // Rules produce non-negative scores today; the guard must never flip a sign.
    expect(persistableScore(-4601)).toBe(-4601);
    expect(persistableScore(-(MAX_PERSISTABLE_SCORE - 1))).toBe(-(MAX_PERSISTABLE_SCORE - 1));
  });
});

describe("a score the column cannot hold", () => {
  it("becomes unknown, not a clamp and not an error", () => {
    expect(persistableScore(MAX_PERSISTABLE_SCORE)).toBeNull();
    expect(persistableScore(MAX_PERSISTABLE_SCORE * 10)).toBeNull();
    expect(persistableScore(-MAX_PERSISTABLE_SCORE)).toBeNull();
  });

  it("treats NaN and the infinities as unknown", () => {
    expect(persistableScore(Number.NaN)).toBeNull();
    expect(persistableScore(Number.POSITIVE_INFINITY)).toBeNull();
    expect(persistableScore(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("never returns anything the column would refuse", () => {
    const samples = [0, 1, 188993, 1e10, 1e13, 1e14, 1e15, -1e14, Number.NaN, Number.POSITIVE_INFINITY];
    for (const sample of samples) {
      const stored = persistableScore(sample);
      if (stored !== null) {
        expect(Number.isFinite(stored)).toBe(true);
        expect(Math.abs(stored)).toBeLessThan(MAX_PERSISTABLE_SCORE);
      }
    }
  });
});
