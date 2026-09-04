import { createHash } from "node:crypto";

/**
 * The revision hash every approval binds to (docs/P4_SPEC.md §25).
 *
 * Computed over the content fields only - not ids, not timestamps, not who
 * wrote it - so two revisions with the same words have the same hash and a
 * one-character change does not. Text is normalised to Unicode NFC with LF
 * line endings and no trailing whitespace, so an editor that rewraps line
 * endings has not changed the content; anything a reader could notice has.
 *
 * The version number is part of the input. If the canonical form ever
 * changes, old hashes stay comparable to what they were computed from and a
 * new version is a new hash, never a silently different one.
 */

export const REVISION_HASH_VERSION = 1;

export type RevisionContent = {
  title: string;
  slug?: string | null;
  excerpt?: string | null;
  bodyMarkdown: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  schemaJson?: unknown;
};

function text(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

/** JSON with object keys sorted at every level, so key order cannot change a hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function revisionHash(content: RevisionContent): string {
  const canonical = canonicalJson({
    v: REVISION_HASH_VERSION,
    title: text(content.title),
    slug: text(content.slug),
    excerpt: text(content.excerpt),
    bodyMarkdown: text(content.bodyMarkdown),
    metaTitle: text(content.metaTitle),
    metaDescription: text(content.metaDescription),
    schemaJson: content.schemaJson == null ? null : canonicalJson(content.schemaJson),
  });

  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
