import { describe, expect, it } from "vitest";

import {
  CONTENT_DRAFT_SCHEMAS,
  CONTENT_DRAFT_SCHEMA_VERSION,
  CONTENT_DRAFT_V2_LIMITS,
  contentDraftSchema,
  contentDraftSchemaV1,
  contentDraftSchemaV2,
  type ContentDraftOutput,
} from "@/lib/ai/schemas/content-draft";

/**
 * Content draft output schema version 2 (the real-provider fix): a strict
 * object with every list required as an array, more room for an open
 * question and the change summary, and everything else exactly as version 1
 * had it.
 */

const complete: ContentDraftOutput = {
  title: "Payroll software in the Philippines: a buyer's guide",
  slug: "payroll-software-philippines",
  excerpt: "How to shortlist payroll software that handles BIR requirements.",
  meta_title: "Payroll Software Philippines | Guide",
  meta_description: "Compare payroll software for Philippine employers.",
  body_markdown: "# Guide\n\n## What BIR compliance requires\n\nPayslips follow BIR formats.\n",
  claims: [
    {
      text: "Payslips follow BIR formats",
      evidence_id: "fact:00000000-0000-4000-8000-000000000001",
    },
    { text: "Fast", evidence_id: null },
  ],
  internal_links_used: [
    { evidence_id: "own:00000000-0000-4000-8000-000000000002", anchor_text: "pricing" },
  ],
  sections_covered: ["What BIR compliance requires"],
  open_questions: ["What does the starter plan cost?"],
  change_summary: "First draft from the brief.",
};

const LISTS = ["claims", "internal_links_used", "sections_covered", "open_questions"] as const;

describe("the content draft output schema, version 2", () => {
  it("is the current version, and both versions are on record", () => {
    expect(CONTENT_DRAFT_SCHEMA_VERSION).toBe("2");
    expect(contentDraftSchema).toBe(contentDraftSchemaV2);
    expect(CONTENT_DRAFT_SCHEMAS["1"]).toBe(contentDraftSchemaV1);
    expect(CONTENT_DRAFT_SCHEMAS["2"]).toBe(contentDraftSchemaV2);
    expect(CONTENT_DRAFT_V2_LIMITS).toEqual({ openQuestion: 500, changeSummary: 1000 });
  });

  it("accepts a complete draft", () => {
    expect(contentDraftSchemaV2.safeParse(complete).success).toBe(true);
  });

  it("requires every list to be present as an array - a missing or stringified list fails", () => {
    for (const list of LISTS) {
      const { [list]: _dropped, ...without } = complete;
      const missing = contentDraftSchemaV2.safeParse(without);
      expect(missing.success, `${list} missing`).toBe(false);
      if (!missing.success) {
        expect(missing.error.issues.map((issue) => issue.path.join("."))).toContain(list);
      }
      const stringified = contentDraftSchemaV2.safeParse({ ...complete, [list]: "one, two" });
      expect(stringified.success, `${list} as a string`).toBe(false);
      if (!stringified.success) {
        expect(stringified.error.issues[0]?.code).toBe("invalid_type");
      }
      expect(contentDraftSchemaV2.safeParse({ ...complete, [list]: [] }).success).toBe(true);
    }
  });

  it("refuses keys the schema does not name, at the root and inside items", () => {
    const extraRoot = contentDraftSchemaV2.safeParse({ ...complete, tone: "confident" });
    expect(extraRoot.success).toBe(false);
    if (!extraRoot.success) {
      expect(extraRoot.error.issues[0]?.code).toBe("unrecognized_keys");
    }
    expect(
      contentDraftSchemaV2.safeParse({
        ...complete,
        claims: [{ text: "Fast", evidence_id: null, confidence: 0.9 }],
      }).success,
    ).toBe(false);
    expect(
      contentDraftSchemaV2.safeParse({
        ...complete,
        internal_links_used: [{ evidence_id: "own:x", anchor_text: "pricing", url: "/pricing" }],
      }).success,
    ).toBe(false);
    // Version 1 strips them; that is what the historical runs were held to.
    expect(contentDraftSchemaV1.safeParse({ ...complete, tone: "confident" }).success).toBe(true);
  });

  it("keeps the canonical slug pattern: lowercase, digits, single hyphens, nothing else", () => {
    for (const good of ["payroll-software-philippines", "guide", "top-10-tools-2026"]) {
      expect(contentDraftSchemaV2.safeParse({ ...complete, slug: good }).success, good).toBe(true);
    }
    for (const bad of [
      "/payroll-software-philippines",
      "payroll-software-philippines/",
      "payroll software philippines",
      "payroll_software",
      "example.com/payroll-software",
      "https://example.com/payroll",
      "Payroll-Software",
      "-leading",
      "trailing-",
      "double--hyphen",
      "",
    ]) {
      const result = contentDraftSchemaV2.safeParse({ ...complete, slug: bad });
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["slug"]);
      }
    }
    expect(contentDraftSchemaV2.safeParse({ ...complete, slug: null }).success).toBe(true);
    // The slug key itself is required, as strict mode sends it.
    const { slug: _slug, ...withoutSlug } = complete;
    expect(contentDraftSchemaV2.safeParse(withoutSlug).success).toBe(false);
  });

  it("gives an open question and the change summary room, and only those", () => {
    const { openQuestion, changeSummary } = CONTENT_DRAFT_V2_LIMITS;
    expect(
      contentDraftSchemaV2.safeParse({ ...complete, open_questions: ["q".repeat(openQuestion)] })
        .success,
    ).toBe(true);
    const longQuestion = contentDraftSchemaV2.safeParse({
      ...complete,
      open_questions: ["q".repeat(openQuestion + 1)],
    });
    expect(longQuestion.success).toBe(false);
    if (!longQuestion.success) {
      expect(longQuestion.error.issues[0]?.path).toEqual(["open_questions", 0]);
      expect(longQuestion.error.issues[0]?.code).toBe("too_big");
    }
    expect(
      contentDraftSchemaV2.safeParse({ ...complete, change_summary: "s".repeat(changeSummary) })
        .success,
    ).toBe(true);
    const longSummary = contentDraftSchemaV2.safeParse({
      ...complete,
      change_summary: "s".repeat(changeSummary + 1),
    });
    expect(longSummary.success).toBe(false);
    if (!longSummary.success) {
      expect(longSummary.error.issues[0]?.path).toEqual(["change_summary"]);
      expect(longSummary.error.issues[0]?.code).toBe("too_big");
    }
    // Version 1 was tighter, and stays tighter.
    expect(
      contentDraftSchemaV1.safeParse({ ...complete, open_questions: ["q".repeat(301)] }).success,
    ).toBe(false);
    expect(
      contentDraftSchemaV1.safeParse({ ...complete, change_summary: "s".repeat(501) }).success,
    ).toBe(false);

    // Every other limit is unchanged from version 1.
    const unchanged: [keyof ContentDraftOutput, unknown][] = [
      ["title", "t".repeat(201)],
      ["slug", "s".repeat(121)],
      ["excerpt", "e".repeat(501)],
      ["meta_title", "m".repeat(201)],
      ["meta_description", "m".repeat(401)],
      ["body_markdown", "b".repeat(80_001)],
      ["claims", [{ text: "c".repeat(501), evidence_id: null }]],
      ["claims", [{ text: "Fast", evidence_id: "f".repeat(201) }]],
      ["internal_links_used", [{ evidence_id: "own:x", anchor_text: "a".repeat(201) }]],
      ["sections_covered", ["h".repeat(201)]],
      ["claims", Array.from({ length: 41 }, () => ({ text: "Fast", evidence_id: null }))],
      [
        "internal_links_used",
        Array.from({ length: 21 }, () => ({ evidence_id: "own:x", anchor_text: "a" })),
      ],
      ["sections_covered", Array.from({ length: 31 }, () => "h")],
      ["open_questions", Array.from({ length: 21 }, () => "q")],
    ];
    for (const [field, value] of unchanged) {
      expect(contentDraftSchemaV2.safeParse({ ...complete, [field]: value }).success, field).toBe(
        false,
      );
      expect(contentDraftSchemaV1.safeParse({ ...complete, [field]: value }).success, field).toBe(
        false,
      );
    }
  });

  it("keeps the claim and link shapes and the evidence id rules of version 1", () => {
    // A claim may say it has no fact behind it, but never omit the field.
    expect(
      contentDraftSchemaV2.safeParse({ ...complete, claims: [{ text: "Fast", evidence_id: null }] })
        .success,
    ).toBe(true);
    expect(
      contentDraftSchemaV2.safeParse({ ...complete, claims: [{ text: "Fast" }] }).success,
    ).toBe(false);
    expect(
      contentDraftSchemaV2.safeParse({ ...complete, claims: [{ text: "", evidence_id: null }] })
        .success,
    ).toBe(false);
    expect(
      contentDraftSchemaV2.safeParse({ ...complete, claims: [{ text: "Fast", evidence_id: "" }] })
        .success,
    ).toBe(false);
    // A link always names its evidence and its anchor.
    expect(
      contentDraftSchemaV2.safeParse({
        ...complete,
        internal_links_used: [{ evidence_id: "own:x" }],
      }).success,
    ).toBe(false);
    expect(
      contentDraftSchemaV2.safeParse({
        ...complete,
        internal_links_used: [{ evidence_id: null, anchor_text: "pricing" }],
      }).success,
    ).toBe(false);
    // The strings that are never null.
    for (const field of ["title", "body_markdown", "change_summary"] as const) {
      expect(contentDraftSchemaV2.safeParse({ ...complete, [field]: null }).success, field).toBe(
        false,
      );
      expect(contentDraftSchemaV2.safeParse({ ...complete, [field]: "" }).success, field).toBe(
        false,
      );
    }
    for (const field of ["excerpt", "meta_title", "meta_description"] as const) {
      expect(contentDraftSchemaV2.safeParse({ ...complete, [field]: null }).success, field).toBe(
        true,
      );
    }
  });
});
