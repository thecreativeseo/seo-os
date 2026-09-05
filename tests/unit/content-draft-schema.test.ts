import { describe, expect, it } from "vitest";

import { CONTENT_DRAFT_SCHEMA_VERSION, contentDraftSchema } from "@/lib/ai/schemas/content-draft";
import { PROMPTS, findPrompt } from "@/lib/ai/prompts/registry";
import { CONTENT_DRAFT_POLICY, findPolicy } from "@/lib/evidence/retrieval-policy";

const minimal = {
  title: "Payroll software in the Philippines",
  body_markdown: "# Payroll software\n\nA guide.",
  change_summary: "First draft from the brief.",
};

describe("the content draft output schema", () => {
  it("accepts a minimal draft and fills the rest with empties", () => {
    const parsed = contentDraftSchema.parse(minimal);
    expect(parsed.slug).toBeNull();
    expect(parsed.claims).toEqual([]);
    expect(parsed.internal_links_used).toEqual([]);
    expect(parsed.open_questions).toEqual([]);
    expect(parsed.meta_title).toBeNull();
  });

  it("requires a body and a change summary", () => {
    expect(contentDraftSchema.safeParse({ ...minimal, body_markdown: "" }).success).toBe(false);
    expect(contentDraftSchema.safeParse({ title: "t", body_markdown: "b" }).success).toBe(false);
  });

  it("accepts only URL-safe slugs", () => {
    expect(contentDraftSchema.safeParse({ ...minimal, slug: "payroll-software-ph" }).success).toBe(
      true,
    );
    expect(contentDraftSchema.safeParse({ ...minimal, slug: "Payroll Software" }).success).toBe(
      false,
    );
    expect(contentDraftSchema.safeParse({ ...minimal, slug: "-leading" }).success).toBe(false);
  });

  it("lets a claim say it has no fact behind it, but never omit the field", () => {
    const parsed = contentDraftSchema.parse({
      ...minimal,
      claims: [
        { text: "Payslips follow BIR formats", evidence_id: "fact:x" },
        { text: "Fast", evidence_id: null },
      ],
    });
    expect(parsed.claims[1]!.evidence_id).toBeNull();
    expect(contentDraftSchema.safeParse({ ...minimal, claims: [{ text: "Fast" }] }).success).toBe(
      true,
    );
  });
});

describe("the draft prompt and policy", () => {
  it("registers one active CONTENT_DRAFT / GENERATE_DRAFT prompt on this schema version", () => {
    const prompt = findPrompt("CONTENT_DRAFT", "GENERATE_DRAFT");
    expect(prompt?.active).toBe(true);
    expect(prompt?.outputSchemaVersion).toBe(CONTENT_DRAFT_SCHEMA_VERSION);
    expect(prompt?.systemInstructions).toMatch(/Never invent a fact/);
    expect(prompt?.systemInstructions).toMatch(/will be removed/);
  });

  it("keeps the page diagnosis prompt first, so nothing that reads PROMPTS by position moves", () => {
    expect(PROMPTS.find((prompt) => prompt.active)?.agentType).toBe("PAGE_DIAGNOSIS");
  });

  it("has a named, versioned content-draft policy that admits only approved facts", () => {
    expect(findPolicy("content-draft", 1)).toBe(CONTENT_DRAFT_POLICY);
    expect(CONTENT_DRAFT_POLICY.rules.join(" ")).toMatch(/APPROVED only, as of drafting time/);
    expect(CONTENT_DRAFT_POLICY.maxContentChars).toBeGreaterThanOrEqual(10_000);
  });
});
