import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { requireWebsiteAccess, type TenantContext } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  decryptCredential,
  encryptCredential,
  type OAuthState,
} from "@/server/crypto/credentials";
import {
  GoogleOAuthError,
  exchangeCodeForTokens,
  listProperties,
  refreshAccessToken,
  type GoogleProvider,
  type RemoteProperty,
} from "@/server/connectors/google/oauth";
import type { Connection } from "@/generated/prisma/client";

/**
 * Connecting a provider, in two deliberate steps.
 *
 * Authorising an account is not the same as choosing which property SEO OS reads.
 * A user with five Search Console properties must pick one; guessing would attach a
 * website to the wrong data and every number after that would be quietly wrong.
 *
 * So the callback stores the credential and leaves the connection CONNECTING. It
 * becomes CONNECTED only when a person selects a property.
 */

export class ConnectionAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ConnectionAuthError";
  }
}

/**
 * Completes the OAuth handshake.
 *
 * The state has already been verified by the caller, and it carries the website the
 * flow was started for — so the connection is attached to that website, never to
 * one named in the request.
 */
export async function completeAuthorization(
  state: OAuthState,
  code: string,
): Promise<{ context: TenantContext; connection: Connection }> {
  const provider = state.provider as GoogleProvider;

  // Re-verify access from the session rather than trusting the state alone.
  const context = await requireWebsiteAccess(state.websiteId, REQUIRED.APPROVE, {
    throwOnDenied: true,
  });

  const tokens = await exchangeCodeForTokens(provider, code);

  if (!tokens.refreshToken) {
    // Without a refresh token the connection would work for an hour and then fail
    // overnight, which is worse than refusing now.
    throw new ConnectionAuthError(
      "Google did not return a refresh token. Revoke the app's access in your Google account and try again.",
      "no_refresh_token",
    );
  }

  const encrypted = encryptCredential(
    JSON.stringify({ refreshToken: tokens.refreshToken }),
  );

  const connection = await prisma.$transaction(async (tx) => {
    const record = await tx.connection.upsert({
      where: {
        websiteId_provider: { websiteId: context.website.id, provider },
      },
      update: {
        status: "CONNECTING",
        connectedAt: new Date(),
        lastError: null,
      },
      create: {
        websiteId: context.website.id,
        workspaceId: context.workspace.id,
        provider,
        status: "CONNECTING",
        connectedAt: new Date(),
      },
    });

    await tx.credential.upsert({
      where: { connectionId: record.id },
      update: {
        encryptedPayload: encrypted.ciphertext,
        keyVersion: encrypted.keyVersion,
        scopes: tokens.scopes,
        expiresAt: tokens.expiresAt,
        rotatedAt: new Date(),
      },
      create: {
        connectionId: record.id,
        provider,
        encryptedPayload: encrypted.ciphertext,
        keyVersion: encrypted.keyVersion,
        scopes: tokens.scopes,
        expiresAt: tokens.expiresAt,
      },
    });

    await recordAudit(tx, context, {
      entityType: "Connection",
      entityId: record.id,
      action: "UPDATE",
      // Scopes are recorded; nothing token-shaped is, and redaction would catch it
      // even if a future change tried.
      after: { provider, status: "CONNECTING", scopes: tokens.scopes },
    });

    return record;
  });

  return { context, connection };
}

/** An access token for a stored connection, refreshed on demand. */
export async function getAccessToken(connectionId: string): Promise<string> {
  const credential = await prisma.credential.findUnique({
    where: { connectionId },
  });

  if (!credential) {
    throw new ConnectionAuthError("This connection has no stored credential.", "no_credential");
  }

  const { refreshToken } = JSON.parse(
    decryptCredential(credential.encryptedPayload),
  ) as { refreshToken: string };

  try {
    const tokens = await refreshAccessToken(refreshToken);
    return tokens.accessToken;
  } catch (error) {
    // A revoked or expired grant is a state the interface must show, not an error
    // to swallow: the data will silently stop updating otherwise.
    await prisma.connection.update({
      where: { id: connectionId },
      data: {
        status: "REAUTH_REQUIRED",
        lastError: error instanceof GoogleOAuthError ? error.code : "refresh_failed",
      },
    });

    throw new ConnectionAuthError(
      "This connection needs to be authorised again.",
      "reauth_required",
    );
  }
}

/**
 * Providers authenticated by a key the customer pastes in, not by OAuth.
 *
 * A separate flow because the trust model is different. An OAuth grant is scoped,
 * revocable from the provider's side, and never seen by us in plaintext after the
 * exchange; a vendor API key is a bearer secret with, typically, full account
 * access and no scoping. So there is no property-selection second step — there is
 * nothing to choose — and the key is verified against the provider before the
 * connection is allowed to read CONNECTED.
 */
export type ApiKeyProvider = "SEMRUSH" | "AHREFS";

export function isApiKeyProvider(value: string): value is ApiKeyProvider {
  return value === "SEMRUSH" || value === "AHREFS";
}

/**
 * Stores an API key and marks the connection connected.
 *
 * `verify` is the caller's chance to prove the key works before we claim it does.
 * A connection that went CONNECTED on an unverified key would be the "do not fake
 * a successful connection" rule broken in the most literal way: every screen
 * would say connected and every sync would fail.
 */
export async function connectApiKey(
  context: TenantContext,
  provider: ApiKeyProvider,
  apiKey: string,
  verify?: (apiKey: string) => Promise<void>,
): Promise<Connection> {
  const trimmed = apiKey.trim();

  if (!trimmed) {
    throw new ConnectionAuthError("Enter the API key.", "missing_key");
  }

  if (verify) {
    try {
      await verify(trimmed);
    } catch (error) {
      // The provider's own message is not passed on: for Semrush the key travels
      // in the query string, so an upstream error body can contain the secret.
      throw new ConnectionAuthError(
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? messageForVerifyFailure(error.code)
          : "That key could not be verified with the provider.",
        "key_rejected",
      );
    }
  }

  const encrypted = encryptCredential(JSON.stringify({ apiKey: trimmed }));

  return prisma.$transaction(async (tx) => {
    const record = await tx.connection.upsert({
      where: { websiteId_provider: { websiteId: context.website.id, provider } },
      update: { status: "CONNECTED", connectedAt: new Date(), lastError: null },
      create: {
        websiteId: context.website.id,
        workspaceId: context.workspace.id,
        provider,
        status: "CONNECTED",
        connectedAt: new Date(),
      },
    });

    await tx.credential.upsert({
      where: { connectionId: record.id },
      update: {
        encryptedPayload: encrypted.ciphertext,
        keyVersion: encrypted.keyVersion,
        scopes: [],
        rotatedAt: new Date(),
      },
      create: {
        connectionId: record.id,
        provider,
        encryptedPayload: encrypted.ciphertext,
        keyVersion: encrypted.keyVersion,
        scopes: [],
      },
    });

    await recordAudit(tx, context, {
      entityType: "Connection",
      entityId: record.id,
      action: "UPDATE",
      // That a key was stored, never any part of the key itself. Redaction would
      // catch it even if a future edit tried to add it.
      after: { provider, status: "CONNECTED", credentialStored: true },
    });

    return record;
  });
}

function messageForVerifyFailure(code: string): string {
  switch (code) {
    case "invalid_key":
      return "The provider rejected that key.";
    case "quota_exhausted":
      return "That key is valid but the account has no API units left.";
    case "not_subscribed":
      return "That account's plan does not include API access.";
    case "unknown_database":
      return "The provider has no database for this website's market.";
    default:
      return "That key could not be verified with the provider.";
  }
}

/**
 * The stored API key for a connection.
 *
 * Returned in plaintext because a request cannot be signed without it, and
 * deliberately nowhere near the view models: nothing that reaches a page or a
 * client component calls this.
 */
export async function getApiKey(connectionId: string): Promise<string> {
  const credential = await prisma.credential.findUnique({
    where: { connectionId },
  });

  if (!credential) {
    throw new ConnectionAuthError("This connection has no stored credential.", "no_credential");
  }

  const payload = JSON.parse(decryptCredential(credential.encryptedPayload)) as {
    apiKey?: string;
  };

  if (!payload.apiKey) {
    throw new ConnectionAuthError("This connection has no stored API key.", "no_credential");
  }

  return payload.apiKey;
}

export async function listAvailableProperties(
  context: TenantContext,
  provider: GoogleProvider,
): Promise<RemoteProperty[]> {
  const connection = await prisma.connection.findFirst({
    where: { websiteId: context.website.id, provider },
  });

  if (!connection) {
    throw new ConnectionAuthError("This provider is not connected.", "not_connected");
  }

  const accessToken = await getAccessToken(connection.id);
  return listProperties(provider, accessToken);
}

/**
 * Records the property a person chose. This is what makes a connection CONNECTED.
 */
export async function selectProperty(
  context: TenantContext,
  provider: GoogleProvider,
  property: RemoteProperty,
): Promise<Connection> {
  const existing = await prisma.connection.findFirst({
    where: { websiteId: context.website.id, provider },
  });

  if (!existing) {
    throw new ConnectionAuthError("This provider is not connected.", "not_connected");
  }

  return prisma.$transaction(async (tx) => {
    const connection = await tx.connection.update({
      where: { id: existing.id },
      data: {
        externalPropertyId: property.id,
        externalPropertyName: property.name,
        propertySelectedAt: new Date(),
        status: "CONNECTED",
        lastError: null,
      },
    });

    await recordAudit(tx, context, {
      entityType: "Connection",
      entityId: connection.id,
      action: "UPDATE",
      before: { externalPropertyId: existing.externalPropertyId },
      after: { externalPropertyId: property.id, status: "CONNECTED" },
    });

    return connection;
  });
}

/** Removes the stored credential and returns the connection to NOT_CONNECTED. */
export async function disconnectProvider(
  context: TenantContext,
  provider: GoogleProvider | ApiKeyProvider,
): Promise<void> {
  const existing = await prisma.connection.findFirst({
    where: { websiteId: context.website.id, provider },
  });

  if (!existing) return;

  await prisma.$transaction(async (tx) => {
    await tx.credential.deleteMany({ where: { connectionId: existing.id } });

    await tx.connection.update({
      where: { id: existing.id },
      data: {
        status: "NOT_CONNECTED",
        externalPropertyId: null,
        externalPropertyName: null,
        propertySelectedAt: null,
        connectedAt: null,
        lastError: null,
      },
    });

    await recordAudit(tx, context, {
      entityType: "Connection",
      entityId: existing.id,
      action: "UPDATE",
      before: { status: existing.status },
      after: { status: "NOT_CONNECTED" },
    });
  });

  // Metrics already ingested are left in place: they were real measurements, and
  // deleting history because an authorization ended would lose data that is still
  // true.
}
