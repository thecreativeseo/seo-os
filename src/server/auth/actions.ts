"use server";

import { redirect } from "next/navigation";

import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/server/auth/supabase-server";

/**
 * Starts the Google OAuth flow.
 *
 * Runs server-side so the PKCE code verifier is written to an httpOnly cookie by the
 * same client that will later exchange it. No token or verifier is exposed to the
 * browser, and nothing OAuth-shaped is logged.
 */
export async function signInWithGoogle(): Promise<void> {
  const env = getEnv();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  });

  if (error || !data.url) {
    // Deliberately generic: provider errors can carry request details we do not
    // want rendered or logged.
    redirect("/auth/auth-error?reason=oauth_start_failed");
  }

  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
