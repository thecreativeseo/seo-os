import { prisma } from "@/server/db/prisma";
import { redact } from "@/lib/redact";
import type { Organization, User, Workspace } from "@/generated/prisma/client";

/**
 * Organization provisioning.
 *
 * This is one of only two ways an OrganizationMembership can come into existence
 * (the other being an explicit invitation from an OWNER/ADMIN, which is out of P0
 * scope). A user who signs in with Google and creates an organization becomes its
 * OWNER. Nothing here consults the email domain.
 */

export type ProvisionResult = {
  organization: Organization;
  workspace: Workspace;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function uniqueOrganizationSlug(base: string): Promise<string> {
  const root = slugify(base) || "organization";

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const taken = await prisma.organization.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  return `${root}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Creates Organization -> Workspace and makes the caller its OWNER.
 *
 * All four writes plus the audit event happen in one transaction: a half-created
 * tenant, or an organization nobody can reach, would both be worse than a failure.
 */
export async function createOrganizationWithWorkspace(
  user: User,
  input: { organizationName: string; workspaceName: string },
): Promise<ProvisionResult> {
  const slug = await uniqueOrganizationSlug(input.organizationName);

  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: input.organizationName.trim(), slug },
    });

    const workspace = await tx.workspace.create({
      data: {
        organizationId: organization.id,
        name: input.workspaceName.trim(),
        slug: slugify(input.workspaceName) || "workspace",
      },
    });

    const membership = await tx.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: "OWNER",
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    });

    await tx.auditEvent.create({
      data: {
        organizationId: organization.id,
        workspaceId: workspace.id,
        actorUserId: user.id,
        entityType: "Organization",
        entityId: organization.id,
        action: "CREATE",
        afterSnapshotJson: redact({
          organization: { name: organization.name, slug: organization.slug },
          workspace: { name: workspace.name, slug: workspace.slug },
          membership: { role: membership.role, status: membership.status },
        }),
      },
    });

    return { organization, workspace };
  });
}
