import { describe, expect, it } from "vitest";

import {
  detectOwnershipCandidates,
  type OwnershipInput,
  type RankingObservation,
} from "@/lib/ownership/candidates";
import {
  DIAGNOSTIC_VOCABULARY,
  renderOwnershipCandidate,
} from "@/lib/ownership/templates";
import { CAUSAL_VOCABULARY, PRESCRIPTIVE_VOCABULARY } from "@/lib/signals/templates";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function ranking(
  overrides: Partial<RankingObservation> & { capturedAt: Date },
): RankingObservation {
  return {
    pageId: null,
    path: null,
    rankingUrl: null,
    position: null,
    ...overrides,
  };
}

function input(overrides: Partial<OwnershipInput> = {}): OwnershipInput {
  return {
    keywordId: "kw-1",
    keyword: "payroll software",
    ownerPageId: null,
    ownerPath: null,
    rankings: [],
    hasDemand: true,
    ...overrides,
  };
}

const typesOf = (candidates: { type: string }[]) => candidates.map((c) => c.type).sort();

describe("no owning page", () => {
  it("is raised for a keyword with demand and no owner", () => {
    const candidates = detectOwnershipCandidates(input({ hasDemand: true }));

    expect(typesOf(candidates)).toContain("NO_OWNING_PAGE");
  });

  it("is not raised for a keyword nobody has measured and nothing ranks for", () => {
    // Every unowned keyword being a finding would make the finding worthless.
    const candidates = detectOwnershipCandidates(
      input({ hasDemand: false, rankings: [] }),
    );

    expect(candidates).toHaveLength(0);
  });

  it("is raised when something ranks even without demand data", () => {
    const candidates = detectOwnershipCandidates(
      input({
        hasDemand: false,
        rankings: [ranking({ capturedAt: day("2026-08-30"), pageId: "page-a", position: 7 })],
      }),
    );

    expect(typesOf(candidates)).toContain("NO_OWNING_PAGE");
  });

  it("is not raised once a page owns the keyword", () => {
    const candidates = detectOwnershipCandidates(
      input({ ownerPageId: "page-a", ownerPath: "/payroll-software" }),
    );

    expect(typesOf(candidates)).not.toContain("NO_OWNING_PAGE");
  });
});

describe("divergence", () => {
  const diverging = input({
    ownerPageId: "page-owner",
    ownerPath: "/payroll-software",
    rankings: [
      ranking({
        capturedAt: day("2026-08-30"),
        pageId: "page-blog",
        path: "/blog/payroll-guide",
        position: 11,
      }),
    ],
  });

  it("is raised when the ranking page is not the owner", () => {
    expect(typesOf(detectOwnershipCandidates(diverging))).toContain(
      "RANKING_URL_DIVERGENCE",
    );
  });

  it("is not raised when the owner is the page ranking", () => {
    const agreeing = input({
      ownerPageId: "page-owner",
      ownerPath: "/payroll-software",
      rankings: [
        ranking({ capturedAt: day("2026-08-30"), pageId: "page-owner", position: 4 }),
      ],
    });

    expect(typesOf(detectOwnershipCandidates(agreeing))).not.toContain(
      "RANKING_URL_DIVERGENCE",
    );
  });

  it("is not raised when the ranking page is not in our inventory", () => {
    // A ranking URL we cannot resolve is not evidence that the owner is wrong;
    // it is evidence that we do not know what ranked.
    const unresolved = input({
      ownerPageId: "page-owner",
      ownerPath: "/payroll-software",
      rankings: [
        ranking({
          capturedAt: day("2026-08-30"),
          pageId: null,
          rankingUrl: "https://example.com/unknown",
          position: 9,
        }),
      ],
    });

    expect(typesOf(detectOwnershipCandidates(unresolved))).not.toContain(
      "RANKING_URL_DIVERGENCE",
    );
  });
});

describe("switches and multiple pages", () => {
  it("notices the ranking page changing between captures", () => {
    const switched = input({
      rankings: [
        ranking({ capturedAt: day("2026-08-30"), pageId: "page-b", path: "/b", position: 9 }),
        ranking({ capturedAt: day("2026-08-23"), pageId: "page-a", path: "/a", position: 8 }),
      ],
    });

    expect(typesOf(detectOwnershipCandidates(switched))).toContain("RANKING_URL_SWITCH");
  });

  it("does not call a stable ranking a switch", () => {
    const stable = input({
      rankings: [
        ranking({ capturedAt: day("2026-08-30"), pageId: "page-a", position: 9 }),
        ranking({ capturedAt: day("2026-08-23"), pageId: "page-a", position: 8 }),
      ],
    });

    expect(typesOf(detectOwnershipCandidates(stable))).not.toContain("RANKING_URL_SWITCH");
  });

  it("counts distinct pages, not captures", () => {
    const repeated = input({
      ownerPageId: "page-a",
      rankings: [
        ranking({ capturedAt: day("2026-08-30"), pageId: "page-a", position: 9 }),
        ranking({ capturedAt: day("2026-08-23"), pageId: "page-a", position: 8 }),
        ranking({ capturedAt: day("2026-08-16"), pageId: "page-a", position: 7 }),
      ],
    });

    expect(typesOf(detectOwnershipCandidates(repeated))).not.toContain(
      "MULTIPLE_RANKING_PAGES",
    );
  });
});

describe("the candidate people most want to jump ahead of", () => {
  const overlapping = input({
    ownerPageId: "page-owner",
    ownerPath: "/payroll-software",
    rankings: [
      ranking({
        capturedAt: day("2026-08-30"),
        pageId: "page-blog",
        path: "/blog/payroll-guide",
        position: 11,
      }),
      ranking({
        capturedAt: day("2026-08-23"),
        pageId: "page-other",
        path: "/resources/payroll",
        position: 14,
      }),
    ],
  });

  it("needs both divergence and several pages", () => {
    expect(typesOf(detectOwnershipCandidates(overlapping))).toContain(
      "CANNIBALIZATION_CANDIDATE",
    );

    // Divergence alone is not enough: one page ranking instead of the intended
    // owner is a divergence, not an overlap.
    const onlyDivergence = input({
      ownerPageId: "page-owner",
      rankings: [ranking({ capturedAt: day("2026-08-30"), pageId: "page-blog", position: 11 })],
    });

    expect(typesOf(detectOwnershipCandidates(onlyDivergence))).not.toContain(
      "CANNIBALIZATION_CANDIDATE",
    );
  });
});

/**
 * The language rule. P1 forbids causal and prescriptive wording; P2 adds a third
 * denylist because this is the finding people most want to state as a conclusion.
 */
describe("wording stays observational", () => {
  const everyType = [
    input({ hasDemand: true }),
    input({
      ownerPageId: "page-owner",
      ownerPath: "/payroll-software",
      rankings: [
        ranking({
          capturedAt: day("2026-08-30"),
          pageId: "page-blog",
          path: "/blog/payroll-guide",
          position: 11,
        }),
        ranking({
          capturedAt: day("2026-08-23"),
          pageId: "page-other",
          path: "/resources/payroll",
          position: 14,
        }),
      ],
    }),
  ].flatMap((scenario) => detectOwnershipCandidates(scenario));

  it("covers every candidate type", () => {
    // If a type is added without a scenario here, its wording goes unchecked.
    expect(new Set(everyType.map((candidate) => candidate.type)).size).toBe(5);
  });

  it("never claims one page harms another", () => {
    for (const candidate of everyType) {
      const copy = renderOwnershipCandidate(candidate);
      const text = `${copy.headline} ${copy.detail}`;

      expect(text).not.toMatch(DIAGNOSTIC_VOCABULARY);
    }
  });

  it("never explains why or recommends what to do", () => {
    for (const candidate of everyType) {
      const copy = renderOwnershipCandidate(candidate);
      const text = `${copy.headline} ${copy.detail}`;

      expect(text).not.toMatch(CAUSAL_VOCABULARY);
      expect(text).not.toMatch(PRESCRIPTIVE_VOCABULARY);
    }
  });

  it("says plainly that the interaction is not established", () => {
    const overlap = everyType.find(
      (candidate) => candidate.type === "CANNIBALIZATION_CANDIDATE",
    );

    expect(overlap).toBeDefined();
    expect(renderOwnershipCandidate(overlap!).detail).toMatch(/not been established/i);
  });

  it("catches the phrasing it exists to catch", () => {
    // Guarding the guard: a denylist that matches nothing is worse than none.
    expect("The blog post is cannibalizing the commercial page.").toMatch(
      DIAGNOSTIC_VOCABULARY,
    );
    expect("These pages are competing with each other.").toMatch(DIAGNOSTIC_VOCABULARY);
    expect("This page is hurting the other one.").toMatch(DIAGNOSTIC_VOCABULARY);
  });
});
