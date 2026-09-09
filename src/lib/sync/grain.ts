/**
 * One stored row per persisted grain (P1 GSC normalized-grain aggregation).
 *
 * Search Console reports a page as the exact string it saw. `/careers`,
 * `/careers/`, `http://…/careers` and `/careers?utm_source=x` are four rows to
 * Search Console and one page to SEO OS, because page identity is the
 * normalized URL and the normalizer folds all four together — on purpose, so a
 * page's clicks are not split among its spellings. Queries fold the same way
 * across spacing, quotes and dashes.
 *
 * Folding identities without folding the rows that carry them produced, on
 * the ninth of September, a batch of five hundred rows in which the same
 * (website, date, page, query, country, device, search type) appeared twice.
 * Postgres refuses that in an `INSERT … ON CONFLICT DO UPDATE` — SQLSTATE
 * 21000, "cannot affect row a second time" — and the whole statement, and the
 * sync, failed. Every retry did the same, because the collision is a property
 * of the data, not of the moment.
 *
 * So rows that resolve to the same grain are collapsed into one before the
 * database sees them, and collapsed as measurements, not as duplicates. Clicks
 * and impressions of the same page for the same query on the same day are the
 * same thing counted under different spellings, and add. CTR is then clicks
 * over impressions of the whole, never an average of ratios. Position is
 * weighted by impressions, as it is everywhere else in the product: a rank
 * seen ten thousand times counts for more than one seen twice.
 *
 * A row with no collision passes through untouched, including its provider
 * CTR and position, so a dataset that never collided is stored exactly as it
 * was before this existed.
 */

/** The dimensions Search Console rows are stored on. The writer fixes the last three. */
export type GscGrainKey = {
  date: string;
  pageId: string;
  queryId: string;
  country: string;
  device: string;
  searchType: string;
};

export type GscMeasurement = {
  clicks: number;
  impressions: number;
  /** Null when there is nothing to compute it from. Never fabricated. */
  ctr: number | null;
  position: number | null;
};

/** What the writer fixes for every row it stores. Kept here so the key is the schema's key. */
export const GSC_FIXED_DIMENSIONS = { country: "ALL", device: "ALL", searchType: "WEB" } as const;

/**
 * The conflict key as one string: exactly the columns of the unique index on
 * gsc_metric_daily, in its order, with website implicit because a chunk is
 * always one website's.
 */
export function gscGrainKey(row: GscGrainKey): string {
  return [row.date, row.pageId, row.queryId, row.country, row.device, row.searchType].join("|");
}

/**
 * The measurement of a group of rows that are all the same grain.
 *
 * A group of one is returned as it came, so no arithmetic touches a row that
 * did not collide. A group of more is summed in a canonical order — by
 * position, then impressions, then clicks — so that the same rows arriving in
 * a different order from the provider produce a bit-identical result. Integer
 * sums are exact in any order; the impression-weighted position is a sum of
 * floating-point products, and floating-point addition is not associative.
 */
export function aggregateGscMeasurements<T extends GscMeasurement>(
  group: readonly T[],
): GscMeasurement {
  if (group.length === 1) {
    const only = group[0]!;
    return {
      clicks: only.clicks,
      impressions: only.impressions,
      ctr: only.ctr,
      position: only.position,
    };
  }

  const ordered = [...group].sort(
    (a, b) =>
      (a.position ?? -1) - (b.position ?? -1) ||
      a.impressions - b.impressions ||
      a.clicks - b.clicks,
  );

  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  let weightedImpressions = 0;

  for (const row of ordered) {
    clicks += row.clicks;
    impressions += row.impressions;
    // A row with no position has no rank to contribute, and its impressions
    // must not dilute the ranks that were reported.
    if (row.position !== null) {
      weightedPosition += row.position * row.impressions;
      weightedImpressions += row.impressions;
    }
  }

  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: weightedImpressions > 0 ? weightedPosition / weightedImpressions : null,
  };
}

/**
 * Collapses rows to one per grain, preserving every other field from the
 * group's first row in canonical order.
 *
 * Output order is the order in which each grain was first seen, which keeps a
 * chunk that had no collisions in the order it arrived.
 */
export function collapseGscRows<T extends GscGrainKey & GscMeasurement>(rows: readonly T[]): T[] {
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const key = gscGrainKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const collapsed: T[] = [];
  for (const group of groups.values()) {
    collapsed.push({ ...group[0]!, ...aggregateGscMeasurements(group) });
  }

  return collapsed;
}

/** True when no two rows share a grain. What the database requires of a batch. */
export function hasUniqueGscGrains(rows: readonly GscGrainKey[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = gscGrainKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
