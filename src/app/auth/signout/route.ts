import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/server/auth/supabase-server";

/**
 * Sign out. POST only — a GET would let a third-party page log the user out via an
 * image tag or link prefetch.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(new URL("/login", new URL(request.url).origin), {
    status: 303,
  });
}
