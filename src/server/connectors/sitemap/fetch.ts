import { normalizeUrl } from "@/lib/url/normalize-url";
import { validateSameSiteUrl } from "@/lib/url/same-site";

/**
 * Sitemap fetching and parsing (docs/P1_SPEC.md §12).
 *
 * This is the only place SEO OS fetches a URL a user typed, which makes it the
 * only server-side request forgery surface in the product. The guards below are
 * therefore not optional politeness:
 *
 *   - http and https only, so file: and gopher: cannot be reached
 *   - the sitemap host must match the website it belongs to, so a workspace cannot
 *     aim the fetcher at an internal service or someone else's server
 *   - literal IP addresses are refused outright, which closes the obvious route to
 *     169.254.169.254 and other loopback and link-local targets
 *   - responses are size- and time-limited, so a slow or enormous response cannot
 *     hold a request open or exhaust memory
 *
 * A sitemap is a claim the site makes about itself. Nothing here treats a listed
 * URL as indexed, ranked, or even reachable.
 */

export const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
/** One level of nesting: a sitemap index pointing at sitemaps. Deeper is refused. */
export const MAX_NESTED_SITEMAPS = 50;

export type SitemapFetchError =
  | "invalid_url"
  | "unsupported_protocol"
  | "host_mismatch"
  | "ip_address_not_allowed"
  | "unreachable"
  | "http_error"
  | "too_large"
  | "not_xml"
  | "empty";

export class SitemapError extends Error {
  constructor(
    message: string,
    readonly code: SitemapFetchError,
  ) {
    super(message);
    this.name = "SitemapError";
  }
}

/**
 * Validates that a sitemap URL is safe to fetch for a given website.
 *
 * The guard itself now lives in lib/url/same-site, shared with P3's page content
 * capture. It was written and tested here first; sharing it rather than copying
 * it means there is one implementation of the rule instead of one correct
 * implementation and one that was not updated.
 *
 * Still exported from here: the guarantees matter more than the fetching, and
 * they should be provable without a network.
 */
export function validateSitemapUrl(
  input: string,
  websiteHostname: string,
): { ok: true; url: string } | { ok: false; code: SitemapFetchError } {
  const result = validateSameSiteUrl(input, websiteHostname);

  return result.ok ? { ok: true, url: result.url } : { ok: false, code: result.code };
}

/** Extracts <loc> values. Works for both urlset and sitemapindex documents. */
export function parseSitemapLocations(xml: string): {
  kind: "index" | "urlset";
  locations: string[];
} {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "index" : "urlset";

  const locations: string[] = [];
  const pattern = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(xml)) !== null) {
    const value = match[1]!
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();

    if (value.length > 0) locations.push(value);
  }

  return { kind, locations };
}

async function fetchXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/xml, text/xml, */*" },
      // A redirect could land somewhere the host check already rejected, so the
      // fetcher does not follow them silently.
      redirect: "manual",
    });
  } catch {
    throw new SitemapError("Could not reach that sitemap.", "unreachable");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new SitemapError(
      "That sitemap redirects. Use the final URL directly.",
      "http_error",
    );
  }

  if (!response.ok) {
    throw new SitemapError(`That sitemap returned ${response.status}.`, "http_error");
  }

  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_SITEMAP_BYTES) {
    throw new SitemapError("That sitemap is too large to process.", "too_large");
  }

  const text = await response.text();

  if (text.length > MAX_SITEMAP_BYTES) {
    throw new SitemapError("That sitemap is too large to process.", "too_large");
  }

  if (!text.includes("<loc")) {
    throw new SitemapError("That does not look like a sitemap.", "not_xml");
  }

  return text;
}

export type SitemapResult = {
  /** Normalized, de-duplicated URLs belonging to this website. */
  urls: string[];
  /** URLs that were listed but rejected, with why. Surfaced, never silently dropped. */
  skipped: { url: string; reason: string }[];
  nestedSitemaps: number;
};

/**
 * Fetches a sitemap and returns the URLs it lists.
 *
 * A URL that does not belong to this website is skipped rather than imported: a
 * sitemap can legitimately list a CDN or a partner domain, and importing those as
 * Pages would attribute someone else's URLs to this site.
 */
export async function fetchSitemap(
  sitemapUrl: string,
  websiteHostname: string,
): Promise<SitemapResult> {
  const validated = validateSitemapUrl(sitemapUrl, websiteHostname);

  if (!validated.ok) {
    throw new SitemapError(SITEMAP_ERROR_MESSAGES[validated.code], validated.code);
  }

  const xml = await fetchXml(validated.url);
  const parsed = parseSitemapLocations(xml);

  const skipped: { url: string; reason: string }[] = [];
  const seen = new Set<string>();
  let nestedSitemaps = 0;

  const collect = (locations: string[]) => {
    for (const location of locations) {
      const normalized = normalizeUrl(location, websiteHostname);

      if (!normalized.ok) {
        skipped.push({ url: location, reason: normalized.reason });
        continue;
      }

      const host = normalized.value.hostname.replace(/^www\./, "");
      const site = websiteHostname.toLowerCase().replace(/^www\./, "");

      if (host !== site && !host.endsWith(`.${site}`)) {
        skipped.push({ url: location, reason: "different_host" });
        continue;
      }

      seen.add(normalized.value.normalized);
    }
  };

  if (parsed.kind === "urlset") {
    collect(parsed.locations);
    return { urls: [...seen], skipped, nestedSitemaps: 0 };
  }

  // A sitemap index. One level only: deeper nesting is legal but rare, and
  // following it without a depth limit is how a fetcher becomes a crawler.
  for (const child of parsed.locations.slice(0, MAX_NESTED_SITEMAPS)) {
    const childValidated = validateSitemapUrl(child, websiteHostname);

    if (!childValidated.ok) {
      skipped.push({ url: child, reason: childValidated.code });
      continue;
    }

    try {
      const childXml = await fetchXml(childValidated.url);
      const childParsed = parseSitemapLocations(childXml);
      nestedSitemaps += 1;

      if (childParsed.kind === "index") {
        skipped.push({ url: child, reason: "nested_too_deep" });
        continue;
      }

      collect(childParsed.locations);
    } catch {
      skipped.push({ url: child, reason: "unreachable" });
    }
  }

  return { urls: [...seen], skipped, nestedSitemaps };
}

export const SITEMAP_ERROR_MESSAGES: Record<SitemapFetchError, string> = {
  invalid_url: "Enter a full sitemap URL, for example https://example.com/sitemap.xml.",
  unsupported_protocol: "Only http and https sitemaps are supported.",
  host_mismatch: "A sitemap must be on the same domain as the website.",
  ip_address_not_allowed: "Enter a domain name rather than an IP address.",
  unreachable: "Could not reach that sitemap.",
  http_error: "That sitemap could not be fetched.",
  too_large: "That sitemap is too large to process.",
  not_xml: "That does not look like a sitemap.",
  empty: "That sitemap lists no URLs.",
};
