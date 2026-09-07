import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { revisionHash } from "@/lib/execution/hash";
import type { Prisma } from "@/generated/prisma/client";
import { deleteOrganizations, deleteUsers } from "../helpers/teardown";

/**
 * P4 M6.1: the execution binding, tested at the database.
 *
 * Nothing here goes through a service. The question is what Postgres refuses on
 * its own, because the claim this milestone makes is that an execution names
 * one coherent approved chain and that what a CMS created cannot be edited
 * afterwards. A claim that only the service enforces is a claim that survives
 * exactly as long as nobody writes a second service.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Chain = {
  userId: string;
  organizationId: string;
  workspaceId: string;
  websiteId: string;
  connectionId: string;
  recommendationId: string;
  decisionId: string;
  workItemId: string;
  briefId: string;
  draftId: string;
  revisionId: string;
  revisionHash: string;
  qaRunId: string;
  approvalId: string;
};

const CONTENT = {
  title: "Payroll Software Philippines",
  bodyMarkdown: "# Payroll Software Philippines\n\nA guide.\n",
};

async function makeChain(label: string): Promise<Chain> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `m61-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `M61 ${label}`, slug: `m61-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  await prisma.organizationMembership.create({
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

  const host = `${label}-${suffix}.example.com`;
  const website = await prisma.website.create({
    data: { workspaceId: workspace.id, domain: host, normalizedDomain: host, primaryMarket: "PH" },
  });

  const connection = await prisma.connection.create({
    data: {
      workspaceId: workspace.id,
      websiteId: website.id,
      provider: "WORDPRESS",
      status: "CONNECTED",
      authType: "APPLICATION_PASSWORD",
      baseUrl: `https://${host}`,
    },
  });

  const { recommendationId, decisionId, workItemId } = await makeWorkItem(
    website.id,
    user.id,
    "Refresh the payroll guide",
  );

  const brief = await prisma.contentBrief.create({
    data: {
      websiteId: website.id,
      contentWorkItemId: workItemId,
      version: 1,
      title: "Payroll guide refresh",
      contentType: "guide",
      status: "APPROVED",
      createdByUserId: user.id,
      approvedByUserId: user.id,
      approvedAt: new Date(),
    },
  });

  const draft = await prisma.contentDraft.create({
    data: {
      websiteId: website.id,
      contentWorkItemId: workItemId,
      briefId: brief.id,
      status: "APPROVED",
      createdByUserId: user.id,
    },
  });

  const hash = revisionHash(CONTENT);
  const revision = await prisma.contentRevision.create({
    data: {
      websiteId: website.id,
      contentDraftId: draft.id,
      revisionNumber: 1,
      ...CONTENT,
      changeSummary: "First draft",
      contentHash: hash,
      createdByUserId: user.id,
    },
  });

  const run = await prisma.contentQaRun.create({
    data: {
      websiteId: website.id,
      contentWorkItemId: workItemId,
      contentDraftId: draft.id,
      contentRevisionId: revision.id,
      revisionNumber: 1,
      revisionHash: hash,
      briefId: brief.id,
      briefVersion: 1,
      inputsFingerprint: "sha256:inputs",
      checkerVersion: "test/1",
      requestedByUserId: user.id,
      status: "COMPLETED",
      outcome: "PASS",
      completedAt: new Date(),
    },
  });

  const approval = await prisma.contentCmsApproval.create({
    data: {
      websiteId: website.id,
      contentWorkItemId: workItemId,
      contentDraftId: draft.id,
      contentRevisionId: revision.id,
      revisionNumber: 1,
      revisionHash: hash,
      qaRunId: run.id,
      briefId: brief.id,
      briefVersion: 1,
      approvedByUserId: user.id,
    },
  });

  await prisma.contentWorkItem.update({
    where: { id: workItemId },
    data: { status: "APPROVED_FOR_CMS" },
  });

  return {
    userId: user.id,
    organizationId: organization.id,
    workspaceId: workspace.id,
    websiteId: website.id,
    connectionId: connection.id,
    recommendationId,
    decisionId,
    workItemId,
    briefId: brief.id,
    draftId: draft.id,
    revisionId: revision.id,
    revisionHash: hash,
    qaRunId: run.id,
    approvalId: approval.id,
  };
}

/** A second piece of work in the same tenant, with its own recommendation. */
async function makeWorkItem(websiteId: string, userId: string, title: string) {
  const recommendation = await prisma.recommendation.create({
    data: {
      websiteId,
      type: "CONTENT_REFRESH",
      status: "APPROVED",
      title,
      summary: "The guide has lost rankings.",
      rationale: "Clicks down over 28 days.",
    },
  });
  const decision = await prisma.decision.create({
    data: {
      websiteId,
      recommendationId: recommendation.id,
      decision: "APPROVED",
      decidedByUserId: userId,
    },
  });
  const item = await prisma.contentWorkItem.create({
    data: {
      websiteId,
      recommendationId: recommendation.id,
      decisionId: decision.id,
      type: "CONTENT_REFRESH",
      title,
      objective: "Recover the primary keyword.",
    },
  });
  return { recommendationId: recommendation.id, decisionId: decision.id, workItemId: item.id };
}

function executionData(chain: Chain, overrides: Record<string, unknown> = {}) {
  return {
    websiteId: chain.websiteId,
    recommendationId: chain.recommendationId,
    decisionId: chain.decisionId,
    contentWorkItemId: chain.workItemId,
    contentRevisionId: chain.revisionId,
    revisionHash: chain.revisionHash,
    contentCmsApprovalId: chain.approvalId,
    qaRunId: chain.qaRunId,
    targetEntityType: "POST",
    idempotencyKey: `test:${crypto.randomUUID()}`,
    permissionMode: "DRAFT_ONLY",
    executionType: "CREATE_CMS_DRAFT",
    provider: "WORDPRESS",
    connectionId: chain.connectionId,
    status: "READY",
    ...overrides,
  } as unknown as Prisma.ExecutionUncheckedCreateInput;
}

const create = (chain: Chain, overrides: Record<string, unknown> = {}) =>
  prisma.execution.create({ data: executionData(chain, overrides) });

async function clearExecutions(websiteId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
    await tx.executionStep.deleteMany({ where: { websiteId } });
    await tx.execution.deleteMany({ where: { websiteId } });
  });
}

async function teardown(ids: string[]): Promise<void> {
  await deleteOrganizations(ids);
}

let a: Chain;
let b: Chain;

beforeAll(async () => {
  a = await makeChain("a");
  b = await makeChain("b");
}, 120_000);

afterAll(async () => {
  if (organizationIds.length > 0) await teardown(organizationIds);
  if (userIds.length > 0) await deleteUsers(userIds);
  await prisma.$disconnect();
});

describe("what a CREATE_CMS_DRAFT execution must carry", () => {
  it("accepts one that names a coherent approved chain", async () => {
    const execution = await create(a);
    expect(execution.contentCmsApprovalId).toBe(a.approvalId);
    expect(execution.targetEntityType).toBe("POST");
    await clearExecutions(a.websiteId);
  });

  it("refuses one with no target type, key, run, approval or mode", async () => {
    for (const missing of [
      "targetEntityType",
      "idempotencyKey",
      "qaRunId",
      "contentCmsApprovalId",
      "permissionMode",
    ]) {
      await expect(create(a, { [missing]: null })).rejects.toThrow();
    }
  });

  it("leaves other execution types free of CMS bindings", async () => {
    const execution = await create(a, {
      executionType: "APPLY_INTERNAL_LINK_UPDATE",
      contentCmsApprovalId: null,
      qaRunId: null,
      targetEntityType: null,
      idempotencyKey: null,
      permissionMode: null,
    });
    expect(execution.contentCmsApprovalId).toBeNull();
    await clearExecutions(a.websiteId);
  });
});

describe("the approval chain", () => {
  it("refuses an execution whose revision is not the approved one", async () => {
    await expect(create(a, { contentRevisionId: b.revisionId })).rejects.toThrow(
      /same approved chain|violates foreign key/,
    );
  });

  it("refuses an execution whose hash is not the approved hash", async () => {
    await expect(create(a, { revisionHash: "sha256:not-the-approved-words" })).rejects.toThrow(
      /same approved chain/,
    );
  });

  it("refuses an execution whose QA run is not the approval's run", async () => {
    await expect(create(a, { qaRunId: b.qaRunId })).rejects.toThrow(/same approved chain/);
  });

  it("refuses an approval belonging to another work item", async () => {
    const other = await makeWorkItem(a.websiteId, a.userId, "A second piece of work");
    await expect(create(a, { contentWorkItemId: other.workItemId })).rejects.toThrow(
      /same approved chain/,
    );
  });

  it("refuses another tenant's approval, whatever else the row says", async () => {
    await expect(
      create(a, { contentCmsApprovalId: b.approvalId, qaRunId: b.qaRunId }),
    ).rejects.toThrow(/same approved chain/);
  });

  it("refuses another tenant's connection", async () => {
    await expect(create(a, { connectionId: b.connectionId })).rejects.toThrow(
      /does not belong to website/,
    );
  });

  it("refuses an approval that is no longer APPROVED", async () => {
    await prisma.contentCmsApproval.update({
      where: { id: b.approvalId },
      data: {
        status: "INVALIDATED",
        invalidatedAt: new Date(),
        invalidatedReason: "The draft was reopened.",
      },
    });
    await expect(create(b)).rejects.toThrow(/cannot authorize an execution/);
  });

  it("keeps an execution written while its approval was live, after that approval is invalidated", async () => {
    const chain = await makeChain("history");
    const execution = await create(chain);

    await prisma.contentCmsApproval.update({
      where: { id: chain.approvalId },
      data: {
        status: "INVALIDATED",
        invalidatedAt: new Date(),
        invalidatedReason: "The draft was reopened.",
      },
    });

    // The record of what was done does not change because the authorization
    // behind it was later withdrawn.
    const after = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(after.contentCmsApprovalId).toBe(chain.approvalId);
    expect(after.revisionHash).toBe(chain.revisionHash);

    // And it can still be moved along, because history is not frozen work.
    const moved = await prisma.execution.update({
      where: { id: execution.id },
      data: { status: "EXECUTING", startedAt: new Date() },
    });
    expect(moved.status).toBe("EXECUTING");
  });

  it("refuses to move any binding once written", async () => {
    const execution = await create(a);
    for (const change of [
      { contentCmsApprovalId: null },
      { qaRunId: null },
      { targetEntityType: "PAGE" },
      { idempotencyKey: "test:something-else" },
      { revisionHash: "sha256:other" },
      { executionType: "PUBLISH_CONTENT" },
      { connectionId: b.connectionId },
    ]) {
      await expect(
        prisma.execution.update({
          where: { id: execution.id },
          data: change as Prisma.ExecutionUncheckedUpdateInput,
        }),
      ).rejects.toThrow(/bindings cannot change/);
    }
    await clearExecutions(a.websiteId);
  });
});

describe("what the CMS created", () => {
  it("is frozen once known: it cannot be changed or cleared", async () => {
    const execution = await create(a, { externalEntityId: "1234", status: "SUCCEEDED" });

    await expect(
      prisma.execution.update({ where: { id: execution.id }, data: { externalEntityId: "9999" } }),
    ).rejects.toThrow(/cannot be changed or cleared/);

    await expect(
      prisma.execution.update({ where: { id: execution.id }, data: { externalEntityId: null } }),
    ).rejects.toThrow(/cannot be changed or cleared/);

    // Everything else about it may still move.
    const moved = await prisma.execution.update({
      where: { id: execution.id },
      data: { externalStatus: "draft", verifiedAt: new Date() },
    });
    expect(moved.externalEntityId).toBe("1234");
  });

  it("allows exactly one external entity per work item and type", async () => {
    await expect(create(a, { externalEntityId: "5678" })).rejects.toThrow(/Unique constraint/);
  });

  it("allows exactly one execution per connection and external entity", async () => {
    const other = await makeWorkItem(a.websiteId, a.userId, "Another refresh");
    await expect(
      create(a, {
        contentWorkItemId: other.workItemId,
        contentCmsApprovalId: null,
        qaRunId: null,
        targetEntityType: null,
        idempotencyKey: null,
        permissionMode: null,
        executionType: "APPLY_INTERNAL_LINK_UPDATE",
        externalEntityId: "1234",
      }),
    ).rejects.toThrow(/Unique constraint/);
    await clearExecutions(a.websiteId);
  });
});

describe("the idempotency key", () => {
  it("is unique within a website", async () => {
    const key = `test:${crypto.randomUUID()}`;
    await create(a, { idempotencyKey: key });
    await expect(create(a, { idempotencyKey: key })).rejects.toThrow(/Unique constraint/);
    await clearExecutions(a.websiteId);
  });

  it("does not collide across websites, which have their own operations", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const chain = await makeChain("keys");
    await create(a, { idempotencyKey: key });
    const elsewhere = await create(chain, { idempotencyKey: key });
    expect(elsewhere.idempotencyKey).toBe(key);
    await clearExecutions(a.websiteId);
  });
});

describe("a connection's capabilities", () => {
  it("hold one answer per capability and entity type, including the unscoped one", async () => {
    const row = {
      websiteId: a.websiteId,
      connectionId: a.connectionId,
      capability: "CREATE_DRAFT" as const,
      granted: true,
      source: "test",
      checkedAt: new Date(),
    };
    await prisma.connectionCapability.create({ data: { ...row, entityType: "POST" } });
    await prisma.connectionCapability.create({ data: { ...row, entityType: "PAGE" } });
    await expect(
      prisma.connectionCapability.create({ data: { ...row, entityType: "POST" } }),
    ).rejects.toThrow(/Unique constraint/);

    // A null entity type is one answer too, not an unlimited supply of them.
    await prisma.connectionCapability.create({
      data: { ...row, capability: "READ_CONTENT", entityType: null },
    });
    await expect(
      prisma.connectionCapability.create({
        data: { ...row, capability: "READ_CONTENT", entityType: null },
      }),
    ).rejects.toThrow(/Unique constraint/);
  });
});

describe("tearing a tenant down", () => {
  const ids: string[] = [];

  beforeAll(async () => {
    const chain = await makeChain("teardown");
    ids.push(chain.organizationId);
    const execution = await create(chain, { externalEntityId: "4242", status: "SUCCEEDED" });
    await prisma.executionStep.create({
      data: {
        websiteId: chain.websiteId,
        executionId: execution.id,
        attempt: 0,
        stepType: "PREFLIGHT",
        status: "SUCCEEDED",
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
  }, 60_000);

  it("still works with an execution referencing an approval, through the documented hatch", async () => {
    // The reference from execution to approval is RESTRICT. Both cascade from
    // the website, and this is the proof that ordering does not deadlock them.
    await expect(prisma.organization.delete({ where: { id: ids[0]! } })).rejects.toThrow();

    await teardown(ids);

    expect(await prisma.organization.count({ where: { id: ids[0]! } })).toBe(0);
    organizationIds.splice(organizationIds.indexOf(ids[0]!), 1);
  });

  it("leaves no execution or step behind", async () => {
    const orphanSteps = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) n FROM execution_step s
         LEFT JOIN execution e ON e.id = s.execution_id
        WHERE e.id IS NULL`,
    );
    expect(Number(orphanSteps[0]!.n)).toBe(0);

    const orphanBindings = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) n FROM execution e
         LEFT JOIN content_cms_approval ca ON ca.id = e.content_cms_approval_id
        WHERE e.content_cms_approval_id IS NOT NULL AND ca.id IS NULL`,
    );
    expect(Number(orphanBindings[0]!.n)).toBe(0);
  });
});
