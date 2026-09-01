import { describe, expect, it } from "vitest";

import { computeReadiness, type ReadinessSnapshot } from "@/lib/readiness/compute";

/**
 * Command Center readiness (P0_ACCEPTANCE_CRITERIA "Command Center").
 *
 * The acceptance criterion is that the Next Best Step is deterministic, so these
 * assert exact outputs for exact inputs rather than "something sensible".
 */

const EMPTY: ReadinessSnapshot = {
  hasDomain: true,
  hasWebsiteType: false,
  hasApprovedContext: false,
  hasPrimaryCustomer: false,
  hasPrimaryConversion: false,
  hasPrimaryMarket: false,
  competitorCount: 0,
  activeGoalCount: 0,
  draftGoalCount: 0,
  approvedBrandFactCount: 0,
  proposedBrandFactCount: 0,
  activeSeoRuleCount: 0,
  connectedProviderCount: 0,
  providerCount: 7,
};

const COMPLETE: ReadinessSnapshot = {
  ...EMPTY,
  hasWebsiteType: true,
  hasApprovedContext: true,
  hasPrimaryCustomer: true,
  hasPrimaryConversion: true,
  hasPrimaryMarket: true,
  competitorCount: 4,
  activeGoalCount: 2,
  approvedBrandFactCount: 3,
  activeSeoRuleCount: 2,
};

function itemState(snapshot: ReadinessSnapshot, key: string) {
  return computeReadiness(snapshot).items.find((item) => item.key === key)?.state;
}

describe("determinism", () => {
  it("produces identical output for identical input", () => {
    const a = computeReadiness(COMPLETE);
    const b = computeReadiness(COMPLETE);
    expect(a).toEqual(b);
  });

  it("always reports the ten spec items in order", () => {
    const keys = computeReadiness(EMPTY).items.map((item) => item.key);
    expect(keys).toEqual([
      "website",
      "context",
      "customer",
      "conversion",
      "market",
      "competitors",
      "goals",
      "brandFacts",
      "seoRules",
      "connections",
    ]);
  });
});

describe("setup completion", () => {
  it("is 0% when nothing is described", () => {
    const readiness = computeReadiness(EMPTY);
    expect(readiness.percentage).toBe(0);
    expect(readiness.countedComplete).toBe(0);
  });

  it("is 100% when everything countable is done", () => {
    const readiness = computeReadiness(COMPLETE);
    expect(readiness.percentage).toBe(100);
    expect(readiness.countedComplete).toBe(9);
    expect(readiness.countedTotal).toBe(9);
  });

  it("excludes connections from the percentage", () => {
    // Nothing can be connected in P0, so counting it would cap completion for a
    // reason the user cannot act on.
    const readiness = computeReadiness(COMPLETE);
    expect(readiness.countedTotal).toBe(9);
    expect(readiness.items).toHaveLength(10);
    expect(itemState(COMPLETE, "connections")).toBe("INFORMATIONAL");
  });

  it("still reports the connection count honestly", () => {
    const readiness = computeReadiness({ ...COMPLETE, connectedProviderCount: 0 });
    const connections = readiness.items.find((item) => item.key === "connections");
    expect(connections?.detail).toBe("0 / 7");
  });

  it("rounds to whole percent", () => {
    // 5 of 9 complete = 55.55…%
    const readiness = computeReadiness({
      ...EMPTY,
      hasWebsiteType: true,
      hasApprovedContext: true,
      hasPrimaryCustomer: true,
      hasPrimaryConversion: true,
      hasPrimaryMarket: true,
    });
    expect(readiness.countedComplete).toBe(5);
    expect(readiness.percentage).toBe(56);
  });
});

describe("item rules", () => {
  it("needs a website type as well as a domain", () => {
    expect(itemState({ ...EMPTY, hasWebsiteType: false }, "website")).toBe("NEEDS_ATTENTION");
    expect(itemState({ ...EMPTY, hasWebsiteType: true }, "website")).toBe("COMPLETE");
  });

  it("treats context as done only once published", () => {
    expect(itemState({ ...EMPTY, hasApprovedContext: false }, "context")).toBe(
      "NEEDS_ATTENTION",
    );
    expect(itemState({ ...EMPTY, hasApprovedContext: true }, "context")).toBe("COMPLETE");
  });

  it("does not count a draft goal as a goal", () => {
    const drafts = { ...COMPLETE, activeGoalCount: 0, draftGoalCount: 8 };
    expect(itemState(drafts, "goals")).toBe("NEEDS_ATTENTION");

    const item = computeReadiness(drafts).items.find((entry) => entry.key === "goals");
    expect(item?.detail).toBe("8 in draft");
    expect(item?.action).toBe("Activate your business goals");
  });

  it("does not count an unapproved brand fact", () => {
    const proposed = { ...COMPLETE, approvedBrandFactCount: 0, proposedBrandFactCount: 3 };
    expect(itemState(proposed, "brandFacts")).toBe("NEEDS_ATTENTION");

    const item = computeReadiness(proposed).items.find((entry) => entry.key === "brandFacts");
    expect(item?.detail).toBe("3 awaiting review");
    expect(item?.action).toBe("Review your brand facts");
  });

  it("counts a single competitor as enough", () => {
    expect(itemState({ ...COMPLETE, competitorCount: 0 }, "competitors")).toBe(
      "NEEDS_ATTENTION",
    );
    expect(itemState({ ...COMPLETE, competitorCount: 1 }, "competitors")).toBe("COMPLETE");
  });
});

describe("next best step", () => {
  it("follows a fixed priority order", () => {
    // Everything missing: website comes first.
    expect(computeReadiness(EMPTY).nextBestStep?.label).toBe("Website");

    const cases: [Partial<ReadinessSnapshot>, string][] = [
      [{ hasWebsiteType: true }, "Business Context"],
      [{ hasWebsiteType: true, hasApprovedContext: true }, "Customer"],
      [
        { hasWebsiteType: true, hasApprovedContext: true, hasPrimaryCustomer: true },
        "Conversion",
      ],
      [
        {
          hasWebsiteType: true,
          hasApprovedContext: true,
          hasPrimaryCustomer: true,
          hasPrimaryConversion: true,
        },
        "Market",
      ],
      [
        {
          hasWebsiteType: true,
          hasApprovedContext: true,
          hasPrimaryCustomer: true,
          hasPrimaryConversion: true,
          hasPrimaryMarket: true,
        },
        "Competitors",
      ],
    ];

    for (const [overrides, expected] of cases) {
      expect(computeReadiness({ ...EMPTY, ...overrides }).nextBestStep?.label).toBe(expected);
    }
  });

  it("matches the blueprint scenario", () => {
    // Everything described except goals and brand facts — the blueprint's example.
    const snapshot: ReadinessSnapshot = {
      ...COMPLETE,
      activeGoalCount: 0,
      draftGoalCount: 3,
      approvedBrandFactCount: 0,
      proposedBrandFactCount: 2,
    };
    const readiness = computeReadiness(snapshot);

    expect(readiness.countedComplete).toBe(7);
    expect(readiness.percentage).toBe(78);
    expect(readiness.nextBestStep).toEqual({
      label: "Goals",
      action: "Activate your business goals",
      path: "goals",
    });
  });

  it("is null once everything countable is done", () => {
    expect(computeReadiness(COMPLETE).nextBestStep).toBeNull();
  });

  it("never points at connections", () => {
    // Connections is informational; it must never be presented as a step, because
    // nothing can be connected in this phase.
    const snapshot = { ...COMPLETE, connectedProviderCount: 0 };
    expect(computeReadiness(snapshot).nextBestStep).toBeNull();
  });
});

describe("no fabricated metrics", () => {
  it("reports nothing that is not derived from the snapshot", () => {
    const readiness = computeReadiness(EMPTY);
    const serialized = JSON.stringify(readiness).toLowerCase();

    for (const forbidden of ["clicks", "impressions", "ranking", "ctr", "traffic", "score"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
