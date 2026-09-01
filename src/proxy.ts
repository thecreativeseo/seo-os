import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next 16 proxy (formerly middleware).
 *
 * Two jobs:
 *   1. Refresh the Supabase session cookie so it does not expire mid-visit.
 *   2. Redirect unauthenticated traffic away from protected routes.
 *
 * (2) is a convenience, NOT the security boundary. Every protected page and Server
 * Action independently calls requireUser(), and every tenant query goes through the
 * authorization guards. UI hiding is not security (CLAUDE.md).
 */

const PUBLIC_PATHS = ["/login", "/auth", "/api/health"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    // Misconfigured environment: fail closed on protected routes rather than
    // silently letting traffic through.
    return isPublic(request.nextUrl.pathname)
      ? response
      : NextResponse.redirect(new URL("/login", request.url));
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() validates the token with the auth server; getSession() only reads the
  // cookie and must not be used for an access decision.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic(request.nextUrl.pathname)) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets. Without this, auth
    // redirects would also block CSS, JS, and images.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
