import { describe, expect, it } from "vitest";

import {
  MARKETS,
  MAX_ADDITIONAL_MARKETS,
  isMarketCode,
  marketName,
  resolveMarketCode,
} from "@/lib/markets";

/**
 * Markets as codes (docs/P0_SPEC.md "Main Market").
 *
 * The properties that matter: the list is the ISO set and nothing more, a
 * spelling a person would type resolves to the same code keyword identity
 * uses, and anything unrecognised resolves to null rather than to a default -
 * because this value chooses which country's data the connectors are billed
 * for, and a wrong country is data about the wrong place.
 */

describe("the market list", () => {
  it("is the ISO set, nothing more", () => {
    const codes = MARKETS.map((market) => market.code);

    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z]{2}$/);
    for (const present of ["PH", "GB", "US", "SG", "MY", "AE"]) expect(codes).toContain(present);

    // CLDR aliases, superseded codes and pseudo-locales are not markets anyone
    // can buy search data for.
    for (const absent of ["UK", "EU", "ZZ", "XK", "SU", "YU", "XA", "QO"]) {
      expect(codes).not.toContain(absent);
    }
  });

  it("is sorted by name, because it is a dropdown", () => {
    const names = MARKETS.map((market) => market.name);
    expect([...names].sort((a, b) => a.localeCompare(b, "en"))).toEqual(names);
  });

  it("caps additional markets at five", () => {
    expect(MAX_ADDITIONAL_MARKETS).toBe(5);
  });
});

describe("resolving a market", () => {
  it("accepts a code in any case, with whitespace", () => {
    expect(resolveMarketCode("GB")).toBe("GB");
    expect(resolveMarketCode("gb")).toBe("GB");
    expect(resolveMarketCode(" ph ")).toBe("PH");
  });

  it("understands the spellings the keyword-identity layer already knows", () => {
    // The same table, so a website that onboarded as "United Kingdom" and its
    // keywords filed under GB agree about where they are.
    expect(resolveMarketCode("United Kingdom")).toBe("GB");
    expect(resolveMarketCode("Philippines")).toBe("PH");
    expect(resolveMarketCode("usa")).toBe("US");
    expect(resolveMarketCode("en-GB")).toBe("GB");
  });

  it("returns null rather than a default for anything else", () => {
    expect(resolveMarketCode("")).toBeNull();
    expect(resolveMarketCode("   ")).toBeNull();
    expect(resolveMarketCode(null)).toBeNull();
    expect(resolveMarketCode(undefined)).toBeNull();
    // Shaped like a code, but not one.
    expect(resolveMarketCode("XX")).toBeNull();
    // The kind of thing an approved context version actually holds.
    expect(
      resolveMarketCode(
        "English-speaking B2B SEO agencies, initially targeting the UK and United States.",
      ),
    ).toBeNull();
  });

  it("calls only a real, uppercase ISO code a market code", () => {
    expect(isMarketCode("PH")).toBe(true);
    expect(isMarketCode("UK")).toBe(false);
    expect(isMarketCode("ph")).toBe(false);
    expect(isMarketCode(null)).toBe(false);
  });
});

describe("naming a market", () => {
  it("names a code", () => {
    expect(marketName("PH")).toBe("Philippines");
    expect(marketName("GB")).toBe("United Kingdom");
  });

  it("names a stored name by resolving it first", () => {
    expect(marketName("united kingdom")).toBe("United Kingdom");
  });

  it("hands back what it cannot resolve, so an approved sentence still shows", () => {
    const sentence = "initially targeting the UK and United States";
    expect(marketName(sentence)).toBe(sentence);
  });

  it("is null for nothing", () => {
    expect(marketName(null)).toBeNull();
    expect(marketName("")).toBeNull();
  });
});
