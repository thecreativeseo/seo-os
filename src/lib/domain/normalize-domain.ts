/**
 * Domain normalization (docs/P0_SPEC.md §9).
 *
 * Required behaviour:
 *   https://www.Example.com/  -> example.com
 *   www.example.com           -> example.com
 *   example.com/              -> example.com
 *   meaningful subdomains stay distinct: blog.example.com != example.com
 *
 * Only a leading "www." is stripped. Every other label is meaningful — a site may
 * genuinely operate on blog.example.com or shop.example.com, and collapsing those
 * would merge two different SEO properties into one.
 */

export type NormalizeResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: NormalizeError };

export type NormalizeError =
  | "empty"
  | "invalid"
  | "ip_address"
  | "no_public_suffix"
  | "too_long";

const MAX_HOSTNAME_LENGTH = 253;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function normalizeDomain(input: string): NormalizeResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }

  // A bare domain has no scheme; add one so the URL parser will accept it. Anything
  // that already carries a scheme keeps it, so "http://x" and "x" behave alike.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let hostname: string;
  try {
    // URL handles port, path, query, fragment, credentials, and IDN -> punycode.
    hostname = new URL(withScheme).hostname;
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (hostname.length === 0) {
    return { ok: false, reason: "invalid" };
  }

  // Trailing dot marks an explicit root; it is not part of the identity.
  let host = hostname.toLowerCase().replace(/\.$/, "");

  // IPv6 literals arrive bracketed.
  if (host.startsWith("[") || IPV4.test(host)) {
    return { ok: false, reason: "ip_address" };
  }

  if (host.startsWith("www.")) {
    host = host.slice(4);
  }

  if (host.length > MAX_HOSTNAME_LENGTH) {
    return { ok: false, reason: "too_long" };
  }

  const labels = host.split(".");

  if (labels.length < 2) {
    // "localhost", "intranet" — no public suffix, so not an SEO property.
    return { ok: false, reason: "no_public_suffix" };
  }

  if (labels.some((label) => label.length === 0)) {
    return { ok: false, reason: "invalid" };
  }

  // Punycode output is already ASCII; reject anything else unexpected.
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return { ok: false, reason: "invalid" };
  }

  if (labels.some((label) => label.startsWith("-") || label.endsWith("-"))) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, normalized: host };
}

export const NORMALIZE_ERROR_MESSAGES: Record<NormalizeError, string> = {
  empty: "Enter a website domain.",
  invalid: "That does not look like a valid domain.",
  ip_address: "Enter a domain name rather than an IP address.",
  no_public_suffix: "Enter a full domain, for example example.com.",
  too_long: "That domain is too long.",
};
