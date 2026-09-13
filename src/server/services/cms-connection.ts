import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { decryptCredential, encryptCredential } from "@/server/crypto/credentials";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { SYSTEM_AUTH_USER_ID } from "@/server/jobs/system-context";
import { parseCmsBaseUrl, type CanonicalSiteUrl } from "@/lib/cms/url";
import { selectProvider } from "@/server/connectors/wordpress/registry";
import { createTransport } from "@/server/connectors/wordpress/transport";
import {
  CmsProviderError,
  type CmsProvider,
  type CmsTransport,
  type DiscoveredCapability,
  type ProviderContext,
} from "@/server/connectors/wordpress/types";
import type { Connection } from "@/generated/prisma/client";

/**
 * Getting from a stored Connection to something that can talk to a CMS.
 *
 * Two callers need this and they need slightly different things, so it lives
 * here rather than inside either. An execution needs the connection checked,
 * the policy checked and the capability checked before a word is sent. A
 * connection test needs the first of those only — it is the thing that finds
 * out what the capabilities are, so it cannot require them.
 *
 * What both get is the same: a site URL that has been through the SSRF policy,
 * a credential decrypted at the last possible moment and held for one call, and
 * a transport that cannot be pointed anywhere else.
 */

export type ProviderResolution = {
  provider: CmsProvider;
  providerContext: ProviderContext;
  simulated: boolean;
};

export type ProviderOptions = {
  /** Injected in tests. Production builds one from the validated base URL. */
  transport?: CmsTransport;
  resolve?: (hostname: string) => Promise<string[]>;
};

/**
 * The website's WordPress connection, checked as far as it can be before the
 * question of what it may do arises.
 */
export type LoadConnectionOptions = {
  /**
   * Whether the connection must already be CONNECTED.
   *
   * True everywhere that acts on a CMS. False for the connection test, which
   * is the thing that decides whether it is connected: a freshly saved
   * connection is CONNECTING, and requiring CONNECTED here would mean it could
   * never be tested and so never become connected.
   */
  requireConnected?: boolean;
};

export async function loadWordPressConnection(
  context: TenantContext,
  connectionId?: string,
  options: LoadConnectionOptions = {},
): Promise<{ connection: Connection; site: CanonicalSiteUrl }> {
  const connection = await prisma.connection.findFirst({
    where: {
      ...(connectionId ? { id: connectionId } : {}),
      provider: "WORDPRESS",
      ...websiteScope(context),
    },
  });

  if (!connection) throw new CmsProviderError("not_configured");

  const usable =
    options.requireConnected === false
      ? connection.status === "CONNECTED" || connection.status === "CONNECTING"
      : connection.status === "CONNECTED";
  if (!usable) throw new CmsProviderError("connection_disabled");
  if (connection.authType === null) throw new CmsProviderError("auth_required");

  const parsed = connection.baseUrl ? parseCmsBaseUrl(connection.baseUrl) : null;
  if (!parsed || !parsed.ok) throw new CmsProviderError("invalid_site_url");

  return { connection, site: parsed.value };
}

/**
 * Reads the stored credential, and reads it strictly.
 *
 * A payload that is not the shape M6 stores is refused as though there were no
 * credential at all. The reason is never surfaced or logged: "the JSON did not
 * parse" and "username was missing" both describe the plaintext, and describing
 * the plaintext of a secret is how a secret leaks a piece at a time.
 */
function readCredential(payload: string): { username: string; applicationPassword: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new CmsProviderError("auth_required");
  }

  const shape = (parsed ?? {}) as { username?: unknown; applicationPassword?: unknown };
  if (typeof shape.username !== "string" || shape.username.length === 0) {
    throw new CmsProviderError("auth_required");
  }
  if (typeof shape.applicationPassword !== "string" || shape.applicationPassword.length === 0) {
    throw new CmsProviderError("auth_required");
  }

  return { username: shape.username, applicationPassword: shape.applicationPassword };
}

/** The provider for a connection, with its credential and its transport. */
export async function buildProviderContext(
  context: TenantContext,
  connection: Connection,
  site: CanonicalSiteUrl,
  options: ProviderOptions = {},
): Promise<ProviderResolution> {
  const { provider } = selectProvider(connection, context.website);

  let credential = { username: "simulated", applicationPassword: "simulated" };

  if (!provider.simulated) {
    const stored = await prisma.credential.findUnique({ where: { connectionId: connection.id } });
    if (!stored) throw new CmsProviderError("auth_required");
    // A credential filed under another provider is not this connection's, whatever
    // the foreign key says.
    if (stored.provider !== "WORDPRESS") throw new CmsProviderError("auth_required");
    credential = readCredential(decryptCredential(stored.encryptedPayload));
  }

  return {
    provider,
    simulated: provider.simulated,
    providerContext: {
      site,
      credential,
      transport: options.transport ?? createTransport({ site, resolve: options.resolve }),
    },
  };
}

export type ConnectionTestOutcome = {
  accountName: string | null;
  capabilities: DiscoveredCapability[];
  simulated: boolean;
};

/**
 * Asks the CMS who we are and what we may do, and writes the answer down.
 *
 * Read-only against WordPress: one GET of `users/me`, which is the only thing
 * core offers that answers the permission question without writing something.
 * Creating a test draft to find out would be a draft in somebody's CMS that
 * nobody asked for, so a permission WordPress will not confirm is recorded as
 * not granted rather than assumed.
 *
 * The rows it writes are what the execution path later reads. `source` says how
 * each was established and is never "assumed"; a capability that was asked
 * about and refused is stored as granted=false, which is a different fact from
 * never having asked and is why the row exists at all.
 */
export async function testCmsConnection(
  context: TenantContext,
  options: ProviderOptions & { connectionId?: string } = {},
): Promise<ConnectionTestOutcome> {
  const { connection, site } = await loadWordPressConnection(context, options.connectionId, {
    requireConnected: false,
  });
  const { provider, providerContext, simulated } = await buildProviderContext(
    context,
    connection,
    site,
    options,
  );

  const result = await provider.testConnection(providerContext);
  const checkedAt = new Date();

  for (const capability of result.capabilities) {
    // READ_CONTENT has no entity scope, so its key carries a null. The index
    // that makes it unique is declared NULLS NOT DISTINCT in SQL, but the
    // generated compound key does not accept null, so the row is found and
    // then written rather than upserted.
    const existing = await prisma.connectionCapability.findFirst({
      where: {
        connectionId: connection.id,
        capability: capability.capability,
        entityType: capability.entityType,
      },
      select: { id: true },
    });

    if (existing) {
      await prisma.connectionCapability.update({
        where: { id: existing.id },
        data: { granted: capability.granted, source: capability.source, checkedAt },
      });
    } else {
      await prisma.connectionCapability.create({
        data: {
          websiteId: context.website.id,
          connectionId: connection.id,
          capability: capability.capability,
          entityType: capability.entityType,
          granted: capability.granted,
          source: capability.source,
          checkedAt,
        },
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.connection.update({
      where: { id: connection.id },
      data: { externalAccountName: result.accountName, lastCheckedAt: checkedAt, lastError: null },
    });

    await recordAudit(tx, context, {
      entityType: "Connection",
      entityId: connection.id,
      action: "UPDATE",
      after: {
        provider: provider.name,
        simulated,
        operation: "test_connection",
        // Counts and flags. Never the credential, and never what WordPress sent.
        capabilities: result.capabilities.map((capability) => ({
          capability: capability.capability,
          entityType: capability.entityType,
          granted: capability.granted,
          source: capability.source,
        })),
      },
    });
  });

  return { accountName: result.accountName, capabilities: result.capabilities, simulated };
}

// ---------------------------------------------------------------------------
// Configuring the connection
// ---------------------------------------------------------------------------

export type ConfigureWordPressInput = {
  /** The site's own https address. Not a REST endpoint. */
  baseUrl: string;
  username: string;
  /** A WordPress application password. Encrypted here and never returned. */
  applicationPassword: string;
};

export type ConfigureWordPressResult = {
  connectionId: string;
  siteHost: string;
};

/**
 * Stores where the WordPress is and how to authenticate to it (M6.4 §4).
 *
 * Three of the four things that decide what this connection may do are not
 * accepted from the caller at all. The provider is WordPress because this is
 * the WordPress connection; the auth type is an application password because
 * it is the only one M6 implements; and the publishing policy is DRAFT_ONLY,
 * which is what makes publishing impossible rather than merely unbuilt. A
 * browser cannot widen any of them, because there is no argument to do it with.
 *
 * Saving is not connecting. The credential is stored and the connection is left
 * CONNECTING: whether the site answers, whether the password is accepted and
 * what the account may do are questions only testCmsConnection can settle, and
 * a row that said CONNECTED because a form was submitted would be exactly the
 * faked connection the rules forbid.
 */
export async function configureWordPressConnection(
  context: TenantContext,
  input: ConfigureWordPressInput,
): Promise<ConfigureWordPressResult> {
  // Replacing CMS credentials is an administrative act, and a different one
  // from being allowed to execute an already-approved draft.
  if (context.user.authUserId === SYSTEM_AUTH_USER_ID) {
    throw new CmsProviderError("forbidden");
  }
  if (!hasRole(context.membership.role, REQUIRED.APPROVE)) {
    throw new CmsProviderError("forbidden");
  }

  // The same gate the fetcher uses. A REST endpoint, a private address or a
  // credential-bearing URL is refused here rather than at request time.
  const parsed = parseCmsBaseUrl(input.baseUrl);
  if (!parsed.ok) throw new CmsProviderError("invalid_site_url");

  // A subdirectory install is legitimate, so the URL policy allows a path.
  // It cannot tell /blog from /wp-json, and the second is never a site root —
  // it is the API this connector builds its own paths onto. Refused here, at
  // the point somebody typed it, rather than by weakening the shared policy.
  if (/(^|\/)wp-json(\/|$)/i.test(parsed.value.basePath)) {
    throw new CmsProviderError("invalid_site_url");
  }

  const username = input.username.trim();
  if (username.length === 0) throw new CmsProviderError("auth_required");
  // WordPress prints application passwords in spaced groups; the spaces are
  // presentation and are not part of the secret.
  const applicationPassword = input.applicationPassword.trim();
  if (applicationPassword.length === 0) throw new CmsProviderError("auth_required");

  const encrypted = encryptCredential(JSON.stringify({ username, applicationPassword }));

  return prisma.$transaction(async (tx) => {
    const connection = await tx.connection.upsert({
      where: {
        websiteId_provider: { websiteId: context.website.id, provider: "WORDPRESS" },
      },
      create: {
        websiteId: context.website.id,
        workspaceId: context.workspace.id,
        provider: "WORDPRESS",
        authType: "APPLICATION_PASSWORD",
        baseUrl: parsed.value.href,
        // Saved, not proven. Testing is what makes it CONNECTED.
        status: "CONNECTING",
        lastError: null,
      },
      update: {
        authType: "APPLICATION_PASSWORD",
        baseUrl: parsed.value.href,
        status: "CONNECTING",
        externalAccountName: null,
        lastError: null,
      },
    });

    await tx.credential.upsert({
      where: { connectionId: connection.id },
      create: {
        connectionId: connection.id,
        provider: "WORDPRESS",
        encryptedPayload: encrypted.ciphertext,
        keyVersion: encrypted.keyVersion,
        scopes: [],
      },
      update: {
        encryptedPayload: encrypted.ciphertext,
        keyVersion: encrypted.keyVersion,
        rotatedAt: new Date(),
      },
    });

    // The one policy M6 permits. There is no argument that could set another,
    // and no screen that offers one.
    await tx.publishingPolicy.upsert({
      where: {
        websiteId_connectionId: {
          websiteId: context.website.id,
          connectionId: connection.id,
        },
      },
      create: { websiteId: context.website.id, connectionId: connection.id, mode: "DRAFT_ONLY" },
      update: { mode: "DRAFT_ONLY" },
    });

    // A change of site or credential invalidates what the old one could do.
    await tx.connectionCapability.deleteMany({ where: { connectionId: connection.id } });

    await recordAudit(tx, context, {
      entityType: "Connection",
      entityId: connection.id,
      action: "CONNECT",
      after: {
        provider: "WORDPRESS",
        authType: "APPLICATION_PASSWORD",
        // The host, which is not a secret. Never the username or the password.
        siteHost: parsed.value.hostname,
        publishingMode: "DRAFT_ONLY",
        credential: "stored",
      },
    });

    return { connectionId: connection.id, siteHost: parsed.value.hostname };
  });
}

/**
 * Marks a connection's own state from what a test found (M6.4 §8).
 *
 * Called after testCmsConnection so that CONNECTED means the site answered,
 * the password was accepted and the account's permissions are known — not that
 * somebody filled in a form.
 */
export async function markConnectionTested(
  context: TenantContext,
  connectionId: string,
  outcome: { ok: boolean; errorCode?: string },
): Promise<void> {
  await prisma.connection.updateMany({
    where: { id: connectionId, provider: "WORDPRESS", ...websiteScope(context) },
    data: outcome.ok
      ? { status: "CONNECTED", connectedAt: new Date(), lastError: null }
      : {
          status: "ERROR",
          // Our own code, never the provider's text.
          lastError: outcome.errorCode ?? null,
        },
  });
}
