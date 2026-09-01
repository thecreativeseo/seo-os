import { redact } from "@/lib/redact";
import type { TenantContext, WorkspaceContext } from "@/server/auth/guards";
import type { AuditAction, Prisma } from "@/generated/prisma/client";

/**
 * Writes an AuditEvent (docs/P0_SPEC.md §19).
 *
 * Takes a transaction client so the event is written in the SAME transaction as
 * the mutation it records. An audit trail that can disagree with the data is worse
 * than none: it would be evidence of something that did not happen, or silence
 * about something that did.
 *
 * Snapshots pass through the redaction denylist. A secret in an audit event is a
 * release-blocking P0 failure, so redaction is applied here rather than trusted to
 * each call site.
 */
export type AuditInput = {
  entityType: string;
  entityId: string;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
};

type TxClient = Prisma.TransactionClient;

export async function recordAudit(
  tx: TxClient,
  context: TenantContext,
  input: AuditInput,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      organizationId: context.organization.id,
      workspaceId: context.workspace.id,
      websiteId: context.website.id,
      actorUserId: context.user.id,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      beforeSnapshotJson:
        input.before === undefined ? undefined : (redact(input.before) as Prisma.InputJsonValue),
      afterSnapshotJson:
        input.after === undefined ? undefined : (redact(input.after) as Prisma.InputJsonValue),
    },
  });
}

/**
 * Workspace-level events, which have no website — renaming a workspace, changing
 * membership. Same redaction, same transaction rule.
 */
export async function recordWorkspaceAudit(
  tx: TxClient,
  context: WorkspaceContext,
  input: AuditInput,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      organizationId: context.organization.id,
      workspaceId: context.workspace.id,
      actorUserId: context.user.id,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      beforeSnapshotJson:
        input.before === undefined ? undefined : (redact(input.before) as Prisma.InputJsonValue),
      afterSnapshotJson:
        input.after === undefined ? undefined : (redact(input.after) as Prisma.InputJsonValue),
    },
  });
}
