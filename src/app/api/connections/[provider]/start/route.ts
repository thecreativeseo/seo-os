import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { createOAuthState } from "@/server/crypto/credentials";
import { buildAuthorizationUrl, providerFromSlug } from "@/server/connectors/google/oauth";

/**
 * Starts a data-access authorization.
 *
 * POST rather than GET: this is a state-changing action that sends the user to
 * Google, and a GET could be triggered by a link prefetch.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider: slug } = await params;
  const provider = providerFromSlug(slug);
  const origin = new URL(request.url).origin;

  if (!provider) {
    return NextResponse.redirect(new URL("/", origin), { status: 303 });
  }

  const form = await request.formData();
  const websiteId = String(form.get("websiteId") ?? "");

  // Connecting a data source is an owner or admin decision.
  const context = await requireWebsiteAccess(websiteId, REQUIRED.APPROVE);

  try {
    const state = createOAuthState({
      websiteId: context.website.id,
      provider,
      userId: context.user.id,
    });

    return NextResponse.redirect(buildAuthorizationUrl(provider, state), { status: 303 });
  } catch {
    return NextResponse.redirect(
      new URL(`/websites/${context.website.id}/connections?error=not_configured`, origin),
      { status: 303 },
    );
  }
}
