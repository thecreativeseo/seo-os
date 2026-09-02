import { describe, expect, it } from "vitest";

import {
  parseSitemapLocations,
  validateSitemapUrl,
} from "@/server/connectors/sitemap/fetch";

/**
 * This is the only place SEO OS fetches a URL somebody typed, so it is the only
 * server-side request forgery surface in the product. These tests are about the
 * guard, not the parsing.
 */

describe("sitemap url validation", () => {
  const site = "example.com";

  it("accepts a sitemap on the website's own domain", () => {
    for (const url of [
      "https://example.com/sitemap.xml",
      "https://www.example.com/sitemap.xml",
      "https://blog.example.com/sitemap.xml",
      "http://example.com/sitemap_index.xml",
    ]) {
      expect(validateSitemapUrl(url, site).ok).toBe(true);
    }
  });

  it("refuses a sitemap on another domain", () => {
    // Without this, a workspace could aim the fetcher at any server we can reach.
    const result = validateSitemapUrl("https://attacker.example.net/sitemap.xml", site);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("host_mismatch");
  });

  it("refuses a domain that merely ends with the site name", () => {
    // notexample.com must not pass a naive endsWith check.
    const result = validateSitemapUrl("https://notexample.com/sitemap.xml", site);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("host_mismatch");
  });

  it("refuses IP addresses", () => {
    // The obvious route to cloud metadata and loopback services.
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/sitemap.xml",
      "http://10.0.0.1/sitemap.xml",
      "http://[::1]/sitemap.xml",
    ]) {
      const result = validateSitemapUrl(url, site);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("ip_address_not_allowed");
    }
  });

  it("refuses non-web protocols", () => {
    for (const url of ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/x"]) {
      const result = validateSitemapUrl(url, site);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unsupported_protocol");
    }
  });

  it("refuses a malformed URL", () => {
    const result = validateSitemapUrl("not a url", site);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_url");
  });
});

describe("sitemap parsing", () => {
  it("reads a urlset", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/</loc></url>
        <url><loc>https://example.com/pricing</loc><lastmod>2026-08-01</lastmod></url>
      </urlset>`;

    const parsed = parseSitemapLocations(xml);
    expect(parsed.kind).toBe("urlset");
    expect(parsed.locations).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
    ]);
  });

  it("recognises a sitemap index", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
      </sitemapindex>`;

    const parsed = parseSitemapLocations(xml);
    expect(parsed.kind).toBe("index");
    expect(parsed.locations).toHaveLength(2);
  });

  it("unwraps CDATA and decodes entities", () => {
    const xml = `<urlset>
      <url><loc><![CDATA[https://example.com/a?x=1&amp;y=2]]></loc></url>
      <url><loc>https://example.com/b?x=1&amp;y=2</loc></url>
    </urlset>`;

    expect(parseSitemapLocations(xml).locations).toEqual([
      "https://example.com/a?x=1&y=2",
      "https://example.com/b?x=1&y=2",
    ]);
  });

  it("tolerates whitespace and newlines inside loc", () => {
    const xml = `<urlset><url><loc>
        https://example.com/spaced
      </loc></url></urlset>`;

    expect(parseSitemapLocations(xml).locations).toEqual(["https://example.com/spaced"]);
  });

  it("returns nothing for a document with no locations", () => {
    expect(parseSitemapLocations("<urlset></urlset>").locations).toEqual([]);
  });
});
