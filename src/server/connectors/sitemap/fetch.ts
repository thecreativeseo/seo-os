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
  // URL-shape refusals, decided before any request is made.
  | "invalid_url"
  | "unsupported_protocol"
  | "host_mismatch"
  | "ip_address_not_allowed"
  // What the request came back as. "http_error" was the whole story before;
  // it hid a 404 from a 403 from a 500, so each now stands on its own and the
  // HTTP status is carried alongside.
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "redirect"
  | "timeout"
  | "unreachable"
  | "http_error"
  // The request succeeded but the body is not a sitemap.
  | "invalid_content_type"
  | "invalid_xml"
  | "not_xml"
  | "too_large"
  | "empty";

export class SitemapError extends Error {
  constructor(
    message: string,
    readonly code: SitemapFetchError,
    /** The HTTP status, when the failure was an HTTP response rather than a refusal. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "SitemapError";
  }
}

/** Options shared by the fetch entry points. `fetchImpl` is injected in tests. */
export type SitemapFetchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** A polite, honest identifier. Some servers answer an empty User-Agent with 403. */
const SITEMAP_USER_AGENT = "SEO-OS/1.0 (+sitemap fetch)";

/** Turns an HTTP status into a specific code, preserving the number for the message. */
export function classifyHttpStatus(status: number): SitemapFetchError {
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "http_error";
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

async function fetchXml(url: string, options: SitemapFetchOptions = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/xml, text/xml, application/xhtml+xml, */*",
        "User-Agent": SITEMAP_USER_AGENT,
      },
      // A redirect could land somewhere the host check already rejected, so the
      // fetcher refuses to chase a target the SSRF guard never saw.
      redirect: "manual",
    });
  } catch (error) {
    // Our own timeout aborts with this name; anything else is a genuine
    // connection failure — DNS, refused, reset.
    if (error instanceof Error && error.name === "AbortError") {
      throw new SitemapError("The sitemap did not respond in time.", "timeout");
    }
    throw new SitemapError("Could not reach that sitemap.", "unreachable");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new SitemapError(
      "That sitemap redirects. Enter the final URL directly.",
      "redirect",
      response.status,
    );
  }

  if (!response.ok) {
    throw new SitemapError(
      `The server returned HTTP ${response.status} for that sitemap.`,
      classifyHttpStatus(response.status),
      response.status,
    );
  }

  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_SITEMAP_BYTES) {
    throw new SitemapError("That sitemap is too large to process.", "too_large");
  }

  const text = await response.text();

  if (text.length > MAX_SITEMAP_BYTES) {
    throw new SitemapError("That sitemap is too large to process.", "too_large");
  }

  // A 200 can still be the wrong thing: a login wall, a soft-404 HTML page, a
  // JSON error. An HTML body is never a sitemap however valid it looks, but a
  // sitemap served under an odd content-type still is one.
  const head = text.slice(0, 512).toLowerCase();
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const looksHtml =
    contentType.includes("text/html") || head.includes("<!doctype html") || head.includes("<html");
  const looksSitemap = /<(urlset|sitemapindex)[\s>]/i.test(text) || text.includes("<loc");

  if (looksHtml && !looksSitemap) {
    throw new SitemapError("That URL returned a web page, not a sitemap.", "invalid_content_type");
  }

  if (!looksSitemap) {
    throw new SitemapError("That response was not a valid sitemap.", "invalid_xml");
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
  options: SitemapFetchOptions = {},
): Promise<SitemapResult> {
  const validated = validateSitemapUrl(sitemapUrl, websiteHostname);

  if (!validated.ok) {
    throw new SitemapError(SITEMAP_ERROR_MESSAGES[validated.code], validated.code);
  }

  const xml = await fetchXml(validated.url, options);
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
      const childXml = await fetchXml(childValidated.url, options);
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
  not_found: "The sitemap could not be found at this URL.",
  forbidden: "The website refused access to the sitemap.",
  rate_limited: "The website is rate limiting requests. Try again shortly.",
  server_error: "The website returned a server error while the sitemap was fetched.",
  redirect: "That URL redirects. Enter the final sitemap URL directly.",
  timeout: "The sitemap did not respond in time.",
  unreachable: "The sitemap could not be reached.",
  http_error: "The sitemap could not be fetched.",
  invalid_content_type: "That URL responded, but it returned a web page rather than a sitemap.",
  invalid_xml: "That URL responded, but it was not a valid sitemap XML file.",
  not_xml: "That does not look like a sitemap.",
  too_large: "That sitemap is too large to process.",
  empty: "That sitemap lists no URLs.",
};
