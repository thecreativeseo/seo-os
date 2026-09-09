import { describe, expect, it } from "vitest";

import { normalizeUrl } from "@/lib/url/normalize-url";
import { landingPageToUrl } from "@/server/services/sync";

/**
 * GA4 audit (P1 GSC normalized-grain aggregation, §14).
 *
 * The question asked: can two raw GA4 rows resolve to the same persisted
 * Ga4LandingPageMetricDaily conflict key — (website, date, page) — inside one
 * INSERT? These tests establish the answer from the code as it is, and make
 * no behavioural change. They exist so the answer is a fact in the suite
 * rather than a sentence in a report.
 *
 * The connector asks GA4 for `landingPagePlusQueryString`, so GA4 reports
 * `/careers`, `/careers/` and `/careers?utm_source=x` as three rows. The
 * writer maps each through landingPageToUrl and then normalizeUrl, which
 * folds all three into one page. Three rows, one page, one day: the same
 * shape that failed Search Console.
 */

const HOST = "sprout.ph";

function pageOf(landingPage: string): string | null {
  const candidate = landingPageToUrl(landingPage, HOST);
  if (!candidate) return null;
  const url = normalizeUrl(candidate, HOST);
  return url.ok ? url.value.normalized : null;
}

describe("GA4 landing pages that become one page", () => {
  it("folds a trailing slash, a tracking parameter and an index file together", () => {
    const pages = [
      "/careers",
      "/careers/",
      "/careers?utm_source=newsletter",
      "/careers?gclid=abc&utm_medium=cpc",
      "/careers/index.html",
      "/careers#openings",
    ].map(pageOf);

    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).toBe(`https://${HOST}/careers`);
  });

  it("keeps a content-selecting parameter as its own page", () => {
    expect(pageOf("/careers?p=2")).not.toBe(pageOf("/careers"));
    expect(pageOf("/careers?job=engineer")).not.toBe(pageOf("/careers"));
  });

  it("drops the placeholders GA4 uses when it could not attribute a session", () => {
    expect(pageOf("(not set)")).toBeNull();
    expect(pageOf("(other)")).toBeNull();
    expect(pageOf("")).toBeNull();
  });
});

describe("the conclusion", () => {
  it("is that the same duplicate-key path exists for GA4, and is not fixed here", () => {
    // Two GA4 rows for one date and these two landing pages would produce two
    // insert rows with the same (website, date, page) in one statement. GA4's
    // metrics do not all add the way clicks do — users and new users are
    // distinct counts across landing pages and would overcount if summed — so
    // the aggregation is a separate decision, deliberately not made in a
    // Search Console hotfix.
    const a = pageOf("/careers");
    const b = pageOf("/careers/?utm_source=x");
    expect(a).toBe(b);
  });
});
