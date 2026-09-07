import { describe, expect, it } from "vitest";

import {
  IDEMPOTENCY_VERSION,
  canonicalIdentity,
  executionIdempotencyKey,
  type ExecutionIdentity,
} from "@/lib/cms/idempotency";
import {
  CMS_ENTITY_TYPES,
  isCmsEntityType,
  isScopedCapability,
  suggestEntityType,
} from "@/lib/cms/target";

/**
 * The identity of a CMS operation (M6 plan D3).
 *
 * Every component has to matter, or two different operations would share a key
 * and the second one would be silently swallowed as a duplicate. And nothing a
 * browser sends may reach it, or a caller could choose to collide.
 */

const BASE: ExecutionIdentity = {
  websiteId: "11111111-1111-4111-8111-111111111111",
  connectionId: "22222222-2222-4222-8222-222222222222",
  canonicalSite: "https://example.com",
  contentCmsApprovalId: "33333333-3333-4333-8333-333333333333",
  revisionHash: "sha256:abc",
  executionType: "CREATE_CMS_DRAFT",
  targetEntityType: "POST",
};

describe("the execution idempotency key", () => {
  it("is stable for the same operation asked twice", () => {
    expect(executionIdempotencyKey(BASE)).toBe(executionIdempotencyKey({ ...BASE }));
  });

  it("carries its recipe version, so a later recipe is visibly different", () => {
    expect(executionIdempotencyKey(BASE).startsWith(`${IDEMPOTENCY_VERSION}:`)).toBe(true);
    expect(canonicalIdentity(BASE).startsWith(IDEMPOTENCY_VERSION)).toBe(true);
  });

  it("changes when any part of what is being done changes", () => {
    const base = executionIdempotencyKey(BASE);
    const variants: Partial<ExecutionIdentity>[] = [
      { websiteId: "99999999-9999-4999-8999-999999999999" },
      { connectionId: "99999999-9999-4999-8999-999999999999" },
      { canonicalSite: "https://other.example.com" },
      { canonicalSite: "https://example.com/blog" },
      { contentCmsApprovalId: "99999999-9999-4999-8999-999999999999" },
      { revisionHash: "sha256:def" },
      { executionType: "UPDATE_CMS_DRAFT" },
      { targetEntityType: "PAGE" },
    ];
    const keys = variants.map((patch) => executionIdempotencyKey({ ...BASE, ...patch }));
    for (const key of keys) expect(key).not.toBe(base);
    expect(new Set([base, ...keys]).size).toBe(keys.length + 1);
  });

  it("tells a post from a page, so one cannot be mistaken for the other", () => {
    expect(executionIdempotencyKey({ ...BASE, targetEntityType: "POST" })).not.toBe(
      executionIdempotencyKey({ ...BASE, targetEntityType: "PAGE" }),
    );
  });

  it("cannot be steered by moving a boundary between components", () => {
    // Without an unambiguous separator, a site of "https://a" with approval "bc"
    // and a site of "https://ab" with approval "c" could hash the same.
    const left = executionIdempotencyKey({
      ...BASE,
      canonicalSite: "https://a.example.com",
      contentCmsApprovalId: "bc",
    });
    const right = executionIdempotencyKey({
      ...BASE,
      canonicalSite: "https://a.example.comb",
      contentCmsApprovalId: "c",
    });
    expect(left).not.toBe(right);
  });

  it("refuses a component that is empty or carries the separator", () => {
    expect(() => executionIdempotencyKey({ ...BASE, revisionHash: "" })).toThrow(/separator/);
    expect(() =>
      executionIdempotencyKey({ ...BASE, canonicalSite: `https://a${String.fromCharCode(31)}b` }),
    ).toThrow(/separator/);
  });

  it("is a sha-256 digest and not the values themselves", () => {
    const key = executionIdempotencyKey(BASE);
    expect(key).toMatch(/^cms-exec\/1:[0-9a-f]{64}$/);
    expect(key).not.toContain(BASE.contentCmsApprovalId);
    expect(key).not.toContain("example.com");
  });
});

describe("the CMS target type", () => {
  it("is a post or a page, and nothing else", () => {
    expect([...CMS_ENTITY_TYPES]).toEqual(["POST", "PAGE"]);
    expect(isCmsEntityType("POST")).toBe(true);
    expect(isCmsEntityType("PAGE")).toBe(true);
    expect(isCmsEntityType("PRODUCT")).toBe(false);
    expect(isCmsEntityType("post")).toBe(false);
  });

  it("scopes the capabilities WordPress scopes, and not the one it does not", () => {
    expect(isScopedCapability("CREATE_DRAFT")).toBe(true);
    expect(isScopedCapability("UPDATE_DRAFT")).toBe(true);
    expect(isScopedCapability("PUBLISH")).toBe(true);
    expect(isScopedCapability("READ_CONTENT")).toBe(false);
  });

  it("suggests without deciding, and declines to suggest when it does not know", () => {
    expect(suggestEntityType("BLOG_POST").suggested).toBe("POST");
    expect(suggestEntityType("COMMERCIAL").suggested).toBe("PAGE");
    expect(suggestEntityType(null).suggested).toBeNull();
    expect(suggestEntityType("UNKNOWN").suggested).toBeNull();
    expect(suggestEntityType("OTHER").suggested).toBeNull();
    for (const value of ["BLOG_POST", "COMMERCIAL", null, "UNKNOWN"] as const) {
      expect(suggestEntityType(value).reason.length).toBeGreaterThan(10);
    }
  });
});
