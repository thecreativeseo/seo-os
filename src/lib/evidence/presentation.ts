import { RELIABILITY_LABELS, reliabilityRank, type Evidence } from "@/lib/evidence/types";

/**
 * Turning evidence records into something a person can read.
 *
 * The assembler produces a flat list of records because that is what the model
 * needs: one shape, citable by ID, no nesting. A person needs the opposite. Two
 * records that are the same measurement over two periods are one row with a
 * before and an after, and forty records from one provider are one table, not
 * forty cards.
 *
 * This module does that rearranging and nothing else. It reads no database, and
 * it never invents a number: every value here came off a record, and a value
 * that was not measured stays null rather than becoming a zero.
 *
 * The labelling bug it exists to fix
 * ----------------------------------
 * A windowed measurement is stored with `metricKey` of the form
 * `gsc_page_window`, and `numericValue` set to the headline figure — clicks for
 * Search Console, sessions for GA4. Rendering the key generically produced
 * "Gsc page window: 6,846", which names the shape of the query rather than what
 * was counted, and hides that the record also carries impressions, CTR and
 * position in its context. The number was always right; nothing ever said what
 * it was. So these keys are expanded here into the metrics they actually hold,
 * and every other metric key keeps rendering as it always has.
 */

export type Period = { start: string; end: string };

export type ManifestWindow = {
  start: string;
  end: string;
  comparisonStart: string;
  comparisonEnd: string;
};

export type EvidenceManifest = {
  window: ManifestWindow | null;
  included?: Record<string, number>;
  omitted?: { category: string; count: number; reason?: string }[];
};

export type MetricFormat = "integer" | "percent" | "decimal";

/** One measurement, over the current period and the one before it. */
export type MetricRow = {
  key: string;
  label: string;
  /** Null means not measured. It never means zero. */
  current: number | null;
  previous: number | null;
  format: MetricFormat;
};

export type SubjectKind = "site" | "page" | "query";

/** One thing measured — the site, a page, a search query — over both periods. */
export type MeasuredSubject = {
  key: string;
  kind: SubjectKind;
  label: string;
  metrics: MetricRow[];
  /** Every record folded into this row, for the provenance section. */
  evidenceIds: string[];
};

export type SourceGroup = {
  source: string;
  /** "Reported by a connected provider", and the like. */
  reliabilityLabel: string;
  /** The latest date any record in this group is about. */
  dataThrough: Date | null;
  current: Period | null;
  previous: Period | null;
  /** Windowed measurements, one entry per thing measured. */
  subjects: MeasuredSubject[];
  /** Records in this source that are not windowed measurements. */
  records: Evidence[];
};

export type OmittedGroup = { label: string; count: number };

export type EvidenceView = {
  groups: SourceGroup[];
  omitted: OmittedGroup[];
  counts: { included: number; omitted: number; available: number };
};

// ---------------------------------------------------------------------------
// What a windowed record actually holds
// ---------------------------------------------------------------------------

type MetricSpec = { key: string; label: string; format: MetricFormat };

/**
 * The metrics carried in a windowed record's context, in reading order.
 *
 * These mirror the aggregates the resolver runs. CTR and engagement rate are
 * stored as fractions and shown as percentages; position is impression-weighted
 * and shown to one decimal, as everywhere else in the product.
 */
const WINDOW_METRICS: Record<string, MetricSpec[]> = {
  gsc: [
    { key: "clicks", label: "Clicks", format: "integer" },
    { key: "impressions", label: "Impressions", format: "integer" },
    { key: "ctr", label: "CTR", format: "percent" },
    { key: "position", label: "Average position", format: "decimal" },
  ],
  ga4: [
    { key: "sessions", label: "Sessions", format: "integer" },
    { key: "engagedSessions", label: "Engaged sessions", format: "integer" },
    { key: "engagementRate", label: "Engagement rate", format: "percent" },
    { key: "keyEvents", label: "Key events", format: "integer" },
    { key: "revenue", label: "Revenue", format: "decimal" },
  ],
};

const WINDOW_KEY = /^(gsc|ga4)_(site|page|query)_window$/;

/** The family and subject of a windowed metric key, or null if it is not one. */
export function parseWindowKey(
  metricKey: string | null,
): { family: "gsc" | "ga4"; subject: SubjectKind } | null {
  if (!metricKey) return null;
  const match = WINDOW_KEY.exec(metricKey);
  if (!match) return null;
  return { family: match[1] as "gsc" | "ga4", subject: match[2] as SubjectKind };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function periodOf(evidence: Evidence): Period | null {
  const context = evidence.contextJson;
  if (!context) return null;
  const start = context.periodStart;
  const end = context.periodEnd;
  if (typeof start !== "string" || typeof end !== "string") return null;
  return { start, end };
}

function samePeriod(a: Period | null, b: Period | null): boolean {
  return a !== null && b !== null && a.start === b.start && a.end === b.end;
}

// ---------------------------------------------------------------------------
// Building the view
// ---------------------------------------------------------------------------

/** A readable name for a page or query id, supplied by the reader. */
export type SubjectLabels = Map<string, string>;

const SUBJECT_FALLBACK: Record<SubjectKind, string> = {
  site: "Whole site",
  page: "This page",
  query: "Search query",
};

/**
 * Groups evidence by where it came from, folding paired windows together.
 *
 * A record is only paired with another when both name the same subject and the
 * manifest says which window each belongs to. Without a manifest window there
 * is nothing to call "previous", so each record stands on its own with its own
 * dates rather than being guessed into a comparison.
 */
export function buildEvidenceView(
  evidence: Evidence[],
  manifest: EvidenceManifest | null,
  labels: SubjectLabels = new Map(),
): EvidenceView {
  const window = manifest?.window ?? null;
  const current: Period | null = window ? { start: window.start, end: window.end } : null;
  const previous: Period | null = window
    ? { start: window.comparisonStart, end: window.comparisonEnd }
    : null;

  type Draft = {
    source: string;
    reliability: Evidence["reliability"];
    dataThrough: Date | null;
    subjects: Map<
      string,
      MeasuredSubject & {
        family: "gsc" | "ga4";
        values: Map<string, [number | null, number | null]>;
      }
    >;
    records: Evidence[];
  };

  const drafts = new Map<string, Draft>();

  const draftFor = (item: Evidence): Draft => {
    const existing = drafts.get(item.source);
    if (existing) {
      // The most cautious reliability in the group is the one worth showing.
      if (reliabilityRank(item.reliability) > reliabilityRank(existing.reliability)) {
        existing.reliability = item.reliability;
      }
      if (item.asOfDate && (!existing.dataThrough || item.asOfDate > existing.dataThrough)) {
        existing.dataThrough = item.asOfDate;
      }
      return existing;
    }

    const created: Draft = {
      source: item.source,
      reliability: item.reliability,
      dataThrough: item.asOfDate,
      subjects: new Map(),
      records: [],
    };
    drafts.set(item.source, created);
    return created;
  };

  for (const item of evidence) {
    const draft = draftFor(item);
    const windowed = parseWindowKey(item.metricKey);
    const period = periodOf(item);

    // Not a windowed measurement, or one we cannot place in a period: it keeps
    // its own card rather than being folded into a comparison it may not belong
    // in.
    if (!windowed || !period) {
      draft.records.push(item);
      continue;
    }

    const column = samePeriod(period, current) ? 0 : samePeriod(period, previous) ? 1 : null;

    if (column === null) {
      draft.records.push(item);
      continue;
    }

    const subjectKey = `${windowed.subject}:${item.sourceEntityId ?? "site"}`;
    let subject = draft.subjects.get(subjectKey);

    if (!subject) {
      subject = {
        key: subjectKey,
        kind: windowed.subject,
        family: windowed.family,
        label:
          (item.sourceEntityId ? labels.get(item.sourceEntityId) : undefined) ??
          SUBJECT_FALLBACK[windowed.subject],
        metrics: [],
        evidenceIds: [],
        values: new Map(),
      };
      draft.subjects.set(subjectKey, subject);
    }

    subject.evidenceIds.push(item.id);

    for (const spec of WINDOW_METRICS[windowed.family]!) {
      const raw = item.contextJson?.[spec.key];
      // A key the resolver never wrote is a metric this source does not report,
      // and is left out entirely. A key written as null was looked for and not
      // found, and is shown as unknown.
      if (raw === undefined) continue;

      const pair = subject.values.get(spec.key) ?? [null, null];
      pair[column] = numberOrNull(raw);
      subject.values.set(spec.key, pair);
    }
  }

  const groups: SourceGroup[] = [];

  for (const draft of drafts.values()) {
    const subjects: MeasuredSubject[] = [];

    for (const subject of draft.subjects.values()) {
      // In the order the provider's own metrics are usually read, not in
      // whatever order the records happened to arrive.
      const metrics: MetricRow[] = [];
      for (const spec of WINDOW_METRICS[subject.family]!) {
        const pair = subject.values.get(spec.key);
        if (!pair) continue;
        metrics.push({
          key: spec.key,
          label: spec.label,
          current: pair[0],
          previous: pair[1],
          format: spec.format,
        });
      }

      subjects.push({
        key: subject.key,
        kind: subject.kind,
        label: subject.label,
        metrics,
        evidenceIds: subject.evidenceIds,
      });
    }

    // Site totals before individual pages, pages before queries: the general
    // fact before the particular ones that make it up.
    const order: Record<SubjectKind, number> = { site: 0, page: 1, query: 2 };
    subjects.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));

    groups.push({
      source: draft.source,
      reliabilityLabel: RELIABILITY_LABELS[draft.reliability],
      dataThrough: draft.dataThrough,
      current: subjects.length > 0 ? current : null,
      previous: subjects.length > 0 ? previous : null,
      subjects,
      records: draft.records,
    });
  }

  // Measured sources first, then stated ones, then derived and inferred.
  groups.sort((a, b) => {
    const byMeasured = Number(b.subjects.length > 0) - Number(a.subjects.length > 0);
    return byMeasured !== 0 ? byMeasured : a.source.localeCompare(b.source);
  });

  const omitted = (manifest?.omitted ?? []).map((entry) => ({
    label: categoryLabel(entry.category),
    count: entry.count,
  }));

  const omittedTotal = omitted.reduce((sum, entry) => sum + entry.count, 0);

  return {
    groups,
    omitted,
    counts: {
      included: evidence.length,
      omitted: omittedTotal,
      available: evidence.length + omittedTotal,
    },
  };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Category enums as the source a person would name. */
const CATEGORY_LABELS: Record<string, string> = {
  GSC_METRIC: "Search Console",
  GA4_METRIC: "Analytics",
  KEYWORD_METRIC: "keyword",
  RANKING_SNAPSHOT: "ranking",
  COMPETITOR_OBSERVATION: "competitor",
  PAGE_CONTENT: "page content",
  INTERNAL_LINK: "internal link",
  BUSINESS_CONTEXT: "business context",
  BUSINESS_GOAL: "business goal",
  BRAND_FACT: "brand fact",
  SEO_RULE: "SEO rule",
  KEYWORD_OWNERSHIP: "keyword ownership",
  TOPIC_MAPPING: "topic mapping",
  TECHNICAL_FINDING: "technical finding",
  PREVIOUS_CHANGE: "previous change",
  PREVIOUS_DIAGNOSIS: "previous diagnosis",
  PREVIOUS_LEARNING: "previous learning",
  MANUAL_VERIFICATION: "manual verification",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.toLowerCase().replaceAll("_", " ");
}

/**
 * What was available but not included.
 *
 * The old wording said things were "left out to fit the budget", which describes
 * our context window rather than the customer's data and reads like an apology
 * for a limitation nobody asked about. The fact worth stating is the one that
 * bears on the diagnosis: more evidence existed, this much of it, of this kind.
 */
export function describeOmitted(omitted: OmittedGroup[]): string | null {
  if (omitted.length === 0) return null;

  const parts = omitted.map((entry) => {
    const noun = `${entry.label} evidence item${entry.count === 1 ? "" : "s"}`;
    return `${entry.count.toLocaleString("en-GB")} additional ${noun}`;
  });

  const list =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;

  return `${list} ${parts.length === 1 && omitted[0]!.count === 1 ? "was" : "were"} available but not included in this diagnosis package.`;
}

/** How many search queries contributed evidence, said as a sentence. */
export function describeQueryCoverage(count: number): string {
  return count === 1
    ? "1 search query contributed evidence in this period"
    : `${count.toLocaleString("en-GB")} search queries contributed evidence in this period`;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** A measured value, or the word for not having one. Never a fabricated zero. */
export function formatMetric(value: number | null, format: MetricFormat): string {
  if (value === null) return "Unknown";

  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  if (format === "decimal") return value.toFixed(1);
  return Math.round(value).toLocaleString("en-GB");
}

export type Change = { text: string; direction: "up" | "down" | "flat" } | null;

/**
 * The movement between two periods.
 *
 * Only stated when both ends are known. A percentage against a previous value
 * of zero is not a percentage, so that case says how much it moved instead.
 */
export function formatChange(row: MetricRow): Change {
  const { current, previous, format } = row;
  if (current === null || previous === null) return null;

  const delta = current - previous;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  if (direction === "flat") return { text: "No change", direction };

  const sign = delta > 0 ? "+" : "";

  // Position is a rank and CTR is already a proportion. A percentage change of
  // either is meaningless, so both move in points.
  if (format === "decimal" || format === "percent") {
    const points = format === "percent" ? `${(delta * 100).toFixed(1)} pts` : delta.toFixed(1);
    return { text: `${sign}${points}`, direction };
  }

  // A count moves by an amount first — that is the fact — with the proportion
  // after it, where there is a previous value to be a proportion of.
  const moved = `${sign}${Math.round(delta).toLocaleString("en-GB")}`;
  if (previous === 0) return { text: moved, direction };

  const percent = (delta / previous) * 100;
  return { text: `${moved} (${sign}${percent.toFixed(1)}%)`, direction };
}

/** A period as a person would write it: "8 Aug – 4 Sep 2026". */
export function formatPeriod(period: Period | null): string | null {
  if (!period) return null;

  const start = new Date(`${period.start}T00:00:00.000Z`);
  const end = new Date(`${period.end}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  const day = (date: Date, withYear: boolean) =>
    date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });

  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return `${day(start, !sameYear)} – ${day(end, true)}`;
}

/**
 * The heading for a single record, in words rather than an enum.
 *
 * `humanize` on the category produced "Gsc metric", which is the enum with its
 * underscores removed rather than a name for the thing. These are the names.
 */
const TYPE_HEADINGS: Record<string, string> = {
  GSC_METRIC: "Search Console measurement",
  GA4_METRIC: "Analytics measurement",
  KEYWORD_METRIC: "Keyword demand",
  RANKING_SNAPSHOT: "Ranking position",
  COMPETITOR_OBSERVATION: "Competitor position",
  PAGE_CONTENT: "Page content",
  INTERNAL_LINK: "Internal link",
  BUSINESS_CONTEXT: "Business context",
  BUSINESS_GOAL: "Business goal",
  BRAND_FACT: "Brand fact",
  SEO_RULE: "SEO rule",
  KEYWORD_OWNERSHIP: "Keyword ownership",
  TOPIC_MAPPING: "Topic mapping",
  TECHNICAL_FINDING: "Technical finding",
  PREVIOUS_CHANGE: "Previous change",
  PREVIOUS_DIAGNOSIS: "Previous diagnosis",
  PREVIOUS_LEARNING: "Previous learning",
  MANUAL_VERIFICATION: "Manual verification",
};

export function evidenceHeading(type: string): string {
  const known = TYPE_HEADINGS[type];
  if (known) return known;
  const words = type.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a single record's number is, said properly.
 *
 * A windowed record's key names the query that produced it rather than the
 * figure it holds, so the figure is named here instead: clicks for Search
 * Console, sessions for GA4. This is the last line of defence — grouped
 * rendering pairs these records into tables and never reaches this function —
 * but a record that falls outside both windows still lands on a card, and it
 * must not be the one place "Gsc page window" survives.
 */
export function describeRecordValue(evidence: {
  metricKey: string | null;
  numericValue: number | null;
}): string | null {
  const windowed = parseWindowKey(evidence.metricKey);

  if (windowed) {
    const headline = WINDOW_METRICS[windowed.family]![0]!;
    if (evidence.numericValue === null) return headline.label;
    return `${headline.label}: ${formatMetric(evidence.numericValue, headline.format)}`;
  }

  if (evidence.numericValue === null) {
    return evidence.metricKey ? humanizeKey(evidence.metricKey) : null;
  }

  const shown = Number.isInteger(evidence.numericValue)
    ? evidence.numericValue.toLocaleString("en-GB")
    : evidence.numericValue.toFixed(2);

  return evidence.metricKey ? `${humanizeKey(evidence.metricKey)}: ${shown}` : shown;
}

/** A metric key as words. Only used for keys that already read meaningfully. */
function humanizeKey(key: string): string {
  const words = key.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * How much evidence a finding cites, in one line.
 *
 * The records themselves are shown once, at the top of the page, grouped and
 * compared. Repeating those tables under every finding made the same figures
 * appear five and six times on one screen, which buries the findings rather
 * than supporting them.
 *
 * What a finding still needs to say is how much it rests on, so a reader can
 * tell a claim backed by nine records from one backed by none, and knows where
 * to look. The link between finding and evidence is unchanged in the database;
 * only the second rendering of it is gone.
 */
export function describeCitedEvidence(supporting: number, contradicting: number): string {
  if (supporting === 0 && contradicting === 0) return "No evidence cited for this finding.";

  const parts: string[] = [];
  if (supporting > 0) parts.push(`${supporting} supporting`);
  if (contradicting > 0) parts.push(`${contradicting} contradicting`);

  return `Evidence: ${parts.join(" · ")} — shown above.`;
}
