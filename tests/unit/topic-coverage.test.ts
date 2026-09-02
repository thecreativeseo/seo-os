import { describe, expect, it } from "vitest";

import { KEYWORDS_PER_PAGE, computeCoverage } from "@/lib/topic/coverage";

/**
 * Coverage is a rough judgement, and the tests hold it to being exactly that:
 * simple enough to explain in a sentence, and never presented as a measurement.
 */
describe("coverage", () => {
  it("is unmapped when nothing is mapped", () => {
    const result = computeCoverage({ keywordCount: 12, pages: [] });

    expect(result.status).toBe("UNMAPPED");
    expect(result.reason).toContain("12 keywords");
  });

  it("makes no claim when there are pages but no keywords", () => {
    // Nothing to be covered against, so nothing is asserted either way.
    const result = computeCoverage({
      keywordCount: 0,
      pages: [{ pageId: "a", role: "SUPPORTING" }],
    });

    expect(result.status).toBe("UNKNOWN");
    expect(result.keywordsPerPage).toBeNull();
  });

  it("is covered when the pages keep up with the keywords", () => {
    const result = computeCoverage({
      keywordCount: KEYWORDS_PER_PAGE,
      pages: [{ pageId: "a", role: "PILLAR" }],
    });

    expect(result.status).toBe("COVERED");
  });

  it("is partial once keywords outrun the pages", () => {
    const result = computeCoverage({
      keywordCount: KEYWORDS_PER_PAGE + 1,
      pages: [{ pageId: "a", role: "PILLAR" }],
    });

    expect(result.status).toBe("PARTIAL");
    expect(result.reason).toContain(`${KEYWORDS_PER_PAGE}-per-page`);
  });

  it("calls two pillars overlapping, however many keywords there are", () => {
    // A structural contradiction that "covered" would hide.
    const result = computeCoverage({
      keywordCount: 2,
      pages: [
        { pageId: "a", role: "PILLAR" },
        { pageId: "b", role: "PILLAR" },
      ],
    });

    expect(result.status).toBe("OVERLAPPING");
    expect(result.reason).toContain("pillar");
  });

  it("allows many supporting pages", () => {
    const result = computeCoverage({
      keywordCount: 6,
      pages: [
        { pageId: "a", role: "PILLAR" },
        { pageId: "b", role: "SUPPORTING" },
        { pageId: "c", role: "SUPPORTING" },
      ],
    });

    expect(result.status).toBe("COVERED");
  });

  it("always explains itself", () => {
    // A status the screen cannot justify is a number nobody can argue with,
    // which is the failure this whole module is shaped to avoid.
    const scenarios = [
      { keywordCount: 0, pages: [] },
      { keywordCount: 20, pages: [] },
      { keywordCount: 0, pages: [{ pageId: "a", role: "PILLAR" as const }] },
      { keywordCount: 3, pages: [{ pageId: "a", role: "PILLAR" as const }] },
      { keywordCount: 30, pages: [{ pageId: "a", role: "PILLAR" as const }] },
      {
        keywordCount: 4,
        pages: [
          { pageId: "a", role: "COMMERCIAL" as const },
          { pageId: "b", role: "COMMERCIAL" as const },
        ],
      },
    ];

    for (const scenario of scenarios) {
      expect(computeCoverage(scenario).reason.length).toBeGreaterThan(0);
    }
  });
});
