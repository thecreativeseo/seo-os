import { describe, expect, it } from "vitest";

import { normalizeDomain } from "@/lib/domain/normalize-domain";

function normalized(input: string): string | null {
  const result = normalizeDomain(input);
  return result.ok ? result.normalized : null;
}

describe("acceptance cases (P0_ACCEPTANCE_CRITERIA)", () => {
  it("https://www.Example.com/ -> example.com", () => {
    expect(normalized("https://www.Example.com/")).toBe("example.com");
  });

  it("www.example.com -> example.com", () => {
    expect(normalized("www.example.com")).toBe("example.com");
  });

  it("example.com/ -> example.com", () => {
    expect(normalized("example.com/")).toBe("example.com");
  });

  it("keeps meaningful subdomains distinct", () => {
    expect(normalized("blog.example.com")).toBe("blog.example.com");
    expect(normalized("shop.example.com")).toBe("shop.example.com");
    expect(normalized("blog.example.com")).not.toBe(normalized("example.com"));
  });
});

describe("stripping", () => {
  const cases: [string, string][] = [
    ["EXAMPLE.COM", "example.com"],
    ["  example.com  ", "example.com"],
    ["http://example.com", "example.com"],
    ["https://example.com", "example.com"],
    ["https://example.com:8443", "example.com"],
    ["example.com/path/to/page", "example.com"],
    ["example.com?utm_source=x", "example.com"],
    ["example.com#section", "example.com"],
    ["https://www.example.com/path?q=1#frag", "example.com"],
    ["example.com.", "example.com"],
    ["https://user:pass@example.com/", "example.com"],
    ["example.co.uk", "example.co.uk"],
    ["www.example.co.uk", "example.co.uk"],
    ["thecreativeseo.com", "thecreativeseo.com"],
  ];

  it.each(cases)("%s -> %s", (input, expected) => {
    expect(normalized(input)).toBe(expected);
  });
});

describe("www handling", () => {
  it("strips only a leading www", () => {
    expect(normalized("www.example.com")).toBe("example.com");
  });

  it("does not strip www from the middle", () => {
    expect(normalized("www.www.example.com")).toBe("www.example.com");
  });

  it("does not strip a label merely starting with www", () => {
    expect(normalized("wwwx.example.com")).toBe("wwwx.example.com");
  });
});

describe("internationalised domains", () => {
  it("converts to punycode so one site has one identity", () => {
    const result = normalized("münchen.de");
    expect(result).toBe("xn--mnchen-3ya.de");
  });

  it("treats the unicode and punycode forms as the same domain", () => {
    expect(normalized("münchen.de")).toBe(normalized("xn--mnchen-3ya.de"));
  });
});

describe("rejections", () => {
  const cases: [string, string][] = [
    ["", "empty"],
    ["   ", "empty"],
    ["localhost", "no_public_suffix"],
    ["intranet", "no_public_suffix"],
    ["127.0.0.1", "ip_address"],
    ["192.168.1.1", "ip_address"],
    ["http://[::1]/", "ip_address"],
    ["example..com", "invalid"],
    ["-example.com", "invalid"],
    ["example-.com", "invalid"],
  ];

  it.each(cases)("rejects %s as %s", (input, reason) => {
    const result = normalizeDomain(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
    }
  });
});

describe("idempotence", () => {
  it("normalizing twice changes nothing", () => {
    for (const input of [
      "https://www.Example.com/",
      "blog.example.com",
      "münchen.de",
      "example.co.uk",
    ]) {
      const once = normalized(input)!;
      expect(normalized(once)).toBe(once);
    }
  });
});
