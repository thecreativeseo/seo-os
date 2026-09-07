import crypto from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { decryptCredential } from "@/server/crypto/credentials";
import { connectApiKey } from "@/server/services/connection-auth";
import { fetchOrganicPositions } from "@/server/connectors/semrush/client";
import type { TenantContext } from "@/server/auth/guards";
import { deleteOrganizations, registerOrganizations } from "../helpers/teardown";

/**
 * Connecting Semrush (Semrush connection hotfix).
 *
 * The production symptom was one sentence, "The provider rejected that key",
 * shown for every way the probe could fail. These are the ways, and each one
 * now has to say something a person could act on.
 *
 * The key here is a fake, and several assertions exist only to prove it does
 * not appear anywhere: not in the message, not in the diagnostic line, not in
 * the audit trail. Semrush puts the key in the query string, so the request URL
 * is a secret too.
 */

const KEY = "semrush-fake-key-do-not-log-abc123";
const organizationIds: string[] = [];
const userIds: string[] = [];

/** One Semrush answer, as the v3 API sends it: 200 with the error in the body. */
function respond(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "Content-Type": "text/plain" } })) as typeof fetch;
}

const probeWith =
  (body: string, status = 200) =>
  async (key: string) => {
    await fetchOrganicPositions({
      apiKey: key,
      domain: "example.com",
      database: "ph",
      maxRows: 1,
      fetchImpl: respond(body, status),
      sleepImpl: async () => {},
    });
  };

async function tenant(): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `sr-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `SR ${suffix}`, slug: `sr-conn-${suffix}` },
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

  const host = `sr-${suffix}.example.com`;
  const website = await prisma.website.create({
    data: { workspaceId: workspace.id, domain: host, normalizedDomain: host, primaryMarket: "PH" },
  });

  return { user, membership, organization, workspace, website };
}

beforeAll(() => {
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
    process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (organizationIds.length > 0) await deleteOrganizations(organizationIds);
  if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("a website with no Semrush rankings", () => {
  it("connects, because nothing found means the key was accepted", async () => {
    const context = await tenant();

    const connection = await connectApiKey(
      context,
      "SEMRUSH",
      KEY,
      probeWith("ERROR 50 :: NOTHING FOUND"),
    );

    expect(connection.status).toBe("CONNECTED");
    expect(connection.provider).toBe("SEMRUSH");
  });
});

describe("what a refused connection says", () => {
  const cases: [string, string, RegExp][] = [
    [
      "ERROR 120 :: WRONG KEY - ID PAIR",
      "the key, and where the v3 one lives",
      /My Profile → API Keys/i,
    ],
    ["ERROR 130 :: API DISABLED", "API access", /does not currently include API access/i],
    ["ERROR 131 :: LIMIT EXCEEDED", "report limit", /limit for this report has been reached/i],
    ["ERROR 132 :: API UNITS BALANCE IS ZERO", "units", /API unit balance is zero/i],
    ["ERROR 133 :: DB ACCESS DENIED", "database", /access to the selected regional database/i],
    ["ERROR 134 :: TOTAL LIMIT EXCEEDED", "total limit", /total API request limit/i],
    [
      "ERROR 135 :: API REPORT TYPE DISABLED",
      "report type",
      /not available for the current subscription/i,
    ],
  ];

  for (const [body, what, expected] of cases) {
    it(`names ${what} rather than blaming the key`, async () => {
      const context = await tenant();

      const error = (await connectApiKey(context, "SEMRUSH", KEY, probeWith(body)).catch(
        (caught: unknown) => caught,
      )) as Error;

      expect(error.message).toMatch(expected);
      // The four account states used to produce this, about a key that was fine.
      if (!/v3 key/.test(error.message)) {
        expect(error.message).not.toMatch(/rejected that key|check the key/i);
      }
    });
  }

  it("leaves no connection and no credential behind", async () => {
    const context = await tenant();

    await expect(
      connectApiKey(context, "SEMRUSH", KEY, probeWith("ERROR 132 :: API UNITS BALANCE IS ZERO")),
    ).rejects.toThrow();

    expect(await prisma.connection.count({ where: { websiteId: context.website.id } })).toBe(0);
  });
});

describe("what a refused connection records", () => {
  it("logs the status and the numeric code, and never the key or the url", async () => {
    const context = await tenant();
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(" "));
    });

    await expect(
      connectApiKey(context, "SEMRUSH", KEY, probeWith("ERROR 132 :: API UNITS BALANCE IS ZERO")),
    ).rejects.toThrow();

    const line = logged.find((entry) => entry.includes("connection.verify"));
    expect(line).toBeDefined();

    const payload = JSON.parse(line!.replace("connection.verify ", "")) as Record<string, unknown>;
    expect(payload).toEqual({
      provider: "SEMRUSH",
      operation: "verify_connection",
      httpStatus: 200,
      providerErrorCode: "132",
      classifiedCode: "API_UNITS_EXHAUSTED",
    });

    for (const entry of logged) {
      expect(entry).not.toContain(KEY);
      expect(entry).not.toContain("api.semrush.com");
      expect(entry).not.toMatch(/key=/);
    }
  });
});

describe("the stored key", () => {
  it("is encrypted, readable only server-side, and absent from the audit trail", async () => {
    const context = await tenant();

    const connection = await connectApiKey(
      context,
      "SEMRUSH",
      KEY,
      probeWith("ERROR 50 :: NOTHING FOUND"),
    );

    const credential = await prisma.credential.findUniqueOrThrow({
      where: { connectionId: connection.id },
    });
    expect(credential.encryptedPayload).not.toContain(KEY);
    expect(JSON.parse(decryptCredential(credential.encryptedPayload))).toEqual({ apiKey: KEY });

    const events = await prisma.auditEvent.findMany({
      where: { entityType: "Connection", entityId: connection.id },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });
});
