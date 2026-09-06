import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  STRICT_UNSUPPORTED_KEYWORDS,
  projectStrict,
  toToolSchema,
} from "@/server/ai/providers/anthropic";
import { contentDraftSchemaV1, contentDraftSchemaV2 } from "@/lib/ai/schemas/content-draft";

/**
 * The strict projection of the content draft schema: what the provider is
 * told. Types, required keys, nullability and object shapes survive; the
 * pattern and length keywords strict mode rejects are dropped, which is why
 * the prompt has to state them and the server has to check them.
 */

const FIELDS = [
  "title",
  "slug",
  "excerpt",
  "meta_title",
  "meta_description",
  "body_markdown",
  "claims",
  "internal_links_used",
  "sections_covered",
  "open_questions",
  "change_summary",
];

type Node = Record<string, unknown>;

function keywords(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) keywords(item, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      keywords(value, found);
    }
  }
  return found;
}

describe("the strict projection of the content draft schema", () => {
  const projected = toToolSchema(contentDraftSchemaV2) as Node;
  const properties = projected.properties as Record<string, Node>;

  it("keeps all eleven fields, all required, and nothing else", () => {
    expect(Object.keys(properties).sort()).toEqual([...FIELDS].sort());
    expect([...(projected.required as string[])].sort()).toEqual([...FIELDS].sort());
    expect(projected.additionalProperties).toBe(false);
  });

  it("keeps the structural types: strings, nullable strings, arrays of strings and of objects", () => {
    expect(properties.title).toEqual({ type: "string" });
    expect(properties.body_markdown).toEqual({ type: "string" });
    expect(properties.change_summary).toEqual({ type: "string" });
    for (const field of ["slug", "excerpt", "meta_title", "meta_description"]) {
      expect(properties[field], field).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    }
    expect(properties.sections_covered).toEqual({ type: "array", items: { type: "string" } });
    expect(properties.open_questions).toEqual({ type: "array", items: { type: "string" } });
    expect(properties.claims).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          evidence_id: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["text", "evidence_id"],
        additionalProperties: false,
      },
    });
    expect(properties.internal_links_used).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { evidence_id: { type: "string" }, anchor_text: { type: "string" } },
        required: ["evidence_id", "anchor_text"],
        additionalProperties: false,
      },
    });
  });

  it("drops the pattern and length keywords strict mode rejects, and only those", () => {
    const raw = z.toJSONSchema(contentDraftSchemaV2, { io: "output" }) as Node;
    expect({ type: "object", ...(projectStrict(raw) as Node) }).toEqual(projected);
    const before = keywords(raw);
    const after = keywords(projected);
    // The canonical schema carries them; the projection does not.
    expect(before.has("pattern")).toBe(true);
    expect(before.has("maxLength")).toBe(true);
    expect(before.has("maxItems")).toBe(true);
    for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) {
      expect(after.has(keyword), keyword).toBe(false);
    }
    // Nothing structural was lost with them.
    for (const keyword of [
      "type",
      "properties",
      "required",
      "items",
      "anyOf",
      "additionalProperties",
    ]) {
      expect(after.has(keyword), keyword).toBe(before.has(keyword));
    }
  });

  it("projects version 1 to the same structure, so the change is in the contract, not the wire", () => {
    const v1 = toToolSchema(contentDraftSchemaV1) as Node;
    expect(Object.keys(v1.properties as Node).sort()).toEqual([...FIELDS].sort());
    expect([...(v1.required as string[])].sort()).toEqual([...FIELDS].sort());
  });
});
