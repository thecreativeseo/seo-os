import { validateSameSiteUrl } from "@/lib/url/same-site";

import type { SitemapFetchOptions } from "./fetch";

/**
 * Sitemap discovery from robots.txt (docs/P1_SPEC.md §12).
 *
 * robots.txt is the site's own declaration of where its sitemaps live, so it is
 * the authority to prefer over a guessed conventional path such as /sitemap.xml.
 * A WordPress site, for instance, serves its index at /wp-sitemap.xml and says so
 * in robots.txt; guessing /sitemap.xml would find a different plugin's map or
 * nothing at all.
 *
 * Every URL robots.txt names is still put through the same-site guard before it
 * is trusted. A robots.txt can declare a sitemap on any host, and following one
 * blindly would reopen the very SSRF hole the fetcher exists to close.
 */

/** Enough for any real site; a robots.txt naming more than this is noise or hostile. */
const MAX_DECLARED = 20;
const ROBOTS_TIMEOUT_MS = 10_000;
const MAX_ROBOTS_BYTES = 512 * 1024;

export async function discoverSitemapsFromRobots(
  websiteHostname: string,
  options: SitemapFetchOptions = {},
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? ROBOTS_TIMEOUT_MS);

  let text: string;
  try {
    const response = await fetchImpl(`https://${websiteHostname}/robots.txt`, {
      signal: controller.signal,
      headers: { "User-Agent": "SEO-OS/1.0 (+sitemap discovery)" },
      // Same reasoning as the sitemap fetcher: a redirect could leave the origin
      // the guard vetted, so it is not chased.
      redirect: "manual",
    });

    if (!response.ok) return [];
    text = (await response.text()).slice(0, MAX_ROBOTS_BYTES);
  } catch {
    // A site with no robots.txt is normal, not an error worth surfacing.
    return [];
  } finally {
    clearTimeout(timeout);
  }

  const declared: string[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (!match) continue;

    // A declared sitemap on another host is refused rather than followed.
    const validated = validateSameSiteUrl(match[1]!, websiteHostname);
    if (!validated.ok) continue;

    if (!seen.has(validated.url)) {
      seen.add(validated.url);
      declared.push(validated.url);
      if (declared.length >= MAX_DECLARED) break;
    }
  }

  return declared;
}
