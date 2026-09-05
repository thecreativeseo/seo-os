import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  aiDiagnosticsEnabled,
  diagnosticEventFor,
  formatAiDiagnostic,
  logAiDiagnostic,
  type AiDiagnosticEvent,
} from "@/server/ai/diagnostics";
import { summariseIssues } from "@/lib/ai/provider";
import { StubProvider } from "@/server/ai/providers/stub";

/**
 * The development-only diagnostic (the CONTENT_BRIEF real-provider fix):
 * structure only, outside production only.
 */

const SENTINEL = "PAGE-CONTENT-THAT-MUST-NOT-APPEAR";

const schema = z.object({
  title: z.string().max(10),
  items: z.array(z.string()),
  kind: z.enum(["A", "B"]),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issue summaries", () => {
  it("name the path, the code, the expectation, and the received type and length - never the value", () => {
    const input = { title: SENTINEL, items: SENTINEL, kind: SENTINEL, extra: SENTINEL };
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issues = summariseIssues(parsed.error.issues, input);
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          path: "title",
          code: "too_big",
          expected: "<= 10",
          receivedType: "string",
          receivedLength: SENTINEL.length,
        },
        {
          path: "items",
          code: "invalid_type",
          expected: "array",
          receivedType: "string",
          receivedLength: SENTINEL.length,
        },
        expect.objectContaining({ path: "kind", code: "invalid_value", receivedType: "string" }),
      ]),
    );
    expect(JSON.stringify(issues)).not.toContain(SENTINEL);
  });
});

describe("the diagnostic event", () => {
  const event: AiDiagnosticEvent = {
    event: "AI_STRUCTURED_OUTPUT_INVALID",
    runId: "run-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    agentType: "CONTENT_BRIEF",
    taskType: "GENERATE_BRIEF",
    promptVersion: 2,
    outputSchemaVersion: "2",
    errorCode: "invalid_output",
    httpStatus: 200,
    stopReason: "tool_use",
    blockKinds: ["tool_use"],
    usage: { inputTokens: 11133, outputTokens: 3906 },
    issues: [
      {
        path: "key_questions",
        code: "invalid_type",
        expected: "array",
        receivedType: "string",
        receivedLength: 77,
      },
    ],
  };

  it("formats as one JSON line with exactly the allowed fields", () => {
    const line = formatAiDiagnostic(event);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "agentType",
        "blockKinds",
        "errorCode",
        "event",
        "httpStatus",
        "issues",
        "model",
        "outputSchemaVersion",
        "promptVersion",
        "provider",
        "runId",
        "stopReason",
        "taskType",
        "usage",
      ].sort(),
    );
    expect(line).toContain("key_questions");
    expect(line).toContain("3906");
  });

  it("maps failure kinds to events", () => {
    expect(diagnosticEventFor("invalid_structured_output")).toBe("AI_STRUCTURED_OUTPUT_INVALID");
    expect(diagnosticEventFor("unparseable_response")).toBe("AI_STRUCTURED_OUTPUT_INVALID");
    expect(diagnosticEventFor("output_truncated")).toBe("AI_OUTPUT_TRUNCATED");
    expect(diagnosticEventFor("provider_http_error")).toBe("AI_PROVIDER_ERROR");
    expect(diagnosticEventFor("refused")).toBe("AI_PROVIDER_REFUSED");
  });

  it("logs outside production and stays silent in production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logAiDiagnostic(event, { NODE_ENV: "production" });
    expect(warn).not.toHaveBeenCalled();
    expect(aiDiagnosticsEnabled({ NODE_ENV: "production" })).toBe(false);

    logAiDiagnostic(event, { NODE_ENV: "development" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("[ai-diagnostic]");
    expect(aiDiagnosticsEnabled({ NODE_ENV: "test" })).toBe(true);
  });
});

describe("the stub provider", () => {
  it("attaches the same structure-only diagnostic when a fixture drifts from its schema", async () => {
    const stub = new StubProvider({ responses: [{ title: "ok", items: SENTINEL, kind: "A" }] });
    const result = await stub.generateStructured({
      system: "s",
      task: "t",
      schema,
      schemaName: "thing",
      outputSchemaVersion: "1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_output");
    expect(result.diagnostic?.issues).toEqual([
      expect.objectContaining({
        path: "items",
        code: "invalid_type",
        expected: "array",
        receivedType: "string",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
