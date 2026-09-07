import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import {
  ExecutionServiceError,
  externalDraftFor,
  listExecutionSteps,
  preflightCreateCmsDraft,
  requestCmsDraftExecution,
  unresolvedExecutionFor,
} from "@/server/services/execution";
import { CmsFixtures, SITE_URL, type CmsFixture } from "../helpers/cms-fixture";

/**
 * P4 M6.1: one operation, one execution (M6 plan D3, D5, D10).
 *
 * The failure this exists to prevent is two drafts in somebody's WordPress
 * because a button was pressed twice, a request was retried, or an earlier
 * attempt ended in silence. Each of these is a way that could happen.
 */

const fixtures = new CmsFixtures();
let base: CmsFixture;

beforeAll(async () => {
  base = await fixtures.approvedForCms("idem");
}, 60_000);

afterEach(async () => {
  await clearExecutions();
});

afterAll(async () => {
  resetProvider();
  vi.unstubAllEnvs();
  await fixtures.teardown();
  await prisma.$disconnect();
});

async function clearExecutions(): Promise<void> {
  const websiteId = base.tenant.website.id;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
    await tx.executionStep.deleteMany({ where: { websiteId } });
    await tx.execution.deleteMany({ where: { websiteId } });
  });
}

const request = (entity: "POST" | "PAGE" = "POST") =>
  requestCmsDraftExecution(base.lead, base.item.id, { targetEntityType: entity });

const countExecutions = () =>
  prisma.execution.count({ where: { websiteId: base.tenant.website.id } });

describe("asking twice for the same thing", () => {
  it("creates one execution and then recognises it", async () => {
    const first = await request();
    expect(first.reused).toBe(false);
    expect(first.execution.status).toBe("READY");
    expect(first.execution.externalEntityId).toBeNull();

    const second = await request();
    expect(second.reused).toBe(true);
    expect(second.execution.id).toBe(first.execution.id);
    expect(await countExecutions()).toBe(1);
  });

  it("creates one execution when both requests arrive together", async () => {
    const [a, b] = await Promise.all([request(), request()]);

    expect(a.execution.id).toBe(b.execution.id);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
    expect(await countExecutions()).toBe(1);
  });

  it("records a preflight step for every request, so the trail shows both", async () => {
    const first = await request();
    await request();

    const steps = await listExecutionSteps(base.lead, first.execution.id);
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.stepType)).toEqual(["PREFLIGHT", "PREFLIGHT"]);
    expect(steps.every((step) => step.status === "SUCCEEDED")).toBe(true);

    const summaries = steps.map((step) => step.requestSummaryJson as { outcome: string });
    expect(summaries.map((summary) => summary.outcome)).toEqual(["create", "reuse"]);
  });

  it("keeps credentials and content out of the step summary", async () => {
    const first = await request();
    const [step] = await listExecutionSteps(base.lead, first.execution.id);
    const text = JSON.stringify(step);
    expect(text).toContain("cms.example.com");
    expect(text).not.toMatch(/password|authorization|secret|token/i);
    expect(text).not.toContain("bodyMarkdown");
  });
});

describe("what makes an operation a different operation", () => {
  it("tells a post from a page", async () => {
    const post = await preflightCreateCmsDraft(base.lead, base.item.id, {
      targetEntityType: "POST",
    });
    const page = await preflightCreateCmsDraft(base.lead, base.item.id, {
      targetEntityType: "PAGE",
    });
    expect(post.plan!.idempotencyKey).not.toBe(page.plan!.idempotencyKey);
  });

  it("tells one WordPress from another, even on the same connection row", async () => {
    const before = await preflightCreateCmsDraft(base.lead, base.item.id, {
      targetEntityType: "POST",
    });

    await fixtures.connect(base.tenant, { baseUrl: "https://other.example.com" });
    const after = await preflightCreateCmsDraft(base.lead, base.item.id, {
      targetEntityType: "POST",
    });

    expect(after.plan!.idempotencyKey).not.toBe(before.plan!.idempotencyKey);
    await fixtures.connect(base.tenant, { baseUrl: SITE_URL });
  });

  it("cannot be steered by anything the browser sends", async () => {
    const forged = { targetEntityType: "POST", idempotencyKey: "attacker-chosen" };
    const result = await requestCmsDraftExecution(
      base.lead,
      base.item.id,
      forged as { targetEntityType: "POST" },
    );

    const derived = await preflightCreateCmsDraft(base.lead, base.item.id, {
      targetEntityType: "POST",
    });
    expect(result.execution.idempotencyKey).toBe(derived.plan!.idempotencyKey);
    expect(result.execution.idempotencyKey).not.toBe("attacker-chosen");
    expect(result.execution.idempotencyKey).toMatch(/^cms-exec\/1:[0-9a-f]{64}$/);
  });
});

describe("an earlier attempt that already did something", () => {
  it("refuses a second create once a CMS entity exists", async () => {
    const first = await request();
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: { status: "SUCCEEDED", externalEntityId: "1234", externalStatus: "draft" },
    });

    await expect(request()).rejects.toThrow(ExecutionServiceError);
    await expect(request()).rejects.toMatchObject({ code: "already_executed" });
    expect(await countExecutions()).toBe(1);

    const external = await externalDraftFor(base.lead, base.item.id);
    expect(external?.externalEntityId).toBe("1234");
  });
});

describe("an earlier attempt whose outcome nobody can state", () => {
  it("refuses while it is still running", async () => {
    const first = await request();
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: { status: "EXECUTING", startedAt: new Date() },
    });

    await expect(request()).rejects.toMatchObject({ code: "execution_in_progress" });
    expect(await countExecutions()).toBe(1);
    expect((await unresolvedExecutionFor(base.lead, base.item.id))?.id).toBe(first.execution.id);
  });

  it("refuses after a failure that does not prove the CMS was left alone", async () => {
    const first = await request();
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: {
        status: "EXECUTING",
        startedAt: new Date(),
      },
    });
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: {
        status: "FAILED",
        errorCode: "ambiguous_timeout",
        errorSummary: "The CMS did not answer.",
      },
    });

    await expect(request()).rejects.toMatchObject({ code: "ambiguous_timeout" });
    expect(await countExecutions()).toBe(1);
  });

  it("refuses after an answer we could not read, which is not proof of anything", async () => {
    const first = await request();
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: { status: "EXECUTING", startedAt: new Date() },
    });
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: { status: "FAILED", errorCode: "invalid_response" },
    });

    await expect(request()).rejects.toMatchObject({ code: "ambiguous_timeout" });
  });

  it("blocks even when a different operation identity would otherwise be allowed", async () => {
    const first = await request("POST");
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: { status: "EXECUTING", startedAt: new Date() },
    });

    // A page is a different operation with a different key. It is still refused,
    // because we cannot rule out that the post attempt created something.
    await expect(request("PAGE")).rejects.toMatchObject({ code: "ambiguous_timeout" });
    expect(await countExecutions()).toBe(1);
  });
});

describe("an earlier attempt that provably changed nothing", () => {
  it("is reused and put back to ready, rather than duplicated", async () => {
    const first = await request();
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: { status: "EXECUTING", startedAt: new Date() },
    });
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: {
        status: "FAILED",
        errorCode: "connection_failed",
        errorSummary: "The CMS could not be reached.",
      },
    });

    const again = await request();
    expect(again.reused).toBe(true);
    expect(again.execution.id).toBe(first.execution.id);
    expect(again.execution.status).toBe("READY");
    expect(again.execution.errorCode).toBeNull();
    expect(await countExecutions()).toBe(1);

    const steps = await listExecutionSteps(base.lead, first.execution.id);
    expect((steps.at(-1)!.requestSummaryJson as { outcome: string }).outcome).toBe("retry");
  });

  it("is reused after reconciliation proved the CMS created nothing", async () => {
    const first = await request();
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: { status: "EXECUTING", startedAt: new Date() },
    });
    await prisma.execution.update({
      where: { id: first.execution.id },
      data: { status: "FAILED", errorCode: "reconciled_absent" },
    });

    const again = await request();
    expect(again.execution.id).toBe(first.execution.id);
    expect(again.execution.status).toBe("READY");
  });
});

describe("what the execution records", () => {
  it("names the approval, the run, the revision and the target, and nothing external", async () => {
    const { execution, plan } = await request();

    expect(execution.contentCmsApprovalId).toBe(base.approval.id);
    expect(execution.qaRunId).toBe(base.approval.qaRunId);
    expect(execution.contentRevisionId).toBe(base.approval.contentRevisionId);
    expect(execution.revisionHash).toBe(base.approval.revisionHash);
    expect(execution.targetEntityType).toBe("POST");
    expect(execution.permissionMode).toBe("DRAFT_ONLY");
    expect(execution.provider).toBe("WORDPRESS");
    expect(execution.requestedByUserId).toBe(base.lead.user.id);
    expect(execution.approvedByUserId).toBe(base.approval.approvedByUserId);

    // Nothing has been done outside SEO OS, and the record says so.
    expect(execution.externalEntityId).toBeNull();
    expect(execution.externalUrl).toBeNull();
    expect(execution.externalStatus).toBeNull();
    expect(execution.startedAt).toBeNull();
    expect(execution.completedAt).toBeNull();
    expect(execution.verifiedAt).toBeNull();
    expect(plan.siteHost).toBe("cms.example.com");
  });

  it("writes an audit event naming what was authorized, without the site's secrets", async () => {
    const { execution } = await request();
    const events = await prisma.auditEvent.findMany({
      where: { entityType: "Execution", entityId: execution.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("CREATE");

    const after = events[0]!.afterSnapshotJson as Record<string, unknown>;
    expect(after.contentCmsApprovalId).toBe(base.approval.id);
    expect(after.targetEntityType).toBe("POST");
    expect(after.siteHost).toBe("cms.example.com");
    expect(JSON.stringify(after)).not.toMatch(/password|authorization|secret/i);
  });

  it("records a refusal against the work item, with the check that refused", async () => {
    await fixtures.connect(base.tenant, { createDraftFor: [] });

    const where = {
      entityType: "ContentWorkItem",
      entityId: base.item.id,
      action: "DECLINE" as const,
    };
    const before = await prisma.auditEvent.findMany({ where, select: { id: true } });

    await expect(request()).rejects.toMatchObject({ code: "capability_missing" });

    const seen = new Set(before.map((event) => event.id));
    const fresh = (await prisma.auditEvent.findMany({ where })).filter(
      (event) => !seen.has(event.id),
    );
    expect(fresh).toHaveLength(1);

    const after = fresh[0]!.afterSnapshotJson as Record<string, unknown>;
    expect(after.refusedAt).toBe("capability");
    expect(after.code).toBe("capability_missing");
    expect(after.failedChecks).toEqual(["capability"]);
    expect(await countExecutions()).toBe(0);

    await fixtures.connect(base.tenant);
  });
});
