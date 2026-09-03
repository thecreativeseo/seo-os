/**
 * The guard for fetching a URL somebody typed.
 *
 * Extracted from the sitemap fetcher in P1, where it was written and tested, and
 * shared rather than copied because P3 needs the same guarantees to capture page
 * content. Two implementations of a security rule eventually become one correct
 * implementation and one that was not updated.
 *
 * What it refuses, and why:
 *
 *   - anything but http and https, so file: and gopher: cannot be reached
 *   - literal IP addresses, which closes the obvious route to 169.254.169.254
 *     and other loopback and link-local targets
 *   - any host that is not the website itself or a subdomain of it, so a
 *     workspace cannot aim the fetcher at an internal service or somebody else's
 *     server
 *
 * The host check is deliberately not endsWith: "notexample.com" ends with
 * "example.com" and is a different company.
 */

export type SameSiteUrlError =
  | "invalid_url"
  | "unsupported_protocol"
  | "ip_address_not_allowed"
  | "host_mismatch";

export type SameSiteUrlResult =
  | { ok: true; url: string; hostname: string }
  | { ok: false; code: SameSiteUrlError };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function validateSameSiteUrl(
  input: string,
  websiteHostname: string,
): SameSiteUrlResult {
  let parsed: URL;

  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, code: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "unsupported_protocol" };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");

  // A bracketed host is an IPv6 literal; IPV4 catches the other form.
  if (host.startsWith("[") || IPV4.test(host)) {
    return { ok: false, code: "ip_address_not_allowed" };
  }

  const site = websiteHostname.toLowerCase().replace(/^www\./, "");
  const candidate = host.replace(/^www\./, "");

  if (candidate !== site && !candidate.endsWith(`.${site}`)) {
    return { ok: false, code: "host_mismatch" };
  }

  return { ok: true, url: parsed.toString(), hostname: host };
}

export const SAME_SITE_URL_MESSAGES: Record<SameSiteUrlError, string> = {
  invalid_url: "Enter a full URL, for example https://example.com/pricing.",
  unsupported_protocol: "Only http and https addresses can be fetched.",
  ip_address_not_allowed: "Enter a domain name rather than an IP address.",
  host_mismatch: "That address is not on this website's domain.",
};
