import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AnthropicProvider,
  STRICT_UNSUPPORTED_KEYWORDS,
  projectStrict,
  toToolSchema,
} from "@/server/ai/providers/anthropic";
import { contentBriefSchemaV1, contentBriefSchemaV2 } from "@/lib/ai/schemas/content-brief";
import { contentQaSchemaV1 } from "@/lib/ai/schemas/content-qa";
import { pageDiagnosisSchema } from "@/lib/ai/schemas/page-diagnosis";

/**
 * Strict tool use and the structure-only diagnostic (the CONTENT_BRIEF
 * real-provider fix). What a fake provider returns here is what the real one
 * returned: complete tool responses with arrays rendered as strings, items
 * longer than the schema allows, and a run that stopped on max_tokens.
 */

const SENTINEL = "CUSTOMER-PAGE-TEXT-THAT-MUST-NEVER-LEAK";

function respond(body: unknown, status = 200) {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function sent(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const init = mock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function walk(node: unknown, visit: (key: string) => void): void {
  if (Array.isArray(node)) node.forEach((child) => walk(child, visit));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      visit(key);
      if (key !== "properties" && key !== "$defs") walk(value, visit);
      else Object.values(value as Record<string, unknown>).forEach((child) => walk(child, visit));
    }
  }
}

const shape = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(["A", "B"]),
  note: z.string().max(300).nullable().default(null),
  slug: z
    .string()
    .regex(/^[a-z-]+$/)
    .nullable(),
  tags: z.array(z.string().min(1).max(50)).max(5).default([]),
  sections: z.array(z.object({ heading: z.string().min(1), purpose: z.string().max(500) })).max(3),
  count: z.number().int().min(0).max(10).optional(),
});

const brief = {
  title: "A brief",
  content_type: "GUIDE",
  search_intent: "COMMERCIAL",
  primary_conversion: null,
  audience: "HR leads",
  customer_problem: "Compliance confusion",
  desired_outcome: "A shortlist",
  recommended_angle: "Compliance first",
  key_questions: ["What does BIR require?"],
  required_sections: [{ heading: "Compliance", purpose: "The core" }],
  optional_sections: [],
  internal_link_targets: [],
  external_evidence_requirements: [],
  approved_claims: [],
  prohibited_claims: [],
  seo_rule_constraints: [],
  secondary_keyword_evidence_ids: [],
  brand_voice_notes: null,
  missing_evidence: [],
};

const briefRequest = {
  system: "Brief.",
  task: "Write the brief.",
  untrustedData: SENTINEL,
  schema: contentBriefSchemaV2,
  schemaName: "content_brief",
  outputSchemaVersion: "2",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the strict tool schema projection", () => {
  it("keeps structure and drops the keywords strict mode rejects", () => {
    const projected = toToolSchema(shape);
    const seen = new Set<string>();
    walk(projected, (key) => seen.add(key));
    for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) expect(seen.has(keyword)).toBe(false);

    const properties = projected.properties as Record<string, Record<string, unknown>>;
    expect(projected.type).toBe("object");
    expect(projected.additionalProperties).toBe(false);
    expect(projected.required).toEqual(
      expect.arrayContaining(["title", "kind", "note", "slug", "tags", "sections"]),
    );
    expect(properties.kind).toEqual({ type: "string", enum: ["A", "B"] });
    expect(properties.note).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(properties.sections?.type).toBe("array");
    const item = (properties.sections?.items as Record<string, unknown>) ?? {};
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["heading", "purpose"]);
  });

  it("projects the brief and diagnosis schemas without losing enums, required keys or nullability", () => {
    for (const schema of [contentBriefSchemaV1, contentBriefSchemaV2, pageDiagnosisSchema]) {
      const projected = toToolSchema(schema);
      const seen = new Set<string>();
      walk(projected, (key) => seen.add(key));
      for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) expect(seen.has(keyword)).toBe(false);
      expect(projected.additionalProperties).toBe(false);
    }
    const briefProps = toToolSchema(contentBriefSchemaV2).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(briefProps.content_type?.enum).toEqual(expect.arrayContaining(["GUIDE", "OTHER"]));
    expect(briefProps.primary_conversion?.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(toToolSchema(contentBriefSchemaV2).required).toHaveLength(19);
    const diagProps = toToolSchema(pageDiagnosisSchema).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(diagProps.overall_confidence?.enum).toEqual(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]);
    expect((diagProps.findings?.items as Record<string, unknown>)?.required).toEqual(
      expect.arrayContaining([
        "category",
        "verdict",
        "supporting_evidence_ids",
        "missing_evidence",
      ]),
    );
    expect(projectStrict({ properties: { default: { type: "string", default: "x" } } })).toEqual({
      properties: { default: { type: "string" } },
    });
  });
});

describe("AnthropicProvider, strict", () => {
  it("sends strict: true with the projected schema and the forced tool", async () => {
    const mock = respond({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "content_brief", input: brief }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const result = await new AnthropicProvider("k", "m").generateStructured(briefRequest);
    expect(result.ok).toBe(true);
    const body = sent(mock);
    const tools = body.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.strict).toBe(true);
    expect(body.tool_choice).toEqual({ type: "tool", name: "content_brief" });
    const seen = new Set<string>();
    walk(tools[0]?.input_schema, (key) => seen.add(key));
    expect(seen.has("maxLength")).toBe(false);
    expect(seen.has("default")).toBe(false);
  });

  it("still refuses an array that arrived as a string, and says where without saying what", async () => {
    respond({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "content_brief",
          input: { ...brief, key_questions: `"${SENTINEL}", "another"`, approved_claims: SENTINEL },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const result = await new AnthropicProvider("k", "m").generateStructured(briefRequest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_output");
    expect(result.diagnostic?.kind).toBe("invalid_structured_output");
    expect(result.diagnostic?.stopReason).toBe("tool_use");
    expect(result.diagnostic?.blockKinds).toEqual(["tool_use"]);
    expect(result.diagnostic?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "key_questions",
          code: "invalid_type",
          expected: "array",
          receivedType: "string",
        }),
        expect.objectContaining({
          path: "approved_claims",
          code: "invalid_type",
          expected: "array",
          receivedType: "string",
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("reports an oversized descriptive item under v1 with its path and length, never its text", async () => {
    const long = `${SENTINEL} `.repeat(20);
    respond({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "content_brief", input: { ...brief, missing_evidence: [long] } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const result = await new AnthropicProvider("k", "m").generateStructured({
      ...briefRequest,
      schema: contentBriefSchemaV1,
      outputSchemaVersion: "1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic?.issues).toEqual([
      expect.objectContaining({
        path: "missing_evidence.0",
        code: "too_big",
        expected: "<= 300",
        receivedType: "string",
        receivedLength: long.length,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("accepts the same item under v2, whose limit is higher", async () => {
    const long = "x".repeat(700);
    respond({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "content_brief", input: { ...brief, missing_evidence: [long] } },
      ],
    });
    const result = await new AnthropicProvider("k", "m").generateStructured(briefRequest);
    expect(result.ok).toBe(true);
  });

  it("reports max_tokens as truncation, not as a shape problem", async () => {
    respond({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: SENTINEL }],
      usage: { input_tokens: 10, output_tokens: 6144 },
    });
    const result = await new AnthropicProvider("k", "m").generateStructured(briefRequest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("output_truncated");
    expect(result.error.message).toMatch(/output budget/);
    expect(result.diagnostic).toMatchObject({
      kind: "output_truncated",
      stopReason: "max_tokens",
      blockKinds: ["text"],
      usage: { inputTokens: 10, outputTokens: 6144 },
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("maps a 400 to a provider error with the status and nothing from the body", async () => {
    respond({ error: { type: "invalid_request_error", message: SENTINEL } }, 400);
    const result = await new AnthropicProvider("k", "m").generateStructured(briefRequest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("provider_error");
    expect(result.diagnostic).toMatchObject({ kind: "provider_http_error", httpStatus: 400 });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("carries a valid page diagnosis through the same adapter", async () => {
    const mock = respond({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "page_diagnosis",
          input: {
            executive_summary: "Clicks fell while impressions held.",
            findings: [
              {
                category: "CTR_SERP_MISMATCH",
                verdict: "SUSPECT",
                confidence: "MEDIUM",
                title: "Title no longer matches the query",
                summary: "The title promises a guide; the query asks for pricing.",
                supporting_evidence_ids: ["gsc:x"],
                contradicting_evidence_ids: [],
                missing_evidence: ["A SERP snapshot."],
              },
            ],
            overall_confidence: "MEDIUM",
            recommendations: [],
          },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const result = await new AnthropicProvider("k", "m").generateStructured({
      system: "Diagnose.",
      task: "Diagnose the page.",
      schema: pageDiagnosisSchema,
      schemaName: "page_diagnosis",
      outputSchemaVersion: "2",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.findings[0]?.category).toBe("CTR_SERP_MISMATCH");
    expect((sent(mock).tools as Record<string, unknown>[])[0]?.strict).toBe(true);
  });

  it("carries a content QA judgment through the same adapter, strictly", async () => {
    const judgment = {
      intent_alignment: { status: "ALIGNED", rationale: "It serves the intent.", excerpts: [] },
      answer_readiness: [
        {
          question: "What does BIR require?",
          status: "PARTIAL",
          heading: "Compliance",
          form: "LIST",
          excerpt: "payslips follow the bureau's format",
        },
      ],
      rule_judgments: [
        { rule_id: "rule:abc", status: "UNCLEAR", rationale: "Hard to tell.", excerpt: null },
      ],
      unlisted_claims: [],
      prohibited_paraphrases: [],
      call_to_action: null,
      keyword_use: { status: "NATURAL", rationale: "Reads well.", excerpt: null },
      brand_voice: { status: "MATCHES", rationale: "Plain.", excerpt: null },
    };
    const mock = respond({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "content_qa", input: judgment }],
      usage: { input_tokens: 20, output_tokens: 9 },
    });
    const request = {
      system: "Judge.",
      task: "Judge the revision.",
      untrustedData: SENTINEL,
      schema: contentQaSchemaV1,
      schemaName: "content_qa",
      outputSchemaVersion: "1",
    };
    const result = await new AnthropicProvider("k", "m").generateStructured(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.answer_readiness[0]?.status).toBe("PARTIAL");
      expect(result.value.call_to_action).toBeNull();
    }
    const body = sent(mock);
    const tool = (body.tools as Record<string, unknown>[])[0]!;
    expect(tool.strict).toBe(true);
    expect(tool.name).toBe("content_qa");
    expect(JSON.stringify(tool)).not.toContain("maxLength");
    expect(JSON.stringify(tool)).toContain("MISALIGNED");
  });

  it("refuses a judgment whose list arrived as a string, and says where without saying what", async () => {
    respond({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "content_qa",
          input: {
            intent_alignment: { status: "ALIGNED", rationale: SENTINEL, excerpts: [] },
            answer_readiness: "everything was answered",
            rule_judgments: [],
            unlisted_claims: [],
            prohibited_paraphrases: [],
            call_to_action: null,
            keyword_use: null,
            brand_voice: { status: "MATCHES", rationale: "Plain.", excerpt: null },
          },
        },
      ],
      usage: { input_tokens: 20, output_tokens: 9 },
    });
    const result = await new AnthropicProvider("k", "m").generateStructured({
      system: "Judge.",
      task: "Judge the revision.",
      untrustedData: SENTINEL,
      schema: contentQaSchemaV1,
      schemaName: "content_qa",
      outputSchemaVersion: "1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_output");
    expect(result.error.message).toBe(
      "The AI provider returned a response that did not match the expected shape.",
    );
    const diagnostic = JSON.stringify(result.diagnostic);
    expect(diagnostic).toContain("answer_readiness");
    expect(diagnostic).toContain("invalid_type");
    expect(diagnostic).not.toContain(SENTINEL);
    expect(diagnostic).not.toContain("everything was answered");
  });
});
