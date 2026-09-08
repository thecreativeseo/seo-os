import { lookup } from "node:dns/promises";

import { checkRedirect, assertPublicDestination, type CanonicalSiteUrl } from "@/lib/cms/url";
import type { CmsRequest, CmsTransport, CmsTransportResult } from "./types";

/**
 * The only way a CMS request leaves this process.
 *
 * Two things it exists to guarantee, both of which the milestone treats as
 * release blocking.
 *
 * The destination stays inside the policy. The URL is built from a base that
 * already passed `parseCmsBaseUrl`, the host is resolved and every returned
 * address checked before the socket is opened, and each redirect is put through
 * the same questions again rather than followed. Redirects are followed one at
 * a time, by hand, because `fetch`'s own following would do it without asking.
 *
 * A failed POST is never quietly retried, and more than that: whether it may
 * have been transmitted is part of the answer. There is no retry wrapper here
 * at all, for any method. A caller that wants to try again has to decide to,
 * with the `sent` flag in front of it.
 */

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

export type TransportOptions = {
  site: CanonicalSiteUrl;
  /** Injected in tests. Production passes node's resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

async function resolveAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * Whether a failure happened before anything could have been sent.
 *
 * An abort fired by our own timeout, or a DNS failure, or a refused connection
 * all happen before a request body reaches the server. Anything else after the
 * socket is open could have been received and acted on, so the honest answer is
 * that we do not know.
 *
 * Node's error codes are the evidence. An unrecognised failure is treated as
 * possibly-sent, which is the safe direction: it costs a reconciliation, where
 * the other way costs a duplicate draft.
 */
function neverSent(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  const cause =
    error && typeof error === "object" && "cause" in error && error.cause
      ? ((error.cause as { code?: unknown }).code ?? undefined)
      : undefined;

  const codes = new Set([code, cause === undefined ? undefined : String(cause)]);

  // Connection never established: nothing could have arrived.
  for (const safe of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]) {
    if (codes.has(safe)) return true;
  }

  return false;
}

/**
 * Builds the transport for one site.
 *
 * The credential never appears here. Headers arrive already built by the caller
 * for the one call being made, and nothing in this file reads, copies, logs or
 * persists them.
 */
export function createTransport(options: TransportOptions): CmsTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const resolve = options.resolve ?? resolveAddresses;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request: CmsRequest): Promise<CmsTransportResult> => {
    const destination = await assertPublicDestination(options.site, resolve);
    if (!destination.ok) {
      // Never dialled, so nothing was sent whatever the reason.
      return { ok: false, sent: false, code: "cms_unreachable" };
    }

    let url = request.url;
    let sent = false;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      let response: Response;

      try {
        sent = true;
        response = await doFetch(url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (neverSent(error)) return { ok: false, sent: false, code: "cms_unreachable" };
        // A timeout or a reset after the socket opened. For a GET that is simply
        // a failure; for a create it means the CMS may hold a draft we cannot
        // see, and the caller must reconcile rather than send it again.
        return {
          ok: false,
          sent: request.mutating,
          code: request.mutating ? "create_ambiguous" : "cms_unreachable",
        };
      }

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        const next = checkRedirect(options.site, location, url);
        if (!next.ok) {
          // A redirect we will not follow. For a create this is ambiguous: the
          // request reached something, and what it did with it is unknown.
          return {
            ok: false,
            sent: request.mutating,
            code: request.mutating ? "create_ambiguous" : "cms_unreachable",
          };
        }

        const checked = await assertPublicDestination(
          { ...options.site, hostname: new URL(next.value).hostname },
          resolve,
        );
        if (!checked.ok) {
          return {
            ok: false,
            sent: request.mutating,
            code: request.mutating ? "create_ambiguous" : "cms_unreachable",
          };
        }

        url = next.value;
        continue;
      }

      let body: string;
      try {
        body = await response.text();
      } catch {
        return { ok: false, sent, code: "cms_invalid_response" };
      }

      return { ok: true, status: response.status, body };
    }

    // Still redirecting after the ceiling. Same reasoning as a refused redirect.
    return {
      ok: false,
      sent: request.mutating,
      code: request.mutating ? "create_ambiguous" : "cms_unreachable",
    };
  };
}

/**
 * The Basic header for one request.
 *
 * Built here, handed to one call, and never returned, stored or logged. The
 * base64 value is a credential in its own right, which is why it is produced at
 * the moment of use rather than carried around.
 */
export function basicAuthHeader(username: string, applicationPassword: string): string {
  return `Basic ${Buffer.from(`${username}:${applicationPassword}`, "utf8").toString("base64")}`;
}
