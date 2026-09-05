import { describe, expect, it } from "vitest";

import { reconcileBriefClaims, reconcileRules } from "@/lib/content/reconcile";

describe("reconciling the pinned brief against the fresh package", () => {
  const claims = [
    { text: "Payslips follow BIR formats", evidenceId: "fact:a", source: "BRAND_FACT" },
    { text: "Trusted by 10,000 businesses", evidenceId: "fact:b", source: "BRAND_FACT" },
    { text: "Book a demo in minutes", evidenceId: "goal:g", source: "BRAND_FACT" },
  ];

  it("keeps claims whose fact is still approved and marks the rest stale, with reasons", () => {
    const packageTypes = new Map([
      ["fact:a", "BRAND_FACT"],
      ["goal:g", "BUSINESS_GOAL"],
      ["rule:r", "SEO_RULE"],
    ]);
    const result = reconcileBriefClaims(claims, packageTypes);

    expect(result.valid.map((c) => c.evidenceId)).toEqual(["fact:a"]);
    expect(result.stale.map((c) => [c.evidenceId, c.status])).toEqual([
      ["fact:b", "STALE"],
      ["goal:g", "STALE"],
    ]);
    expect(result.stale[0]!.reason).toMatch(/no longer approved, or was removed/);
    expect(result.stale[1]!.reason).toMatch(/not a brand fact/);
  });

  it("never rewrites a claim's text or id", () => {
    const result = reconcileBriefClaims(claims, new Map());
    expect(result.valid).toEqual([]);
    expect(result.stale.map((c) => c.text)).toEqual(claims.map((c) => c.text));
  });
});

describe("rules come from the package", () => {
  it("holds the draft to the package's rules and lists the brief's retired ones", () => {
    const briefRules = [
      { ruleId: "r1", evidenceId: "rule:r1", severity: "BLOCKING", rule: "No superlatives" },
      { ruleId: "r2", evidenceId: "rule:r2", severity: "INFO", rule: "Retired since" },
    ];
    const packageRules = [
      {
        ruleId: "r1",
        evidenceId: "rule:r1",
        severity: "BLOCKING",
        rule: "No superlatives",
        checkJson: null,
      },
      {
        ruleId: "r3",
        evidenceId: "rule:r3",
        severity: "WARNING",
        rule: "Added since",
        checkJson: null,
      },
    ];
    const result = reconcileRules(briefRules, packageRules);
    expect(result.active.map((r) => r.ruleId)).toEqual(["r1", "r3"]);
    expect(result.retired.map((r) => r.ruleId)).toEqual(["r2"]);
  });
});
