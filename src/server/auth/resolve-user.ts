import type { User as SupabaseUser } from "@supabase/supabase-js";

import { prisma } from "@/server/db/prisma";
import type { User } from "@/generated/prisma/client";

/**
 * Maps an authenticated Supabase identity to the internal SEO OS user.
 *
 * Keyed on authUserId (Supabase auth.users.id, stable for a given Google account),
 * never on email. Two consequences, both required by CLAUDE.md:
 *
 *   1. Repeat login resolves the same internal user, so signing in again never
 *      duplicates the account.
 *   2. A user whose Google email changes keeps their identity, and a user who
 *      acquires someone else's old address does not inherit anything.
 *
 * This function grants NO access. It creates a User row and nothing else. Tenant
 * access exists only where an OrganizationMembership row exists, and nothing here
 * inspects the email domain.
 */
export async function resolveInternalUser(authUser: SupabaseUser): Promise<User> {
  const email = authUser.email;

  if (!email) {
    // Google always returns an email for the scopes we request; if it is missing,
    // fail closed rather than inventing an identity.
    throw new Error("Authenticated identity has no email address");
  }

  const metadata = authUser.user_metadata ?? {};
  const displayName =
    typeof metadata.full_name === "string"
      ? metadata.full_name
      : typeof metadata.name === "string"
        ? metadata.name
        : null;
  const avatarUrl =
    typeof metadata.avatar_url === "string"
      ? metadata.avatar_url
      : typeof metadata.picture === "string"
        ? metadata.picture
        : null;

  return prisma.user.upsert({
    where: { authUserId: authUser.id },
    update: {
      email,
      displayName,
      avatarUrl,
      lastLoginAt: new Date(),
    },
    create: {
      authUserId: authUser.id,
      email,
      displayName,
      avatarUrl,
      lastLoginAt: new Date(),
    },
  });
}
