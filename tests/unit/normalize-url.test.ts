import { describe, expect, it } from "vitest";

import { normalizeUrl } from "@/lib/url/normalize-url";
import { normalizeQuery } from "@/lib/query/normalize-query";

/**
 * P1 acceptance: "meaningful URL distinctions preserved" and unique
 * (website_id, normalized_url). Over-normalizing is the dangerous direction —
 * it silently sums the metrics of unrelated pages.
 */

function url(input: string, base?: string): string | null {
  const result = normalizeUrl(input, base);
  return result.ok ? result.value.normalized : null;
}

describe("url normalization", () => {
  const same: [string, string][] = [
    ["https://example.com/pricing", "https://example.com/pricing"],
    ["https://example.com/pricing/", "https://example.com/pricing"],
    ["https://EXAMPLE.com/Pricing", "https://example.com/Pricing"],
    ["http://example.com/pricing", "https://example.com/pricing"],
    ["https://example.com/pricing#features", "https://example.com/pricing"],
    ["https://example.com/pricing/index.html", "https://example.com/pricing"],
    ["https://example.com//pricing", "https://example.com/pricing"],
    ["https://example.com", "https://example.com/"],
    ["https://example.com/", "https://example.com/"],
  ];

  it.each(same)("%s -> %s", (input, expected) => {
    expect(url(input)).toBe(expected);
  });

  it("keeps the path case, because servers may treat it as significant", () => {
    // Hostnames are case-insensitive; paths are not.
    expect(url("https://example.com/Pricing")).not.toBe(url("https://example.com/pricing"));
  });

  it("strips tracking parameters", () => {
    expect(url("https://example.com/p?utm_source=x&utm_campaign=y")).toBe(
      "https://example.com/p",
    );
    expect(url("https://example.com/p?gclid=abc&fbclid=def")).toBe("https://example.com/p");
  });

  it("keeps parameters that select content", () => {
    expect(url("https://example.com/blog?page=2")).toBe("https://example.com/blog?page=2");
    expect(url("https://example.com/p?product=widget")).toBe(
      "https://example.com/p?product=widget",
    );
  });

  it("keeps a content parameter even alongside tracking ones", () => {
    expect(url("https://example.com/blog?utm_source=x&page=2")).toBe(
      "https://example.com/blog?page=2",
    );
  });

  it("orders parameters so ordering cannot create a second identity", () => {
    expect(url("https://example.com/p?b=2&a=1")).toBe(url("https://example.com/p?a=1&b=2"));
  });

  it("does not merge genuinely different pages", () => {
    const pages = [
      "https://example.com/pricing",
      "https://example.com/pricing/enterprise",
      "https://example.com/blog/pricing",
      "https://blog.example.com/pricing",
      "https://example.com/blog?page=2",
      "https://example.com/blog?page=3",
    ].map((entry) => url(entry));

    expect(new Set(pages).size).toBe(pages.length);
  });

  it("resolves a bare path against the website hostname", () => {
    // GA4 reports landing pages as paths.
    expect(url("/pricing", "example.com")).toBe("https://example.com/pricing");
    expect(url("pricing", "example.com")).toBe("https://example.com/pricing");
  });

  it("returns the parts a Page row needs", () => {
    const result = normalizeUrl("https://blog.example.com/posts/one/?utm_source=x");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hostname).toBe("blog.example.com");
      expect(result.value.protocol).toBe("https");
      expect(result.value.path).toBe("/posts/one");
    }
  });

  const rejected: [string, string][] = [
    ["", "empty"],
    ["   ", "empty"],
    ["ftp://example.com/file", "unsupported_protocol"],
    ["javascript:alert(1)", "unsupported_protocol"],
    ["not a url", "invalid"],
    ["data:text/html,<h1>x</h1>", "unsupported_protocol"],
  ];

  it.each(rejected)("rejects %s as %s", (input, reason) => {
    const result = normalizeUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("treats a port as a port, not a scheme", () => {
    // The scheme check must not fire on "example.com:8080".
    expect(url("example.com:8080/pricing")).toBe("https://example.com/pricing");
  });

  it("is idempotent", () => {
    for (const input of [
      "https://www.Example.com/pricing/?utm_source=x",
      "https://example.com/blog?page=2",
      "https://example.com/",
    ]) {
      const once = url(input)!;
      expect(url(once)).toBe(once);
    }
  });
});

describe("query normalization", () => {
  function q(input: string): string | null {
    const result = normalizeQuery(input);
    return result.ok ? result.normalized : null;
  }

  it("lowercases and collapses whitespace", () => {
    expect(q("  SEO   Agency  ")).toBe("seo agency");
    expect(q("SEO\tAgency")).toBe("seo agency");
    expect(q("seo\nagency")).toBe("seo agency");
  });

  it("folds typographic variants", () => {
    expect(q("john’s seo")).toBe("john's seo");
    expect(q("seo — agency")).toBe("seo - agency");
  });

  it("does not stem, de-pluralize, or drop stop words", () => {
    // These rank differently and are searched differently. Merging them would hide
    // the very splits this phase exists to surface.
    expect(q("seo agency")).not.toBe(q("seo agencies"));
    expect(q("seo for startups")).not.toBe(q("seo startups"));
    expect(q("running shoes")).not.toBe(q("run shoes"));
  });

  it("keeps accented characters distinct from their unaccented forms", () => {
    expect(q("café seo")).not.toBe(q("cafe seo"));
  });

  it("rejects empty and overlong queries", () => {
    expect(normalizeQuery("   ").ok).toBe(false);
    expect(normalizeQuery("a".repeat(301)).ok).toBe(false);
  });

  it("is idempotent", () => {
    const once = q("  SEO   Agency ")!;
    expect(q(once)).toBe(once);
  });
});
