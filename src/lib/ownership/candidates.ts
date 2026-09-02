import type { OwnershipCandidateType } from "@/generated/prisma/client";

/**
 * Ownership observations (docs/P2_SPEC.md §13).
 *
 * The idea underneath P2: a team decides which page should own a keyword, and
 * Google decides which page actually ranks for it. Those two answers are often
 * different, and the gap is the most useful thing this phase knows.
 *
 * Every type here ends up rendered as something that was observed. The spec is
 * unusually blunt about the line, and it is worth restating because the temptation
 * is real:
 *
 *   Good — "The intended owner is /payroll-software/, but /blog/payroll-guide/
 *           ranked for this keyword in the latest snapshot."
 *   Bad  — "The blog post is cannibalizing the commercial page."
 *
 * The second sentence is a diagnosis. It might even be right. But it asserts a
 * causal mechanism nothing here measured, and once the product says it, someone
 * deletes a page on its authority. Confirming it is P3's job, with evidence P3 is
 * built to gather.
 *
 * Pure and dependency-free so the rules can be tested without a database.
 */

export type RankingObservation = {
  capturedAt: Date;
  pageId: string | null;
  path: string | null;
  rankingUrl: string | null;
  position: number | null;
};

export type OwnershipInput = {
  keywordId: string;
  keyword: string;
  /** The page a person nominated. Null when nobody has. */
  ownerPageId: string | null;
  ownerPath: string | null;
  /** Newest first. */
  rankings: RankingObservation[];
  /** Whether any provider has reported demand for this keyword. */
  hasDemand: boolean;
};

export type OwnershipCandidate = {
  type: OwnershipCandidateType;
  keywordId: string;
  /** The pages involved, for evidence. */
  ownerPageId: string | null;
  rankingPageId: string | null;
  ownerPath: string | null;
  rankingPath: string | null;
  rankingUrl: string | null;
  observedAt: Date | null;
  /** Distinct pages seen ranking in the window. */
  distinctPages: number;
  detail: Record<string, string | number | null>;
};

/** Two captures far enough apart that a switch is a change, not a wobble. */
export const SWITCH_WINDOW_DAYS = 90;

function distinctPageKeys(rankings: RankingObservation[]): string[] {
  const keys = new Set<string>();

  for (const ranking of rankings) {
    // A snapshot with no URL says the keyword ranked, not which page did.
    const key = ranking.pageId ?? ranking.rankingUrl;
    if (key) keys.add(key);
  }

  return [...keys];
}

function samePage(a: RankingObservation, b: RankingObservation): boolean {
  if (a.pageId && b.pageId) return a.pageId === b.pageId;
  if (a.rankingUrl && b.rankingUrl) return a.rankingUrl === b.rankingUrl;
  return false;
}

/**
 * Every ownership observation for one keyword.
 *
 * A keyword can produce several: a divergence and a switch describe different
 * things and both can be true at once.
 */
export function detectOwnershipCandidates(
  input: OwnershipInput,
): OwnershipCandidate[] {
  const candidates: OwnershipCandidate[] = [];
  const [latest, ...older] = input.rankings;
  const pages = distinctPageKeys(input.rankings);

  const base = {
    keywordId: input.keywordId,
    ownerPageId: input.ownerPageId,
    ownerPath: input.ownerPath,
    rankingPageId: latest?.pageId ?? null,
    rankingPath: latest?.path ?? null,
    rankingUrl: latest?.rankingUrl ?? null,
    observedAt: latest?.capturedAt ?? null,
    distinctPages: pages.length,
  };

  // Nobody has said which page should own this. Only worth raising when the
  // keyword matters — demand, or something already ranking for it.
  if (input.ownerPageId === null && (input.hasDemand || input.rankings.length > 0)) {
    candidates.push({
      ...base,
      type: "NO_OWNING_PAGE",
      detail: { rankingPages: pages.length },
    });
  }

  // The intended owner is not the page that ranked.
  if (
    input.ownerPageId !== null &&
    latest &&
    latest.pageId !== null &&
    latest.pageId !== input.ownerPageId
  ) {
    candidates.push({
      ...base,
      type: "RANKING_URL_DIVERGENCE",
      detail: { position: latest.position },
    });
  }

  // The page Google ranks changed between the two most recent captures. This is
  // a change in what Google chose, which is not the same as a change in position.
  const previous = older[0];
  if (latest && previous && !samePage(latest, previous)) {
    candidates.push({
      ...base,
      type: "RANKING_URL_SWITCH",
      detail: {
        from: previous.path ?? previous.rankingUrl,
        to: latest.path ?? latest.rankingUrl,
        switchedOn: latest.capturedAt.toISOString().slice(0, 10),
      },
    });
  }

  // More than one page of ours has ranked for this keyword in the window.
  if (pages.length > 1) {
    candidates.push({
      ...base,
      type: "MULTIPLE_RANKING_PAGES",
      detail: { pages: pages.length },
    });
  }

  // Divergence and multiple pages together. Still a candidate: pages trade
  // places on a SERP for reasons that have nothing to do with each other, and
  // whether these two interact is exactly what has not been established.
  const hasDivergence = candidates.some((c) => c.type === "RANKING_URL_DIVERGENCE");

  if (hasDivergence && pages.length > 1) {
    candidates.push({
      ...base,
      type: "CANNIBALIZATION_CANDIDATE",
      detail: { pages: pages.length },
    });
  }

  return candidates;
}
