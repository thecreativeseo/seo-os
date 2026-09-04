import type { NextRequest } from "next/server";

/**
 * The origin the browser is actually talking to.
 *
 * Inside a route handler, request.url is built from the address the server is
 * bound to. Behind a host's proxy that is the container's own address - on
 * Railway, https://localhost:8080 - so a redirect built from it sends the
 * browser somewhere it cannot reach. The sign-in callback did exactly that:
 * the session cookie was set, then the browser was pointed at localhost.
 *
 * NEXT_PUBLIC_APP_URL is the origin every OAuth return URL was registered
 * under, so it is the origin redirects use. Like every NEXT_PUBLIC_ value it is
 * inlined at build time, so a deployment redirects to the origin it was built
 * for - which is the one its variables name. The forwarded headers are the
 * fallback for a deployment that has not set it; the request URL is the last
 * resort, which is right on a laptop and wrong behind a proxy.
 */
export function publicOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Malformed; fall through to what the request can tell us.
    }
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();

  if (host) {
    return `${proto || "https"}://${host}`;
  }

  return new URL(request.url).origin;
}
