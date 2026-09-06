import { describe, expect, it } from "vitest";

import { checkBrandFacts, checkClaimSafety, classifyHighRisk } from "@/lib/content/qa/claims";
import type { QaContext, QaSubject } from "@/lib/content/qa/types";

/**
 * Claims at QA time (M5 plan §7, §8, D7). Deterministic: a fact revoked
 * after the editorial approval makes its claim stale and blocks; a claim
 * with nothing behind it blocks when it is high-risk and warns when it is
 * ordinary; and high-risk assertions said in words, not digits, are found.
 */

const FACT_A = "11111111-1111-4111-8111-111111111111";
const FACT_B = "22222222-2222-4222-8222-222222222222";
const CTX = "33333333-3333-4333-8333-333333333333";

const ctx: QaContext = {
  siteHost: "example.com",
  facts: [
    { id: FACT_A, value: "Payslips follow BIR formats", approved: true },
    { id: FACT_B, value: "Trusted by 10,000 businesses", approved: false },
  ],
  rules: [],
  contextVersion: {
    id: CTX,
    prohibitedClaims: ["Guaranteed compliance"],
    avoidTopics: ["Tax evasion"],
  },
  brief: {
    requiredSections: [],
    keyQuestions: [],
    linkTargets: [],
    approvedClaims: [
      {
        text: "Payslips follow BIR formats",
        evidenceId: `fact:${FACT_A}`,
        ref: { kind: "fact", id: FACT_A },
      },
    ],
    primaryKeyword: "payroll software",
    secondaryKeywords: [],
    searchIntent: "COMMERCIAL",
    primaryConversion: null,
  },
  targetPage: null,
  otherPages: [],
  aiAvailable: false,
  checkerVersion: "qa-deterministic/test",
};

const subject = (overrides: Partial<QaSubject> = {}): QaSubject => ({
  workType: "CONTENT_REFRESH",
  title: "Payroll software in the Philippines",
  slug: "payroll-software-philippines",
  excerpt: null,
  metaTitle: null,
  metaDescription: "Compare payroll software for Philippine employers.",
  bodyMarkdown: "# Guide\n\n## What BIR compliance requires\n\nPayslips follow BIR formats.\n",
  claims: [],
  sectionsCovered: [],
  ...overrides,
});

describe("high-risk classification, without digits", () => {
  it("names the category of an assertion that needs an approved fact", () => {
    expect(classifyHighRisk("We are the best payroll software in the Philippines.")).toContain(
      "superlative",
    );
    expect(classifyHighRisk("Thousands of businesses run payroll with us.")).toContain("count");
    expect(classifyHighRisk("Our platform is fully compliant with BIR rules.")).toContain(
      "compliance",
    );
    expect(classifyHighRisk("We are ISO 27001 certified.")).toContain("certification");
    expect(classifyHighRisk("Faster than any spreadsheet.")).toContain("comparison");
    expect(classifyHighRisk("We guarantee accurate payroll.")).toContain("guarantee");
    expect(classifyHighRisk("Your data is never shared.")).toContain("guarantee");
    expect(classifyHighRisk("Cut payroll time in half.")).toContain("outcome");
    expect(classifyHighRisk("It will increase your conversions.")).toContain("outcome");
    expect(classifyHighRisk("Start your free trial today.")).toContain("price");
    expect(classifyHighRisk("Reduce errors by 40 percent.")).toContain("percentage");
  });

  it("leaves ordinary prose alone", () => {
    for (const sentence of [
      "Follow these best practices when you set up payroll.",
      "The best way to start is with one cohort.",
      "This guide explains what BIR compliance requires.",
      "Compliance is a moving target for small teams.",
      "It is easier than it looks once the first month is done.",
      "Cohort analysis is a leading indicator of retention, not a promise.",
      "Save the report before you leave the page.",
      "First, open the settings menu.",
      "The only thing you need is last month's payroll register.",
    ]) {
      expect(classifyHighRisk(sentence), sentence).toEqual([]);
    }
  });
});

describe("BRAND_FACT_VALIDATION", () => {
  it("passes claims whose facts are approved now", () => {
    const result = checkBrandFacts(
      subject({
        claims: [
          {
            text: "Payslips follow BIR formats",
            evidenceId: `fact:${FACT_A}`,
            ref: { kind: "fact", id: FACT_A },
          },
          {
            text: "Our voice is plain",
            evidenceId: `ctx:${CTX}`,
            ref: { kind: "context", id: CTX },
          },
        ],
      }),
      ctx,
    );
    expect(result.status).toBe("PASS");
    expect(result.findings).toEqual([]);
    expect(result.considered).toMatchObject({ claims: 2, supported: 2, approvedFacts: 1 });
  });

  it("blocks a claim whose fact was revoked after approval, in the spec's words", () => {
    const result = checkBrandFacts(
      subject({
        claims: [
          {
            text: "Trusted by 10,000 businesses",
            evidenceId: `fact:${FACT_B}`,
            ref: { kind: "fact", id: FACT_B },
          },
        ],
      }),
      ctx,
    );
    expect(result.status).toBe("FAIL");
    expect(result.findings[0]).toMatchObject({
      code: "STALE_CLAIM",
      severity: "BLOCKING",
      source: "DETERMINISTIC",
      refs: { factId: FACT_B },
    });
  });

  it("blocks a high-risk claim with nothing behind it, and warns for an ordinary one", () => {
    const result = checkBrandFacts(
      subject({
        claims: [
          { text: "Thousands of businesses trust us", evidenceId: null, ref: null },
          { text: "Our onboarding is friendly", evidenceId: null, ref: null },
        ],
      }),
      ctx,
    );
    expect(result.status).toBe("FAIL");
    expect(result.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ["MISSING_APPROVED_FACT", "BLOCKING"],
      ["UNSUPPORTED_CLAIM", "WARNING"],
    ]);
    expect(result.findings[0]!.message).toContain("MISSING APPROVED FACT");
  });

  it("treats evidence that does not resolve as unsupported, never as supported", () => {
    const result = checkBrandFacts(
      subject({
        claims: [
          {
            text: "We are certified",
            evidenceId: "fact:00000000-0000-4000-8000-000000000000",
            ref: { kind: "fact", id: "00000000-0000-4000-8000-000000000000" },
          },
          {
            text: "We are friendly",
            evidenceId: "nonsense",
            ref: { kind: "unknown", raw: "nonsense" },
          },
          { text: "Plain voice", evidenceId: "ctx:other", ref: { kind: "context", id: "other" } },
        ],
      }),
      ctx,
    );
    expect(result.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ["UNRESOLVED_EVIDENCE", "BLOCKING"],
      ["UNRESOLVED_EVIDENCE", "WARNING"],
      ["STALE_CLAIM", "BLOCKING"],
    ]);
  });
});

describe("CLAIM_SAFETY", () => {
  it("passes clean text, and says which judged parts are not built yet", () => {
    const result = checkClaimSafety(subject(), ctx);
    expect(result.findings.filter((finding) => finding.code !== "NOT_CHECKED")).toEqual([]);
    expect(result.status).toBe("PASS_WITH_WARNINGS");
    expect(
      result.coverage.filter((entry) => entry.status === "NOT_CHECKED").map((entry) => entry.check),
    ).toEqual(["unlisted_claims", "paraphrased_prohibitions"]);
    expect(result.coverage.find((entry) => entry.check === "unlisted_claims")?.reason).toBe(
      "NO_PROVIDER",
    );
  });

  it("blocks prohibited claims, avoid-topics, unapproved figures and high-risk assertions", () => {
    const result = checkClaimSafety(
      subject({
        bodyMarkdown:
          "# Guide\n\nWe offer guaranteed compliance for every employer. Some firms turn to tax evasion. Over 5,000 companies use us. We are the leading payroll platform in the region.\n",
      }),
      ctx,
    );
    expect(result.status).toBe("FAIL");
    const codes = result.findings
      .filter((finding) => finding.severity === "BLOCKING")
      .map((finding) => finding.code);
    expect(codes).toContain("PROHIBITED_CLAIM");
    expect(codes).toContain("AVOID_TOPIC");
    expect(codes).toContain("UNSUPPORTED_NUMERIC_CLAIM");
    expect(codes).toContain("HIGH_RISK_CLAIM");
    const highRisk = result.findings.find(
      (finding) =>
        finding.code === "HIGH_RISK_CLAIM" && finding.excerpt?.includes("leading payroll platform"),
    );
    expect(highRisk?.refs?.category).toContain("superlative");
    expect(highRisk?.excerpt).toContain("leading payroll platform");
  });

  it("exempts a sentence that carries an approved or supported claim", () => {
    const result = checkClaimSafety(
      subject({
        bodyMarkdown:
          "# Guide\n\nPayslips follow BIR formats, which is why 10,000 businesses picked us.\n",
        claims: [
          {
            text: "Payslips follow BIR formats",
            evidenceId: `fact:${FACT_A}`,
            ref: { kind: "fact", id: FACT_A },
          },
        ],
      }),
      ctx,
    );
    expect(result.findings.filter((finding) => finding.severity === "BLOCKING")).toEqual([]);
  });

  it("says when there is no approved context to check prohibitions against", () => {
    const result = checkClaimSafety(subject(), { ...ctx, contextVersion: null });
    expect(result.coverage.find((entry) => entry.check === "prohibited_claims")).toMatchObject({
      status: "NOT_CHECKED",
      reason: "NO_CONTEXT_VERSION",
    });
    expect(result.status).toBe("PASS_WITH_WARNINGS");
  });
});
