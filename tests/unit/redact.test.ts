import { describe, expect, it } from "vitest";

import { REDACTED, isSensitiveKey, redact } from "@/lib/redact";

/**
 * CLAUDE.md: a secret in an audit snapshot or log line is a release-blocking P0
 * failure. These cover the shapes an OAuth flow actually produces.
 */

describe("isSensitiveKey", () => {
  const sensitive = [
    "access_token",
    "refresh_token",
    "provider_token",
    "providerToken",
    "PROVIDER_TOKEN",
    "id_token",
    "password",
    "application_password",
    "api_key",
    "apiKey",
    "privateKey",
    "credential_reference",
    "authorization",
    "cookie",
    "code_verifier",
    "SUPABASE_SERVICE_ROLE_KEY",
    "anon_key",
  ];

  it.each(sensitive)("flags %s", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  const safe = ["email", "displayName", "domain", "title", "status", "createdAt"];

  it.each(safe)("does not flag %s", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redact", () => {
  it("removes token values from a nested OAuth payload", () => {
    const payload = {
      user: { id: "u1", email: "person@example.com" },
      session: {
        access_token: "ya29.super-secret",
        refresh_token: "1//refresh-secret",
        expires_in: 3600,
      },
    };

    const result = redact(payload);

    expect(JSON.stringify(result)).not.toContain("ya29.super-secret");
    expect(JSON.stringify(result)).not.toContain("1//refresh-secret");
    expect(result.user.email).toBe("person@example.com");
  });

  it("redacts inside arrays", () => {
    const result = redact([{ api_key: "sk-live-1" }, { name: "safe" }]);
    expect(result[0]).toEqual({ api_key: REDACTED });
    expect(result[1]).toEqual({ name: "safe" });
  });

  it("preserves structure and non-sensitive values", () => {
    const before = { title: "Goal", baseline: null, owner: { email: "a@b.com" } };
    expect(redact(before)).toEqual(before);
  });

  it("keeps dates intact", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(redact({ createdAt: date }).createdAt).toEqual(date);
  });

  it("survives circular references", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
  });

  it("redacts a connection record's credential reference", () => {
    const connection = {
      id: "c1",
      provider: "GOOGLE_SEARCH_CONSOLE",
      status: "CONNECTED",
      credentialReference: "secret-manager://projects/x/secrets/gsc",
    };
    const result = redact(connection);
    expect(result.credentialReference).toBe(REDACTED);
    expect(result.provider).toBe("GOOGLE_SEARCH_CONSOLE");
  });
});
