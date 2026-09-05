import { describe, expect, it } from "vitest";

import {
  CONTENT_BRIEF_SCHEMAS,
  CONTENT_BRIEF_SCHEMA_VERSION,
  CONTENT_BRIEF_V2_LIMITS,
  contentBriefSchema,
  contentBriefSchemaV1,
  contentBriefSchemaV2,
} from "@/lib/ai/schemas/content-brief";

/**
 * Output schema version 2 (the CONTENT_BRIEF real-provider fix): every list
 * is a required array, unknown keys are refused, and only the descriptive
 * free-text lists gained room. Everything about ids, enums and citations is
 * exactly as it was.
 */

const full = {
  title: "Payroll software in the Philippines: a buyer's guide",
  content_type: "GUIDE",
  search_intent: "COMMERCIAL",
  primary_conversion: "Book a demo",
  audience: "HR leads at growing Philippine companies",
  customer_problem: "They cannot tell which payroll tools handle BIR requirements.",
  desired_outcome: "The reader shortlists tools and books a demo.",
  recommended_angle: "Compliance first, features second.",
  key_questions: ["Which payroll tools produce BIR-compliant payslips?"],
  required_sections: [{ heading: "What BIR compliance requires", purpose: "The core." }],
  optional_sections: [],
  internal_link_targets: [
    {
      evidence_id: "own:00000000-0000-4000-8000-000000000001",
      anchor_text: "pricing",
      reason: "The next step.",
    },
  ],
  external_evidence_requirements: ["A verified customer count."],
  approved_claims: [
    {
      text: "Payslips follow BIR formats",
      evidence_id: "fact:00000000-0000-4000-8000-000000000002",
    },
  ],
  prohibited_claims: [],
  seo_rule_constraints: [],
  secondary_keyword_evidence_ids: [],
  brand_voice_notes: null,
  missing_evidence: ["No ranking data for the primary keyword."],
};

describe("the content brief output schema, version 2", () => {
  it("is the current version, and both versions are on record", () => {
    expect(CONTENT_BRIEF_SCHEMA_VERSION).toBe("2");
    expect(contentBriefSchema).toBe(contentBriefSchemaV2);
    expect(CONTENT_BRIEF_SCHEMAS["1"]).toBe(contentBriefSchemaV1);
    expect(CONTENT_BRIEF_SCHEMAS["2"]).toBe(contentBriefSchemaV2);
  });

  it("accepts a complete brief", () => {
    expect(contentBriefSchemaV2.safeParse(full).success).toBe(true);
  });

  it("requires every list to be present as an array - a missing or stringified list fails", () => {
    const { key_questions: _dropped, ...withoutQuestions } = full;
    expect(contentBriefSchemaV2.safeParse(withoutQuestions).success).toBe(false);
    for (const key of [
      "key_questions",
      "required_sections",
      "approved_claims",
      "missing_evidence",
      "secondary_keyword_evidence_ids",
    ]) {
      const result = contentBriefSchemaV2.safeParse({ ...full, [key]: '"one", "two"' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(key);
      }
    }
    // Version 1 tolerated absence; it still refuses a string.
    expect(contentBriefSchemaV1.safeParse(withoutQuestions).success).toBe(true);
    expect(contentBriefSchemaV1.safeParse({ ...full, key_questions: "one, two" }).success).toBe(
      false,
    );
  });

  it("refuses keys the schema does not name, at the root and inside items", () => {
    expect(contentBriefSchemaV2.safeParse({ ...full, tone: "friendly" }).success).toBe(false);
    expect(
      contentBriefSchemaV2.safeParse({
        ...full,
        approved_claims: [{ text: "x", evidence_id: "fact:a", confidence: "high" }],
      }).success,
    ).toBe(false);
  });

  it("gives the descriptive lists room, and only those", () => {
    const at = (n: number) => "x".repeat(n);
    expect(
      contentBriefSchemaV2.safeParse({
        ...full,
        missing_evidence: [at(CONTENT_BRIEF_V2_LIMITS.missingEvidence)],
      }).success,
    ).toBe(true);
    expect(
      contentBriefSchemaV2.safeParse({
        ...full,
        missing_evidence: [at(CONTENT_BRIEF_V2_LIMITS.missingEvidence + 1)],
      }).success,
    ).toBe(false);
    expect(contentBriefSchemaV1.safeParse({ ...full, missing_evidence: [at(301)] }).success).toBe(
      false,
    );
    expect(
      contentBriefSchemaV2.safeParse({
        ...full,
        external_evidence_requirements: [at(CONTENT_BRIEF_V2_LIMITS.externalEvidenceRequirement)],
      }).success,
    ).toBe(true);
    expect(
      contentBriefSchemaV1.safeParse({ ...full, external_evidence_requirements: [at(301)] })
        .success,
    ).toBe(false);
    expect(
      contentBriefSchemaV2.safeParse({
        ...full,
        internal_link_targets: [
          { ...full.internal_link_targets[0], reason: at(CONTENT_BRIEF_V2_LIMITS.linkReason) },
        ],
      }).success,
    ).toBe(true);
    expect(
      contentBriefSchemaV2.safeParse({
        ...full,
        internal_link_targets: [
          { ...full.internal_link_targets[0], reason: at(CONTENT_BRIEF_V2_LIMITS.linkReason + 1) },
        ],
      }).success,
    ).toBe(false);
    // Unchanged limits: claim text, audience, key questions.
    expect(
      contentBriefSchemaV2.safeParse({
        ...full,
        approved_claims: [{ text: at(501), evidence_id: "fact:a" }],
      }).success,
    ).toBe(false);
    expect(contentBriefSchemaV2.safeParse({ ...full, audience: at(1001) }).success).toBe(false);
    expect(contentBriefSchemaV2.safeParse({ ...full, key_questions: [at(301)] }).success).toBe(
      false,
    );
  });

  it("keeps the evidence id, enum and citation rules of version 1", () => {
    expect(contentBriefSchemaV2.safeParse({ ...full, content_type: "WHITEPAPER" }).success).toBe(
      false,
    );
    expect(contentBriefSchemaV2.safeParse({ ...full, search_intent: "BUY" }).success).toBe(false);
    expect(
      contentBriefSchemaV2.safeParse({ ...full, approved_claims: [{ text: "No id" }] }).success,
    ).toBe(false);
    expect(
      contentBriefSchemaV2.safeParse({ ...full, approved_claims: [{ text: "x", evidence_id: 42 }] })
        .success,
    ).toBe(false);
    expect(
      contentBriefSchemaV2.safeParse({ ...full, approved_claims: [{ text: "x", evidence_id: "" }] })
        .success,
    ).toBe(false);
    expect(
      contentBriefSchemaV2.safeParse({ ...full, seo_rule_constraints: [{ constraint: "x" }] })
        .success,
    ).toBe(false);
    expect(contentBriefSchemaV2.safeParse({ ...full, primary_conversion: 7 }).success).toBe(false);
    expect(contentBriefSchemaV2.safeParse({ ...full, brand_voice_notes: null }).success).toBe(true);
    const tooMany = Array.from({ length: 13 }, (_, i) => `Question ${i}`);
    expect(contentBriefSchemaV2.safeParse({ ...full, key_questions: tooMany }).success).toBe(false);
  });
});
