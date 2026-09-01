import { notFound } from "next/navigation";

import { prisma } from "@/server/db/prisma";
import { requireUser } from "@/server/auth/session";
import { hasRole } from "@/server/auth/roles";
import type {
  Organization,
  OrganizationMembership,
  Role,
  User,
  Website,
  Workspace,
} from "@/generated/prisma/client";

/**
 * Tenant authorization. The ONLY way application code may reach tenant data.
 *
 * Rules these guards enforce (CLAUDE.md, docs/P0_SPEC.md §6):
 *
 *   - A client-supplied id is a CLAIM to be verified, never a scope to trust.
 *   - The ownership chain is resolved from the database on every call:
 *       website -> workspace -> organization -> membership(user, organization)
 *   - Failure is notFound(), never forbidden. A 403 would confirm the row exists
 *     and leak the shape of another tenant.
 *   - Callers receive a resolved context; repositories still re-scope their
 *     queries with it, so a missing guard yields no rows rather than a leak.
 */

export type OrgContext = {
  user: User;
  membership: OrganizationMembership;
  organization: Organization;
};

export type WorkspaceContext = OrgContext & { workspace: Workspace };

export type TenantContext = WorkspaceContext & { website: Website };

/** Thrown only by non-page callers; pages get notFound(). */
export class TenantAccessError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "TenantAccessError";
  }
}

type GuardOptions = {
  /**
   * Server Actions and tests want a thrown error rather than Next's notFound()
   * control-flow exception.
   */
  throwOnDenied?: boolean;
};

function deny(options?: GuardOptions): never {
  if (options?.throwOnDenied) {
    throw new TenantAccessError();
  }
  notFound();
}

async function activeMembership(
  userId: string,
  organizationId: string,
): Promise<OrganizationMembership | null> {
  return prisma.organizationMembership.findFirst({
    where: { userId, organizationId, status: "ACTIVE" },
  });
}

export async function requireOrgAccess(
  organizationId: string,
  minimumRole: Role = "VIEWER",
  options?: GuardOptions,
): Promise<OrgContext> {
  const { user } = await requireUser();

  const organization = await prisma.organization.findFirst({
    where: { id: organizationId, status: "ACTIVE" },
  });

  if (!organization) {
    return deny(options);
  }

  const membership = await activeMembership(user.id, organization.id);

  if (!membership || !hasRole(membership.role, minimumRole)) {
    return deny(options);
  }

  return { user, membership, organization };
}

export async function requireWorkspaceAccess(
  workspaceId: string,
  minimumRole: Role = "VIEWER",
  options?: GuardOptions,
): Promise<WorkspaceContext> {
  const { user } = await requireUser();

  // Resolve the workspace together with its owning organization in one query, so
  // the chain cannot be spoofed by supplying mismatched ids.
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, status: "ACTIVE" },
    include: { organization: true },
  });

  if (!workspace || workspace.organization.status !== "ACTIVE") {
    return deny(options);
  }

  const membership = await activeMembership(user.id, workspace.organizationId);

  if (!membership || !hasRole(membership.role, minimumRole)) {
    return deny(options);
  }

  const { organization, ...workspaceFields } = workspace;

  return { user, membership, organization, workspace: workspaceFields };
}

export async function requireWebsiteAccess(
  websiteId: string,
  minimumRole: Role = "VIEWER",
  options?: GuardOptions,
): Promise<TenantContext> {
  const { user } = await requireUser();

  const website = await prisma.website.findFirst({
    where: { id: websiteId, status: "ACTIVE" },
    include: { workspace: { include: { organization: true } } },
  });

  if (
    !website ||
    website.workspace.status !== "ACTIVE" ||
    website.workspace.organization.status !== "ACTIVE"
  ) {
    return deny(options);
  }

  const membership = await activeMembership(
    user.id,
    website.workspace.organizationId,
  );

  if (!membership || !hasRole(membership.role, minimumRole)) {
    return deny(options);
  }

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
 * Defence in depth for repositories: a where-clause fragment that re-asserts the
 * ownership chain even when the caller already holds a verified context. A child
 * id belonging to another tenant then resolves to nothing instead of leaking.
 */
export function websiteScope(context: TenantContext) {
  return {
    websiteId: context.website.id,
    website: {
      workspaceId: context.workspace.id,
      workspace: { organizationId: context.organization.id },
    },
  } as const;
}

/**
 * Validates that a user id supplied as an owner is an active member of THIS
 * organization. Prevents assigning ownership to a user from another tenant.
 */
export async function requireTenantMember(
  context: OrgContext,
  userId: string,
): Promise<void> {
  const membership = await activeMembership(userId, context.organization.id);

  if (!membership) {
    throw new TenantAccessError("User is not a member of this organization");
  }
}
