import { describe, expect, it } from "vitest";

import {
  buildEvidenceView,
  describeOmitted,
  describeCitedEvidence,
  describeQueryCoverage,
  formatChange,
  formatMetric,
  formatPeriod,
  parseWindowKey,
  describeRecordValue,
  evidenceHeading,
  type EvidenceManifest,
} from "@/lib/evidence/presentation";
import type { Evidence } from "@/lib/evidence/types";

/**
 * Reading evidence (P1/P3 observability).
 *
 * The bug this covers was not a wrong number. It was a right number with no
 * name: a record holding a page's clicks, impressions, CTR and position was
 * rendered as "Gsc page window: 6,846" — the shape of the query instead of what
 * was counted, with the other three metrics never shown at all.
 *
 * So these tests are mostly about labels and about what happens to a value that
 * was never measured. A null must survive every step as "Unknown", because the
 * one thing worse than an unlabelled number is a zero we invented.
 */

const CURRENT = { start: "2026-08-08", end: "2026-09-04" };
const PREVIOUS = { start: "2026-07-11", end: "2026-08-07" };

const MANIFEST: EvidenceManifest = {
  window: {
    start: CURRENT.start,
    end: CURRENT.end,
    comparisonStart: PREVIOUS.start,
    comparisonEnd: PREVIOUS.end,
  },
  omitted: [],
};

function gsc(
  period: { start: string; end: string },
  context: Record<string, unknown>,
  overrides: Partial<Evidence> = {},
): Evidence {
  return {
    id: `gsc:page:page-1:${period.start}..${period.end}`,
    websiteId: "website-1",
    type: "GSC_METRIC",
    source: "Google Search Console",
    sourceEntityType: "GscMetricDaily",
    sourceEntityId: "page-1",
    capturedAt: null,
    asOfDate: new Date(`${period.end}T00:00:00.000Z`),
    metricKey: "gsc_page_window",
    numericValue: (context.clicks as number) ?? null,
    textValue: null,
    contextJson: { subject: "page", periodStart: period.start, periodEnd: period.end, ...context },
    reliability: "DIRECT_PROVIDER",
    ...overrides,
  };
}

function ga4(period: { start: string; end: string }, context: Record<string, unknown>): Evidence {
  return {
    id: `ga4:page:page-1:${period.start}..${period.end}`,
    websiteId: "website-1",
    type: "GA4_METRIC",
    source: "Google Analytics 4",
    sourceEntityType: "Ga4LandingPageMetricDaily",
    sourceEntityId: "page-1",
    capturedAt: null,
    asOfDate: new Date(`${period.end}T00:00:00.000Z`),
    metricKey: "ga4_page_window",
    numericValue: (context.sessions as number) ?? null,
    textValue: null,
    contextJson: { subject: "page", periodStart: period.start, periodEnd: period.end, ...context },
    reliability: "DIRECT_PROVIDER",
  };
}

describe("recognising a windowed measurement", () => {
  it("reads the family and subject out of the key", () => {
    expect(parseWindowKey("gsc_page_window")).toEqual({ family: "gsc", subject: "page" });
    expect(parseWindowKey("ga4_site_window")).toEqual({ family: "ga4", subject: "site" });
    expect(parseWindowKey("gsc_query_window")).toEqual({ family: "gsc", subject: "query" });
  });

  it("leaves every other metric key alone", () => {
    // These already render meaningfully and are none of this module's business.
    for (const key of ["search_volume", "position", "word_count", "competitor_position", null]) {
      expect(parseWindowKey(key)).toBeNull();
    }
  });
});

describe("grouping evidence by source", () => {
  it("names the metrics a Search Console record actually holds", () => {
    const view = buildEvidenceView(
      [gsc(CURRENT, { clicks: 6846, impressions: 91_233, ctr: 0.075, position: 8.4 })],
      MANIFEST,
    );

    const [group] = view.groups;
    expect(group!.source).toBe("Google Search Console");

    const labels = group!.subjects[0]!.metrics.map((metric) => metric.label);
    expect(labels).toEqual(["Clicks", "Impressions", "CTR", "Average position"]);

    // The headline number was always clicks. Now it says so.
    const clicks = group!.subjects[0]!.metrics.find((metric) => metric.key === "clicks");
    expect(clicks!.current).toBe(6846);

    // And nothing anywhere still calls it a "window".
    expect(JSON.stringify(view)).not.toContain("window");
  });

  it("names the metrics a GA4 record actually holds", () => {
    const view = buildEvidenceView(
      [
        ga4(CURRENT, {
          sessions: 6529,
          engagedSessions: 4110,
          engagementRate: 0.63,
          keyEvents: 88,
        }),
      ],
      MANIFEST,
    );

    const labels = view.groups[0]!.subjects[0]!.metrics.map((metric) => metric.label);
    expect(labels).toEqual(["Sessions", "Engaged sessions", "Engagement rate", "Key events"]);
    expect(view.groups[0]!.source).toBe("Google Analytics 4");
  });

  it("puts each provider in its own group", () => {
    const view = buildEvidenceView(
      [gsc(CURRENT, { clicks: 10, impressions: 100 }), ga4(CURRENT, { sessions: 20 })],
      MANIFEST,
    );

    expect(view.groups.map((group) => group.source).sort()).toEqual([
      "Google Analytics 4",
      "Google Search Console",
    ]);
  });

  it("shows provenance once for the group rather than once per record", () => {
    const view = buildEvidenceView(
      [
        gsc(CURRENT, { clicks: 10, impressions: 100 }),
        gsc(PREVIOUS, { clicks: 8, impressions: 90 }),
      ],
      MANIFEST,
    );

    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]!.reliabilityLabel).toBe("Reported by a connected provider");
    expect(view.groups[0]!.dataThrough?.toISOString().slice(0, 10)).toBe(CURRENT.end);
  });
});

describe("pairing a period against the one before it", () => {
  it("folds two windows of the same subject into one row each", () => {
    const view = buildEvidenceView(
      [
        gsc(CURRENT, { clicks: 6846, impressions: 91_233, ctr: 0.075, position: 8.4 }),
        gsc(PREVIOUS, { clicks: 9221, impressions: 88_010, ctr: 0.105, position: 6.9 }),
      ],
      MANIFEST,
    );

    const group = view.groups[0]!;
    expect(group.subjects).toHaveLength(1);
    expect(group.current).toEqual(CURRENT);
    expect(group.previous).toEqual(PREVIOUS);

    const clicks = group.subjects[0]!.metrics.find((metric) => metric.key === "clicks")!;
    expect(clicks.current).toBe(6846);
    expect(clicks.previous).toBe(9221);

    // Both records are still individually citable.
    expect(group.subjects[0]!.evidenceIds).toHaveLength(2);
  });

  it("leaves a record standing alone when it belongs to neither window", () => {
    const stray = { start: "2026-01-01", end: "2026-01-28" };
    const view = buildEvidenceView([gsc(stray, { clicks: 5, impressions: 50 })], MANIFEST);

    expect(view.groups[0]!.subjects).toHaveLength(0);
    expect(view.groups[0]!.records).toHaveLength(1);
  });

  it("does not invent a comparison when the manifest has no window", () => {
    const view = buildEvidenceView([gsc(CURRENT, { clicks: 5, impressions: 50 })], null);

    expect(view.groups[0]!.current).toBeNull();
    expect(view.groups[0]!.previous).toBeNull();
    expect(view.groups[0]!.records).toHaveLength(1);
  });
});

describe("a value that was never measured", () => {
  it("stays unknown rather than becoming zero", () => {
    // Many properties do not report revenue at all. Zero would be a claim that
    // nothing was earned, which is a different and false statement.
    const view = buildEvidenceView([ga4(CURRENT, { sessions: 100, revenue: null })], MANIFEST);

    const revenue = view.groups[0]!.subjects[0]!.metrics.find((row) => row.key === "revenue")!;
    expect(revenue.current).toBeNull();
    expect(formatMetric(revenue.current, revenue.format)).toBe("Unknown");
  });

  it("omits a metric the source does not carry at all", () => {
    const view = buildEvidenceView([ga4(CURRENT, { sessions: 100 })], MANIFEST);

    const keys = view.groups[0]!.subjects[0]!.metrics.map((metric) => metric.key);
    expect(keys).toEqual(["sessions"]);
    expect(keys).not.toContain("revenue");
  });

  it("states no change when only one side is known", () => {
    expect(
      formatChange({
        key: "clicks",
        label: "Clicks",
        current: 10,
        previous: null,
        format: "integer",
      }),
    ).toBeNull();
  });
});

describe("naming the thing measured", () => {
  it("uses the page URL when the reader resolved one", () => {
    const view = buildEvidenceView(
      [gsc(CURRENT, { clicks: 10, impressions: 100 })],
      MANIFEST,
      new Map([["page-1", "https://example.com/pricing"]]),
    );

    expect(view.groups[0]!.subjects[0]!.label).toBe("https://example.com/pricing");
  });

  it("falls back to a plain word rather than showing a UUID", () => {
    const view = buildEvidenceView([gsc(CURRENT, { clicks: 10, impressions: 100 })], MANIFEST);

    const label = view.groups[0]!.subjects[0]!.label;
    expect(label).toBe("This page");
    expect(label).not.toContain("page-1");
  });

  it("keeps each query separate, with its own figures", () => {
    const query = (id: string, clicks: number): Evidence => ({
      ...gsc(CURRENT, { clicks, impressions: clicks * 12 }),
      id: `gsc:query:${id}:${CURRENT.start}..${CURRENT.end}`,
      metricKey: "gsc_query_window",
      sourceEntityId: id,
      contextJson: {
        subject: "query",
        periodStart: CURRENT.start,
        periodEnd: CURRENT.end,
        clicks,
        impressions: clicks * 12,
      },
    });

    const view = buildEvidenceView(
      [query("q1", 51), query("q2", 12)],
      MANIFEST,
      new Map([
        ["q1", "payroll software"],
        ["q2", "hr system"],
      ]),
    );

    const queries = view.groups[0]!.subjects.filter((subject) => subject.kind === "query");
    expect(queries).toHaveLength(2);
    expect(queries.map((subject) => subject.label).sort()).toEqual([
      "hr system",
      "payroll software",
    ]);

    // 51 is that one query's clicks. It is not, and must never be read as, a
    // count of queries.
    const payroll = queries.find((subject) => subject.label === "payroll software")!;
    expect(payroll.metrics.find((metric) => metric.key === "clicks")!.current).toBe(51);
  });
});

describe("the words around the numbers", () => {
  it("says how many queries contributed, in a sentence", () => {
    expect(describeQueryCoverage(51)).toBe("51 search queries contributed evidence in this period");
    expect(describeQueryCoverage(1)).toBe("1 search query contributed evidence in this period");
  });

  it("describes omitted evidence without mentioning a budget", () => {
    const text = describeOmitted([{ label: "Search Console", count: 14 }])!;

    expect(text).toBe(
      "14 additional Search Console evidence items were available but not included in this diagnosis package.",
    );
    expect(text).not.toMatch(/budget/i);
    expect(text).not.toMatch(/left out/i);
  });

  it("counts what was available alongside what was included", () => {
    const view = buildEvidenceView([gsc(CURRENT, { clicks: 1, impressions: 2 })], {
      ...MANIFEST,
      omitted: [{ category: "GSC_METRIC", count: 14 }],
    });

    expect(view.counts).toEqual({ included: 1, omitted: 14, available: 15 });
    expect(view.omitted).toEqual([{ label: "Search Console", count: 14 }]);
  });

  it("says nothing at all when nothing was omitted", () => {
    expect(describeOmitted([])).toBeNull();
  });
});

describe("formatting", () => {
  it("writes each metric the way that metric is read", () => {
    expect(formatMetric(6846, "integer")).toBe("6,846");
    expect(formatMetric(0.075, "percent")).toBe("7.5%");
    expect(formatMetric(8.42, "decimal")).toBe("8.4");
    expect(formatMetric(null, "integer")).toBe("Unknown");
  });

  it("gives a percentage for counts and points for rates and ranks", () => {
    const change = (current: number, previous: number, format: "integer" | "percent" | "decimal") =>
      formatChange({ key: "k", label: "K", current, previous, format });

    // A count moves by an amount first, because that is the fact a person
    // reads, with the proportion after it.
    expect(change(120, 100, "integer")).toEqual({ text: "+20 (+20.0%)", direction: "up" });
    expect(change(80, 100, "integer")).toEqual({ text: "-20 (-20.0%)", direction: "down" });
    // A rank is not a quantity: "up 20%" on average position means nothing.
    expect(change(9.4, 8.4, "decimal")).toEqual({ text: "+1.0", direction: "up" });
    expect(change(0.09, 0.075, "percent")).toEqual({ text: "+1.5 pts", direction: "up" });
    expect(change(100, 100, "integer")).toEqual({ text: "No change", direction: "flat" });
  });

  it("does not divide by a previous value of zero", () => {
    expect(
      formatChange({ key: "k", label: "K", current: 5, previous: 0, format: "integer" }),
    ).toEqual({ text: "+5", direction: "up" });
  });

  it("writes a period the way a person would", () => {
    // "Sept" rather than "Sep" is what en-GB actually abbreviates September to.
    expect(formatPeriod(CURRENT)).toBe("8 Aug – 4 Sept 2026");

    // The year appears on both ends only when the period crosses one.
    expect(formatPeriod({ start: "2025-12-20", end: "2026-01-16" })).toBe(
      "20 Dec 2025 – 16 Jan 2026",
    );
    expect(formatPeriod(null)).toBeNull();
  });

  it("reads dates as UTC, so a period does not shift with the reader's clock", () => {
    // A date-only value parsed in a western timezone would otherwise land on
    // the previous day and report a period that is off by one at both ends.
    expect(formatPeriod({ start: "2026-03-01", end: "2026-03-31" })).toBe("1 Mar – 31 Mar 2026");
  });
});

/**
 * The screen that was still wrong (P1/P3 observability, second pass).
 *
 * The evidence section at the top of the diagnosis had been rebuilt, but the
 * evidence cited by each individual finding had not, and that is what a reader
 * actually looks at. It still said:
 *
 *   Gsc metric
 *   Google Search Console · Reported by a connected provider · as of 2026-08-07
 *   Gsc page window: 6,846
 *
 * twice, once per window, as two unrelated cards. The two cards are one page
 * measured over two periods, and the only fact worth reading is that clicks
 * fell from 6,846 to 2,245.
 */
describe("the two cards that would not go away", () => {
  const PREVIOUS_WINDOW = { start: "2026-07-11", end: "2026-08-07" };
  const CURRENT_WINDOW = { start: "2026-08-08", end: "2026-09-04" };

  const MANIFEST: EvidenceManifest = {
    window: {
      start: CURRENT_WINDOW.start,
      end: CURRENT_WINDOW.end,
      comparisonStart: PREVIOUS_WINDOW.start,
      comparisonEnd: PREVIOUS_WINDOW.end,
    },
    omitted: [],
  };

  const record = (
    period: { start: string; end: string },
    clicks: number,
    impressions: number,
  ): Evidence => ({
    id: `gsc:page:page-1:${period.start}..${period.end}`,
    websiteId: "website-1",
    type: "GSC_METRIC",
    source: "Google Search Console",
    sourceEntityType: "GscMetricDaily",
    sourceEntityId: "page-1",
    capturedAt: null,
    asOfDate: new Date(`${period.end}T00:00:00.000Z`),
    metricKey: "gsc_page_window",
    numericValue: clicks,
    textValue: null,
    contextJson: {
      subject: "page",
      periodStart: period.start,
      periodEnd: period.end,
      clicks,
      impressions,
      ctr: clicks / impressions,
      position: 8.4,
    },
    reliability: "DIRECT_PROVIDER",
  });

  const cited = [record(PREVIOUS_WINDOW, 6846, 91_233), record(CURRENT_WINDOW, 2245, 64_102)];

  it("renders the two windows as one comparison, not two cards", () => {
    const view = buildEvidenceView(cited, MANIFEST, new Map([["page-1", "/pricing"]]));

    expect(view.groups).toHaveLength(1);
    const group = view.groups[0]!;
    expect(group.source).toBe("Google Search Console");

    // One thing measured, not two records standing alone.
    expect(group.subjects).toHaveLength(1);
    expect(group.records).toHaveLength(0);

    const clicks = group.subjects[0]!.metrics.find((metric) => metric.key === "clicks")!;
    expect(clicks.current).toBe(2245);
    expect(clicks.previous).toBe(6846);
  });

  it("states the fall from 6,846 to 2,245 as an amount and a proportion", () => {
    const view = buildEvidenceView(cited, MANIFEST);
    const clicks = view.groups[0]!.subjects[0]!.metrics.find((m) => m.key === "clicks")!;

    expect(formatMetric(clicks.current, clicks.format)).toBe("2,245");
    expect(formatMetric(clicks.previous, clicks.format)).toBe("6,846");

    const change = formatChange(clicks)!;
    expect(change.direction).toBe("down");
    expect(change.text).toContain("-4,601");
    expect(change.text).toContain("-67.2%");
  });

  it("says average position in points and never as a percentage", () => {
    const view = buildEvidenceView(cited, MANIFEST);
    const position = view.groups[0]!.subjects[0]!.metrics.find((m) => m.key === "position")!;

    // Both windows report 8.4, so the honest answer is that it did not move.
    expect(formatChange(position)).toEqual({ text: "No change", direction: "flat" });

    const moved = formatChange({ ...position, current: 9.9, previous: 8.4 })!;
    expect(moved.text).toBe("+1.5");
    expect(moved.text).not.toContain("%");
  });

  it("never emits the legacy labels anywhere in the view", () => {
    const rendered = JSON.stringify(buildEvidenceView(cited, MANIFEST));

    for (const legacy of [
      "Gsc metric",
      "Ga4 metric",
      "Gsc page window",
      "Ga4 page window",
      "Gsc query window",
      "gsc_page_window",
    ]) {
      expect(rendered).not.toContain(legacy);
    }
  });

  it("keeps both records citable behind the figures", () => {
    const view = buildEvidenceView(cited, MANIFEST);

    // Two cards became one row; two records are still two records.
    expect(view.groups[0]!.subjects[0]!.evidenceIds.sort()).toEqual(
      cited.map((entry) => entry.id).sort(),
    );
  });

  it("keeps provenance, stated once for the source", () => {
    const view = buildEvidenceView(cited, MANIFEST);
    const group = view.groups[0]!;

    expect(group.reliabilityLabel).toBe("Reported by a connected provider");
    // The newest date any record in the group is about.
    expect(group.dataThrough?.toISOString().slice(0, 10)).toBe("2026-09-04");
  });
});

/**
 * A single record that lands on a card rather than in a table — because it
 * belongs to neither window — must still name its number.
 */
describe("a record shown on its own", () => {
  const stray: Evidence = {
    id: "gsc:page:page-9:2026-01-01..2026-01-28",
    websiteId: "website-1",
    type: "GSC_METRIC",
    source: "Google Search Console",
    sourceEntityType: "GscMetricDaily",
    sourceEntityId: "page-9",
    capturedAt: null,
    asOfDate: new Date("2026-01-28T00:00:00.000Z"),
    metricKey: "gsc_page_window",
    numericValue: 6846,
    textValue: null,
    contextJson: null,
    reliability: "DIRECT_PROVIDER",
  };

  it("names the metric instead of the query that produced it", () => {
    expect(describeRecordValue(stray)).toBe("Clicks: 6,846");
    expect(describeRecordValue(stray)).not.toContain("window");
  });

  it("names GA4's headline metric too", () => {
    expect(describeRecordValue({ metricKey: "ga4_page_window", numericValue: 6529 })).toBe(
      "Sessions: 6,529",
    );
  });

  it("leaves a key that already reads properly alone", () => {
    expect(describeRecordValue({ metricKey: "search_volume", numericValue: 1200 })).toBe(
      "Search volume: 1,200",
    );
    expect(describeRecordValue({ metricKey: "word_count", numericValue: 820 })).toBe(
      "Word count: 820",
    );
  });

  it("gives a record a heading a person would use", () => {
    expect(evidenceHeading("GSC_METRIC")).toBe("Search Console measurement");
    expect(evidenceHeading("GA4_METRIC")).toBe("Analytics measurement");
    expect(evidenceHeading("PAGE_CONTENT")).toBe("Page content");

    for (const type of ["GSC_METRIC", "GA4_METRIC"]) {
      expect(evidenceHeading(type)).not.toBe("Gsc metric");
      expect(evidenceHeading(type)).not.toBe("Ga4 metric");
    }
  });
});

/**
 * The query count and the click count are different numbers from different
 * places, and the summary line must never confuse them.
 */
describe("counting queries versus counting clicks", () => {
  const WINDOW = { start: "2026-08-08", end: "2026-09-04" };
  const MANIFEST: EvidenceManifest = {
    window: {
      start: WINDOW.start,
      end: WINDOW.end,
      comparisonStart: "2026-07-11",
      comparisonEnd: "2026-08-07",
    },
    omitted: [],
  };

  const query = (id: string, clicks: number): Evidence => ({
    id: `gsc:query:${id}:${WINDOW.start}..${WINDOW.end}`,
    websiteId: "website-1",
    type: "GSC_METRIC",
    source: "Google Search Console",
    sourceEntityType: "GscMetricDaily",
    sourceEntityId: id,
    capturedAt: null,
    asOfDate: new Date(`${WINDOW.end}T00:00:00.000Z`),
    metricKey: "gsc_query_window",
    numericValue: clicks,
    textValue: null,
    contextJson: {
      subject: "query",
      periodStart: WINDOW.start,
      periodEnd: WINDOW.end,
      clicks,
      impressions: clicks * 20,
      ctr: 0.05,
      position: 6.1,
    },
    reliability: "DIRECT_PROVIDER",
  });

  it("shows one query's 51 clicks as clicks, never as a number of queries", () => {
    const view = buildEvidenceView(
      [query("q1", 51)],
      MANIFEST,
      new Map([["q1", "seo agency philippines"]]),
    );

    const queries = view.groups[0]!.subjects.filter((subject) => subject.kind === "query");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.label).toBe("seo agency philippines");

    const clicks = queries[0]!.metrics.find((metric) => metric.key === "clicks")!;
    expect(clicks.current).toBe(51);
    expect(formatMetric(clicks.current, clicks.format)).toBe("51");

    // The summary counts records, so one query is one query however many
    // clicks it had.
    expect(describeQueryCoverage(queries.length)).toBe(
      "1 search query contributed evidence in this period",
    );
    expect(describeQueryCoverage(queries.length)).not.toContain("51");
  });

  it("counts three query records as three, not as their clicks", () => {
    const view = buildEvidenceView(
      [query("q1", 51), query("q2", 12), query("q3", 4)],
      MANIFEST,
      new Map([
        ["q1", "seo agency philippines"],
        ["q2", "seo services"],
        ["q3", "seo audit"],
      ]),
    );

    const queries = view.groups[0]!.subjects.filter((subject) => subject.kind === "query");
    expect(queries).toHaveLength(3);

    const summary = describeQueryCoverage(queries.length);
    expect(summary).toBe("3 search queries contributed evidence in this period");

    // The clicks of the busiest query must never become the count.
    expect(summary).not.toContain("51");
    expect(summary).not.toContain("67");
  });

  it("keeps every query's own clicks separate", () => {
    const view = buildEvidenceView([query("q1", 51), query("q2", 12)], MANIFEST);
    const queries = view.groups[0]!.subjects.filter((subject) => subject.kind === "query");

    const clicks = queries
      .map((subject) => subject.metrics.find((metric) => metric.key === "clicks")!.current)
      .sort((a, b) => (b ?? 0) - (a ?? 0));

    expect(clicks).toEqual([51, 12]);
  });
});

/**
 * Saying how much a finding rests on, without saying it all again.
 *
 * The records are shown once, grouped and compared, at the top of the page.
 * Six findings each repeating those tables turned a diagnosis into six copies
 * of the same four numbers, which buries the findings in their own supporting
 * material. The link itself is untouched in the database; only the second
 * rendering of it is gone.
 */
describe("what a finding says about its evidence", () => {
  it("counts what supports and what contradicts, and points upward", () => {
    expect(describeCitedEvidence(2, 1)).toBe(
      "Evidence: 2 supporting · 1 contradicting — shown above.",
    );
  });

  it("names only the side that exists", () => {
    expect(describeCitedEvidence(9, 0)).toBe("Evidence: 9 supporting — shown above.");
    expect(describeCitedEvidence(0, 3)).toBe("Evidence: 3 contradicting — shown above.");
  });

  it("says so plainly when a finding cites nothing", () => {
    // A claim resting on no evidence is worth noticing, not hiding behind an
    // empty space.
    expect(describeCitedEvidence(0, 0)).toBe("No evidence cited for this finding.");
  });

  it("is a reference, never a rendering", () => {
    const line = describeCitedEvidence(2, 1);

    // No metric, no figure, no period: everything a table would carry is
    // absent, because the table is above.
    for (const leaked of ["Clicks", "Impressions", "CTR", "Average position", "Sessions", "vs"]) {
      expect(line).not.toContain(leaked);
    }
    expect(line.length).toBeLessThan(60);
  });
});
