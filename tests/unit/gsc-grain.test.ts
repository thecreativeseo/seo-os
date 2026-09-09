import { describe, expect, it } from "vitest";

import {
  GSC_FIXED_DIMENSIONS,
  aggregateGscMeasurements,
  collapseGscRows,
  gscGrainKey,
  hasUniqueGscGrains,
  type GscGrainKey,
  type GscMeasurement,
} from "@/lib/sync/grain";

/**
 * One stored row per grain (P1 GSC normalized-grain aggregation).
 *
 * The production failure: a batch of five hundred rows in which two Search
 * Console spellings of the same page carried the same (date, page, query),
 * and Postgres refused the statement with SQLSTATE 21000. The fix is to add
 * those rows together before the database sees them — as measurements, not
 * as duplicates — and these tests are about the arithmetic being the right
 * arithmetic and the same arithmetic whatever order the rows arrive in.
 */

type Row = GscGrainKey & GscMeasurement & { tag: string };

function row(
  overrides: Partial<Row> & Pick<Row, "clicks" | "impressions"> & { position?: number | null },
): Row {
  const clicks = overrides.clicks;
  const impressions = overrides.impressions;
  return {
    date: "2026-06-10",
    pageId: "page-1",
    queryId: "query-1",
    ...GSC_FIXED_DIMENSIONS,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: 4.5,
    tag: "a",
    ...overrides,
    clicks,
    impressions,
  };
}

/** Fisher–Yates with a fixed seed, so a "random" order is the same every run. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

describe("the production shape", () => {
  // Two provider rows, one page, one query, one day.
  const a = row({ tag: "a", clicks: 3, impressions: 100, position: 4 });
  const b = row({ tag: "b", clicks: 2, impressions: 50, position: 10 });

  it("adds the counts and recomputes the ratios from the whole", () => {
    const [stored] = collapseGscRows([a, b]);

    expect(collapseGscRows([a, b])).toHaveLength(1);
    expect(stored!.clicks).toBe(5);
    expect(stored!.impressions).toBe(150);
    // 5 / 150, never the mean of 0.03 and 0.04.
    expect(stored!.ctr).toBeCloseTo(5 / 150, 12);
    // (4·100 + 10·50) / 150 = 6, never the mean of 4 and 10.
    expect(stored!.position).toBeCloseTo(6, 12);
  });

  it("keeps the grain and the first row's other fields", () => {
    const [stored] = collapseGscRows([a, b]);

    expect(gscGrainKey(stored!)).toBe(gscGrainKey(a));
    expect(stored!.tag).toBe("a");
  });
});

describe("what does not change", () => {
  it("passes a row with no collision through untouched, ratios included", () => {
    const only = row({ clicks: 7, impressions: 90, position: 3.25 });
    only.ctr = 0.077778; // the provider's own rounding, not ours

    const [stored] = collapseGscRows([only]);
    expect(stored).toEqual(only);
    expect(stored!.ctr).toBe(0.077778);
    expect(stored!.position).toBe(3.25);
  });

  it("leaves a chunk with no collisions in the order it arrived", () => {
    const rows = [
      row({ pageId: "p1", clicks: 1, impressions: 10 }),
      row({ pageId: "p2", clicks: 2, impressions: 20 }),
      row({ pageId: "p3", queryId: "q9", clicks: 3, impressions: 30 }),
      row({ pageId: "p1", date: "2026-06-11", clicks: 4, impressions: 40 }),
    ];

    expect(collapseGscRows(rows)).toEqual(rows);
  });

  it("does not merge rows that differ in any grain column", () => {
    const base = row({ clicks: 1, impressions: 10 });
    const variants = [
      { ...base, date: "2026-06-11" },
      { ...base, pageId: "page-2" },
      { ...base, queryId: "query-2" },
      { ...base, country: "PH" },
      { ...base, device: "MOBILE" },
      { ...base, searchType: "IMAGE" },
    ];

    expect(collapseGscRows([base, ...variants])).toHaveLength(7);
  });
});

describe("more than two", () => {
  it("collapses three or more rows into one", () => {
    const rows = [
      row({ clicks: 1, impressions: 10, position: 1 }),
      row({ clicks: 2, impressions: 20, position: 2 }),
      row({ clicks: 3, impressions: 30, position: 3 }),
      row({ clicks: 4, impressions: 40, position: 4 }),
    ];

    const [stored] = collapseGscRows(rows);
    expect(collapseGscRows(rows)).toHaveLength(1);
    expect(stored!.clicks).toBe(10);
    expect(stored!.impressions).toBe(100);
    expect(stored!.ctr).toBeCloseTo(0.1, 12);
    expect(stored!.position).toBeCloseTo((10 + 40 + 90 + 160) / 100, 12);
  });

  it("keeps independent groups independent within one chunk", () => {
    const rows = [
      row({ pageId: "p1", clicks: 1, impressions: 10, position: 2 }),
      row({ pageId: "p2", clicks: 5, impressions: 50, position: 8 }),
      row({ pageId: "p1", clicks: 2, impressions: 20, position: 5 }),
      row({ pageId: "p2", clicks: 1, impressions: 10, position: 2 }),
      row({ pageId: "p3", clicks: 9, impressions: 90, position: 1 }),
    ];

    const stored = collapseGscRows(rows);
    const byPage = new Map(stored.map((entry) => [entry.pageId, entry]));

    expect(stored).toHaveLength(3);
    expect(byPage.get("p1")).toMatchObject({ clicks: 3, impressions: 30 });
    expect(byPage.get("p1")!.position).toBeCloseTo((2 * 10 + 5 * 20) / 30, 12);
    expect(byPage.get("p2")).toMatchObject({ clicks: 6, impressions: 60 });
    expect(byPage.get("p2")!.position).toBeCloseTo((8 * 50 + 2 * 10) / 60, 12);
    expect(byPage.get("p3")).toMatchObject({ clicks: 9, impressions: 90, position: 1 });
  });

  it("collides at the beginning and the end of a chunk alike", () => {
    const first = row({ pageId: "edge", clicks: 1, impressions: 100, position: 1 });
    const middle = Array.from({ length: 20 }, (_, index) =>
      row({ pageId: `mid-${index}`, clicks: 1, impressions: 1 }),
    );
    const last = row({ pageId: "edge", clicks: 3, impressions: 100, position: 3 });

    const stored = collapseGscRows([first, ...middle, last]);
    const edge = stored.find((entry) => entry.pageId === "edge")!;

    expect(stored).toHaveLength(21);
    expect(edge).toMatchObject({ clicks: 4, impressions: 200 });
    expect(edge.position).toBeCloseTo(2, 12);
  });
});

describe("a full write chunk", () => {
  it("leaves five hundred rows with several duplicated grains uniquely keyed", () => {
    // Four hundred distinct grains plus a hundred rows that repeat twenty of
    // them five times each: the shape of a busy site's spellings.
    const distinct = Array.from({ length: 400 }, (_, index) =>
      row({
        pageId: `p-${index}`,
        clicks: index % 5,
        impressions: 10 + index,
        position: 1 + (index % 9),
      }),
    );
    const repeats = Array.from({ length: 100 }, (_, index) =>
      row({ pageId: `p-${index % 20}`, clicks: 1, impressions: 10, position: 7 }),
    );
    const chunk = [...distinct, ...repeats];
    expect(chunk).toHaveLength(500);
    expect(hasUniqueGscGrains(chunk)).toBe(false);

    const stored = collapseGscRows(chunk);

    expect(stored).toHaveLength(400);
    expect(hasUniqueGscGrains(stored)).toBe(true);
    expect(new Set(stored.map(gscGrainKey)).size).toBe(stored.length);

    // Every click and impression that came in is still there.
    const inClicks = chunk.reduce((sum, entry) => sum + entry.clicks, 0);
    const outClicks = stored.reduce((sum, entry) => sum + entry.clicks, 0);
    expect(outClicks).toBe(inClicks);
    const inImpressions = chunk.reduce((sum, entry) => sum + entry.impressions, 0);
    const outImpressions = stored.reduce((sum, entry) => sum + entry.impressions, 0);
    expect(outImpressions).toBe(inImpressions);
  });
});

describe("independence from provider order", () => {
  const rows = [
    row({ pageId: "p1", clicks: 3, impressions: 100, position: 4 }),
    row({ pageId: "p2", clicks: 1, impressions: 7, position: 11.3 }),
    row({ pageId: "p1", clicks: 2, impressions: 50, position: 10 }),
    row({ pageId: "p1", clicks: 8, impressions: 333, position: 2.7 }),
    row({ pageId: "p2", clicks: 0, impressions: 1, position: 40 }),
    row({ pageId: "p1", clicks: 1, impressions: 1, position: 99.9 }),
  ];

  const normalized = (stored: Row[]) =>
    [...stored]
      .sort((a, b) => gscGrainKey(a).localeCompare(gscGrainKey(b)))
      .map(({ tag: _tag, ...rest }) => rest);

  it("gives bit-identical results reversed and shuffled", () => {
    const forward = normalized(collapseGscRows(rows));
    const reversed = normalized(collapseGscRows([...rows].reverse()));

    // toEqual on numbers is exact, so this is bit-identity, not closeness:
    // the weighted sum is accumulated in a canonical order.
    expect(reversed).toEqual(forward);
    for (const seed of [1, 7, 42, 1234, 99991]) {
      expect(normalized(collapseGscRows(shuffled(rows, seed)))).toEqual(forward);
    }
  });
});

describe("what cannot be computed", () => {
  it("stores unknown, not zero, when an aggregate has no impressions", () => {
    const stored = aggregateGscMeasurements([
      row({ clicks: 0, impressions: 0, position: 3 }),
      row({ clicks: 0, impressions: 0, position: 5 }),
    ]);

    expect(stored.clicks).toBe(0);
    expect(stored.impressions).toBe(0);
    expect(stored.ctr).toBeNull();
    expect(stored.position).toBeNull();
  });

  it("weights position only by the impressions that reported one", () => {
    const stored = aggregateGscMeasurements([
      row({ clicks: 1, impressions: 100, position: 4 }),
      row({ clicks: 1, impressions: 900, position: null }),
    ]);

    expect(stored.impressions).toBe(1000);
    // The nine hundred impressions with no rank do not drag the rank to zero.
    expect(stored.position).toBe(4);
    expect(stored.ctr).toBeCloseTo(2 / 1000, 12);
  });
});

describe("the key", () => {
  it("is the unique index of gsc_metric_daily, column for column", () => {
    const key = gscGrainKey({
      date: "2026-06-10",
      pageId: "P",
      queryId: "Q",
      country: "ALL",
      device: "ALL",
      searchType: "WEB",
    });

    expect(key).toBe("2026-06-10|P|Q|ALL|ALL|WEB");
  });
});
