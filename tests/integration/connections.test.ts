import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import {
  PROVIDER_COUNT,
  countConnected,
  listConnectionCards,
} from "@/server/services/connections";
import { CONNECTION_PROVIDERS } from "@/lib/connections/registry";
import type { TenantContext } from "@/server/auth/guards";

/**
 * Connections (P0_ACCEPTANCE_CRITERIA "Connections").
 *
 * "Plaintext credentials = P0 FAIL." The registry must be complete, availability
 * honest, everything allowed to stay NOT_CONNECTED, and nothing credential-shaped
 * may reach the view model.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `conn-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Conn ${label}`, slug: `conn-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

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

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: `${label}-${suffix}.example.com`,
      normalizedDomain: `${label}-${suffix}.example.com`,
    },
  });

  return { user, membership, organization, workspace, website };
}

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("provider registry", () => {
  it("lists every P0 provider, in a stable order", async () => {
    // The registry grows — AHREFS arrived in P2 — but a P0 provider disappearing
    // would orphan any connection pointing at it, and a reordering would move the
    // cards under someone mid-click.
    const context = await makeContext("registry");
    const cards = await listConnectionCards(context);

    expect(cards).toHaveLength(PROVIDER_COUNT);
    expect(cards.map((card) => card.provider)).toEqual([
      "GOOGLE_SEARCH_CONSOLE",
      "GOOGLE_ANALYTICS",
      "HUBSPOT",
      "SEMRUSH",
      "AHREFS",
      "SIMILARWEB",
      "SCREAMING_FROG",
      "WORDPRESS",
    ]);
  });

  it("states availability for every provider", async () => {
    const context = await makeContext("availability");
    const cards = await listConnectionCards(context);

    for (const card of cards) {
      expect(card.availability.length).toBeGreaterThan(0);
    }

    const byProvider = new Map(cards.map((card) => [card.provider, card]));

    // The ones that actually connect say so plainly: the two Google providers by
    // OAuth, Semrush and Ahrefs by API key.
    expect(byProvider.get("GOOGLE_SEARCH_CONSOLE")?.availability).toBe("Available");
    expect(byProvider.get("GOOGLE_ANALYTICS")?.availability).toBe("Available");
    expect(byProvider.get("SEMRUSH")?.availability).toBe("Available");
    expect(byProvider.get("AHREFS")?.availability).toBe("Available");

    // And nothing else does. This is the assertion that matters: the page offers
    // a connect control for exactly these, so any other card reading "Available"
    // would be promising an action that is not on the screen.
    const connectable = new Set([
      "GOOGLE_SEARCH_CONSOLE",
      "GOOGLE_ANALYTICS",
      "SEMRUSH",
      "AHREFS",
    ]);

    for (const card of cards) {
      if (connectable.has(card.provider)) continue;
      expect(card.availability).not.toMatch(/^available$/i);
    }
  });

  it("points Semrush and Ahrefs at the import flow that carries their data", async () => {
    // P2 delivered these through CSV import rather than a live connection
    // (P2_SPEC §7). A card saying only "not connected" would be accurate and
    // would still hide a working feature.
    const context = await makeContext("alternative");
    const cards = await listConnectionCards(context);
    const byProvider = new Map(cards.map((card) => [card.provider, card]));

    for (const provider of ["SEMRUSH", "AHREFS"] as const) {
      const card = byProvider.get(provider);
      expect(card?.alternative).toBeDefined();
      expect(card?.alternative?.href(context.website.id)).toBe(
        `/websites/${context.website.id}/imports`,
      );
    }

    // A provider with no other route offers no link, rather than a dead one.
    expect(byProvider.get("SIMILARWEB")?.alternative).toBeUndefined();
  });

  it("keeps the registry and the database enum in agreement", async () => {
    // A provider added to the enum but not the registry would be invisible in the UI.
    const registryProviders = CONNECTION_PROVIDERS.map((card) => card.provider).sort();
    const enumProviders = [
      "AHREFS",
      "GOOGLE_ANALYTICS",
      "GOOGLE_SEARCH_CONSOLE",
      "HUBSPOT",
      "SCREAMING_FROG",
      "SEMRUSH",
      "SIMILARWEB",
      "WORDPRESS",
    ];
    expect(registryProviders).toEqual(enumProviders);
  });
});

describe("connection state", () => {
  it("reports every provider NOT_CONNECTED when nothing has been touched", async () => {
    const context = await makeContext("default");
    const cards = await listConnectionCards(context);

    expect(cards.every((card) => card.status === "NOT_CONNECTED")).toBe(true);
    expect(cards.every((card) => card.connectedAt === null)).toBe(true);
    expect(await countConnected(context)).toBe(0);
  });

  it("creates no rows just by viewing the page", async () => {
    const context = await makeContext("norows");
    await listConnectionCards(context);

    expect(await prisma.connection.count({ where: { websiteId: context.website.id } })).toBe(
      0,
    );
  });

  it("reflects a stored status without inventing one", async () => {
    const context = await makeContext("stored");
    await prisma.connection.create({
      data: {
        workspaceId: context.workspace.id,
        websiteId: context.website.id,
        provider: "GOOGLE_SEARCH_CONSOLE",
        status: "ERROR",
        lastError: "Token exchange failed",
      },
    });

    const cards = await listConnectionCards(context);
    const gsc = cards.find((card) => card.provider === "GOOGLE_SEARCH_CONSOLE");

    expect(gsc?.status).toBe("ERROR");
    // Untouched providers are unaffected.
    expect(cards.filter((card) => card.status === "NOT_CONNECTED")).toHaveLength(
      PROVIDER_COUNT - 1,
    );
  });
});

describe("credentials", () => {
  it("never exposes a credential reference to the view model", async () => {
    const context = await makeContext("cred");
    await prisma.connection.create({
      data: {
        workspaceId: context.workspace.id,
        websiteId: context.website.id,
        provider: "WORDPRESS",
        status: "CONNECTED",
        credentialReference: "secret-manager://projects/x/secrets/wp-app-password",
        connectedAt: new Date(),
      },
    });

    const cards = await listConnectionCards(context);
    const serialized = JSON.stringify(cards);

    expect(serialized).not.toContain("secret-manager://");
    expect(serialized).not.toContain("wp-app-password");

    const wordpress = cards.find((card) => card.provider === "WORDPRESS");
    // The UI learns only that a reference exists.
    expect(wordpress?.hasCredentialReference).toBe(true);
    expect(wordpress).not.toHaveProperty("credentialReference");
  });

  it("counts a connected provider", async () => {
    const context = await makeContext("count");
    await prisma.connection.create({
      data: {
        workspaceId: context.workspace.id,
        websiteId: context.website.id,
        provider: "SEMRUSH",
        status: "CONNECTED",
        connectedAt: new Date(),
      },
    });

    expect(await countConnected(context)).toBe(1);
  });
});

describe("tenant isolation", () => {
  it("does not show another website's connections", async () => {
    const a = await makeContext("iso-a");
    const b = await makeContext("iso-b");

    await prisma.connection.create({
      data: {
        workspaceId: b.workspace.id,
        websiteId: b.website.id,
        provider: "HUBSPOT",
        status: "CONNECTED",
        connectedAt: new Date(),
      },
    });

    const cards = await listConnectionCards(a);

    expect(cards.every((card) => card.status === "NOT_CONNECTED")).toBe(true);
    expect(await countConnected(a)).toBe(0);
    expect(await countConnected(b)).toBe(1);
  });
});
