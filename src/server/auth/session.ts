import { redirect } from "next/navigation";

import { prisma } from "@/server/db/prisma";
import { getAuthUser } from "@/server/auth/supabase-server";
import { resolveInternalUser } from "@/server/auth/resolve-user";
import type { OrganizationMembership, User } from "@/generated/prisma/client";

export type AuthedUser = {
  user: User;
  memberships: OrganizationMembership[];
};

/**
 * The current session, or null when signed out.
 *
 * Memberships are loaded alongside the user because they are the only thing that
 * grants tenant access. A user with zero active memberships is authenticated but
 * authorized for nothing — which is the correct state for a brand new account.
 */
export async function getCurrentUser(): Promise<AuthedUser | null> {
  const authUser = await getAuthUser();

  if (!authUser) {
    return null;
  }

  const user = await resolveInternalUser(authUser);
  const memberships = await prisma.organizationMembership.findMany({
    where: { userId: user.id, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });

  return { user, memberships };
}

/**
 * Server-side gate for protected pages and actions.
 *
 * The proxy also redirects unauthenticated traffic, but that is a convenience, not
 * the security boundary: it can be bypassed and it does not run for every execution
 * path. Every protected page and every Server Action must call this itself.
 */
export async function requireUser(): Promise<AuthedUser> {
  const current = await getCurrentUser();

  if (!current) {
    redirect("/login");
  }

  return current;
}
