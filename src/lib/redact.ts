/**
 * Redaction for anything that may be logged or written to an AuditEvent.
 *
 * CLAUDE.md: audit snapshots must never contain OAuth tokens, API keys, passwords,
 * application passwords, private keys, or secret-manager values. A secret reaching
 * the audit trail is a release-blocking P0 failure, so redaction lives in one place
 * and is applied by both the logger and the audit writer.
 *
 * The list matches on substrings of the key name, case-insensitively, so
 * `providerToken`, `provider_token`, and `PROVIDER_TOKEN` are all caught.
 */

export const REDACTED = "[REDACTED]";

const DENIED_KEY_FRAGMENTS = [
  "token",
  "password",
  "secret",
  "credential",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "authorization",
  "cookie",
  "session",
  "jwt",
  "code_verifier",
  "refresh",
  "anonkey",
  "anon_key",
  "servicerole",
  "service_role",
] as const;

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-\s]/g, "_");
  return DENIED_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment.replace(/[-\s]/g, "_")),
  );
}

/**
 * Recursively replaces the value of any sensitive key with [REDACTED].
 * Structure is preserved so an audit diff stays readable.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value as object)) {
    return "[CIRCULAR]" as unknown as T;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen)) as unknown as T;
  }

  if (value instanceof Date) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(entry, seen);
  }

  return output as unknown as T;
}
