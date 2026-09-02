import { describe, expect, it } from "vitest";

import {
  SCORING_MODEL_VERSION,
  THRESHOLDS,
  detectSignals,
  positionBand,
  type PageInput,
  type QueryInput,
} from "@/lib/signals/rules";
import {
  CAUSAL_VOCABULARY,
  PRESCRIPTIVE_VOCABULARY,
  renderSignal,
} from "@/lib/signals/templates";

const WINDOW = {
  current: { start: "2026-08-03", end: "2026-08-30" },
  previous: { start: "2026-07-06", end: "2026-08-02" },
};

function page(overrides: Partial<PageInput> = {}): PageInput {
  return {
    pageId: overrides.pageId ?? crypto.randomUUID(),
    path: "/example",
    clicks: 100,
    impressions: 2000,
    ctr: 0.05,
    position: 5,
    previousClicks: 100,
    previousImpressions: 2000,
    previousCtr: 0.05,
    ...overrides,
  };
}

function query(overrides: Partial<QueryInput> = {}): QueryInput {
  return {
    queryId: overrides.queryId ?? crypto.randomUUID(),
    query: "example query",
    topPagePath: "/example",
    clicks: 10,
    impressions: 200,
    ctr: 0.05,
    position: 12,
    previousClicks: 10,
    ...overrides,
  };
}

/** Unwraps to the signal list; the cap and totals are covered separately below. */
function detect(input: Partial<Parameters<typeof detectSignals>[0]>) {
  return detectSignals({
    pages: [],
    queries: [],
    freshnessDays: 3,
    lastSyncFailed: false,
    ...input,
  }).signals;
}

function detectFull(input: Partial<Parameters<typeof detectSignals>[0]>) {
  return detectSignals({
    pages: [],
    queries: [],
    freshnessDays: 3,
    lastSyncFailed: false,
    ...input,
  });
}

describe("determinism", () => {
  it("produces the same signals in the same order", () => {
    const pages = [
      page({ path: "/a", clicks: 40, previousClicks: 200 }),
      page({ path: "/b", clicks: 300, previousClicks: 100 }),
    ];

    expect(detect({ pages })).toEqual(detect({ pages }));
  });

  it("is versioned so thresholds can change without rewriting history", () => {
    expect(SCORING_MODEL_VERSION).toBe("signals-v1");
  });
});

describe("noise is not news", () => {
  it("ignores a large relative change on tiny volume", () => {
    // 2 clicks to 1 is a 50% decline nobody should be shown.
    const signals = detect({ pages: [page({ clicks: 1, previousClicks: 2, impressions: 20 })] });
    expect(signals.filter((signal) => signal.type === "TRAFFIC_DECLINE")).toHaveLength(0);
  });

  it("requires both a relative and an absolute movement", () => {
    // 30% down, but only 6 clicks lost.
    expect(
      detect({ pages: [page({ clicks: 14, previousClicks: 20 })] }).filter(
        (signal) => signal.type === "TRAFFIC_DECLINE",
      ),
    ).toHaveLength(0);

    // 30% down and 60 clicks lost.
    expect(
      detect({ pages: [page({ clicks: 140, previousClicks: 200 })] }).filter(
        (signal) => signal.type === "TRAFFIC_DECLINE",
      ),
    ).toHaveLength(1);
  });
});

describe("traffic decline", () => {
  it("detects the blueprint's example", () => {
    const signals = detect({
      pages: [page({ path: "/payroll-software", clicks: 920, previousClicks: 1240 })],
    });

    const decline = signals.find((signal) => signal.type === "TRAFFIC_DECLINE")!;
    expect(decline.subject).toBe("/payroll-software");
    expect(decline.severity).toBe("MEDIUM");

    const clicks = decline.evidence.find((entry) => entry.metricKey === "clicks")!;
    expect(clicks.currentValue).toBe(920);
    expect(clicks.previousValue).toBe(1240);
  });

  it("carries the evidence needed to explain itself without recomputation", () => {
    const signals = detect({ pages: [page({ clicks: 100, previousClicks: 400 })] });
    const decline = signals.find((signal) => signal.type === "TRAFFIC_DECLINE")!;

    expect(decline.evidence.map((entry) => entry.metricKey).sort()).toEqual([
      "clicks",
      "ctr",
      "impressions",
    ]);
  });
});

describe("CTR opportunity", () => {
  it("compares within a position band, not across bands", () => {
    // Four pages at position 2 with healthy CTR, one far below them.
    const pages = [
      page({ path: "/a", position: 2, ctr: 0.2, impressions: 5000, clicks: 1000 }),
      page({ path: "/b", position: 2, ctr: 0.22, impressions: 5000, clicks: 1100 }),
      page({ path: "/c", position: 2, ctr: 0.18, impressions: 5000, clicks: 900 }),
      page({ path: "/low", position: 2, ctr: 0.04, impressions: 5000, clicks: 200 }),
      // A page at position 18 with a low CTR is normal for its band, not an
      // opportunity. Flagging it would just rediscover how search results work.
      page({ path: "/deep", position: 18, ctr: 0.01, impressions: 5000, clicks: 50 }),
    ];

    const flagged = detect({ pages })
      .filter((signal) => signal.type === "CTR_OPPORTUNITY")
      .map((signal) => signal.subject);

    expect(flagged).toContain("/low");
    expect(flagged).not.toContain("/deep");
  });

  it("needs a real impression volume", () => {
    const pages = [
      page({ path: "/a", position: 2, ctr: 0.2, impressions: 5000 }),
      page({ path: "/b", position: 2, ctr: 0.2, impressions: 5000 }),
      page({ path: "/c", position: 2, ctr: 0.2, impressions: 5000 }),
      page({ path: "/tiny", position: 2, ctr: 0.01, impressions: 50 }),
    ];

    expect(
      detect({ pages }).filter((signal) => signal.type === "CTR_OPPORTUNITY"),
    ).toHaveLength(0);
  });

  it("does not treat two pages as a benchmark", () => {
    const pages = [
      page({ path: "/a", position: 2, ctr: 0.2, impressions: 5000 }),
      page({ path: "/low", position: 2, ctr: 0.01, impressions: 5000 }),
    ];

    expect(
      detect({ pages }).filter((signal) => signal.type === "CTR_OPPORTUNITY"),
    ).toHaveLength(0);
  });
});

describe("striking distance", () => {
  it("uses the documented position band", () => {
    const inBand = detect({ queries: [query({ position: 12, impressions: 300 })] });
    expect(inBand.filter((signal) => signal.type === "STRIKING_DISTANCE")).toHaveLength(1);

    for (const position of [4, 25]) {
      expect(
        detect({ queries: [query({ position, impressions: 300 })] }).filter(
          (signal) => signal.type === "STRIKING_DISTANCE",
        ),
      ).toHaveLength(0);
    }
  });

  it("requires enough impressions to be worth acting on", () => {
    expect(
      detect({ queries: [query({ position: 12, impressions: 20 })] }).filter(
        (signal) => signal.type === "STRIKING_DISTANCE",
      ),
    ).toHaveLength(0);
  });

  it("matches the documented thresholds", () => {
    expect(THRESHOLDS.strikingDistance).toEqual({
      minPosition: 8,
      maxPosition: 20,
      minImpressions: 100,
    });
  });
});

describe("winners and losers", () => {
  it("returns at most three of each and skips flat pages", () => {
    const pages = [
      page({ path: "/w1", clicks: 300, previousClicks: 100 }),
      page({ path: "/w2", clicks: 250, previousClicks: 100 }),
      page({ path: "/w3", clicks: 200, previousClicks: 100 }),
      page({ path: "/w4", clicks: 150, previousClicks: 100 }),
      page({ path: "/l1", clicks: 50, previousClicks: 300 }),
    ];

    const signals = detect({ pages });
    expect(signals.filter((signal) => signal.type === "PAGE_WINNER")).toHaveLength(3);
    expect(signals.filter((signal) => signal.type === "PAGE_LOSER")).toHaveLength(1);
  });
});

describe("data freshness", () => {
  it("says nothing while the lag is normal", () => {
    expect(
      detect({ freshnessDays: 3 }).filter((signal) => signal.type === "DATA_FRESHNESS_RISK"),
    ).toHaveLength(0);
  });

  it("raises a risk once data is genuinely behind", () => {
    const signals = detect({ freshnessDays: 9 });
    const risk = signals.find((signal) => signal.type === "DATA_FRESHNESS_RISK")!;
    expect(risk.severity).toBe("HIGH");
  });

  it("raises a risk when the last sync failed even if data looks recent", () => {
    expect(
      detect({ freshnessDays: 2, lastSyncFailed: true }).filter(
        (signal) => signal.type === "DATA_FRESHNESS_RISK",
      ),
    ).toHaveLength(1);
  });

  it("raises a risk when nothing has ever arrived", () => {
    expect(
      detect({ freshnessDays: null }).filter(
        (signal) => signal.type === "DATA_FRESHNESS_RISK",
      ),
    ).toHaveLength(1);
  });
});

describe("position bands", () => {
  it.each([
    [1, "1-3"],
    [3, "1-3"],
    [4, "4-10"],
    [10, "4-10"],
    [11, "11-20"],
    [20, "11-20"],
    [21, "21+"],
    [null, "unknown"],
  ])("%s -> %s", (position, band) => {
    expect(positionBand(position)).toBe(band);
  });
});

/**
 * The release-blocking language rule: signals observe, they do not explain and
 * they do not prescribe.
 */
describe("signals never claim a cause", () => {
  const everyType = detect({
    pages: [
      page({ path: "/decline", clicks: 920, previousClicks: 1240 }),
      page({ path: "/growth", clicks: 400, previousClicks: 100 }),
      page({ path: "/impressions", clicks: 100, previousClicks: 95, impressions: 5000, previousImpressions: 1000 }),
      page({ path: "/a", position: 2, ctr: 0.2, impressions: 5000 }),
      page({ path: "/b", position: 2, ctr: 0.21, impressions: 5000 }),
      page({ path: "/c", position: 2, ctr: 0.19, impressions: 5000 }),
      page({ path: "/low-ctr", position: 2, ctr: 0.02, impressions: 5000 }),
    ],
    queries: [
      query({ query: "striking query", position: 11, impressions: 400 }),
      query({ query: "rising query", clicks: 200, previousClicks: 30 }),
      query({ query: "falling query", clicks: 20, previousClicks: 300 }),
    ],
    freshnessDays: 12,
  });

  it("covers every signal type the demo needs", () => {
    const types = new Set(everyType.map((signal) => signal.type));
    for (const required of [
      "TRAFFIC_DECLINE",
      "IMPRESSION_GROWTH",
      "CTR_OPPORTUNITY",
      "STRIKING_DISTANCE",
      "PAGE_WINNER",
      "PAGE_LOSER",
    ] as const) {
      expect(types).toContain(required);
    }
  });

  it("uses no causal vocabulary in any rendered signal", () => {
    for (const signal of everyType) {
      const copy = renderSignal(signal, WINDOW);
      expect(copy.headline).not.toMatch(CAUSAL_VOCABULARY);
      expect(copy.summary).not.toMatch(CAUSAL_VOCABULARY);
    }
  });

  it("uses no prescriptive vocabulary either", () => {
    for (const signal of everyType) {
      const copy = renderSignal(signal, WINDOW);
      expect(copy.headline).not.toMatch(PRESCRIPTIVE_VOCABULARY);
      expect(copy.summary).not.toMatch(PRESCRIPTIVE_VOCABULARY);
    }
  });

  it("states the period every signal was measured over", () => {
    for (const signal of everyType) {
      if (signal.type === "DATA_FRESHNESS_RISK") continue;
      expect(renderSignal(signal, WINDOW).summary).toContain("2026-08-03");
      expect(renderSignal(signal, WINDOW).summary).toContain("2026-07-06");
    }
  });

  it("renders the decline as numbers rather than an explanation", () => {
    const decline = everyType.find((signal) => signal.type === "TRAFFIC_DECLINE")!;
    const copy = renderSignal(decline, WINDOW);

    expect(copy.headline).toBe("Clicks decreased");
    expect(copy.summary).toContain("1,240");
    expect(copy.summary).toContain("920");
    expect(copy.summary).toContain("down 25.8%");
  });
});

describe("per-type caps", () => {
  it("caps a type that matches many candidates but reports the true total", () => {
    // Forty queries all sit in the striking-distance band.
    const queries = Array.from({ length: 40 }, (_, index) =>
      query({
        query: `query ${String(index).padStart(2, "0")}`,
        position: 12,
        impressions: 200 + index,
      }),
    );

    const result = detectFull({ queries });
    const striking = result.signals.filter(
      (signal) => signal.type === "STRIKING_DISTANCE",
    );

    // An Attention list with forty items is a second inbox, not attention.
    expect(striking).toHaveLength(12);
    // But nothing is hidden: the interface can say "12 of 40".
    expect(result.totalsByType.STRIKING_DISTANCE).toBe(40);
  });

  it("keeps the highest-scoring candidates when capping", () => {
    const queries = Array.from({ length: 20 }, (_, index) =>
      query({
        query: `query ${String(index).padStart(2, "0")}`,
        position: 12,
        // Impressions rise with the index, so the last ones score highest.
        impressions: 100 + index * 100,
      }),
    );

    const result = detectFull({ queries });
    const kept = result.signals
      .filter((signal) => signal.type === "STRIKING_DISTANCE")
      .map((signal) => signal.subject);

    expect(kept).toContain("query 19");
    expect(kept).not.toContain("query 00");
  });

  it("does not cap types that are already bounded", () => {
    const pages = Array.from({ length: 10 }, (_, index) =>
      page({ path: `/p${index}`, clicks: 300 - index * 10, previousClicks: 50 }),
    );

    const result = detectFull({ pages });
    // Winners are already limited to three by their own rule.
    expect(result.signals.filter((signal) => signal.type === "PAGE_WINNER")).toHaveLength(3);
  });
});
