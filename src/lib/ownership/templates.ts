import type { OwnershipCandidate } from "@/lib/ownership/candidates";

/**
 * Ownership wording.
 *
 * P1 forbids causal and prescriptive language in signals. P2 needs a third rule,
 * because this phase surfaces the one finding people most want to jump ahead of:
 * two pages ranking for one keyword is not proof they harm each other, and the
 * word for that claim is a diagnosis nothing here measured.
 *
 * The vocabulary below is enforced by a test over the rendered output of every
 * candidate type, so the rule survives someone rewriting the copy later — which
 * is exactly when it would otherwise be lost.
 */

/**
 * Claims about pages harming each other. "Candidate" is not a hedge to be tidied
 * away; it is the difference between what was seen and what it means.
 */
export const DIAGNOSTIC_VOCABULARY =
  /\b(cannibali[sz](e|es|ed|ing|ation)|competing (against|with) (itself|each other)|steal(s|ing)?|hurt(s|ing)?|harm(s|ing)?|penali[sz](e|ed|ing)|conflict(s|ing)? with|undermin(e|es|ing))\b/i;

export type OwnershipCopy = { headline: string; detail: string };

function pageLabel(path: string | null, url: string | null): string {
  return path ?? url ?? "a page not in the inventory";
}

export function renderOwnershipCandidate(candidate: OwnershipCandidate): OwnershipCopy {
  const owner = pageLabel(candidate.ownerPath, null);
  const ranking = pageLabel(candidate.rankingPath, candidate.rankingUrl);

  switch (candidate.type) {
    case "NO_OWNING_PAGE":
      return {
        headline: "No page is assigned to own this keyword",
        detail:
          candidate.distinctPages > 0
            ? `${candidate.distinctPages} page${candidate.distinctPages === 1 ? " has" : "s have"} ranked for it, and none has been nominated as the owner.`
            : "Nothing has been nominated as the owner.",
      };

    case "RANKING_URL_DIVERGENCE":
      return {
        headline: "The ranking page is not the intended owner",
        detail: `The intended owner is ${owner}, and ${ranking} ranked for this keyword in the latest snapshot${
          candidate.detail.position ? ` at position ${candidate.detail.position}` : ""
        }.`,
      };

    case "RANKING_URL_SWITCH":
      return {
        headline: "The ranking page changed",
        detail: `${candidate.detail.from ?? "a page"} ranked for this keyword previously, and ${
          candidate.detail.to ?? "another page"
        } ranked in the capture on ${candidate.detail.switchedOn}.`,
      };

    case "MULTIPLE_RANKING_PAGES":
      return {
        headline: "More than one page has ranked for this keyword",
        detail: `${candidate.distinctPages} pages have appeared for this keyword in the last 90 days.`,
      };

    case "CANNIBALIZATION_CANDIDATE":
      return {
        headline: "Several pages rank for this keyword, and none is the intended owner",
        detail: `${candidate.distinctPages} pages have ranked for this keyword, and the page nominated to own it, ${owner}, is not the one ranking. Whether these pages affect one another has not been established.`,
      };
  }
}

export const CANDIDATE_LABELS: Record<OwnershipCandidate["type"], string> = {
  NO_OWNING_PAGE: "No owner",
  RANKING_URL_DIVERGENCE: "Owner differs",
  RANKING_URL_SWITCH: "Ranking page changed",
  MULTIPLE_RANKING_PAGES: "Multiple pages",
  CANNIBALIZATION_CANDIDATE: "Overlap candidate",
};
