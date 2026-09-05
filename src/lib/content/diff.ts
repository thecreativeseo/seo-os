import { wordCount } from "@/lib/content/markdown";

/**
 * Comparing two revisions (docs/P4_SPEC.md §10; M4 plan, D-M4-6).
 *
 * A line-level diff over the body and a changed-fields summary over the rest.
 * Lines are the unit because that is how a person edits markdown, and because
 * an LCS over lines is small enough to run on every history view. Past a size
 * cap the diff degrades to "everything changed" rather than to a slow page.
 */

export type DiffLine = { type: "same" | "added" | "removed"; text: string };

const MAX_LINES = 3_000;

/** Longest-common-subsequence line diff. Deterministic; O(n·m) under the cap. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ type: "removed" as const, text })),
      ...b.map((text) => ({ type: "added" as const, text })),
    ];
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: "removed", text: a[i]! });
      i++;
    } else {
      out.push({ type: "added", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ type: "removed", text: a[i++]! });
  while (j < b.length) out.push({ type: "added", text: b[j++]! });

  return out;
}

export type RevisionFields = {
  title: string;
  slug: string | null;
  excerpt: string | null;
  bodyMarkdown: string;
  metaTitle: string | null;
  metaDescription: string | null;
};

export const REVISION_FIELD_LABELS: Record<keyof RevisionFields, string> = {
  title: "Title",
  slug: "Slug",
  excerpt: "Excerpt",
  bodyMarkdown: "Body",
  metaTitle: "Meta title",
  metaDescription: "Meta description",
};

export type RevisionChanges = {
  changed: (keyof RevisionFields)[];
  wordsBefore: number;
  wordsAfter: number;
  linesAdded: number;
  linesRemoved: number;
};

/** What differs between two revisions, as a person would list it. */
export function revisionChanges(before: RevisionFields, after: RevisionFields): RevisionChanges {
  const keys = Object.keys(REVISION_FIELD_LABELS) as (keyof RevisionFields)[];
  const changed = keys.filter((key) => (before[key] ?? null) !== (after[key] ?? null));

  const diff = changed.includes("bodyMarkdown")
    ? diffLines(before.bodyMarkdown, after.bodyMarkdown)
    : [];

  return {
    changed,
    wordsBefore: wordCount(before.bodyMarkdown),
    wordsAfter: wordCount(after.bodyMarkdown),
    linesAdded: diff.filter((line) => line.type === "added").length,
    linesRemoved: diff.filter((line) => line.type === "removed").length,
  };
}
