/**
 * Where SEO OS is willing to send a CMS request (M6 plan D6).
 *
 * A Connection's base URL is the first value in this product that turns into a
 * destination this server dials. That makes it a server-side request forgery
 * surface: a tenant who can set it can otherwise ask our server to fetch a
 * cloud metadata endpoint, a database admin port, or anything else reachable
 * from inside the deployment and not from outside it.
 *
 * So the policy lives here, in one place, and it is a gate rather than a
 * helper. Provider code cannot construct a request URL except through
 * `cmsRestUrl`, which only accepts a base that has already been through
 * `parseCmsBaseUrl`, and a redirect is only followed after `checkRedirect`
 * has said the same things about the new destination.
 *
 * Two layers, because either alone is bypassable. The syntactic layer refuses
 * literal private addresses and names that cannot be public. The resolution
 * layer refuses a public-looking name that resolves to a private address,
 * which is the whole of DNS rebinding.
 *
 * Nothing here performs a network call. `assertPublicDestination` takes the
 * resolver as an argument so it can be driven by a fake in tests and by
 * node:dns in production.
 */

export const CMS_URL_REFUSAL_CODES = [
  "not_a_url",
  "scheme_not_https",
  "credentials_in_url",
  "has_query",
  "has_fragment",
  "host_missing",
  "host_not_public",
  "address_not_public",
  "port_not_allowed",
  "path_not_allowed",
  "too_long",
  "resolution_failed",
  "resolution_empty",
  "redirect_cross_host",
] as const;

export type CmsUrlRefusalCode = (typeof CMS_URL_REFUSAL_CODES)[number];

/** What a person is told. Never echoes the value: it may be someone's internal host. */
export const CMS_URL_REFUSAL_MESSAGES: Record<CmsUrlRefusalCode, string> = {
  not_a_url: "That is not a web address.",
  scheme_not_https: "The site address must start with https://.",
  credentials_in_url: "The site address must not contain a username or password.",
  has_query: "The site address must not contain a query string.",
  has_fragment: "The site address must not contain a fragment.",
  host_missing: "The site address has no host name.",
  host_not_public: "That host name is not a public internet address.",
  address_not_public: "That host name resolves to an address that is not on the public internet.",
  port_not_allowed: "The site must be served on the standard HTTPS port.",
  path_not_allowed: "The site path may only be a plain subdirectory, such as /blog.",
  too_long: "That site address is too long.",
  resolution_failed: "That host name could not be resolved.",
  resolution_empty: "That host name resolved to no addresses.",
  redirect_cross_host: "The site redirected somewhere else, which is not followed.",
};

export type CmsUrlResult<T> = { ok: true; value: T } | { ok: false; code: CmsUrlRefusalCode };

function refuse<T>(code: CmsUrlRefusalCode): CmsUrlResult<T> {
  return { ok: false, code };
}

/**
 * A base URL that has passed the syntactic policy.
 *
 * The branded field is not decoration: it is what stops a caller passing a raw
 * string where a checked one is required, since only this module can make one.
 */
export type CanonicalSiteUrl = {
  readonly __cmsBaseUrl: true;
  /** Origin plus subdirectory, no trailing slash. The idempotency key uses this. */
  readonly href: string;
  readonly hostname: string;
  readonly port: number;
  /** "" or a leading-slash subdirectory such as "/blog". */
  readonly basePath: string;
};

const MAX_URL_LENGTH = 2000;
const ALLOWED_PORT = 443;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** Host suffixes that are never on the public internet, whatever DNS says. */
const PRIVATE_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".localdomain",
  ".home.arpa",
  ".onion",
  ".test",
  ".example",
  ".invalid",
] as const;

const PRIVATE_HOST_NAMES = ["localhost", "metadata", "metadata.google.internal"] as const;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Strict dotted quad. The URL parser has already normalised octal and decimal forms. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

function ipv4IsPublic([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, and AWS/GCP metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, and Alibaba metadata
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Eight 16-bit groups, or null. Accepts "::" compression and a trailing IPv4 form. */
function parseIpv6(host: string): number[] | null {
  let text = host;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (!text.includes(":")) return null;
  text = text.split("%")[0] ?? text; // drop any zone index

  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const suffix = text.slice(lastColon + 1);
  if (suffix.includes(".")) {
    const v4 = parseIpv4(suffix);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, lastColon + 1) + "0:0";
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? "");
  if (!head) return null;
  if (halves.length === 1) {
    const full = tail.length > 0 ? [...head.slice(0, -2), ...tail] : head;
    return full.length === 8 ? full : null;
  }
  const rest = toGroups(halves[1] ?? "");
  if (!rest) return null;
  const merged = tail.length > 0 ? [...rest.slice(0, -2), ...tail] : rest;
  const missing = 8 - head.length - merged.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...merged];
}

function ipv6IsPublic(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as number[];
  const allZero = groups.every((g) => g === 0);
  if (allZero) return false; // ::
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return false; // ::1
  }
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64
  // (64:ff9b::/96) all carry a v4 address; judge them as that address.
  const embedded = (): boolean => {
    const a = (g6 >> 8) & 0xff;
    const b = g6 & 0xff;
    const c = (g7 >> 8) & 0xff;
    const d = g7 & 0xff;
    return ipv4IsPublic([a, b, c, d]);
  };
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return embedded();
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded();
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return embedded();
  }
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard prefix
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local, deprecated
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/**
 * Whether a literal address may be dialled. Anything unparseable is refused:
 * a resolver that hands us something we do not understand is not a reason to
 * proceed.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return ipv4IsPublic(v4);
  const v6 = parseIpv6(address);
  if (v6) return ipv6IsPublic(v6);
  return false;
}

/** Whether a host name could name something on the public internet. */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return false;
  if (host.startsWith("[")) return isPublicAddress(host);
  if (parseIpv4(host)) return isPublicAddress(host);
  if (PRIVATE_HOST_NAMES.includes(host as (typeof PRIVATE_HOST_NAMES)[number])) return false;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // A single label resolves through the deployment's search domains, which is
  // how an internal service gets reached by a name that looks harmless.
  if (!host.includes(".")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The base URL
// ---------------------------------------------------------------------------

/**
 * The one way to turn a person's typed site address into something this server
 * will dial. Syntactic only: it does no DNS, so it is safe to call anywhere,
 * including while rendering.
 */
export function parseCmsBaseUrl(input: string): CmsUrlResult<CanonicalSiteUrl> {
  const raw = input.trim();
  if (raw.length === 0) return refuse("not_a_url");
  if (raw.length > MAX_URL_LENGTH) return refuse("too_long");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("not_a_url");
  }

  if (url.protocol !== "https:") return refuse("scheme_not_https");
  if (url.username !== "" || url.password !== "") return refuse("credentials_in_url");
  if (url.search !== "") return refuse("has_query");
  if (url.hash !== "") return refuse("has_fragment");
  if (url.hostname === "") return refuse("host_missing");

  const port = url.port === "" ? ALLOWED_PORT : Number(url.port);
  if (port !== ALLOWED_PORT) return refuse("port_not_allowed");

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicHostname(hostname)) return refuse("host_not_public");

  const trimmed = url.pathname.replace(/\/+$/, "");
  if (trimmed !== "") {
    const segments = trimmed.slice(1).split("/");
    if (segments.some((segment) => !PATH_SEGMENT.test(segment))) return refuse("path_not_allowed");
  }

  return {
    ok: true,
    value: {
      __cmsBaseUrl: true,
      href: `https://${hostname}${trimmed}`,
      hostname,
      port,
      basePath: trimmed,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type AddressResolver = (hostname: string) => Promise<string[]>;

/**
 * The second gate, run immediately before a request and again for a redirect.
 *
 * A name that passed the syntactic policy can still resolve inward, either
 * because someone controls the record or because the network is arranged that
 * way. Every returned address must be public; one private answer refuses the
 * whole destination, because we cannot choose which address the socket uses.
 */
export async function assertPublicDestination(
  site: CanonicalSiteUrl,
  resolve: AddressResolver,
): Promise<CmsUrlResult<string[]>> {
  let addresses: string[];
  try {
    addresses = await resolve(site.hostname);
  } catch {
    return refuse("resolution_failed");
  }
  if (addresses.length === 0) return refuse("resolution_empty");
  if (!addresses.every((address) => isPublicAddress(address))) return refuse("address_not_public");
  return { ok: true, value: addresses };
}

// ---------------------------------------------------------------------------
// Building requests
// ---------------------------------------------------------------------------

/**
 * The only way to build a CMS request URL. Takes a checked base, so a provider
 * cannot assemble a destination from a raw string, and re-checks the result so
 * a path argument cannot walk out of the site it was given.
 */
export function cmsRestUrl(
  site: CanonicalSiteUrl,
  path: string,
  query: Readonly<Record<string, string | number | undefined>> = {},
): CmsUrlResult<string> {
  if (!path.startsWith("/")) return refuse("path_not_allowed");
  if (path.includes("..") || path.includes("//")) return refuse("path_not_allowed");

  let url: URL;
  try {
    url = new URL(`${site.href}${path}`);
  } catch {
    return refuse("not_a_url");
  }
  if (url.protocol !== "https:" || url.hostname !== site.hostname || url.port !== "") {
    return refuse("path_not_allowed");
  }
  if (!url.pathname.startsWith(site.basePath === "" ? "/" : `${site.basePath}/`)) {
    return refuse("path_not_allowed");
  }

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return { ok: true, value: url.toString() };
}

/**
 * Whether a redirect may be followed.
 *
 * Same host as the validated base, and nothing else. A CMS that answers a REST
 * call with a redirect to another host is either misconfigured or being used to
 * point us somewhere, and neither is a reason to send the request again with
 * the tenant's credentials attached.
 */
export function checkRedirect(
  site: CanonicalSiteUrl,
  location: string,
  currentUrl: string,
): CmsUrlResult<string> {
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    return refuse("not_a_url");
  }
  if (target.protocol !== "https:") return refuse("scheme_not_https");
  if (target.username !== "" || target.password !== "") return refuse("credentials_in_url");
  if (target.hostname.toLowerCase().replace(/\.$/, "") !== site.hostname) {
    return refuse("redirect_cross_host");
  }
  if (target.port !== "" && Number(target.port) !== site.port) return refuse("port_not_allowed");
  if (!isPublicHostname(target.hostname)) return refuse("host_not_public");
  return { ok: true, value: target.toString() };
}
