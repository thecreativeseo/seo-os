import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { revisionHash } from "@/lib/execution/hash";

/**
 * The P4 execution schema (docs/P4_SPEC.md §6-§27), tested at the database.
 *
 * Nothing here goes through a service: the point is what Postgres refuses on
 * its own. A bug in a service - or a person with a database client - must not
 * be able to rewrite an approved brief, a revision, a decided approval or an
 * execution step, nor queue the same work twice.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = {
  userId: string;
  organizationId: string;
  websiteId: string;
  workspaceId: string;
  recommendationId: string;
  decisionId: string;
  connectionId: string;
};

async function makeFixture(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `p4-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `P4 ${label}`, slug: `p4-${label}-${suffix}` },
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

  const recommendation = await prisma.recommendation.create({
    data: {
      websiteId: website.id,
      type: "CONTENT_REFRESH",
      status: "APPROVED",
      title: "Refresh the payroll guide",
      summary: "The guide has lost rankings for its primary keyword.",
      rationale: "Clicks down 40% over 28 days with impressions flat.",
    },
  });

  const decision = await prisma.decision.create({
    data: {
      websiteId: website.id,
      recommendationId: recommendation.id,
      decision: "APPROVED",
      decidedByUserId: user.id,
    },
  });

  const connection = await prisma.connection.create({
    data: { workspaceId: workspace.id, websiteId: website.id, provider: "WORDPRESS" },
  });

  return {
    userId: user.id,
    organizationId: organization.id,
    websiteId: website.id,
    workspaceId: workspace.id,
    recommendationId: recommendation.id,
    decisionId: decision.id,
    connectionId: connection.id,
  };
}

async function makeWorkItem(fixture: Fixture) {
  return prisma.contentWorkItem.create({
    data: {
      websiteId: fixture.websiteId,
      recommendationId: fixture.recommendationId,
      decisionId: fixture.decisionId,
      type: "CONTENT_REFRESH",
      title: "Refresh the payroll guide",
      objective: "Recover the primary keyword.",
    },
  });
}

async function makeDraftWithRevision(fixture: Fixture, workItemId: string) {
  const brief = await prisma.contentBrief.create({
    data: {
      websiteId: fixture.websiteId,
      contentWorkItemId: workItemId,
      version: 1,
      title: "Payroll guide refresh",
      contentType: "guide",
      status: "APPROVED",
      createdByUserId: fixture.userId,
      approvedByUserId: fixture.userId,
      approvedAt: new Date(),
    },
  });

  const draft = await prisma.contentDraft.create({
    data: {
      websiteId: fixture.websiteId,
      contentWorkItemId: workItemId,
      briefId: brief.id,
      createdByUserId: fixture.userId,
    },
  });

  const content = {
    title: "Payroll Software Philippines",
    bodyMarkdown: "# Payroll Software Philippines\n\nA guide.\n",
  };

  const revision = await prisma.contentRevision.create({
    data: {
      websiteId: fixture.websiteId,
      contentDraftId: draft.id,
      revisionNumber: 1,
      ...content,
      changeSummary: "First draft",
      contentHash: revisionHash(content),
      createdByUserId: fixture.userId,
    },
  });

  return { brief, draft, revision };
}

/**
 * Tearing history down needs the escape hatch, inside the same transaction.
 * Written once here; the last test proves the hatch is the only way through.
 */
async function teardown(organizationIds: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
    await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
  });
}

afterAll(async () => {
  if (organizationIds.length > 0) await teardown(organizationIds);
  if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("one open work item per recommendation", () => {
  it("refuses a second open item and allows one after the first is closed", async () => {
    const fixture = await makeFixture("open");
    const first = await makeWorkItem(fixture);

    await expect(makeWorkItem(fixture)).rejects.toThrow(/unique/i);

    await prisma.contentWorkItem.update({
      where: { id: first.id },
      data: { status: "CANCELLED" },
    });
    const second = await makeWorkItem(fixture);
    expect(second.id).not.toBe(first.id);
  });
});

describe("approved briefs", () => {
  it("cannot be edited, only superseded or archived unchanged", async () => {
    const fixture = await makeFixture("brief");
    const item = await makeWorkItem(fixture);
    const { brief } = await makeDraftWithRevision(fixture, item.id);

    await expect(
      prisma.contentBrief.update({ where: { id: brief.id }, data: { title: "Something else" } }),
    ).rejects.toThrow(/immutable/);

    // A status change that smuggles in a content change is still an edit.
    await expect(
      prisma.contentBrief.update({
        where: { id: brief.id },
        data: { status: "SUPERSEDED", audience: "HR teams" },
      }),
    ).rejects.toThrow(/immutable/);

    const superseded = await prisma.contentBrief.update({
      where: { id: brief.id },
      data: { status: "SUPERSEDED" },
    });
    expect(superseded.status).toBe("SUPERSEDED");

    // A draft brief is still a draft.
    const v2 = await prisma.contentBrief.create({
      data: {
        websiteId: fixture.websiteId,
        contentWorkItemId: item.id,
        version: 2,
        title: "Payroll guide refresh",
        contentType: "guide",
        createdByUserId: fixture.userId,
      },
    });
    const edited = await prisma.contentBrief.update({
      where: { id: v2.id },
      data: { audience: "HR teams" },
    });
    expect(edited.audience).toBe("HR teams");
  });
});

describe("revisions", () => {
  it("are written once: no update, no delete", async () => {
    const fixture = await makeFixture("rev");
    const item = await makeWorkItem(fixture);
    const { revision } = await makeDraftWithRevision(fixture, item.id);

    await expect(
      prisma.contentRevision.update({ where: { id: revision.id }, data: { title: "Edited" } }),
    ).rejects.toThrow(/immutable/);
    await expect(prisma.contentRevision.delete({ where: { id: revision.id } })).rejects.toThrow(
      /immutable/,
    );
  });

  it("have exactly one author", async () => {
    const fixture = await makeFixture("author");
    const item = await makeWorkItem(fixture);
    const { draft } = await makeDraftWithRevision(fixture, item.id);

    const base = {
      websiteId: fixture.websiteId,
      contentDraftId: draft.id,
      title: "x",
      bodyMarkdown: "x",
      changeSummary: "x",
      contentHash: revisionHash({ title: "x", bodyMarkdown: "x" }),
    };

    await expect(
      prisma.contentRevision.create({ data: { ...base, revisionNumber: 2 } }),
    ).rejects.toThrow(/exactly one author|check constraint|constraint/i);

    const run = await prisma.aiRun.create({
      data: {
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        websiteId: fixture.websiteId,
        agentType: "CONTENT_DRAFT",
        taskType: "GENERATE_DRAFT",
        provider: "stub",
        model: "stub",
        promptTemplateVersion: 1,
        outputSchemaVersion: "1",
      },
    });

    await expect(
      prisma.contentRevision.create({
        data: {
          ...base,
          revisionNumber: 2,
          createdByAiRunId: run.id,
          createdByUserId: fixture.userId,
        },
      }),
    ).rejects.toThrow(/exactly one author|check constraint|constraint/i);

    const byRun = await prisma.contentRevision.create({
      data: { ...base, revisionNumber: 2, createdByAiRunId: run.id },
    });
    expect(byRun.createdByAiRunId).toBe(run.id);
  });
});

describe("executions, steps and approvals", () => {
  async function makeExecution(fixture: Fixture, itemId: string, revisionId: string, hash: string) {
    return prisma.execution.create({
      data: {
        websiteId: fixture.websiteId,
        recommendationId: fixture.recommendationId,
        decisionId: fixture.decisionId,
        contentWorkItemId: itemId,
        contentRevisionId: revisionId,
        revisionHash: hash,
        executionType: "PUBLISH_CONTENT",
        provider: "WORDPRESS",
        connectionId: fixture.connectionId,
        requestedByUserId: fixture.userId,
      },
    });
  }

  it("hold one active execution per work item and type", async () => {
    const fixture = await makeFixture("exec");
    const item = await makeWorkItem(fixture);
    const { revision } = await makeDraftWithRevision(fixture, item.id);

    const first = await makeExecution(fixture, item.id, revision.id, revision.contentHash);
    await expect(
      makeExecution(fixture, item.id, revision.id, revision.contentHash),
    ).rejects.toThrow(/unique/i);

    await prisma.execution.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    const second = await makeExecution(fixture, item.id, revision.id, revision.contentHash);
    expect(second.id).not.toBe(first.id);
  });

  it("keep steps append-only", async () => {
    const fixture = await makeFixture("step");
    const item = await makeWorkItem(fixture);
    const { revision } = await makeDraftWithRevision(fixture, item.id);
    const execution = await makeExecution(fixture, item.id, revision.id, revision.contentHash);

    const step = await prisma.executionStep.create({
      data: {
        websiteId: fixture.websiteId,
        executionId: execution.id,
        attempt: 1,
        stepType: "PREFLIGHT",
        status: "SUCCEEDED",
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    await expect(
      prisma.executionStep.update({ where: { id: step.id }, data: { status: "FAILED" } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.executionStep.delete({ where: { id: step.id } })).rejects.toThrow(
      /history/,
    );
  });

  it("allow one open approval, and freeze it once decided", async () => {
    const fixture = await makeFixture("approval");
    const item = await makeWorkItem(fixture);
    const { revision } = await makeDraftWithRevision(fixture, item.id);
    const execution = await makeExecution(fixture, item.id, revision.id, revision.contentHash);

    const request = () =>
      prisma.publishApproval.create({
        data: {
          websiteId: fixture.websiteId,
          executionId: execution.id,
          contentRevisionId: revision.id,
          revisionHash: revision.contentHash,
          requestedByUserId: fixture.userId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

    const approval = await request();
    await expect(request()).rejects.toThrow(/unique/i);

    const decided = await prisma.publishApproval.update({
      where: { id: approval.id },
      data: { status: "APPROVED", decidedByUserId: fixture.userId, decidedAt: new Date() },
    });
    expect(decided.status).toBe("APPROVED");

    await expect(
      prisma.publishApproval.update({ where: { id: approval.id }, data: { reason: "later" } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.publishApproval.update({ where: { id: approval.id }, data: { status: "REJECTED" } }),
    ).rejects.toThrow(/immutable/);

    // Decided: the slot is free for a new request.
    const again = await request();
    expect(again.status).toBe("REQUESTED");
  });
});

describe("the columns the lifecycle clarification and D8 add", () => {
  it("lets a recommendation become IMPLEMENTED and a rule carry a machine check", async () => {
    const fixture = await makeFixture("cols");

    const implemented = await prisma.recommendation.update({
      where: { id: fixture.recommendationId },
      data: { status: "IMPLEMENTED", implementedAt: new Date() },
    });
    expect(implemented.status).toBe("IMPLEMENTED");

    const rule = await prisma.seoRule.create({
      data: {
        websiteId: fixture.websiteId,
        category: "On-page",
        rule: "Meta titles stay under 60 characters.",
        severity: "BLOCKING",
        checkJson: { kind: "max_length", field: "meta_title", max: 60 },
      },
    });
    expect(rule.checkJson).toEqual({ kind: "max_length", field: "meta_title", max: 60 });
  });
});

describe("tearing history down", () => {
  const ids: string[] = [];

  beforeAll(async () => {
    const fixture = await makeFixture("teardown");
    ids.push(fixture.organizationId);
    const item = await makeWorkItem(fixture);
    await makeDraftWithRevision(fixture, item.id);
  });

  it("is refused by default and possible only with the session-scoped escape hatch", async () => {
    await expect(prisma.organization.delete({ where: { id: ids[0]! } })).rejects.toThrow(
      /immutable/,
    );

    await teardown(ids);
    expect(await prisma.organization.count({ where: { id: ids[0]! } })).toBe(0);
    organizationIds.splice(organizationIds.indexOf(ids[0]!), 1);
  });
});
