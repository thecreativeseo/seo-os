import { PrismaPg } from "@prisma/adapter-pg";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { resolveInternalUser } from "@/server/auth/resolve-user";

/**
 * M3 acceptance, verified against live Postgres:
 *
 *   - Google authentication creates or resolves ONE internal user
 *   - repeat login does not duplicate the user
 *   - matching email domain alone grants no tenant access
 *
 * resolveInternalUser reads prisma from the singleton, which uses DATABASE_URL;
 * this suite uses its own client for setup and teardown.
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL ?? "" }),
});

const createdUserIds: string[] = [];
const createdOrganizationIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  if (createdOrganizationIds.length > 0) {
    await prisma.organization.deleteMany({
      where: { id: { in: createdOrganizationIds } },
    });
  }
  await prisma.$disconnect();
});

function fakeAuthUser(overrides: Partial<SupabaseUser> = {}): SupabaseUser {
  const id = crypto.randomUUID();
  return {
    id,
    aud: "authenticated",
    app_metadata: { provider: "google" },
    user_metadata: {
      full_name: "Test Person",
      avatar_url: "https://example.com/avatar.png",
    },
    created_at: new Date().toISOString(),
    email: `auth-test-${id.slice(0, 8)}@example.com`,
    ...overrides,
  } as SupabaseUser;
}

describe("resolveInternalUser", () => {
  it("creates one internal user for a new Google identity", async () => {
    const authUser = fakeAuthUser();

    const user = await resolveInternalUser(authUser);
    createdUserIds.push(user.id);

    expect(user.authUserId).toBe(authUser.id);
    expect(user.email).toBe(authUser.email);
    expect(user.displayName).toBe("Test Person");
    expect(user.lastLoginAt).not.toBeNull();
  });

  it("resolves the same user on repeat login, without duplicating", async () => {
    const authUser = fakeAuthUser();

    const first = await resolveInternalUser(authUser);
    createdUserIds.push(first.id);
    const second = await resolveInternalUser(authUser);
    const third = await resolveInternalUser(authUser);

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    const count = await prisma.user.count({ where: { authUserId: authUser.id } });
    expect(count).toBe(1);
  });

  it("updates the stored email when the Google account's email changes", async () => {
    const authUser = fakeAuthUser();
    const first = await resolveInternalUser(authUser);
    createdUserIds.push(first.id);

    const renamed = { ...authUser, email: `renamed-${first.id.slice(0, 8)}@example.com` };
    const second = await resolveInternalUser(renamed as SupabaseUser);

    // Same identity: keyed on authUserId, not email.
    expect(second.id).toBe(first.id);
    expect(second.email).toBe(renamed.email);
  });

  it("treats two Google identities as two users even on the same domain", async () => {
    const a = fakeAuthUser({ email: "person.a@sharedcompany.com" });
    const b = fakeAuthUser({ email: "person.b@sharedcompany.com" });

    const userA = await resolveInternalUser(a);
    const userB = await resolveInternalUser(b);
    createdUserIds.push(userA.id, userB.id);

    expect(userA.id).not.toBe(userB.id);
  });

  it("grants no membership, so a new user is authorized for nothing", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Shared Company", slug: `shared-${crypto.randomUUID().slice(0, 8)}` },
    });
    createdOrganizationIds.push(organization.id);

    // A user whose email domain matches an existing organization.
    const authUser = fakeAuthUser({ email: "newcomer@sharedcompany.com" });
    const user = await resolveInternalUser(authUser);
    createdUserIds.push(user.id);

    const memberships = await prisma.organizationMembership.findMany({
      where: { userId: user.id },
    });

    // Domain match must never imply access.
    expect(memberships).toHaveLength(0);
  });

  it("fails closed when the identity has no email", async () => {
    const authUser = fakeAuthUser({ email: undefined });
    await expect(resolveInternalUser(authUser)).rejects.toThrow(/no email/i);
  });
});
