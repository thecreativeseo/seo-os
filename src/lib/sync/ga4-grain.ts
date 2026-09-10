import type { Ga4MetricName, Ga4Row } from "@/server/connectors/google/analytics";

/**
 * One stored row per landing page per day (P1 GA4 normalized-grain reliability).
 *
 * GA4 is asked for `landingPagePlusQueryString`, so it reports `/careers`,
 * `/careers/`, `/careers/index.html` and `/careers?utm_source=x` as four rows.
 * SEO OS stores landing-page metrics on (website, date, page), and page
 * identity is the normalized URL, which folds those four into one — on
 * purpose, so a page's sessions are not divided among the ways people reached
 * it. Folding the identity without folding the rows is the shape that failed
 * Search Console with SQLSTATE 21000, and GA4 has it too.
 *
 * GA4's metrics do not all add the way clicks do, which is why this is not the
 * Search Console rule with the names changed.
 *
 *   Sessions, engaged sessions, key events and revenue are counts and sums of
 *   events. A session that landed on `/careers?utm_source=x` and one that
 *   landed on `/careers` are two sessions on the same page, and add.
 *
 *   Total users and new users are unique-user counts: "the total number of
 *   people". The same person can land on both spellings on the same day and
 *   be counted once in each row. Adding the rows counts them twice; taking
 *   the larger, the smaller or the first invents a number GA4 never reported.
 *   There is no arithmetic that recovers the distinct count from its parts,
 *   so when rows collapse, users and new users become null — unknown — and
 *   only a page GA4 itself reported as one row keeps its user counts.
 *
 *   Engagement rate is not stored. Where it is shown it is computed from the
 *   stored engaged sessions and sessions, so the aggregate here is enough.
 *
 * The accumulator covers a whole date window, not a write chunk. Rows for the
 * same page can arrive in different provider pages and different chunks, and
 * a chunk-sized collapse would let the later chunk replace the earlier one.
 * What it holds is bounded by distinct (date, page) grains — a handful of
 * numbers each — never by rows, which is the property the streaming ingest
 * exists to keep.
 */

/** The unique index on ga4_landing_page_metric_daily, website implicit. */
export type Ga4GrainKey = { date: string; pageId: string };

export function ga4GrainKey(row: Ga4GrainKey): string {
  return `${row.date}|${row.pageId}`;
}

/** Metrics that add across rows of the same page and day. */
export const GA4_ADDITIVE_METRICS: readonly Ga4MetricName[] = [
  "sessions",
  "engagedSessions",
  "keyEvents",
  "totalRevenue",
];

/** Unique-user counts. Known only when GA4 reported the grain as one row. */
export const GA4_DISTINCT_METRICS: readonly Ga4MetricName[] = ["totalUsers", "newUsers"];

/** What is stored for one page on one day, with null meaning not measured. */
export type Ga4Measurement = {
  sessions: number | null;
  engagedSessions: number | null;
  users: number | null;
  newUsers: number | null;
  keyEvents: number | null;
  revenue: number | null;
  /** How many raw provider rows this measurement came from. */
  rawRows: number;
};

type Bucket = {
  date: string;
  /** The normalized URL, which is the page's identity before it has an id. */
  url: string;
  rawRows: number;
  sums: Partial<Record<Ga4MetricName, number>>;
  /** The user counts of the single raw row, kept only while there is one. */
  single: { totalUsers: number | null; newUsers: number | null } | null;
  /** Raw rows in arrival order, summed canonically at drain time. */
  revenueParts: number[];
};

/**
 * Accumulates a window's rows by grain and drains them as stored measurements.
 *
 * `available` says which metrics this property reports at all: a metric it
 * cannot report is null for every row, and a metric it can report but a row
 * lacks is zero, which is the connector's existing distinction between "not
 * counted" and "counted nothing".
 */
export class Ga4WindowAccumulator {
  private readonly buckets = new Map<string, Bucket>();
  private readonly measured: ReadonlySet<Ga4MetricName>;

  constructor(available: readonly Ga4MetricName[]) {
    this.measured = new Set(available);
  }

  /** Distinct grains held. Memory is proportional to this, not to rows. */
  get size(): number {
    return this.buckets.size;
  }

  add(date: string, url: string, metrics: Ga4Row["metrics"]): void {
    const key = `${date}|${url}`;
    const valueOf = (name: Ga4MetricName): number | null =>
      this.measured.has(name) ? (metrics[name] ?? 0) : null;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { date, url, rawRows: 0, sums: {}, single: null, revenueParts: [] };
      this.buckets.set(key, bucket);
    }

    bucket.rawRows += 1;

    for (const name of GA4_ADDITIVE_METRICS) {
      const value = valueOf(name);
      if (value === null) continue;
      if (name === "totalRevenue") {
        bucket.revenueParts.push(value);
      } else {
        bucket.sums[name] = (bucket.sums[name] ?? 0) + value;
      }
    }

    // One row: its user counts are GA4's own distinct counts for this page.
    // Two or more: nothing can be said, and the values are dropped for good.
    bucket.single =
      bucket.rawRows === 1
        ? { totalUsers: valueOf("totalUsers"), newUsers: valueOf("newUsers") }
        : null;
  }

  /** Every grain, one measurement each, in first-seen order. */
  drain(): (Ga4GrainKey & { url: string } & Ga4Measurement)[] {
    const out: (Ga4GrainKey & { url: string } & Ga4Measurement)[] = [];

    for (const bucket of this.buckets.values()) {
      out.push({
        date: bucket.date,
        pageId: "",
        url: bucket.url,
        rawRows: bucket.rawRows,
        sessions: this.measured.has("sessions") ? (bucket.sums.sessions ?? 0) : null,
        engagedSessions: this.measured.has("engagedSessions")
          ? (bucket.sums.engagedSessions ?? 0)
          : null,
        keyEvents: this.measured.has("keyEvents") ? (bucket.sums.keyEvents ?? 0) : null,
        revenue: this.measured.has("totalRevenue") ? sumCanonically(bucket.revenueParts) : null,
        users: bucket.single ? bucket.single.totalUsers : null,
        newUsers: bucket.single ? bucket.single.newUsers : null,
      });
    }

    this.buckets.clear();
    return out;
  }
}

/**
 * Revenue is the one non-integer sum, and floating-point addition is not
 * associative, so parts are added in a fixed order to make the result
 * independent of the order the provider sent them.
 */
function sumCanonically(parts: readonly number[]): number {
  return [...parts].sort((a, b) => a - b).reduce((sum, part) => sum + part, 0);
}

/** True when no two rows share a grain: what a single INSERT requires. */
export function hasUniqueGa4Grains(rows: readonly Ga4GrainKey[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = ga4GrainKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
