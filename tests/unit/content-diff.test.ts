import { describe, expect, it } from "vitest";

import { diffLines, revisionChanges, type RevisionFields } from "@/lib/content/diff";

describe("line diff", () => {
  it("marks added, removed and unchanged lines", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { type: "same", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "B" },
      { type: "same", text: "c" },
      { type: "added", text: "d" },
    ]);
  });

  it("is identity for identical text and total for unrelated text", () => {
    expect(diffLines("x\ny", "x\ny").every((line) => line.type === "same")).toBe(true);
    const total = diffLines("one", "two");
    expect(total).toEqual([
      { type: "removed", text: "one" },
      { type: "added", text: "two" },
    ]);
  });
});

describe("what changed between revisions", () => {
  const before: RevisionFields = {
    title: "Payroll software",
    slug: "payroll-software",
    excerpt: null,
    bodyMarkdown: "# Payroll\n\nOne two three.\n",
    metaTitle: null,
    metaDescription: null,
  };

  it("names the fields and counts the words and lines", () => {
    const after = {
      ...before,
      title: "Payroll software in the Philippines",
      bodyMarkdown: "# Payroll\n\nOne two three four.\n\nA new paragraph.\n",
    };
    expect(revisionChanges(before, after)).toEqual({
      changed: ["title", "bodyMarkdown"],
      wordsBefore: 4,
      wordsAfter: 8,
      linesAdded: 3,
      linesRemoved: 1,
    });
  });

  it("reports nothing for an identical revision", () => {
    expect(revisionChanges(before, { ...before })).toMatchObject({
      changed: [],
      linesAdded: 0,
      linesRemoved: 0,
    });
  });
});
