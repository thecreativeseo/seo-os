import { describe, expect, it } from "vitest";

import { checkDraftConstraints, type ConstraintInput } from "@/lib/content/constraints";

const base: ConstraintInput = {
  mode: "ai",
  title: "Payroll software for Philippine employers",
  metaTitle: "Payroll software PH",
  metaDescription: "Compare payroll software.",
  excerpt: null,
  bodyMarkdown: "# Payroll\n\nOur payroll software produces BIR-compliant payslips.\n",
  prohibitedPhrases: ["Guaranteed compliance", "cheapest payroll software"],
  avoidTopics: ["tax evasion"],
  staleClaims: ["Trusted by 10,000 businesses"],
  approvedClaimTexts: ["BIR-compliant payslips"],
  allowedLinkPaths: ["/pricing"],
  siteHost: "sprout.example",
  rules: [],
};

function kinds(input: Partial<ConstraintInput>) {
  return checkDraftConstraints({ ...base, ...input }).findings.map(
    (f) => `${f.kind}:${f.severity}`,
  );
}

describe("prohibited claims, avoid-topics and stale claims", () => {
  it("blocks a prohibited claim wherever it appears, with an excerpt", () => {
    const result = checkDraftConstraints({
      ...base,
      bodyMarkdown: "We offer **guaranteed  compliance** for every client.",
    });
    expect(result.blocking).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "PROHIBITED_CLAIM",
        severity: "BLOCKING",
        field: "body",
        excerpt: expect.stringContaining("guaranteed compliance"),
      }),
    ]);
    expect(kinds({ title: "The cheapest payroll software in Manila" })).toContain(
      "PROHIBITED_CLAIM:BLOCKING",
    );
  });

  it("does not match inside other words", () => {
    expect(kinds({ bodyMarkdown: "Discheapest payroll softwareness" })).toEqual([]);
  });

  it("blocks an avoid-topic and a stale claim", () => {
    expect(kinds({ bodyMarkdown: "A note on tax evasion risks." })).toEqual([
      "AVOID_TOPIC:BLOCKING",
    ]);
    expect(kinds({ bodyMarkdown: "Trusted by 10,000 businesses since 2015." })).toEqual(
      expect.arrayContaining(["STALE_CLAIM:BLOCKING"]),
    );
  });
});

describe("figures nobody approved", () => {
  it("warns about percentages, money, counts and multipliers", () => {
    expect(kinds({ bodyMarkdown: "Cut payroll time by 40%." })).toEqual([
      "UNSUPPORTED_NUMERIC_CLAIM:WARNING",
    ]);
    expect(kinds({ bodyMarkdown: "Plans from $49 per month." })).toEqual([
      "UNSUPPORTED_NUMERIC_CLAIM:WARNING",
    ]);
    expect(kinds({ bodyMarkdown: "Used by 3,000 companies across Asia." })).toEqual([
      "UNSUPPORTED_NUMERIC_CLAIM:WARNING",
    ]);
    expect(kinds({ bodyMarkdown: "Runs 3x faster than spreadsheets." })).toEqual([
      "UNSUPPORTED_NUMERIC_CLAIM:WARNING",
    ]);
  });

  it("does not warn when the sentence carries an approved claim, or has no figure", () => {
    expect(
      kinds({
        bodyMarkdown: "BIR-compliant payslips for 100% of your employees.",
      }),
    ).toEqual([]);
    expect(kinds({ bodyMarkdown: "Payroll takes minutes, not days." })).toEqual([]);
  });
});

describe("links written by the model", () => {
  it("removes external links, keeps their text, and reports each once", () => {
    const result = checkDraftConstraints({
      ...base,
      bodyMarkdown:
        "See [our pricing](/pricing), [a study](https://research.example/x) and [it again](https://research.example/x).",
    });
    expect(result.bodyMarkdown).toBe("See [our pricing](/pricing), a study and it again.");
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "EXTERNAL_LINK_REMOVED",
        severity: "WARNING",
        url: "https://research.example/x",
      }),
    ]);
    expect(result.blocking).toBe(false);
  });

  it("treats links to the site's own host as internal", () => {
    expect(kinds({ bodyMarkdown: "[p](https://www.sprout.example/pricing)" })).toEqual([]);
    expect(kinds({ bodyMarkdown: "[p](/about)" })).toEqual(["LINK_TARGET_NOT_IN_BRIEF:INFO"]);
  });

  it("lets mailto and tel links through", () => {
    expect(kinds({ bodyMarkdown: "[mail](mailto:hi@sprout.example)" })).toEqual([]);
  });
});

describe("links written by a person", () => {
  it("keeps safe external links and flags them for QA", () => {
    const result = checkDraftConstraints({
      ...base,
      mode: "human",
      bodyMarkdown: "See [a study](https://research.example/x).",
    });
    expect(result.bodyMarkdown).toBe("See [a study](https://research.example/x).");
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "EXTERNAL_LINK_UNAPPROVED", severity: "WARNING" }),
    ]);
    expect(result.blocking).toBe(false);
  });

  it("removes an external link only when an explicit rule forbids it", () => {
    const result = checkDraftConstraints({
      ...base,
      mode: "human",
      bodyMarkdown: "See [a study](https://research.example/x).",
      rules: [{ ruleId: "r1", severity: "BLOCKING", check: { kind: "no_external_links" } }],
    });
    expect(result.bodyMarkdown).toBe("See a study.");
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "RULE_CHECK", severity: "BLOCKING", ruleId: "r1" }),
    ]);
    expect(result.blocking).toBe(true);
  });
});

describe("machine-checkable rules", () => {
  it("checks lengths, required phrases and forbidden phrases at the rule's severity", () => {
    const result = checkDraftConstraints({
      ...base,
      metaTitle: "A meta title that is far too long for any search result to show in full",
      rules: [
        {
          ruleId: "len",
          severity: "WARNING",
          check: { kind: "max_length", field: "meta_title", max: 60 },
        },
        {
          ruleId: "req",
          severity: "INFO",
          check: { kind: "required_phrase", field: "title", phrase: "Philippine" },
        },
        {
          ruleId: "req2",
          severity: "INFO",
          check: { kind: "required_phrase", field: "title", phrase: "Singapore" },
        },
        {
          ruleId: "forb",
          severity: "BLOCKING",
          check: { kind: "forbidden_phrase", phrase: "payroll" },
        },
        { ruleId: "odd", severity: "BLOCKING", check: { kind: "something_new" } },
      ],
    });
    const byRule = Object.fromEntries(result.findings.map((f) => [f.ruleId, f.severity]));
    expect(byRule).toEqual({ len: "WARNING", req2: "INFO", forb: "BLOCKING" });
    expect(result.blocking).toBe(true);
  });
});
