import { NextResponse } from "next/server";

import { relativeRedirect } from "@/lib/http/relative-redirect";
import type { NextRequest } from "next/server";

import { verifyOAuthState } from "@/server/crypto/credentials";
import { providerFromSlug } from "@/server/connectors/google/oauth";
import { completeAuthorization } from "@/server/services/connection-auth";

/**
 * OAuth callback for data access.
 *
 * Every failure lands on the connections page with a code from a fixed vocabulary.
 * Google's own error text can carry request details and is never rendered, logged,
 * or passed through — the same rule P0 applies to sign-in failures.
 */
const SAFE_ERRORS = new Set([
  "access_denied",
  "missing_code",
  "invalid_state",
  "no_refresh_token",
  "exchange_failed",
]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider: slug } = await params;
  const url = new URL(request.url);

  const fail = (websiteId: string | null, code: string) => {
    const safe = SAFE_ERRORS.has(code) ? code : "exchange_failed";
    const path = websiteId ? `/websites/${websiteId}/connections?error=${safe}` : `/?error=${safe}`;
    return relativeRedirect(path, 303);
  };

  if (!providerFromSlug(slug)) {
    return fail(null, "invalid_state");
  }

  if (url.searchParams.get("error")) {
    // The user declined consent, or Google refused.
    return fail(null, "access_denied");
  }

  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");

  if (!code || !rawState) {
    return fail(null, "missing_code");
  }

  let websiteId: string | null = null;

  try {
    const state = verifyOAuthState(rawState);
    websiteId = state.websiteId;

    if (state.provider !== providerFromSlug(slug)) {
      return fail(websiteId, "invalid_state");
    }

    const { connection } = await completeAuthorization(state, code);

    // Authorised, but not yet connected: a property still has to be chosen.
    return relativeRedirect(
      `/websites/${state.websiteId}/connections?select=${connection.provider}`,
      303,
    );
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "exchange_failed";
    return fail(websiteId, code);
  }
}
