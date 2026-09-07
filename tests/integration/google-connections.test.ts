import crypto from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { encryptCredential } from "@/server/crypto/credentials";
import {
  ConnectionAuthError,
  discoverProperties,
  selectProperty,
} from "@/server/services/connection-auth";
import type { TenantContext } from "@/server/auth/guards";
import type { GoogleProvider } from "@/server/connectors/google/oauth";
import { deleteOrganizations, registerOrganizations } from "../helpers/teardown";

/**
 * Google property discovery and selection (Google connections hotfix).
 *
 * Google is stubbed at `fetch`, so these exercise the real connector, the real
 * classifier and the real service against the response shapes Google actually
 * sends. Nothing here reaches the network.
 *
 * The two production symptoms are what most of it is about: a Search Console
 * failure that told everybody to reauthorize whatever had gone wrong, and an
 * Analytics connection that could never be finished once the callback redirect
 * was left behind.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SITES_URL = "https://www.googleapis.com/webmasters/v3/sites";
const SUMMARIES_URL = "https://analyticsadmin.googleapis.com/v1beta/accountSummaries";

type StubbedResponse = { status: number; body: unknown };

/** Answers for the two hosts a discovery call touches. */
let googleAnswers: { token?: StubbedResponse; discovery: StubbedResponse[] };
let requestedUrls: string[] = [];

function installGoogle(discovery: StubbedResponse[], token?: StubbedResponse): void {
  googleAnswers = { token, discovery: [...discovery] };
  requestedUrls = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    requestedUrls.push(url);

    const answer = url.startsWith(TOKEN_URL)
      ? (googleAnswers.token ?? {
          status: 200,
          body: { access_token: "stub-access-token", expires_in: 3600, scope: "" },
        })
      : (googleAnswers.discovery.shift() ?? { status: 500, body: {} });

    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/** A tenant with an authorized-but-unselected Google connection. */
async function tenantWith(provider: GoogleProvider): Promise<{
  context: TenantContext;
  connectionId: string;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `gc-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `GC ${suffix}`, slug: `conn-gc-${suffix}` },
  });
  organizationIds.push(organization.id);
  registerOrganizations([organization.id]);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: "OWNER",
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });

  const host = `gc-${suffix}.example.com`;
  const website = await prisma.website.create({
    data: { workspaceId: workspace.id, domain: host, normalizedDomain: host, primaryMarket: "PH" },
  });

  const connection = await prisma.connection.create({
    data: {
      workspaceId: workspace.id,
      websiteId: website.id,
      provider,
      // Authorized, no property chosen: exactly where the callback leaves it.
      status: "CONNECTING",
      connectedAt: new Date(),
    },
  });

  const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stub-refresh-token" }));
  await prisma.credential.create({
    data: {
      connectionId: connection.id,
      provider,
      encryptedPayload: encrypted.ciphertext,
      keyVersion: encrypted.keyVersion,
      scopes: [],
    },
  });

  return {
    context: { user, membership, organization, workspace, website },
    connectionId: connection.id,
  };
}

const googleError = (status: number, reason: string, googleStatus = "PERMISSION_DENIED") => ({
  status,
  body: { error: { code: status, status: googleStatus, errors: [{ reason }] } },
});

beforeAll(() => {
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
    process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (organizationIds.length > 0) await deleteOrganizations(organizationIds);
  if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("Search Console discovery", () => {
  it("lists verified properties and leaves out ones the account cannot read", async () => {
    const { context } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([
      {
        status: 200,
        body: {
          siteEntry: [
            { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
            { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" },
            { siteUrl: "https://not-mine.example/", permissionLevel: "siteUnverifiedUser" },
          ],
        },
      },
    ]);

    const result = await discoverProperties(context, "GOOGLE_SEARCH_CONSOLE");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.properties.map((p) => p.id)).toEqual([
      "sc-domain:example.com",
      "https://blog.example.com/",
    ]);
    expect(requestedUrls.some((url) => url.startsWith(SITES_URL))).toBe(true);
  });

  it("calls an expired token a reauthorization, and records that on the connection", async () => {
    const { context, connectionId } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([googleError(401, "authError", "UNAUTHENTICATED")]);

    const result = await discoverProperties(context, "GOOGLE_SEARCH_CONSOLE");
    expect(result).toMatchObject({ ok: false, code: "REAUTH_REQUIRED" });

    const after = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(after.status).toBe("REAUTH_REQUIRED");
  });

  it("calls a disabled API a disabled API, and does not touch the connection", async () => {
    const { context, connectionId } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([googleError(403, "accessNotConfigured")]);

    const result = await discoverProperties(context, "GOOGLE_SEARCH_CONSOLE");
    expect(result).toMatchObject({ ok: false, code: "API_NOT_ENABLED" });
    if (result.ok) return;
    expect(result.diagnostic).toMatchObject({
      provider: "GOOGLE_SEARCH_CONSOLE",
      operation: "list_properties",
      httpStatus: 403,
      googleReason: "accessNotConfigured",
    });

    // Nothing is wrong with the authorization, so it is left alone.
    const after = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(after.status).toBe("CONNECTING");
  });

  it("calls a permission refusal a scope problem", async () => {
    const { context } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([googleError(403, "insufficientPermissions")]);
    expect(await discoverProperties(context, "GOOGLE_SEARCH_CONSOLE")).toMatchObject({
      ok: false,
      code: "INSUFFICIENT_SCOPE",
    });
  });

  it("treats a successful but empty answer as a result, not a failure", async () => {
    const { context } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([{ status: 200, body: {} }]);

    const result = await discoverProperties(context, "GOOGLE_SEARCH_CONSOLE");
    expect(result).toEqual({ ok: true, properties: [] });
  });

  it("calls a malformed success what it is", async () => {
    const { context } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([{ status: 200, body: { siteEntry: "not an array" } }]);
    expect(await discoverProperties(context, "GOOGLE_SEARCH_CONSOLE")).toMatchObject({
      ok: false,
      code: "INVALID_PROVIDER_RESPONSE",
    });
  });

  it("classifies a rate limit and an outage without blaming the authorization", async () => {
    const { context } = await tenantWith("GOOGLE_SEARCH_CONSOLE");

    installGoogle([{ status: 429, body: {} }]);
    expect(await discoverProperties(context, "GOOGLE_SEARCH_CONSOLE")).toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
    });

    installGoogle([{ status: 503, body: {} }]);
    expect(await discoverProperties(context, "GOOGLE_SEARCH_CONSOLE")).toMatchObject({
      ok: false,
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});

describe("Analytics discovery", () => {
  it("follows every page, rather than stopping at the first", async () => {
    const { context } = await tenantWith("GOOGLE_ANALYTICS");
    installGoogle([
      {
        status: 200,
        body: {
          accountSummaries: [
            {
              displayName: "Acme",
              propertySummaries: [{ property: "properties/1", displayName: "Site one" }],
            },
          ],
          nextPageToken: "page-2",
        },
      },
      {
        status: 200,
        body: {
          accountSummaries: [
            {
              displayName: "Beta",
              propertySummaries: [{ property: "properties/2", displayName: "Site two" }],
            },
          ],
        },
      },
    ]);

    const result = await discoverProperties(context, "GOOGLE_ANALYTICS");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.properties).toEqual([
      { id: "properties/1", name: "Acme · Site one" },
      { id: "properties/2", name: "Beta · Site two" },
    ]);

    const discoveryCalls = requestedUrls.filter((url) => url.startsWith(SUMMARIES_URL));
    expect(discoveryCalls).toHaveLength(2);
    expect(discoveryCalls[1]).toContain("pageToken=page-2");
  });

  it("treats an account with no properties as connected, not broken", async () => {
    const { context } = await tenantWith("GOOGLE_ANALYTICS");
    installGoogle([{ status: 200, body: { accountSummaries: [] } }]);
    expect(await discoverProperties(context, "GOOGLE_ANALYTICS")).toEqual({
      ok: true,
      properties: [],
    });
  });

  it("classifies a disabled Admin API from the details shape Google sends", async () => {
    const { context } = await tenantWith("GOOGLE_ANALYTICS");
    installGoogle([
      {
        status: 403,
        body: { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } },
      },
    ]);
    expect(await discoverProperties(context, "GOOGLE_ANALYTICS")).toMatchObject({
      ok: false,
      code: "API_NOT_ENABLED",
    });
  });
});

describe("choosing a property", () => {
  const listing = {
    status: 200,
    body: {
      siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }],
    },
  };

  it("stores the exact property and the name Google gave it, and connects", async () => {
    const { context, connectionId } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([listing]);

    const connection = await selectProperty(
      context,
      "GOOGLE_SEARCH_CONSOLE",
      "sc-domain:example.com",
    );

    expect(connection.status).toBe("CONNECTED");
    expect(connection.externalPropertyId).toBe("sc-domain:example.com");
    expect(connection.externalPropertyName).toBe("sc-domain:example.com");
    expect(connection.propertySelectedAt).not.toBeNull();

    const stored = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(stored.externalPropertyId).toBe("sc-domain:example.com");
  });

  it("can be reached again afterwards, without reauthorizing", async () => {
    const { context } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([listing, listing]);

    await selectProperty(context, "GOOGLE_SEARCH_CONSOLE", "sc-domain:example.com");
    // The picker is the same flow, and a connected account may open it again to
    // change its mind. No OAuth round trip is involved.
    const again = await discoverProperties(context, "GOOGLE_SEARCH_CONSOLE");
    expect(again.ok).toBe(true);
  });

  it("refuses a property this account was never offered", async () => {
    const { context, connectionId } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([listing]);

    await expect(
      selectProperty(context, "GOOGLE_SEARCH_CONSOLE", "sc-domain:someone-elses-site.com"),
    ).rejects.toMatchObject({ code: "property_not_allowed" });

    const stored = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(stored.externalPropertyId).toBeNull();
    expect(stored.status).toBe("CONNECTING");
  });

  it("refuses when Google cannot confirm the list at all", async () => {
    const { context } = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    installGoogle([googleError(403, "accessNotConfigured")]);

    await expect(
      selectProperty(context, "GOOGLE_SEARCH_CONSOLE", "sc-domain:example.com"),
    ).rejects.toMatchObject({ code: "API_NOT_ENABLED" });
  });
});

describe("across tenants", () => {
  it("gives one tenant nothing of another's connection, whatever it asks for", async () => {
    const owner = await tenantWith("GOOGLE_SEARCH_CONSOLE");
    const attacker = await tenantWith("GOOGLE_ANALYTICS");
    installGoogle([
      {
        status: 200,
        body: { siteEntry: [{ siteUrl: "sc-domain:owner.example", permissionLevel: "siteOwner" }] },
      },
    ]);

    // The attacker's own website has no Search Console connection. The provider
    // is resolved from their tenant context, so the neighbour's is not a
    // candidate: the answer is that they have none, not somebody else's list.
    await expect(
      discoverProperties(attacker.context, "GOOGLE_SEARCH_CONSOLE"),
    ).rejects.toBeInstanceOf(ConnectionAuthError);

    await expect(
      selectProperty(attacker.context, "GOOGLE_SEARCH_CONSOLE", "sc-domain:owner.example"),
    ).rejects.toMatchObject({ code: "not_connected" });

    const untouched = await prisma.connection.findUniqueOrThrow({
      where: { id: owner.connectionId },
    });
    expect(untouched.externalPropertyId).toBeNull();
  });
});
