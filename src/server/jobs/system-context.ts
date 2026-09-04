import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import type { OrganizationMembership, User } from "@/generated/prisma/client";

/**
 * The tenant context a background job runs under.
 *
 * Every service takes a TenantContext, and every service was written assuming
 * the context came from a signed-in person: the audit trail records
 * context.user.id as the actor, the guards check membership.role. A job has no
 * person. It needs an actor that the audit trail can name and a role that the
 * services will accept, without granting a human anything.
 *
 * So there is one system user - a real User row, because AuditEvent.actorUserId
 * is a foreign key and an audit event with a dangling actor is worse than none.
 * Its authUserId is a fixed UUID that no Supabase account can ever have, so no
 * Google sign-in can resolve to it (P0 rule: repeat login resolves to the same
 * internal user; this one resolves to nobody).
 *
 * The membership is NOT a row. It is built in memory for the duration of one
 * job. Persisting it would make the system user a member of every organization,
 * visible in member lists and removable by an admin who did not understand what
 * it was. A membership that exists only inside a job cannot be listed, edited,
 * or used to sign in. Its role is ADMIN because connections and their syncs
 * require it; a job never approves Business Context or makes a decision, and
 * the services that do those things check for a person by other means as well.
 */

/** Fixed, version-4-shaped, and unreachable through any auth provider. */
export const SYSTEM_AUTH_USER_ID = "00000000-0000-4000-8000-000000000001";
export const SYSTEM_USER_EMAIL = "system@seo-os.invalid";
export const SYSTEM_USER_DISPLAY_NAME = "SEO OS (scheduled jobs)";

/** The in-memory membership's id. Never written; recognisable in a stack trace. */
export const SYSTEM_MEMBERSHIP_ID = "00000000-0000-4000-8000-00000000000a";

let systemUserPromise: Promise<User> | null = null;

/**
 * The system user, created on first use. Concurrent first calls share one
 * promise; a lost race against another process is absorbed by the upsert.
 */
export function getSystemUser(): Promise<User> {
  if (!systemUserPromise) {
    systemUserPromise = prisma.user
      .upsert({
        where: { authUserId: SYSTEM_AUTH_USER_ID },
        create: {
          authUserId: SYSTEM_AUTH_USER_ID,
          email: SYSTEM_USER_EMAIL,
          displayName: SYSTEM_USER_DISPLAY_NAME,
        },
        update: {},
      })
      .catch((error: unknown) => {
        systemUserPromise = null;
        throw error;
      });
  }

  return systemUserPromise;
}

/** Tests replace the cached user between tenants; nothing else needs this. */
export function resetSystemUserCache(): void {
  systemUserPromise = null;
}

export class SystemContextError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "inactive",
  ) {
    super(message);
    this.name = "SystemContextError";
  }
}

/**
 * Builds the context for one website. The same status checks as
 * requireWebsiteAccess: an archived website, workspace, or organization gets no
 * jobs, however the job came to be enqueued.
 */
export async function systemContextFor(websiteId: string): Promise<TenantContext> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    include: { workspace: { include: { organization: true } } },
  });

  if (!website) {
    throw new SystemContextError("That website does not exist.", "not_found");
  }

  if (
    website.status !== "ACTIVE" ||
    website.workspace.status !== "ACTIVE" ||
    website.workspace.organization.status !== "ACTIVE"
  ) {
    throw new SystemContextError("That website is not active.", "inactive");
  }

  const user = await getSystemUser();
  const now = new Date();

  const membership: OrganizationMembership = {
    id: SYSTEM_MEMBERSHIP_ID,
    organizationId: website.workspace.organizationId,
    userId: user.id,
    role: "ADMIN",
    status: "ACTIVE",
    invitedByUserId: null,
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const { workspace, ...websiteFields } = website;
  const { organization, ...workspaceFields } = workspace;

  return {
    user,
    membership,
    organization,
    workspace: workspaceFields,
    website: websiteFields,
  };
}

/**
 * Websites the daily fan-out should cover: active all the way up the chain and
 * not a demo. A Demo Workspace holds scripted data, not observations; running
 * detection over it would rewrite the story it was seeded to tell.
 */
export async function listSyncableWebsiteIds(): Promise<string[]> {
  const rows = await prisma.website.findMany({
    where: {
      status: "ACTIVE",
      isDemo: false,
      workspace: { status: "ACTIVE", organization: { status: "ACTIVE" } },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) => row.id);
}
