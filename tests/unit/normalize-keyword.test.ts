import { describe, expect, it } from "vitest";

import {
  DEFAULT_LANGUAGE,
  DEFAULT_MARKET,
  MAX_KEYWORD_LENGTH,
  normalizeKeyword,
  resolveMarketIdentity,
} from "@/lib/keyword/normalize-keyword";
import { normalizeQuery } from "@/lib/query/normalize-query";

describe("keyword folding", () => {
  it("collapses whitespace and lowercases", () => {
    const result = normalizeKeyword("  Payroll   Software\nPhilippines ");
    expect(result.ok && result.value.normalized).toBe("payroll software philippines");
  });

  it("folds typographic variants", () => {
    const curly = normalizeKeyword("what’s the best “payroll” system");
    const straight = normalizeKeyword("what's the best \"payroll\" system");

    expect(curly.ok && curly.value.normalized).toBe(
      straight.ok ? straight.value.normalized : "",
    );
  });

  it("keeps distinctions that rank differently", () => {
    // No stemming and no de-pluralisation. These are typed differently, ranked
    // differently, and bid on differently; merging them would hide the split P2
    // exists to surface.
    const singular = normalizeKeyword("seo agency");
    const plural = normalizeKeyword("seo agencies");

    expect(singular.ok && singular.value.normalized).not.toBe(
      plural.ok ? plural.value.normalized : "",
    );

    // Accents are typed separately too.
    const plain = normalizeKeyword("cafe manila");
    const accented = normalizeKeyword("café manila");
    expect(plain.ok && plain.value.normalized).not.toBe(
      accented.ok ? accented.value.normalized : "",
    );
  });

  it("refuses an empty keyword", () => {
    const result = normalizeKeyword("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
  });

  it("refuses a keyword longer than any provider supports", () => {
    const result = normalizeKeyword("a".repeat(MAX_KEYWORD_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_long");
  });
});

/**
 * The join that makes P2 possible: a Search Console query and a Semrush keyword
 * that are the same string must resolve to the same identity. If these two ever
 * disagree, a keyword shows demand with no clicks — a data bug that reads exactly
 * like an insight.
 */
describe("keyword and query identity agree", () => {
  const cases = [
    "payroll software philippines",
    "  Payroll   Software  ",
    "what’s the best payroll system",
    "café manila",
    "seo agency vs seo agencies",
    "hr-software",
    "HR—Software",
  ];

  it("produces the same string for the same input", () => {
    for (const input of cases) {
      const keyword = normalizeKeyword(input);
      const query = normalizeQuery(input);

      expect(keyword.ok).toBe(query.ok);

      if (keyword.ok && query.ok) {
        expect(keyword.value.normalized).toBe(query.normalized);
      }
    }
  });
});

describe("market identity", () => {
  it("defaults to the configured market", () => {
    const result = normalizeKeyword("payroll software");

    expect(result.ok && result.value.language).toBe(DEFAULT_LANGUAGE);
    expect(result.ok && result.value.market).toBe(DEFAULT_MARKET);
    expect(result.ok && result.value.locale).toBe(`${DEFAULT_LANGUAGE}-${DEFAULT_MARKET}`);
  });

  it("normalizes case in both parts", () => {
    const result = normalizeKeyword("payroll", { language: "EN", market: "ph" });

    expect(result.ok && result.value.language).toBe("en");
    expect(result.ok && result.value.market).toBe("PH");
    expect(result.ok && result.value.locale).toBe("en-PH");
  });

  it("keeps the same text in two markets distinct", () => {
    // The whole reason identity includes the market: same words, different
    // volume, different competitors, different money.
    const ph = normalizeKeyword("payroll software", { market: "PH" });
    const us = normalizeKeyword("payroll software", { market: "US" });

    expect(ph.ok && ph.value.normalized).toBe(us.ok ? us.value.normalized : "");
    expect(ph.ok && ph.value.locale).not.toBe(us.ok ? us.value.locale : "");
  });

  it("refuses codes that are not codes", () => {
    expect(normalizeKeyword("payroll", { language: "english" }).ok).toBe(false);
    expect(normalizeKeyword("payroll", { market: "PHL" }).ok).toBe(false);

    const bad = normalizeKeyword("payroll", { market: "12" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid_market");
  });

  it("never returns a blank locale field", () => {
    // Non-null with defaults is deliberate: a null in a Postgres unique key does
    // not compare equal to another null, so nullable locale columns would permit
    // duplicate keywords. P1 learned this with signals; P2 designs it out.
    const resolved = resolveMarketIdentity({ language: null, market: null });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.language).not.toBe("");
      expect(resolved.value.market).not.toBe("");
      expect(resolved.value.locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });
});
