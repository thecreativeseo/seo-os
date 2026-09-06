import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CONTENT_QA_SCHEMAS,
  CONTENT_QA_SCHEMA_NAME,
  CONTENT_QA_SCHEMA_VERSION,
  CONTENT_QA_V1_LIMITS,
  contentQaSchema,
  contentQaSchemaV1,
  type ContentQaOutput,
} from "@/lib/ai/schemas/content-qa";
import { STRICT_UNSUPPORTED_KEYWORDS, toToolSchema } from "@/server/ai/providers/anthropic";

/**
 * The content QA output schema, version 1 (M5.2 §11, §13): strict from the
 * start. Every field present, unknown keys refused, enums exact, every list
 * an array, null only where the contract says. And its strict projection
 * keeps every field the provider must send.
 */

const complete: ContentQaOutput = {
  intent_alignment: {
    status: "ALIGNED",
    rationale: "It serves the intent.",
    excerpts: ["Start with the payroll register"],
  },
  answer_readiness: [
    {
      question: "Which payroll tools produce BIR-compliant payslips?",
      status: "ANSWERED",
      heading: "Choosing a tool",
      form: "DIRECT",
      excerpt: "compare tools on the forms they file",
    },
  ],
  rule_judgments: [
    {
      rule_id: "rule:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "RESPECTED",
      rationale: "Reads as asked.",
      excerpt: null,
    },
  ],
  unlisted_claims: [
    {
      excerpt: "We are the leading payroll platform.",
      category: "COMPARISON",
      rationale: "A superiority claim.",
    },
  ],
  prohibited_paraphrases: [
    {
      prohibited_claim: "Guaranteed compliance",
      excerpt: "you can be sure every filing is accepted",
      rationale: "Same promise.",
    },
  ],
  call_to_action: { status: "PRESENT", rationale: "The close asks for a demo.", excerpt: null },
  keyword_use: { status: "NATURAL", rationale: "Sits where expected.", excerpt: null },
  brand_voice: { status: "MATCHES", rationale: "Plain.", excerpt: null },
};

const FIELDS = [
  "intent_alignment",
  "answer_readiness",
  "rule_judgments",
  "unlisted_claims",
  "prohibited_paraphrases",
  "call_to_action",
  "keyword_use",
  "brand_voice",
];

describe("the content QA output schema, version 1", () => {
  it("is the current version, on record, named for the provider", () => {
    expect(CONTENT_QA_SCHEMA_VERSION).toBe("1");
    expect(CONTENT_QA_SCHEMA_NAME).toBe("content_qa");
    expect(contentQaSchema).toBe(contentQaSchemaV1);
    expect(CONTENT_QA_SCHEMAS["1"]).toBe(contentQaSchemaV1);
  });

  it("accepts a complete judgment, and null where the contract allows it", () => {
    expect(contentQaSchemaV1.safeParse(complete).success).toBe(true);
    expect(
      contentQaSchemaV1.safeParse({ ...complete, call_to_action: null, keyword_use: null }).success,
    ).toBe(true);
    for (const list of [
      "answer_readiness",
      "rule_judgments",
      "unlisted_claims",
      "prohibited_paraphrases",
    ] as const) {
      expect(contentQaSchemaV1.safeParse({ ...complete, [list]: [] }).success, list).toBe(true);
    }
  });

  it("refuses a missing field, an unknown key, a list as a string, a bad enum, and a malformed object", () => {
    const { brand_voice: _dropped, ...missing } = complete;
    const missingResult = contentQaSchemaV1.safeParse(missing);
    expect(missingResult.success).toBe(false);
    if (!missingResult.success) {
      expect(missingResult.error.issues[0]?.path).toEqual(["brand_voice"]);
    }

    const unknown = contentQaSchemaV1.safeParse({ ...complete, severity: "BLOCKING" });
    expect(unknown.success).toBe(false);
    if (!unknown.success) expect(unknown.error.issues[0]?.code).toBe("unrecognized_keys");

    const stringified = contentQaSchemaV1.safeParse({ ...complete, unlisted_claims: "none" });
    expect(stringified.success).toBe(false);
    if (!stringified.success) expect(stringified.error.issues[0]?.code).toBe("invalid_type");

    const badEnum = contentQaSchemaV1.safeParse({
      ...complete,
      intent_alignment: { ...complete.intent_alignment, status: "BLOCKING" },
    });
    expect(badEnum.success).toBe(false);
    if (!badEnum.success) {
      expect(badEnum.error.issues[0]?.path).toEqual(["intent_alignment", "status"]);
      expect(badEnum.error.issues[0]?.code).toBe("invalid_value");
    }

    const malformed = contentQaSchemaV1.safeParse({
      ...complete,
      answer_readiness: [{ question: "q", status: "ANSWERED" }],
    });
    expect(malformed.success).toBe(false);
    if (!malformed.success) {
      expect(malformed.error.issues.map((issue) => issue.path.join("."))).toContain(
        "answer_readiness.0.form",
      );
    }

    // A judgment cannot smuggle a severity or a verdict in.
    expect(
      contentQaSchemaV1.safeParse({
        ...complete,
        rule_judgments: [{ ...complete.rule_judgments[0], severity: "BLOCKING" }],
      }).success,
    ).toBe(false);
    expect(contentQaSchemaV1.safeParse({ ...complete, verdict: "APPROVE" }).success).toBe(false);
  });

  it("holds the caps the prompt asks the model to stay under", () => {
    const { rationale, ruleRationale, shortRationale, excerpt, answers } = CONTENT_QA_V1_LIMITS;
    expect(
      contentQaSchemaV1.safeParse({
        ...complete,
        intent_alignment: { ...complete.intent_alignment, rationale: "r".repeat(rationale + 1) },
      }).success,
    ).toBe(false);
    expect(
      contentQaSchemaV1.safeParse({
        ...complete,
        rule_judgments: [
          { ...complete.rule_judgments[0], rationale: "r".repeat(ruleRationale + 1) },
        ],
      }).success,
    ).toBe(false);
    expect(
      contentQaSchemaV1.safeParse({
        ...complete,
        unlisted_claims: [
          { ...complete.unlisted_claims[0], rationale: "r".repeat(shortRationale + 1) },
        ],
      }).success,
    ).toBe(false);
    expect(
      contentQaSchemaV1.safeParse({
        ...complete,
        unlisted_claims: [{ ...complete.unlisted_claims[0], excerpt: "e".repeat(excerpt + 1) }],
      }).success,
    ).toBe(false);
    expect(
      contentQaSchemaV1.safeParse({
        ...complete,
        answer_readiness: Array.from({ length: answers + 1 }, () => complete.answer_readiness[0]),
      }).success,
    ).toBe(false);
    expect(
      contentQaSchemaV1.safeParse({
        ...complete,
        intent_alignment: { ...complete.intent_alignment, excerpts: ["a", "b", "c", "d"] },
      }).success,
    ).toBe(false);
  });

  it("projects to a strict tool schema that keeps every field and drops only what strict mode rejects", () => {
    const projected = toToolSchema(contentQaSchemaV1) as Record<string, unknown>;
    expect(Object.keys(projected.properties as object).sort()).toEqual([...FIELDS].sort());
    expect([...(projected.required as string[])].sort()).toEqual([...FIELDS].sort());
    expect(projected.additionalProperties).toBe(false);
    const raw = z.toJSONSchema(contentQaSchemaV1, { io: "output" });
    const text = JSON.stringify(projected);
    for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) {
      expect(text.includes(`"${keyword}"`), keyword).toBe(false);
    }
    expect(JSON.stringify(raw)).toContain('"maxLength"');
    // Enums and nullability survive the projection.
    const intent = (projected.properties as Record<string, Record<string, unknown>>)
      .intent_alignment;
    expect(JSON.stringify(intent)).toContain('"ALIGNED"');
    const cta = (projected.properties as Record<string, Record<string, unknown>>).call_to_action;
    expect(JSON.stringify(cta)).toContain('"null"');
  });
});
