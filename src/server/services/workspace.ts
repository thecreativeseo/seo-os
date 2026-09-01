import { prisma } from "@/server/db/prisma";
import { recordWorkspaceAudit } from "@/server/audit/record";
import type { OrgContext, WorkspaceContext } from "@/server/auth/guards";
import type { AuditEvent, Workspace } from "@/generated/prisma/client";

/**
 * Workspace administration (docs/P0_SPEC.md §21: Team, Audit History, Settings).
 */

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/* -------------------------------------------------------------------- team */

export type TeamMember = {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  joinedAt: Date | null;
  isSelf: boolean;
};

/**
 * Members of the organization that owns this workspace.
 *
 * Read-only in P0. Invitations are out of scope: the only paths to membership are
 * creating an organization and an explicit invite, and building the latter without
 * the acceptance criteria to test it would add an untested way into a tenant.
 */
export async function listTeam(context: OrgContext): Promise<TeamMember[]> {
  const memberships = await prisma.organizationMembership.findMany({
    where: { organizationId: context.organization.id },
    include: { user: { select: { id: true, email: true, displayName: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });

  return memberships.map((membership) => ({
    membershipId: membership.id,
    userId: membership.user.id,
    email: membership.user.email,
    displayName: membership.user.displayName,
    role: membership.role,
    status: membership.status,
    joinedAt: membership.joinedAt,
    isSelf: membership.user.id === context.user.id,
  }));
}

/* ------------------------------------------------------------------- audit */

export type AuditEntry = AuditEvent & {
  actor: { email: string; displayName: string | null } | null;
  website: { normalizedDomain: string } | null;
};

export const AUDIT_PAGE_SIZE = 50;

/**
 * Audit history for a workspace, newest first.
 *
 * Scoped by BOTH organization and workspace. Scoping by workspace alone would rely
 * on workspace ids being unguessable; the pair means a row from another tenant
 * cannot match even if an id is known.
 */
export async function listAuditEvents(
  context: WorkspaceContext,
  options: { take?: number; before?: Date } = {},
): Promise<AuditEntry[]> {
  return prisma.auditEvent.findMany({
    where: {
      organizationId: context.organization.id,
      workspaceId: context.workspace.id,
      ...(options.before ? { createdAt: { lt: options.before } } : {}),
    },
    include: {
      actor: { select: { email: true, displayName: true } },
      website: { select: { normalizedDomain: true } },
    },
    orderBy: { createdAt: "desc" },
    take: options.take ?? AUDIT_PAGE_SIZE,
  });
}

export async function countAuditEvents(context: WorkspaceContext): Promise<number> {
  return prisma.auditEvent.count({
    where: {
      organizationId: context.organization.id,
      workspaceId: context.workspace.id,
    },
  });
}

/* ---------------------------------------------------------------- settings */

/**
 * Renames a workspace. ADMIN or above, enforced by the caller's guard and asserted
 * again here.
 */
export async function renameWorkspace(
  context: WorkspaceContext,
  name: string,
): Promise<Workspace> {
  if (context.membership.role !== "OWNER" && context.membership.role !== "ADMIN") {
    throw new WorkspaceError("You do not have permission to change workspace settings.");
  }

  const trimmed = name.trim();

  if (trimmed.length < 2) {
    throw new WorkspaceError("Enter at least 2 characters.");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.workspace.update({
      where: { id: context.workspace.id },
      data: { name: trimmed },
    });

    await recordWorkspaceAudit(tx, context, {
      entityType: "Workspace",
      entityId: updated.id,
      action: "UPDATE",
      before: { name: context.workspace.name },
      after: { name: updated.name },
    });

    return updated;
  });
}
