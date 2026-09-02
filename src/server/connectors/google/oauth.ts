import { getEnv } from "@/lib/env";

/**
 * Google OAuth for data access, deliberately separate from sign-in.
 *
 * P1_ACCEPTANCE_CRITERIA opens with "Google login does not automatically connect
 * GSC" and "...GA4". Supabase Auth can return a provider token with extra scopes at
 * sign-in, and using it would be the shortcut — but then signing in would grant
 * data access, which is precisely what the criteria forbid. Supabase also does not
 * persist the refresh token, so it could not survive a session anyway.
 *
 * So this is our own flow, with our own client, requesting read-only scopes and
 * storing the refresh token encrypted.
 */

export type GoogleProvider = "GOOGLE_SEARCH_CONSOLE" | "GOOGLE_ANALYTICS";

/** Read-only throughout. P1 reads data; it never writes to a Google property. */
export const PROVIDER_SCOPES: Record<GoogleProvider, string[]> = {
  GOOGLE_SEARCH_CONSOLE: ["https://www.googleapis.com/auth/webmasters.readonly"],
  GOOGLE_ANALYTICS: ["https://www.googleapis.com/auth/analytics.readonly"],
};

export const PROVIDER_SLUGS: Record<GoogleProvider, string> = {
  GOOGLE_SEARCH_CONSOLE: "gsc",
  GOOGLE_ANALYTICS: "ga4",
};

export function providerFromSlug(slug: string): GoogleProvider | null {
  if (slug === "gsc") return "GOOGLE_SEARCH_CONSOLE";
  if (slug === "ga4") return "GOOGLE_ANALYTICS";
  return null;
}

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

type GoogleCredentials = { clientId: string; clientSecret: string };

/**
 * These now live in application environment, where P0 deliberately kept them out.
 * P0 only proved identity, and Supabase performed that exchange; P1 exchanges codes
 * itself, so the secret has to be here.
 */
export function googleCredentials(): GoogleCredentials {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new GoogleOAuthError(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      "not_configured",
    );
  }

  return { clientId, clientSecret };
}

export function redirectUri(provider: GoogleProvider): string {
  const env = getEnv();
  return `${env.NEXT_PUBLIC_APP_URL}/api/connections/${PROVIDER_SLUGS[provider]}/callback`;
}

export function buildAuthorizationUrl(provider: GoogleProvider, state: string): string {
  const { clientId } = googleCredentials();

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri(provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", PROVIDER_SCOPES[provider].join(" "));
  // offline + consent is what actually returns a refresh token. Without both,
  // Google issues an access token that expires in an hour and the connection dies
  // silently overnight.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);

  return url.toString();
}

export type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
};

type GoogleTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json()) as GoogleTokenPayload;

  if (!response.ok || !payload.access_token) {
    // Google's error_description can contain request details. It is logged nowhere
    // and returned to nobody; the caller gets a code from our own vocabulary.
    throw new GoogleOAuthError(
      "Google did not return a token.",
      payload.error ?? "token_exchange_failed",
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000),
    scopes: payload.scope ? payload.scope.split(" ") : [],
  };
}

export async function exchangeCodeForTokens(
  provider: GoogleProvider,
  code: string,
): Promise<TokenResponse> {
  const { clientId, clientSecret } = googleCredentials();

  return postToken(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(provider),
      grant_type: "authorization_code",
    }),
  );
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = googleCredentials();

  return postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  );
}

export type RemoteProperty = { id: string; name: string };

/** Search Console properties this authorization can read. */
export async function listSearchConsoleProperties(
  accessToken: string,
): Promise<RemoteProperty[]> {
  const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new GoogleOAuthError("Could not list Search Console properties.", "list_failed");
  }

  const payload = (await response.json()) as {
    siteEntry?: { siteUrl: string; permissionLevel: string }[];
  };

  return (payload.siteEntry ?? [])
    // A property the user cannot read would produce empty syncs that look like a
    // site with no traffic.
    .filter((entry) => entry.permissionLevel !== "siteUnverifiedUser")
    .map((entry) => ({ id: entry.siteUrl, name: entry.siteUrl }));
}

/** GA4 properties this authorization can read. */
export async function listAnalyticsProperties(
  accessToken: string,
): Promise<RemoteProperty[]> {
  const response = await fetch(
    "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) {
    throw new GoogleOAuthError("Could not list Analytics properties.", "list_failed");
  }

  const payload = (await response.json()) as {
    accountSummaries?: {
      displayName?: string;
      propertySummaries?: { property: string; displayName: string }[];
    }[];
  };

  return (payload.accountSummaries ?? []).flatMap((account) =>
    (account.propertySummaries ?? []).map((property) => ({
      id: property.property,
      name: account.displayName
        ? `${account.displayName} · ${property.displayName}`
        : property.displayName,
    })),
  );
}

export async function listProperties(
  provider: GoogleProvider,
  accessToken: string,
): Promise<RemoteProperty[]> {
  return provider === "GOOGLE_SEARCH_CONSOLE"
    ? listSearchConsoleProperties(accessToken)
    : listAnalyticsProperties(accessToken);
}

/**
 * The slug for a provider, or null when it is not a Google data source.
 *
 * Keeps callers from indexing PROVIDER_SLUGS with the wider ConnectionProvider
 * enum, which would need a cast and would silently return undefined for HubSpot or
 * Semrush.
 */
export function slugForProvider(provider: string): string | null {
  if (provider === "GOOGLE_SEARCH_CONSOLE") return PROVIDER_SLUGS.GOOGLE_SEARCH_CONSOLE;
  if (provider === "GOOGLE_ANALYTICS") return PROVIDER_SLUGS.GOOGLE_ANALYTICS;
  return null;
}

export function isGoogleProvider(provider: string): provider is GoogleProvider {
  return provider === "GOOGLE_SEARCH_CONSOLE" || provider === "GOOGLE_ANALYTICS";
}
