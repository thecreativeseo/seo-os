import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getEnv } from "@/lib/env";

/**
 * Supabase client bound to the request's cookie jar.
 *
 * Server-side only. Sessions live in httpOnly cookies, so nothing token-shaped is
 * ever handed to the browser or to application code.
 *
 * Scope note: this client proves WHO is signed in. It never decides what a user may
 * access — that comes from OrganizationMembership, read through the authorization
 * guards. See docs/P0_SPEC.md §5.
 */
export async function createSupabaseServerClient() {
  const env = getEnv();
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only. The proxy
          // refreshes the session cookie on every request, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * The authenticated Supabase user, or null.
 *
 * Always uses getUser(), which validates the JWT with the auth server. getSession()
 * reads the cookie without verifying it and must not be used for access decisions.
 */
export async function getAuthUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return null;
  }

  return user;
}
