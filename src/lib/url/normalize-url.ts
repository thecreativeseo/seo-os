/**
 * URL normalization for Page identity (docs/P1_SPEC.md §6).
 *
 * A Page is unique on (websiteId, normalizedUrl), so this function decides what
 * counts as "the same page". Two failure modes matter, and they pull in opposite
 * directions:
 *
 *   Normalizing too little splits one page across several rows — a page reached
 *   with a tracking parameter would look like a different page, and its metrics
 *   would be divided between them.
 *
 *   Normalizing too much merges genuinely different pages. That is worse: it
 *   silently sums the metrics of unrelated URLs, and nothing downstream can tell.
 *
 * So the rule is: strip only what is provably not part of page identity, and
 * preserve anything that might be. Query strings that select content — ?p=2,
 * ?product=x — are kept; parameters that only describe the visit are dropped.
 */

/** Parameters that describe how a visit arrived, never which page it reached. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "twclid",
  "ttclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "referrer",
  "source",
]);

/** Filenames that are the directory itself rather than a distinct page. */
const INDEX_FILES = new Set(["index.html", "index.htm", "index.php", "default.html"]);

export type NormalizedUrl = {
  normalized: string;
  hostname: string;
  protocol: string;
  path: string;
};

export type UrlNormalizeError = "empty" | "invalid" | "unsupported_protocol";

export type UrlNormalizeResult =
  | { ok: true; value: NormalizedUrl }
  | { ok: false; reason: UrlNormalizeError };

export function normalizeUrl(input: string, baseHostname?: string): UrlNormalizeResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }

  // Reject a non-web scheme explicitly rather than letting it fall through to a
  // parse failure. These arrive from external APIs and sitemaps, so javascript:
  // and data: need a definite answer, not an incidental one.
  //
  // The negative lookahead separates a scheme from a port: in "example.com:8080"
  // the colon is followed by digits, in "javascript:alert(1)" it is not.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(trimmed);

  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      return { ok: false, reason: "unsupported_protocol" };
    }
  }

  // GSC and sitemaps return absolute URLs; GA4 returns paths. A path is resolved
  // against the website's own hostname rather than guessed at.
  const candidate = schemeMatch
    ? trimmed
    : baseHostname
      ? `https://${baseHostname}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`
      : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported_protocol" };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  if (hostname.length === 0 || !hostname.includes(".")) {
    return { ok: false, reason: "invalid" };
  }

  // Path: decode percent-encoding where it is safe, drop an index file, and
  // collapse a trailing slash. "/a" and "/a/" are the same page in practice, and
  // treating them as two would split a page's metrics in half.
  let path = url.pathname;

  const segments = path.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (INDEX_FILES.has(last.toLowerCase())) {
    segments[segments.length - 1] = "";
    path = segments.join("/");
  }

  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  if (path.length === 0) {
    path = "/";
  }

  // Query: keep content-selecting parameters, sorted so ordering cannot create a
  // second identity for the same page.
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const search =
    kept.length > 0
      ? `?${kept.map(([key, value]) => `${key}=${value}`).join("&")}`
      : "";

  // The fragment is never part of server-side page identity.
  const normalized = `https://${hostname}${path}${search}`;

  return {
    ok: true,
    value: { normalized, hostname, protocol: url.protocol.replace(":", ""), path },
  };
}

export const URL_NORMALIZE_ERROR_MESSAGES: Record<UrlNormalizeError, string> = {
  empty: "Enter a URL.",
  invalid: "That does not look like a valid URL.",
  unsupported_protocol: "Only http and https URLs are supported.",
};
