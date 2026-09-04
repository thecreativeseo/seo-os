import { describe, expect, it } from "vitest";

import { canonicalJson, revisionHash, type RevisionContent } from "@/lib/execution/hash";

const base: RevisionContent = {
  title: "Payroll Software Philippines",
  slug: "payroll-software-philippines",
  excerpt: "What to look for in payroll software for Philippine employers.",
  bodyMarkdown: "# Payroll Software Philippines\n\nA guide for HR teams.\n",
  metaTitle: "Payroll Software Philippines | Sprout",
  metaDescription: "Compare payroll software for Philippine employers.",
  schemaJson: { "@type": "Article", headline: "Payroll Software Philippines" },
};

describe("the revision hash", () => {
  it("is stable for the same content", () => {
    expect(revisionHash(base)).toBe(revisionHash({ ...base }));
    expect(revisionHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when any reader-visible field changes", () => {
    const reference = revisionHash(base);
    expect(revisionHash({ ...base, title: "Payroll Software Philippines." })).not.toBe(reference);
    expect(
      revisionHash({ ...base, bodyMarkdown: base.bodyMarkdown + "One more line.\n" }),
    ).not.toBe(reference);
    expect(revisionHash({ ...base, metaDescription: null })).not.toBe(reference);
    expect(revisionHash({ ...base, slug: "payroll-software-ph" })).not.toBe(reference);
    expect(revisionHash({ ...base, schemaJson: { "@type": "BlogPosting" } })).not.toBe(reference);
  });

  it("ignores line endings and trailing whitespace, which no reader can see", () => {
    const reference = revisionHash(base);
    expect(revisionHash({ ...base, bodyMarkdown: base.bodyMarkdown.replace(/\n/g, "\r\n") })).toBe(
      reference,
    );
    expect(
      revisionHash({
        ...base,
        bodyMarkdown: "# Payroll Software Philippines   \n\nA guide for HR teams.  \n\n\n",
      }),
    ).toBe(reference);
    expect(revisionHash({ ...base, title: "Payroll Software Philippines  " })).toBe(reference);
  });

  it("does not ignore whitespace a reader can see", () => {
    expect(
      revisionHash({
        ...base,
        bodyMarkdown: "# Payroll  Software Philippines\n\nA guide for HR teams.\n",
      }),
    ).not.toBe(revisionHash(base));
  });

  it("treats composed and decomposed Unicode as the same text", () => {
    expect(revisionHash({ ...base, title: "Café payroll" })).toBe(
      revisionHash({ ...base, title: "Café payroll" }),
    );
  });

  it("does not care about the order of keys in structured data", () => {
    const a = revisionHash({ ...base, schemaJson: { a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } } });
    const b = revisionHash({ ...base, schemaJson: { b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 } });
    expect(a).toBe(b);
    expect(canonicalJson({ z: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"z":1}');
  });

  it("distinguishes an absent field from an empty one only when a reader could", () => {
    // Empty and null read the same to a person: both mean "no excerpt".
    expect(revisionHash({ ...base, excerpt: "" })).not.toBe(
      revisionHash({ ...base, excerpt: null }),
    );
  });
});
