import { describe, expect, it } from "vitest";

import {
  CONTENT_BRIEF_SCHEMA_VERSION,
  CONTENT_TYPES,
  SEARCH_INTENTS,
  contentBriefSchema,
} from "@/lib/ai/schemas/content-brief";
import { findPrompt } from "@/lib/ai/prompts/registry";
import { CONTENT_BRIEF_POLICY, findPolicy } from "@/lib/evidence/retrieval-policy";
import { KeywordIntent } from "@/generated/prisma/enums";

const minimal = {
  title: "Payroll Software Philippines: what to look for",
  content_type: "GUIDE",
  search_intent: "COMMERCIAL",
  audience: "HR leads at 50-500 person Philippine companies",
  customer_problem: "Choosing payroll software without knowing which compliance features matter.",
  desired_outcome: "The reader shortlists tools with confidence.",
  recommended_angle: "Compliance first, features second.",
};

describe("the content brief output schema", () => {
  it("accepts a minimal brief and fills the lists with empties", () => {
    const parsed = contentBriefSchema.parse(minimal);
    expect(parsed.key_questions).toEqual([]);
    expect(parsed.approved_claims).toEqual([]);
    expect(parsed.prohibited_claims).toEqual([]);
    expect(parsed.seo_rule_constraints).toEqual([]);
    expect(parsed.internal_link_targets).toEqual([]);
    expect(parsed.secondary_keyword_evidence_ids).toEqual([]);
    expect(parsed.missing_evidence).toEqual([]);
    expect(parsed.primary_conversion).toBeNull();
    expect(parsed.brand_voice_notes).toBeNull();
  });

  it("requires an evidence id on every claim, prohibition, rule and link", () => {
    expect(
      contentBriefSchema.safeParse({ ...minimal, approved_claims: [{ text: "Trusted by 10,000" }] })
        .success,
    ).toBe(false);
    expect(
      contentBriefSchema.safeParse({ ...minimal, prohibited_claims: [{ text: "No." }] }).success,
    ).toBe(false);
    expect(
      contentBriefSchema.safeParse({ ...minimal, seo_rule_constraints: [{ constraint: "x" }] })
        .success,
    ).toBe(false);
    expect(
      contentBriefSchema.safeParse({
        ...minimal,
        internal_link_targets: [{ anchor_text: "pricing", reason: "commercial" }],
      }).success,
    ).toBe(false);
  });

  it("refuses unknown content types and intents rather than widening them", () => {
    expect(contentBriefSchema.safeParse({ ...minimal, content_type: "WHITEPAPER" }).success).toBe(
      false,
    );
    expect(contentBriefSchema.safeParse({ ...minimal, search_intent: "BUY" }).success).toBe(false);
  });

  it("bounds every list, so a runaway answer cannot become a runaway row", () => {
    const tooMany = Array.from({ length: 13 }, (_, i) => `Question ${i}`);
    expect(contentBriefSchema.safeParse({ ...minimal, key_questions: tooMany }).success).toBe(
      false,
    );
  });

  it("offers the model exactly the intents the database knows", () => {
    expect([...SEARCH_INTENTS].sort()).toEqual(Object.values(KeywordIntent).sort());
    expect(CONTENT_TYPES).toContain("GUIDE");
  });
});

describe("the brief prompt and policy", () => {
  it("has one active prompt for CONTENT_BRIEF / GENERATE_BRIEF, on this schema version", () => {
    const prompt = findPrompt("CONTENT_BRIEF", "GENERATE_BRIEF");
    expect(prompt?.active).toBe(true);
    expect(prompt?.outputSchemaVersion).toBe(CONTENT_BRIEF_SCHEMA_VERSION);
    expect(prompt?.systemInstructions).toMatch(/Never construct, guess, complete, or adjust/);
    expect(prompt?.systemInstructions).toMatch(/Do not invent new ones/);
  });

  it("has a named, versioned retrieval policy that admits only approved facts", () => {
    expect(findPolicy("content-brief", 1)).toBe(CONTENT_BRIEF_POLICY);
    expect(CONTENT_BRIEF_POLICY.rules.join(" ")).toMatch(/APPROVED only/);
    expect(CONTENT_BRIEF_POLICY.budgets.BRAND_FACT?.max).toBeGreaterThanOrEqual(10);
    expect(CONTENT_BRIEF_POLICY.budgets.SEO_RULE?.max).toBeGreaterThanOrEqual(10);
  });
});
