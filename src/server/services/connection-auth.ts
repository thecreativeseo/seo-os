import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { requireWebsiteAccess, type TenantContext } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { decryptCredential, encryptCredential, type OAuthState } from "@/server/crypto/credentials";
import {
  GoogleOAuthError,
  exchangeCodeForTokens,
  listProperties,
  refreshAccessToken,
  type GoogleProvider,
  type RemoteProperty,
} from "@/server/connectors/google/oauth";
import { SemrushError } from "@/server/connectors/semrush/client";
import { AhrefsError } from "@/server/connectors/ahrefs/client";
import type { Connection } from "@/generated/prisma/client";
import type { DiscoveryFailureCode } from "@/lib/connections/discovery";
import {
  GoogleDiscoveryError,
  safeDiagnostic,
  type SafeDiagnostic,
} from "@/server/connectors/google/discovery";

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

  const encrypted = encryptCredential(JSON.stringify({ refreshToken: tokens.refreshToken }));

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

  const { refreshToken } = JSON.parse(decryptCredential(credential.encryptedPayload)) as {
    refreshToken: string;
  };

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
      // One safe line, so a refused connection can be diagnosed. The numeric
      // code and the HTTP status are not secrets; the body and the URL are,
      // and for Semrush the URL carries the key, so neither is touched.
      console.error(
        "connection.verify",
        JSON.stringify({
          provider,
          operation: "verify_connection",
          httpStatus: error instanceof SemrushError ? error.httpStatus : null,
          providerErrorCode: error instanceof SemrushError ? error.providerErrorCode : null,
          classifiedCode:
            error instanceof Error && "code" in error && typeof error.code === "string"
              ? error.code
              : null,
        }),
      );

      throw new ConnectionAuthError(
        // The connector's own message, from its own fixed table. Never the
        // upstream text, which can echo a request that carries the key.
        error instanceof SemrushError || error instanceof AhrefsError
          ? error.message
          : messageForVerifyFailure(
              error instanceof Error && "code" in error && typeof error.code === "string"
                ? error.code
                : "",
            ),
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

/**
 * The fallback for a provider that has no message table of its own.
 *
 * Semrush and Ahrefs both carry theirs, which name the provider and the
 * remedy; this is what is left for anything else. It used to answer for both
 * of them, which is how an exhausted Semrush account was told "the provider
 * rejected that key" about a key that was perfectly good.
 */
function messageForVerifyFailure(code: string): string {
  switch (code) {
    case "missing_key":
      return "Enter the API key.";
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

export type PropertyDiscovery =
  | { ok: true; properties: RemoteProperty[] }
  | { ok: false; code: DiscoveryFailureCode; diagnostic: SafeDiagnostic | null };

/**
 * What properties this connection can offer, or why it cannot say.
 *
 * A result rather than an exception, because "Google refused" and "the account
 * has none" and "the API is off" are all ordinary answers a person needs to see
 * differently, not one failure to be caught and paraphrased. The old version
 * threw for every one of them and the page turned all of it into a single
 * sentence about reauthorizing.
 *
 * An empty list stays a success here and is classified by the caller: at this
 * layer it is simply true that there are none.
 */
export async function discoverProperties(
  context: TenantContext,
  provider: GoogleProvider,
): Promise<PropertyDiscovery> {
  const connection = await prisma.connection.findFirst({
    where: { websiteId: context.website.id, provider },
  });

  if (!connection) {
    throw new ConnectionAuthError("This provider is not connected.", "not_connected");
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(connection.id);
  } catch (error) {
    // Both of these are answers, not crashes. A refused refresh has already
    // recorded REAUTH_REQUIRED on the connection; a connection whose credential
    // row is gone - disconnected in another tab, or removed by hand - equally
    // needs authorizing again, and reconnecting is the remedy for both.
    if (
      error instanceof ConnectionAuthError &&
      (error.code === "reauth_required" || error.code === "no_credential")
    ) {
      return { ok: false, code: "REAUTH_REQUIRED", diagnostic: null };
    }
    throw error;
  }

  try {
    return { ok: true, properties: await listProperties(provider, accessToken) };
  } catch (error) {
    if (!(error instanceof GoogleDiscoveryError)) throw error;

    const diagnostic = safeDiagnostic(provider, "list_properties", error);
    // Codes, a status and a reason. Never a token, a header, a URL or a body.
    console.error("connection.discovery", JSON.stringify(diagnostic));

    if (error.code === "REAUTH_REQUIRED") {
      await prisma.connection.update({
        where: { id: connection.id },
        data: { status: "REAUTH_REQUIRED", lastError: error.code },
      });
    }

    return { ok: false, code: error.code, diagnostic };
  }
}

/**
 * Records the property a person chose. This is what makes a connection CONNECTED.
 */
export async function selectProperty(
  context: TenantContext,
  provider: GoogleProvider,
  propertyId: string,
): Promise<Connection> {
  const existing = await prisma.connection.findFirst({
    where: { websiteId: context.website.id, provider },
  });

  if (!existing) {
    throw new ConnectionAuthError("This provider is not connected.", "not_connected");
  }

  // The id arrives in a form, so it is a claim. It is honoured only if Google
  // itself lists it for this connection right now: otherwise a person could
  // post any property string and have SEO OS record it as the source of this
  // website's data. The name is taken from Google too, never from the form.
  const discovery = await discoverProperties(context, provider);
  if (!discovery.ok) {
    throw new ConnectionAuthError(
      "The property list could not be confirmed with Google.",
      discovery.code,
    );
  }

  const property = discovery.properties.find((candidate) => candidate.id === propertyId);
  if (!property) {
    throw new ConnectionAuthError(
      "That property is not one this Google account can read.",
      "property_not_allowed",
    );
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
