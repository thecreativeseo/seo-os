import { NextResponse } from "next/server";

import { relativeRedirect } from "@/lib/http/relative-redirect";
import { createSupabaseServerClient } from "@/server/auth/supabase-server";

/**
 * Sign out. POST only — a GET would let a third-party page log the user out via an
 * image tag or link prefetch.
 */
export async function POST(): Promise<NextResponse> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  return relativeRedirect("/login", 303);
}
