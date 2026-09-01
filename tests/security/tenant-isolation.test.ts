import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthedUser } from "@/server/auth/session";

/**
 * Tenant isolation — release-blocking (P0_ACCEPTANCE_CRITERIA).
 *
 * "Any cross-tenant access = P0 FAIL."
 *
 * Only the session is mocked, so the real guards run against real Postgres. Each
 * case answers one question: can user A, holding a valid session, reach anything
 * belonging to organization B by supplying its ids?
 */

const session: { current: AuthedUser | null } = { current: null };

vi.mock("@/server/auth/session", () => ({
  requireUser: async () => {
    if (!session.current) {
      throw new Error("not signed in");
    }
    return session.current;
  },
  getCurrentUser: async () => session.current,
}));

const { prisma } = await import("@/server/db/prisma");
const {
  TenantAccessError,
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWebsiteAccess,
  requireTenantMember,
  websiteScope,
} = await import("@/server/auth/guards");

type Tenant = {
  user: Awaited<ReturnType<typeof prisma.user.create>>;
  organizationId: string;
  workspaceId: string;
  websiteId: string;
  goalId: string;
};

const organizationIds: string[] = [];
const userIds: string[] = [];

async function createTenant(label: string, role: "OWNER" | "VIEWER" = "OWNER") {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: {
      authUserId: crypto.randomUUID(),
      email: `iso-${label}-${suffix}@example.com`,
      displayName: `Isolation ${label}`,
    },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Isolation ${label}`, slug: `iso-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role,
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

  const goal = await prisma.businessGoal.create({
    data: { websiteId: website.id, title: `${label} confidential goal` },
  });

  return {
    user,
    organizationId: organization.id,
    workspaceId: workspace.id,
    websiteId: website.id,
    goalId: goal.id,
  } satisfies Tenant;
}

async function signInAs(tenant: Tenant) {
  const memberships = await prisma.organizationMembership.findMany({
    where: { userId: tenant.user.id, status: "ACTIVE" },
  });
  session.current = { user: tenant.user, memberships };
}

let tenantA: Tenant;
let tenantB: Tenant;
let viewer: Tenant;
let outsider: Awaited<ReturnType<typeof prisma.user.create>>;

beforeAll(async () => {
  tenantA = await createTenant("a");
  tenantB = await createTenant("b");
  viewer = await createTenant("v", "VIEWER");

  outsider = await prisma.user.create({
    data: {
      authUserId: crypto.randomUUID(),
      email: `iso-outsider-${crypto.randomUUID().slice(0, 8)}@example.com`,
    },
  });
  userIds.push(outsider.id);
});

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
      await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
    });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

const denied = { throwOnDenied: true } as const;

describe("a member reaches their own tenant", () => {
  it("resolves organization, workspace, and website", async () => {
    await signInAs(tenantA);

    const org = await requireOrgAccess(tenantA.organizationId, "VIEWER", denied);
    expect(org.organization.id).toBe(tenantA.organizationId);

    const ws = await requireWorkspaceAccess(tenantA.workspaceId, "VIEWER", denied);
    expect(ws.workspace.id).toBe(tenantA.workspaceId);
    expect(ws.organization.id).toBe(tenantA.organizationId);

    const site = await requireWebsiteAccess(tenantA.websiteId, "VIEWER", denied);
    expect(site.website.id).toBe(tenantA.websiteId);
    expect(site.organization.id).toBe(tenantA.organizationId);
  });
});

describe("tenant A cannot reach tenant B", () => {
  it("denies B's organization", async () => {
    await signInAs(tenantA);
    await expect(
      requireOrgAccess(tenantB.organizationId, "VIEWER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("denies B's workspace", async () => {
    await signInAs(tenantA);
    await expect(
      requireWorkspaceAccess(tenantB.workspaceId, "VIEWER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("denies B's website", async () => {
    await signInAs(tenantA);
    await expect(
      requireWebsiteAccess(tenantB.websiteId, "VIEWER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("denies by default with notFound(), not a 403", async () => {
    await signInAs(tenantA);
    // Next's notFound() throws; the point is that denial never returns data.
    await expect(requireWebsiteAccess(tenantB.websiteId)).rejects.toThrow();
  });
});

describe("IDOR through a nested id", () => {
  it("returns nothing when a child belongs to another tenant", async () => {
    await signInAs(tenantA);
    const context = await requireWebsiteAccess(tenantA.websiteId, "VIEWER", denied);

    // A valid session, a valid context, and B's goal id.
    const stolen = await prisma.businessGoal.findFirst({
      where: { id: tenantB.goalId, ...websiteScope(context) },
    });

    expect(stolen).toBeNull();
  });

  it("still returns the caller's own child rows", async () => {
    await signInAs(tenantA);
    const context = await requireWebsiteAccess(tenantA.websiteId, "VIEWER", denied);

    const own = await prisma.businessGoal.findFirst({
      where: { id: tenantA.goalId, ...websiteScope(context) },
    });

    expect(own?.id).toBe(tenantA.goalId);
  });

  it("does not leak B's rows through a list query scoped to A", async () => {
    await signInAs(tenantA);
    const context = await requireWebsiteAccess(tenantA.websiteId, "VIEWER", denied);

    const goals = await prisma.businessGoal.findMany({ where: websiteScope(context) });

    expect(goals.map((goal) => goal.id)).toEqual([tenantA.goalId]);
  });
});

describe("a user with no membership", () => {
  it("is denied everywhere", async () => {
    session.current = { user: outsider, memberships: [] };

    await expect(
      requireOrgAccess(tenantA.organizationId, "VIEWER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
    await expect(
      requireWorkspaceAccess(tenantA.workspaceId, "VIEWER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
    await expect(
      requireWebsiteAccess(tenantA.websiteId, "VIEWER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("is denied even when the email domain matches the organization", async () => {
    const shared = await prisma.organization.create({
      data: { name: "Shared Domain Co", slug: `shared-${crypto.randomUUID().slice(0, 8)}` },
    });
    organizationIds.push(shared.id);

    const lookalike = await prisma.user.create({
      data: { authUserId: crypto.randomUUID(), email: "someone@shareddomainco.com" },
    });
    userIds.push(lookalike.id);

    session.current = { user: lookalike, memberships: [] };

    await expect(
      requireOrgAccess(shared.id, "VIEWER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });
});

describe("role enforcement", () => {
  it("lets a VIEWER read", async () => {
    await signInAs(viewer);
    const context = await requireWebsiteAccess(viewer.websiteId, "VIEWER", denied);
    expect(context.membership.role).toBe("VIEWER");
  });

  it("denies a VIEWER write access", async () => {
    await signInAs(viewer);
    await expect(
      requireWebsiteAccess(viewer.websiteId, "MEMBER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("denies a VIEWER approval rights", async () => {
    await signInAs(viewer);
    await expect(
      requireWebsiteAccess(viewer.websiteId, "ADMIN", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("lets an OWNER approve", async () => {
    await signInAs(tenantA);
    const context = await requireWebsiteAccess(tenantA.websiteId, "ADMIN", denied);
    expect(context.membership.role).toBe("OWNER");
  });
});

describe("membership status", () => {
  it("denies access once membership is revoked", async () => {
    const revoked = await createTenant("r");
    await signInAs(revoked);

    // Access works while ACTIVE.
    await expect(
      requireWebsiteAccess(revoked.websiteId, "VIEWER", denied),
    ).resolves.toBeDefined();

    await prisma.organizationMembership.updateMany({
      where: { userId: revoked.user.id, organizationId: revoked.organizationId },
      data: { status: "REVOKED" },
    });

    await expect(
      requireWebsiteAccess(revoked.websiteId, "VIEWER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });
});

describe("archived tenants", () => {
  it("denies access to an archived website", async () => {
    const archived = await createTenant("arch");
    await signInAs(archived);

    await prisma.website.update({
      where: { id: archived.websiteId },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    await expect(
      requireWebsiteAccess(archived.websiteId, "VIEWER", denied),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });
});

describe("owner assignment", () => {
  it("rejects an owner from another organization", async () => {
    await signInAs(tenantA);
    const context = await requireOrgAccess(tenantA.organizationId, "VIEWER", denied);

    await expect(requireTenantMember(context, tenantB.user.id)).rejects.toBeInstanceOf(
      TenantAccessError,
    );
  });

  it("accepts a member of this organization", async () => {
    await signInAs(tenantA);
    const context = await requireOrgAccess(tenantA.organizationId, "VIEWER", denied);

    await expect(requireTenantMember(context, tenantA.user.id)).resolves.toBeUndefined();
  });
});
