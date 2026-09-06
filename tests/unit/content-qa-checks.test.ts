import { describe, expect, it } from "vitest";

import {
  QA_CHECKER_VERSION,
  QA_TYPES,
  countFindings,
  deriveOutcome,
  deriveTypeStatus,
  inputsFingerprint,
  runDeterministicChecks,
  type QaContext,
  type QaFinding,
  type QaSubject,
} from "@/lib/content/qa";
import { checkDuplication } from "@/lib/content/qa/duplication";
import { checkLinks } from "@/lib/content/qa/links";
import { checkOnPage } from "@/lib/content/qa/on-page";
import { checkReadability } from "@/lib/content/qa/readability";
import { checkRules } from "@/lib/content/qa/rules";
import { checkStructure, parseLengthBand } from "@/lib/content/qa/structure";
import {
  extractHeadings,
  extractParagraphs,
  extractSections,
  jaccard,
  shingles,
  splitSentences,
} from "@/lib/content/qa/text";

/**
 * The deterministic checks (M5 plan §3, §5, §10-§12). Pure functions over a
 * subject and a context: the same input gives the same findings, and every
 * outcome is derived, never hand-set.
 */

const RULE_MAX = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RULE_PROSE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAGE_TARGET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PAGE_OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PAGE_PRICING = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FACT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const BODY = [
  "# Payroll software in the Philippines",
  "",
  "## What BIR compliance requires",
  "",
  "Payslips follow BIR formats. Every employer files the same forms, and the software fills them from the register.",
  "",
  "## Choosing a tool",
  "",
  "Start with the payroll register you already keep, then compare tools on the forms they file. See our [pricing](/pricing) and [read more](/guides/payroll-basics).",
  "",
].join("\n");

const ctx: QaContext = {
  siteHost: "example.com",
  facts: [{ id: FACT_ID, value: "Payslips follow BIR formats", approved: true }],
  rules: [
    {
      ruleId: RULE_MAX,
      rule: "Meta titles stay under 60 characters.",
      severity: "BLOCKING",
      check: { kind: "max_length", field: "meta_title", max: 60 },
    },
    {
      ruleId: RULE_PROSE,
      rule: "Write for HR leads, not for accountants.",
      severity: "BLOCKING",
      check: null,
    },
  ],
  contextVersion: { id: "ctx-1", prohibitedClaims: [], avoidTopics: [] },
  brief: {
    requiredSections: ["What BIR compliance requires", "Choosing a tool"],
    keyQuestions: ["Which payroll tools produce BIR-compliant payslips?"],
    linkTargets: [
      { pageId: PAGE_PRICING, path: "/pricing" },
      { pageId: PAGE_OTHER, path: "/guides/cohorts" },
    ],
    approvedClaims: [
      {
        text: "Payslips follow BIR formats",
        evidenceId: `fact:${FACT_ID}`,
        ref: { kind: "fact", id: FACT_ID },
      },
    ],
    primaryKeyword: "payroll software",
    secondaryKeywords: [
      { keyword: "payroll register", pages: [{ pageId: PAGE_OTHER, path: "/guides/cohorts" }] },
    ],
    searchIntent: "COMMERCIAL",
    primaryConversion: "Book a demo",
  },
  targetPage: {
    id: PAGE_TARGET,
    path: "/payroll-software",
    title: "Payroll software",
    metaDescription: "Old description",
    bodyText: "Our payroll software handles Philippine payroll end to end for growing teams.",
  },
  otherPages: [
    {
      id: PAGE_OTHER,
      path: "/guides/cohorts",
      title: "Cohort guide",
      metaDescription: "Compare payroll software for Philippine employers.",
      bodyText: "A guide to cohorts.",
    },
    { id: PAGE_PRICING, path: "/pricing", title: "Pricing", metaDescription: null, bodyText: null },
  ],
  aiAvailable: false,
  checkerVersion: QA_CHECKER_VERSION,
};

const subject = (overrides: Partial<QaSubject> = {}): QaSubject => ({
  workType: "CONTENT_REFRESH",
  title: "Payroll software in the Philippines: a buyer's guide",
  slug: "payroll-software",
  excerpt: null,
  metaTitle: "Payroll Software Philippines | Guide",
  metaDescription: "Compare payroll software for Philippine employers.",
  bodyMarkdown: BODY,
  claims: [],
  sectionsCovered: ["What BIR compliance requires", "Choosing a tool"],
  ...overrides,
});

const codes = (findings: QaFinding[]) => findings.map((finding) => finding.code);

describe("text helpers", () => {
  it("reads headings, sections, paragraphs and sentences out of markdown", () => {
    expect(extractHeadings(BODY).map((heading) => [heading.level, heading.text])).toEqual([
      [1, "Payroll software in the Philippines"],
      [2, "What BIR compliance requires"],
      [2, "Choosing a tool"],
    ]);
    const sections = extractSections(BODY);
    expect(sections[0]!.words).toBe(0);
    expect(sections[1]!.words).toBeGreaterThan(10);
    expect(extractParagraphs(BODY)).toHaveLength(2);
    expect(splitSentences("One. Two! Three? four")).toEqual(["One.", "Two!", "Three? four"]);
    expect(extractHeadings("```\n# not a heading\n```\n## real")).toEqual([
      { level: 2, text: "real", line: 3 },
    ]);
  });

  it("measures overlap with word shingles", () => {
    const a = shingles("one two three four five six seven eight nine ten", 4);
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, shingles("something else entirely different here now", 4))).toBe(0);
  });
});

describe("derivations", () => {
  const finding = (severity: QaFinding["severity"]): QaFinding => ({
    code: "RULE_FAILED",
    qaType: "SEO_RULE_VALIDATION",
    severity,
    source: "DETERMINISTIC",
    needsHumanConfirmation: false,
    message: "x",
    by: "t",
  });

  it("derives a type's status: blocking fails, no coverage is not checked, partial coverage warns", () => {
    expect(deriveTypeStatus([finding("BLOCKING")], [{ check: "a", status: "CHECKED" }])).toBe(
      "FAIL",
    );
    expect(
      deriveTypeStatus([], [{ check: "a", status: "NOT_CHECKED", reason: "NO_PROVIDER" }]),
    ).toBe("NOT_CHECKED");
    expect(
      deriveTypeStatus(
        [],
        [
          { check: "a", status: "CHECKED" },
          { check: "b", status: "NOT_CHECKED", reason: "NO_PROVIDER" },
        ],
      ),
    ).toBe("PASS_WITH_WARNINGS");
    expect(deriveTypeStatus([finding("INFO")], [{ check: "a", status: "CHECKED" }])).toBe("PASS");
    expect(deriveTypeStatus([finding("WARNING")], [{ check: "a", status: "CHECKED" }])).toBe(
      "PASS_WITH_WARNINGS",
    );
    // Blocking wins even when nothing else could run.
    expect(
      deriveTypeStatus(
        [finding("BLOCKING")],
        [{ check: "a", status: "NOT_CHECKED", reason: "NO_PROVIDER" }],
      ),
    ).toBe("FAIL");
  });

  it("derives the outcome: any FAIL fails, PASS needs every type to pass", () => {
    const type = (status: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "NOT_CHECKED") => ({
      qaType: "STRUCTURE" as const,
      status,
      source: "DETERMINISTIC" as const,
      findings: [],
      coverage: [],
      notCheckedReason: null,
      considered: {},
    });
    expect(deriveOutcome([type("PASS"), type("PASS")])).toBe("PASS");
    expect(deriveOutcome([type("PASS"), type("NOT_CHECKED")])).toBe("PASS_WITH_WARNINGS");
    expect(deriveOutcome([type("PASS_WITH_WARNINGS"), type("FAIL")])).toBe("FAIL");
    expect(
      countFindings([
        {
          ...type("PASS_WITH_WARNINGS"),
          findings: [finding("WARNING"), finding("INFO")],
          coverage: [{ check: "x", status: "NOT_CHECKED", reason: "NO_PROVIDER" }],
        },
      ]),
    ).toEqual({ blocking: 0, warning: 1, info: 1, notChecked: 1 });
  });

  it("fingerprints the inputs stably, and differently when a fact or rule changes", () => {
    const base = {
      contextVersionId: "ctx-1",
      facts: [
        { id: "f2", value: "b", approved: true },
        { id: "f1", value: "a", approved: true },
      ],
      rules: [{ ruleId: "r1", rule: "x", severity: "INFO", check: null }],
    };
    const reordered = { ...base, facts: [base.facts[1]!, base.facts[0]!] };
    expect(inputsFingerprint(base)).toBe(inputsFingerprint(reordered));
    expect(inputsFingerprint(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      inputsFingerprint({
        ...base,
        facts: [{ id: "f1", value: "a", approved: false }, base.facts[0]!],
      }),
    ).not.toBe(inputsFingerprint(base));
    expect(
      inputsFingerprint({ ...base, rules: [{ ...base.rules[0]!, severity: "BLOCKING" }] }),
    ).not.toBe(inputsFingerprint(base));
    expect(inputsFingerprint({ ...base, contextVersionId: "ctx-2" })).not.toBe(
      inputsFingerprint(base),
    );
  });
});

describe("SEO_RULE_VALIDATION", () => {
  it("measures machine rules and leaves prose rules for a person, flagged when BLOCKING", () => {
    const result = checkRules(
      subject({ metaTitle: "A meta title that is far longer than sixty characters allow here" }),
      ctx,
    );
    expect(result.status).toBe("FAIL");
    const failed = result.findings.find((finding) => finding.code === "RULE_FAILED");
    expect(failed).toMatchObject({
      severity: "BLOCKING",
      refs: { ruleId: RULE_MAX },
      field: "meta_title",
    });
    const prose = result.findings.find((finding) => finding.code === "NOT_CHECKED");
    expect(prose).toMatchObject({
      needsHumanConfirmation: true,
      refs: { ruleId: RULE_PROSE, reason: "NO_PROVIDER" },
    });
    expect(result.considered).toMatchObject({ machineRules: 1, textualRules: 1 });
  });

  it("passes with a warning when every machine rule is met and a prose rule waits", () => {
    const result = checkRules(subject(), ctx);
    expect(result.status).toBe("PASS_WITH_WARNINGS");
    expect(codes(result.findings)).toEqual(["NOT_CHECKED"]);
    expect(checkRules(subject(), { ...ctx, rules: [ctx.rules[0]!] }).status).toBe("PASS");
  });
});

describe("ON_PAGE_SEO", () => {
  it("finds long descriptions, duplicate descriptions, a missing keyword, and names the judged parts", () => {
    const result = checkOnPage(
      subject({
        title: "Cohorts",
        metaTitle: null,
        bodyMarkdown: "# Cohorts\n\n### Skipped\n\nText about retention.",
      }),
      ctx,
    );
    const found = codes(result.findings);
    expect(found).toContain("DUPLICATE_META");
    expect(found).toContain("KEYWORD_ABSENT");
    expect(found).toContain("HEADING_SKIP");
    expect(
      result.coverage.filter((entry) => entry.status === "NOT_CHECKED").map((entry) => entry.check),
    ).toEqual(["keyword_reads_naturally", "call_to_action"]);
    expect(result.status).toBe("PASS_WITH_WARNINGS");
  });

  it("treats the slug by the work type", () => {
    const taken = checkOnPage(subject({ workType: "NEW_CONTENT", slug: "cohorts" }), ctx);
    expect(codes(taken.findings)).toContain("SLUG_TAKEN");
    const differs = checkOnPage(subject({ slug: "payroll-tools" }), ctx);
    expect(codes(differs.findings)).toContain("SLUG_DIFFERS");
    const invalid = checkOnPage(subject({ slug: "/payroll software" }), ctx);
    expect(codes(invalid.findings)).toContain("SLUG_INVALID");
    const missing = checkOnPage(subject({ workType: "NEW_CONTENT", slug: null }), ctx);
    expect(missing.findings.find((finding) => finding.code === "SLUG_MISSING")?.severity).toBe(
      "WARNING",
    );
  });

  it("says when there is no keyword or no other page to compare against", () => {
    const result = checkOnPage(subject(), {
      ...ctx,
      otherPages: [],
      brief: { ...ctx.brief, primaryKeyword: null },
    });
    expect(result.coverage.find((entry) => entry.check === "primary_keyword")).toMatchObject({
      status: "NOT_CHECKED",
      reason: "NO_KEYWORD",
    });
    expect(result.coverage.find((entry) => entry.check === "duplicate_title_meta")).toMatchObject({
      status: "NOT_CHECKED",
      reason: "NO_OTHER_PAGES",
    });
  });
});

describe("STRUCTURE", () => {
  it("finds missing and empty sections and reads the length band", () => {
    expect(parseLengthBand("900-1,500 words")).toEqual([900, 1500]);
    expect(
      parseLengthBand("A title, meta title, meta description and a short body of 150-300 words"),
    ).toEqual([150, 300]);
    const result = checkStructure(
      subject({ bodyMarkdown: "# Title\n\n## Choosing a tool\n\n## Empty\n" }),
      ctx,
    );
    const found = codes(result.findings);
    expect(found).toContain("SECTION_UNMATCHED");
    expect(found).toContain("SECTION_EMPTY");
    expect(found).toContain("LENGTH_OUT_OF_BAND");
    expect(
      result.findings.find((finding) => finding.code === "SECTION_UNMATCHED")?.refs?.section,
    ).toBe("What BIR compliance requires");
  });

  it("warns for a required section nobody claims to have covered", () => {
    const result = checkStructure(
      subject({ bodyMarkdown: "# Title\n\n## Choosing a tool\n\nText.\n", sectionsCovered: [] }),
      ctx,
    );
    expect(result.findings.find((finding) => finding.code === "SECTION_MISSING")).toMatchObject({
      severity: "WARNING",
      refs: { section: "What BIR compliance requires" },
    });
  });
});

describe("INTERNAL_LINKING", () => {
  it("resolves internal links, names unused targets, generic anchors and suggested pages", () => {
    const result = checkLinks(
      subject({
        bodyMarkdown: `${BODY}\n[Broken](/nowhere) and [our site](https://www.example.com/pricing) and [elsewhere](https://other.example.org/x).\n`,
      }),
      ctx,
    );
    const found = codes(result.findings);
    expect(found).toContain("LINK_UNRESOLVED");
    expect(found).toContain("GENERIC_ANCHOR");
    expect(found).toContain("EXTERNAL_LINK");
    expect(found).toContain("LINK_TARGET_UNUSED");
    expect(
      result.findings.find((finding) => finding.code === "LINK_TARGET_UNUSED")?.refs?.pagePath,
    ).toBe("/guides/cohorts");
    // The unused brief target also owns a secondary keyword, so it is suggested.
    expect(found).toContain("LINK_SUGGESTED");
  });

  it("suggests pages that own the secondary keywords when they are not linked", () => {
    const result = checkLinks(subject({ bodyMarkdown: "# T\n\nNo links here.\n" }), ctx);
    expect(result.findings.find((finding) => finding.code === "LINK_SUGGESTED")).toMatchObject({
      severity: "INFO",
      refs: { pagePath: "/guides/cohorts" },
    });
    expect(result.status).toBe("PASS");
  });
});

describe("READABILITY and DUPLICATION_RISK", () => {
  it("measures long sentences and walls of text, and leaves voice to a judge", () => {
    const long = Array.from(
      { length: 4 },
      () =>
        "This sentence keeps going with clause after clause so that it runs well past thirty words before it finally reaches a full stop, which is exactly the kind of sentence a reader skims past without noticing what it said.",
    ).join(" ");
    const result = checkReadability(subject({ bodyMarkdown: `# T\n\n${long}\n` }), ctx);
    expect(codes(result.findings)).toContain("LONG_SENTENCES");
    expect(result.findings.find((finding) => finding.code === "LONG_SENTENCES")?.severity).toBe(
      "WARNING",
    );
    expect(result.coverage.find((entry) => entry.check === "brand_voice")).toMatchObject({
      status: "NOT_CHECKED",
      reason: "NO_PROVIDER",
    });
    const wall = checkReadability(
      subject({ bodyMarkdown: `# T\n\n${Array.from({ length: 130 }, () => "word").join(" ")}.\n` }),
      ctx,
    );
    expect(codes(wall.findings)).toContain("WALL_OF_TEXT");
  });

  it("reports an unchanged refresh and a near duplicate, and says when there is nothing to compare", () => {
    const text =
      "Our payroll software handles Philippine payroll end to end for growing teams. It files every BIR form from the register and keeps the payslips in the format the bureau expects.";
    const unchanged = checkDuplication(subject({ bodyMarkdown: `# T\n\n${text}\n` }), {
      ...ctx,
      targetPage: { ...ctx.targetPage!, bodyText: text },
    });
    expect(codes(unchanged.findings)).toContain("UNCHANGED_REFRESH");
    const near = checkDuplication(
      subject({ workType: "NEW_CONTENT", bodyMarkdown: `# T\n\n${text}\n` }),
      {
        ...ctx,
        targetPage: null,
        otherPages: [
          { id: PAGE_OTHER, path: "/dup", title: null, metaDescription: null, bodyText: text },
        ],
      },
    );
    expect(near.findings.find((finding) => finding.code === "NEAR_DUPLICATE")).toMatchObject({
      severity: "WARNING",
      refs: { pagePath: "/dup" },
    });
    const nothing = checkDuplication(subject(), {
      ...ctx,
      targetPage: { ...ctx.targetPage!, bodyText: null },
      otherPages: [],
    });
    expect(nothing.status).toBe("NOT_CHECKED");
    expect(nothing.coverage.map((entry) => entry.reason)).toEqual([
      "NO_PAGE_SNAPSHOT",
      "NO_OTHER_PAGES",
    ]);
  });
});

describe("the whole deterministic pass", () => {
  it("returns every type in the spec's order, deterministically, with the judged types not checked when there is no judge", () => {
    const first = runDeterministicChecks(subject(), ctx);
    const second = runDeterministicChecks(subject(), ctx);
    expect(first.map((result) => result.qaType)).toEqual([...QA_TYPES]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const byType = new Map(first.map((result) => [result.qaType, result]));
    expect(byType.get("INTENT_ALIGNMENT")).toMatchObject({
      status: "NOT_CHECKED",
      notCheckedReason: "NO_PROVIDER",
    });
    expect(byType.get("ANSWER_READINESS")).toMatchObject({
      status: "NOT_CHECKED",
      notCheckedReason: "NO_PROVIDER",
    });
    expect(byType.get("BRAND_FACT_VALIDATION")?.status).toBe("PASS");
    for (const result of first) {
      for (const finding of result.findings) {
        expect(finding.by).toBe(QA_CHECKER_VERSION);
        expect(finding.source).toBe("DETERMINISTIC");
      }
    }
    expect(deriveOutcome(first)).toBe("PASS_WITH_WARNINGS");
  });

  it("never lets a deterministic finding be anything but deterministic, and never PASS by absence", () => {
    const results = runDeterministicChecks(subject(), {
      ...ctx,
      brief: { ...ctx.brief, keyQuestions: [] },
    });
    const answers = results.find((result) => result.qaType === "ANSWER_READINESS");
    expect(answers).toMatchObject({ status: "NOT_CHECKED", notCheckedReason: "NO_KEY_QUESTIONS" });
    expect(
      results.every(
        (result) =>
          result.status !== "PASS" || result.coverage.every((entry) => entry.status === "CHECKED"),
      ),
    ).toBe(true);
  });
});
