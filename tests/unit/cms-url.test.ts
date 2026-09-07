import { describe, expect, it } from "vitest";

import {
  assertPublicDestination,
  checkRedirect,
  cmsRestUrl,
  isPublicAddress,
  isPublicHostname,
  parseCmsBaseUrl,
  type CanonicalSiteUrl,
} from "@/lib/cms/url";

/**
 * The WordPress URL policy (M6 plan D6).
 *
 * A CMS base URL is a destination this server dials, and the tenant chooses it.
 * These are the cases where saying yes would let someone reach something inside
 * the deployment that they cannot reach from outside it. No milestone after
 * this one may make any of them pass.
 */

function site(input: string): CanonicalSiteUrl {
  const parsed = parseCmsBaseUrl(input);
  if (!parsed.ok) throw new Error(`expected ${input} to be accepted, got ${parsed.code}`);
  return parsed.value;
}

function refusalFor(input: string): string {
  const parsed = parseCmsBaseUrl(input);
  return parsed.ok ? "ACCEPTED" : parsed.code;
}

describe("the CMS base URL", () => {
  it("accepts a plain https site and canonicalises it", () => {
    const value = site("https://Example.com/");
    expect(value.href).toBe("https://example.com");
    expect(value.hostname).toBe("example.com");
    expect(value.port).toBe(443);
    expect(value.basePath).toBe("");
  });

  it("accepts a WordPress installed in a subdirectory", () => {
    expect(site("https://example.com/blog").basePath).toBe("/blog");
    expect(site("https://example.com/blog/").href).toBe("https://example.com/blog");
    expect(site("https://example.com/site/wp").basePath).toBe("/site/wp");
  });

  it("refuses anything that is not https", () => {
    expect(refusalFor("http://example.com")).toBe("scheme_not_https");
    expect(refusalFor("ftp://example.com")).toBe("scheme_not_https");
    expect(refusalFor("file:///etc/passwd")).toBe("scheme_not_https");
    expect(refusalFor("gopher://example.com")).toBe("scheme_not_https");
    expect(refusalFor("example.com")).toBe("not_a_url");
    expect(refusalFor("")).toBe("not_a_url");
  });

  it("refuses credentials embedded in the address", () => {
    expect(refusalFor("https://user:secret@example.com")).toBe("credentials_in_url");
    expect(refusalFor("https://user@example.com")).toBe("credentials_in_url");
  });

  it("refuses a query or a fragment", () => {
    expect(refusalFor("https://example.com/?rest_route=/")).toBe("has_query");
    expect(refusalFor("https://example.com/#top")).toBe("has_fragment");
  });

  it("refuses a port other than the standard one", () => {
    expect(refusalFor("https://example.com:8443")).toBe("port_not_allowed");
    expect(refusalFor("https://example.com:22")).toBe("port_not_allowed");
    expect(refusalFor("https://example.com:443")).toBe("ACCEPTED");
  });

  it("refuses names that cannot be on the public internet", () => {
    expect(refusalFor("https://localhost")).toBe("host_not_public");
    expect(refusalFor("https://api.localhost")).toBe("host_not_public");
    expect(refusalFor("https://wordpress.local")).toBe("host_not_public");
    expect(refusalFor("https://metadata.google.internal")).toBe("host_not_public");
    expect(refusalFor("https://db.internal")).toBe("host_not_public");
    expect(refusalFor("https://host.home.arpa")).toBe("host_not_public");
    // A single label resolves through the deployment's own search domains.
    expect(refusalFor("https://intranet")).toBe("host_not_public");
  });

  it("refuses literal private and reserved addresses", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.4.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.100.100.200",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "192.0.2.1",
      "198.18.0.1",
    ]) {
      expect(refusalFor(`https://${host}`)).toBe("host_not_public");
    }
  });

  it("refuses an address dressed up as a decimal or hexadecimal number", () => {
    // The URL parser normalises these to 127.0.0.1 before the policy sees them,
    // which is exactly why the policy checks the parsed host and not the input.
    expect(refusalFor("https://2130706433")).toBe("host_not_public");
    expect(refusalFor("https://0x7f.0.0.1")).toBe("host_not_public");
    expect(refusalFor("https://127.1")).toBe("host_not_public");
  });

  it("refuses private IPv6, including the addresses that carry a v4 inside them", () => {
    for (const host of [
      "[::1]",
      "[::]",
      "[fd00::1]",
      "[fc00::1]",
      "[fe80::1]",
      "[ff02::1]",
      "[2001:db8::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:10.0.0.1]",
      "[64:ff9b::169.254.169.254]",
    ]) {
      expect(refusalFor(`https://${host}`)).toBe("host_not_public");
    }
  });

  it("accepts a public IPv6 address", () => {
    expect(refusalFor("https://[2606:2800:220:1:248:1893:25c8:1946]")).toBe("ACCEPTED");
  });

  it("refuses a path that is not a plain subdirectory", () => {
    expect(refusalFor("https://example.com/a%2Fb")).toBe("path_not_allowed");
    expect(refusalFor("https://example.com/wp admin")).toBe("path_not_allowed");
  });

  it("refuses an address longer than anything real", () => {
    expect(refusalFor(`https://example.com/${"a".repeat(2100)}`)).toBe("too_long");
  });
});

describe("judging an address on its own", () => {
  it("says yes only to public unicast", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fd12:3456::1")).toBe(false);
  });

  it("refuses anything it cannot parse rather than assuming the best", () => {
    expect(isPublicAddress("not-an-address")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
    expect(isPublicAddress("999.1.1.1")).toBe(false);
  });

  it("judges a host name without resolving it", () => {
    expect(isPublicHostname("example.com")).toBe(true);
    expect(isPublicHostname("EXAMPLE.COM.")).toBe(true);
    expect(isPublicHostname("localhost")).toBe(false);
  });
});

describe("resolving before dialling", () => {
  const target = site("https://example.com");

  it("accepts a name that resolves entirely to public addresses", async () => {
    const result = await assertPublicDestination(target, async () => ["93.184.216.34"]);
    expect(result.ok).toBe(true);
  });

  it("refuses a public name that resolves inward, which is the whole of rebinding", async () => {
    const result = await assertPublicDestination(target, async () => ["169.254.169.254"]);
    expect(result).toEqual({ ok: false, code: "address_not_public" });
  });

  it("refuses when any one answer is private, because we do not pick the socket", async () => {
    const result = await assertPublicDestination(target, async () => [
      "93.184.216.34",
      "127.0.0.1",
    ]);
    expect(result).toEqual({ ok: false, code: "address_not_public" });
  });

  it("refuses an empty or failing resolution", async () => {
    expect(await assertPublicDestination(target, async () => [])).toEqual({
      ok: false,
      code: "resolution_empty",
    });
    const thrower = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await assertPublicDestination(target, thrower)).toEqual({
      ok: false,
      code: "resolution_failed",
    });
  });
});

describe("building a request URL", () => {
  it("derives from the validated base and nowhere else", () => {
    const result = cmsRestUrl(site("https://example.com"), "/wp-json/wp/v2/posts", {
      status: "draft",
      per_page: 5,
    });
    expect(result).toEqual({
      ok: true,
      value: "https://example.com/wp-json/wp/v2/posts?status=draft&per_page=5",
    });
  });

  it("keeps a subdirectory install inside its subdirectory", () => {
    const result = cmsRestUrl(site("https://example.com/blog"), "/wp-json/wp/v2/posts");
    expect(result).toEqual({ ok: true, value: "https://example.com/blog/wp-json/wp/v2/posts" });
  });

  it("refuses a path that tries to leave the site it was given", () => {
    const target = site("https://example.com/blog");
    expect(cmsRestUrl(target, "/../../wp-json")).toEqual({ ok: false, code: "path_not_allowed" });
    expect(cmsRestUrl(target, "//evil.example/x")).toEqual({ ok: false, code: "path_not_allowed" });
    expect(cmsRestUrl(target, "wp-json")).toEqual({ ok: false, code: "path_not_allowed" });
  });
});

describe("following a redirect", () => {
  const target = site("https://example.com");
  const current = "https://example.com/wp-json/wp/v2/posts";

  it("allows one that stays on the same site", () => {
    expect(checkRedirect(target, "/wp-json/wp/v2/posts/", current)).toEqual({
      ok: true,
      value: "https://example.com/wp-json/wp/v2/posts/",
    });
  });

  it("refuses one that leaves it, however ordinary the destination looks", () => {
    expect(checkRedirect(target, "https://cdn.example.com/x", current)).toEqual({
      ok: false,
      code: "redirect_cross_host",
    });
    expect(checkRedirect(target, "https://example.com.evil.test/x", current)).toEqual({
      ok: false,
      code: "redirect_cross_host",
    });
  });

  it("refuses a redirect that would downgrade, re-target inward, or carry credentials", () => {
    expect(checkRedirect(target, "http://example.com/x", current)).toEqual({
      ok: false,
      code: "scheme_not_https",
    });
    expect(checkRedirect(target, "https://169.254.169.254/latest/meta-data", current)).toEqual({
      ok: false,
      code: "redirect_cross_host",
    });
    expect(checkRedirect(target, "https://user:pw@example.com/x", current)).toEqual({
      ok: false,
      code: "credentials_in_url",
    });
    expect(checkRedirect(target, "https://example.com:8443/x", current)).toEqual({
      ok: false,
      code: "port_not_allowed",
    });
  });
});
