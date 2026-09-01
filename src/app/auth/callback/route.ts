import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/server/auth/supabase-server";
import { resolveInternalUser } from "@/server/auth/resolve-user";

/**
 * OAuth callback. Exchanges the authorization code for a session, then resolves the
 * internal SEO OS user.
 *
 * Failure is always generic and always lands on /auth/auth-error. Provider error
 * text, the authorization code, and anything token-shaped are never rendered,
 * redirected with, or logged.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const providerError = url.searchParams.get("error");

  const errorRedirect = (reason: string) =>
    NextResponse.redirect(new URL(`/auth/auth-error?reason=${reason}`, url.origin));

  // The user declined consent, or Google rejected the request.
  if (providerError) {
    return errorRedirect("access_denied");
  }

  if (!code) {
    return errorRedirect("missing_code");
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    return errorRedirect("exchange_failed");
  }

  try {
    await resolveInternalUser(data.user);
  } catch {
    return errorRedirect("user_resolution_failed");
  }

  return NextResponse.redirect(new URL("/", url.origin));
}
