import { NextResponse } from "next/server";

/**
 * A redirect the browser resolves against the URL it is already on.
 *
 * Route handlers cannot trust any absolute origin they can compute: behind a
 * host's proxy request.url is the container's own address, and an environment
 * variable can be set to the wrong domain (Railway's private network name has
 * been). A relative Location has no origin to get wrong - the browser fills in
 * the one it used to reach us, which is by definition the one it can reach.
 *
 * Only site-relative paths are accepted. A protocol-relative "//host" or an
 * absolute URL would turn this into an open redirect.
 */
export function relativeRedirect(path: string, status: 303 | 307 = 307): NextResponse {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    throw new Error(`relativeRedirect expects a site-relative path, got "${path}"`);
  }

  return new NextResponse(null, { status, headers: { Location: path } });
}
