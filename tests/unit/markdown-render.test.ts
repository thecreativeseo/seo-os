import { describe, expect, it } from "vitest";

import {
  extractLinks,
  plainText,
  renderMarkdown,
  stripLink,
  wordCount,
} from "@/lib/content/markdown";

describe("rendering markdown for a preview", () => {
  it("renders headings, lists, emphasis and internal links", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\nSee [pricing](/pricing) and **bold**.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('<a href="/pricing">pricing</a>');
    expect(html).toContain("<strong>bold</strong>");
  });

  it("escapes raw HTML instead of rendering it", () => {
    const html = renderMarkdown('Hello <script>alert(1)</script> <iframe src="x"></iframe>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never emits a javascript: link or an event handler", () => {
    const html = renderMarkdown('[x](javascript:alert(1)) and <a href="/ok" onclick="x()">y</a>');
    // markdown-it refuses the link; its text stays as text, which is the point.
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/<[^>]*onclick/i);
    expect(html).not.toContain('<a href="/ok"');
  });

  it("allows https images and drops the source of http ones", () => {
    const html = renderMarkdown("![a](https://cdn.example/a.png) ![b](http://cdn.example/b.png)");
    expect(html).toContain('src="https://cdn.example/a.png"');
    expect(html).not.toContain("http://cdn.example/b.png");
  });
});

describe("links and text", () => {
  it("lists every link in order, autolinks included, and none for unsafe schemes", () => {
    expect(
      extractLinks('See [a](/a) then <https://x.example/p> and [b](https://y.example "t").'),
    ).toEqual([
      { href: "/a", text: "a" },
      { href: "https://x.example/p", text: "https://x.example/p" },
      { href: "https://y.example", text: "b" },
    ]);
    expect(extractLinks("[x](javascript:alert(1)) [y](vbscript:foo)")).toEqual([]);
  });

  it("removes a link but keeps its text", () => {
    expect(
      stripLink('Read [our guide](https://evil.example/g "g") now.', "https://evil.example/g"),
    ).toBe("Read our guide now.");
    expect(stripLink("Go to <https://evil.example/g> now.", "https://evil.example/g")).toBe(
      "Go to  now.",
    );
    expect(stripLink("Keep [this](/pricing).", "https://evil.example/g")).toBe(
      "Keep [this](/pricing).",
    );
  });

  it("counts words in the text, not the markup", () => {
    expect(wordCount("# Two words\n\n- **three** more here\n\n[link](/x)")).toBe(6);
    expect(plainText("# A *b*\n\n[c](/d)")).toBe("A b c");
  });
});
