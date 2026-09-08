import { describe, expect, it } from "vitest";

import {
  canonicalContent,
  compareContent,
  compareText,
  normalizeHref,
  normalizeText,
} from "@/lib/cms/content";

/**
 * Deciding whether WordPress holds what we approved (M6.2).
 *
 * Two halves, and both matter. What must be forgiven, because WordPress does it
 * to every post and none of it changes the piece. And what must never be
 * forgiven, because each one is a way a draft could be wrong while looking
 * right: a lost paragraph, an altered word, a link pointing somewhere else.
 *
 * The old approach compared the first and last thirty words. Every "must be
 * caught" case below would have passed it.
 */

const article = [
  "<h2>Payroll in the Philippines</h2>",
  "<p>Employers file monthly, and the deadline moves for holidays.</p>",
  '<p>See the <a href="https://example.com/guide">full guide</a> for the schedule.</p>',
  "<ul><li>Compute the contribution</li><li>File before the cutoff</li></ul>",
].join("");

describe("what WordPress is allowed to change", () => {
  it("forgives the typography it rewrites on every post", () => {
    const ours = "<p>It's a \"quote\" -- and an ellipsis...</p>";
    const theirs = "<p>It’s a “quote” – and an ellipsis…</p>";
    expect(compareContent(ours, theirs).matches).toBe(true);
  });

  it("forgives whitespace, newlines and non-breaking spaces", () => {
    const theirs = "<h2>Payroll in the Philippines</h2>\n\n  <p>Employers file monthly,\n and the deadline moves for holidays.</p>\n<p>See the <a href=\"https://example.com/guide\">full guide</a> for the schedule.</p>\n<ul>\n<li>Compute the contribution</li>\n<li>File before the cutoff</li>\n</ul>";
    expect(compareContent(article, theirs).matches).toBe(true);
  });

  it("forgives an empty paragraph, which WordPress adds and removes freely", () => {
    expect(compareContent(article, `${article}<p></p>`).matches).toBe(true);
  });

  it("forgives a host's letter case and a bare trailing slash", () => {
    expect(normalizeHref("HTTPS://Example.com/")).toBe(normalizeHref("https://example.com"));
  });
});

describe("what it is never allowed to change", () => {
  const mustFail = (label: string, observed: string, kind: string) => {
    it(label, () => {
      const result = compareContent(article, observed);
      expect(result.matches, label).toBe(false);
      expect(result.difference?.kind).toBe(kind);
      expect(result.expectedFingerprint).not.toBe(result.observedFingerprint);
    });
  };

  mustFail(
    "notices a paragraph that never arrived",
    article.replace("<p>Employers file monthly, and the deadline moves for holidays.</p>", ""),
    "BLOCK_COUNT",
  );

  mustFail(
    "notices substantive content nobody approved",
    `${article}<p>Contact us for a free consultation.</p>`,
    "BLOCK_COUNT",
  );

  mustFail("notices a changed word", article.replace("monthly", "annually"), "TEXT");

  mustFail(
    "notices a changed heading",
    article.replace("Payroll in the Philippines", "Payroll in Singapore"),
    "TEXT",
  );

  mustFail(
    "notices a heading demoted to a paragraph",
    article.replace("<h2>Payroll in the Philippines</h2>", "<p>Payroll in the Philippines</p>"),
    "BLOCK",
  );

  mustFail(
    "notices a link sent somewhere else",
    article.replace("https://example.com/guide", "https://competitor.example/guide"),
    "LINK",
  );

  mustFail(
    "notices a link that was removed, leaving its words",
    article.replace('<a href="https://example.com/guide">full guide</a>', "full guide"),
    "LINK_COUNT",
  );

  it("notices reordered headings even when every word survives", () => {
    const reordered = [
      "<h2>Second</h2>",
      "<h2>First</h2>",
    ].join("");
    const original = ["<h2>First</h2>", "<h2>Second</h2>"].join("");
    expect(compareContent(original, reordered).matches).toBe(false);
  });

  it("notices a change in the middle, which sampling the ends would miss", () => {
    const long = (middle: string) =>
      `<p>Opening paragraph that stays exactly the same.</p>${middle}<p>Closing paragraph that stays exactly the same.</p>`;

    expect(
      compareContent(long("<p>Rates rose by four percent.</p>"), long("<p>Rates rose by nine percent.</p>"))
        .matches,
    ).toBe(false);
  });
});

describe("the canonical form", () => {
  it("keeps every block, in order, with its whole text", () => {
    const canonical = canonicalContent(article);
    expect(canonical.blocks.map((block) => block.tag)).toEqual(["h2", "p", "p", "li", "li"]);
    expect(canonical.blocks[1]!.text).toBe(
      "Employers file monthly, and the deadline moves for holidays.",
    );
  });

  it("keeps every link with its destination and its words", () => {
    expect(canonicalContent(article).links).toEqual([
      { href: "https://example.com/guide", text: "full guide" },
    ]);
  });

  it("is stable across runs, so a fingerprint can be compared later", () => {
    expect(canonicalContent(article).fingerprint).toBe(canonicalContent(article).fingerprint);
    expect(canonicalContent(article).fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not lose text that is left outside any block", () => {
    expect(canonicalContent("Bare words with no wrapper").text).toBe("Bare words with no wrapper");
  });

  it("survives empty and malformed input rather than throwing", () => {
    for (const input of ["", "   ", "<p>unclosed", "<<>>", "<script>alert(1)</script>"]) {
      expect(() => canonicalContent(input)).not.toThrow();
    }
    expect(canonicalContent("<script>alert(1)</script>").text).toBe("");
  });
});

describe("titles and excerpts", () => {
  it("compare whole values, with the same forgiveness", () => {
    expect(compareText("It's here", "It’s here")).toBe(true);
    expect(compareText("  Spaced   out  ", "Spaced out")).toBe(true);
    expect(compareText("Payroll guide", "Payroll guides")).toBe(false);
    expect(compareText(null, "")).toBe(true);
  });

  it("normalizes text without swallowing a difference", () => {
    expect(normalizeText("a  b\n c")).toBe("a b c");
    expect(normalizeText("a b")).not.toBe(normalizeText("a c"));
  });
});
