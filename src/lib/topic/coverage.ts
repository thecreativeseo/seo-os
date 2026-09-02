import type { TopicCoverage, TopicPageRole } from "@/generated/prisma/client";

/**
 * Topic coverage (docs/P2_SPEC.md §14).
 *
 * The spec asks for something unusual and correct: "P2 should avoid pretending
 * topic authority is scientifically precise." Coverage is a rough judgement about
 * whether a subject has enough pages behind it, and dressing that up as a
 * measurement would be the kind of confident nonsense this product is built to
 * avoid.
 *
 * So the rule is deliberately simple, stated in full on screen, and overridable by
 * anyone who knows the topic better than a ratio does. What it must never be is a
 * number nobody can explain.
 */

/**
 * Above this many keywords per mapped page, a topic is treated as partially
 * covered. Roughly "one page cannot serve much more than a handful of related
 * searches well" — a rule of thumb, and labelled as one.
 */
export const KEYWORDS_PER_PAGE = 5;

export type CoverageInput = {
  keywordCount: number;
  /** Pages mapped to the topic, with the role each was given. */
  pages: { pageId: string; role: TopicPageRole }[];
};

export type CoverageResult = {
  status: TopicCoverage;
  /** Why, in words, so the screen never shows a status it cannot justify. */
  reason: string;
  keywordsPerPage: number | null;
};

/** Roles where two pages holding the same one is a contradiction, not a plan. */
const SINGULAR_ROLES: TopicPageRole[] = ["PILLAR", "COMMERCIAL"];

export function computeCoverage(input: CoverageInput): CoverageResult {
  const { keywordCount, pages } = input;
  const pageCount = pages.length;

  const duplicatedRole = SINGULAR_ROLES.find(
    (role) => pages.filter((page) => page.role === role).length > 1,
  );

  // Checked first: two pillar pages is a structural problem regardless of how
  // many keywords the topic has, and reporting "covered" would hide it.
  if (duplicatedRole) {
    return {
      status: "OVERLAPPING",
      reason: `More than one page is marked ${duplicatedRole.toLowerCase()} for this topic.`,
      keywordsPerPage: pageCount === 0 ? null : keywordCount / pageCount,
    };
  }

  if (pageCount === 0) {
    return {
      status: "UNMAPPED",
      reason:
        keywordCount > 0
          ? `${keywordCount} keywords are mapped to this topic and no page is.`
          : "No pages or keywords are mapped to this topic yet.",
      keywordsPerPage: null,
    };
  }

  if (keywordCount === 0) {
    // Pages but no keywords. Nothing to be covered against, so no claim is made.
    return {
      status: "UNKNOWN",
      reason: "No keywords are mapped to this topic, so coverage cannot be assessed.",
      keywordsPerPage: null,
    };
  }

  const ratio = keywordCount / pageCount;

  if (ratio > KEYWORDS_PER_PAGE) {
    return {
      status: "PARTIAL",
      reason: `${keywordCount} keywords across ${pageCount} page${pageCount === 1 ? "" : "s"}, above the ${KEYWORDS_PER_PAGE}-per-page guideline.`,
      keywordsPerPage: ratio,
    };
  }

  return {
    status: "COVERED",
    reason: `${keywordCount} keywords across ${pageCount} page${pageCount === 1 ? "" : "s"}.`,
    keywordsPerPage: ratio,
  };
}

export const COVERAGE_LABELS: Record<TopicCoverage, string> = {
  UNMAPPED: "Unmapped",
  PLANNED: "Planned",
  PARTIAL: "Partial",
  COVERED: "Covered",
  OVERLAPPING: "Overlapping",
  UNKNOWN: "Unknown",
};

export const ROLE_LABELS: Record<TopicPageRole, string> = {
  PILLAR: "Pillar",
  SUPPORTING: "Supporting",
  COMMERCIAL: "Commercial",
  UTILITY: "Utility",
  UNKNOWN: "Unassigned",
};

/**
 * The caveat shown wherever authority appears.
 *
 * Authority is a person's read of whether a site is taken seriously on a subject.
 * There is no measurement behind it and the interface says so rather than letting
 * a coloured badge imply one.
 */
export const AUTHORITY_CAVEAT =
  "Authority is a judgement recorded by your team, not a measurement.";
