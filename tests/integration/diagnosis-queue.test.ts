import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { runQueuedDiagnosis } from "@/server/jobs/definitions";
import { JOB_NAMES, type Queue } from "@/server/jobs/queue";
import { getSystemUser } from "@/server/jobs/system-context";
import {
  createDiagnosisRequest,
  executeDiagnosisRequest,
  latestOpenRequestForPage,
  listOpenDiagnosisRequests,
} from "@/server/services/diagnosis";
import { submitPageDiagnosis } from "@/server/services/diagnosis-runner";

/**
 * A diagnosis that runs somewhere other than the request that asked for it
 * (docs/P1_SPEC.md section 23, docs/P3_SPEC.md section 14).
 *
 * The tenant here has a page and nothing else, so every run takes the
 * deterministic no-evidence path: no model, no stub, the same result every
 * time. What is under test is the lifecycle - who may run a request, under
 * whose name, how many times, and what happens to one nobody can run.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & { pageId: string };

async function makeTenant(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `dq-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Queue ${label}`, slug: `dq-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  const membership = await prisma.organizationMembership.create({
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
    data: {
      workspaceId: workspace.id,
      domain: host,
      normalizedDomain: host,
      primaryLanguage: "en",
      primaryMarket: "PH",
    },
  });

  const page = await prisma.page.create({
    data: {
      websiteId: website.id,
      url: `https://${host}/pricing`,
      normalizedUrl: `https://${host}/pricing`,
      path: "/pricing",
      hostname: host,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });

  return { user, membership, organization, workspace, website, pageId: page.id };
}

type Enqueued = { name: string; data: object; singletonKey?: string };

function fakeQueue(behaviour: "accept" | "refuse" = "accept"): Pick<Queue, "enqueue"> & {
  calls: Enqueued[];
} {
  const calls: Enqueued[] = [];
  return {
    calls,
    async enqueue(name, data, options) {
      if (behaviour === "refuse") {
        throw new Error("connect ECONNREFUSED (the queue is not there)");
      }
      calls.push({ name, data, singletonKey: options?.singletonKey });
      return `job-${calls.length}`;
    },
  };
}

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("the two halves of a request", () => {
  it("creates a request with its audit event, and executes it later from the row", async () => {
    const tenant = await makeTenant("halves");

    const request = await createDiagnosisRequest(tenant, { pageId: tenant.pageId });
    expect(request.status).toBe("REQUESTED");
    expect(request.requestedByUserId).toBe(tenant.user.id);

    const created = await prisma.auditEvent.findFirst({
      where: { entityType: "DiagnosisRequest", entityId: request.id, action: "CREATE" },
    });
    expect(created?.actorUserId).toBe(tenant.user.id);

    // Visible as open to the page until it runs.
    expect((await latestOpenRequestForPage(tenant, tenant.pageId))?.id).toBe(request.id);

    const outcome = await executeDiagnosisRequest(tenant, request.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.request.status).toBe("COMPLETED");
    expect(outcome.diagnosis.requestId).toBe(request.id);
    expect(outcome.diagnosis.createdByUserId).toBe(tenant.user.id);
    // No evidence, no model call - and no invented run to say otherwise.
    expect(outcome.diagnosis.aiRunId).toBeNull();

    expect(await latestOpenRequestForPage(tenant, tenant.pageId)).toBeNull();
  });

  it("refuses to execute a request that has finished, and one from another tenant", async () => {
    const tenant = await makeTenant("finished");
    const other = await makeTenant("other");

    const request = await createDiagnosisRequest(tenant, { pageId: tenant.pageId });

    await expect(executeDiagnosisRequest(other, request.id)).rejects.toMatchObject({
      name: "DiagnosisError",
      code: "not_found",
    });

    await prisma.diagnosisRequest.update({
      where: { id: request.id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });

    await expect(executeDiagnosisRequest(tenant, request.id)).rejects.toMatchObject({
      name: "DiagnosisError",
      code: "already_finished",
    });
  });
});

describe("submitting a diagnosis", () => {
  it("runs to completion here when the runner is inline", async () => {
    const tenant = await makeTenant("inline");

    const submitted = await submitPageDiagnosis(
      tenant,
      { pageId: tenant.pageId },
      { runner: "inline" },
    );

    expect(submitted.runner).toBe("inline");
    expect(submitted.outcome?.ok).toBe(true);
    expect(submitted.request.status).toBe("COMPLETED");
  });

  it("hands the request to the queue, keyed by request, when the runner is queue", async () => {
    const tenant = await makeTenant("queued");
    const queue = fakeQueue();

    const submitted = await submitPageDiagnosis(
      tenant,
      { pageId: tenant.pageId },
      { runner: "queue", queue },
    );

    expect(submitted.runner).toBe("queue");
    expect(submitted.outcome).toBeUndefined();
    expect(submitted.request.status).toBe("REQUESTED");

    expect(queue.calls).toEqual([
      {
        name: JOB_NAMES.DIAGNOSIS_RUN,
        data: { websiteId: tenant.website.id, requestId: submitted.request.id },
        singletonKey: submitted.request.id,
      },
    ]);

    // Nothing has been diagnosed yet: the row waits for the worker.
    const diagnoses = await prisma.diagnosis.count({ where: { requestId: submitted.request.id } });
    expect(diagnoses).toBe(0);
  });

  it("closes the request as failed, in our words, when the queue will not take it", async () => {
    const tenant = await makeTenant("refused");

    const submitted = await submitPageDiagnosis(
      tenant,
      { pageId: tenant.pageId },
      { runner: "queue", queue: fakeQueue("refuse") },
    );

    expect(submitted.request.status).toBe("FAILED");
    expect(submitted.request.errorCode).toBe("queue_unavailable");
    expect(submitted.request.errorSummary).not.toContain("ECONNREFUSED");
    expect(submitted.outcome?.ok).toBe(false);

    const closed = await prisma.auditEvent.findFirst({
      where: { entityType: "DiagnosisRequest", entityId: submitted.request.id, action: "COMPLETE" },
    });
    expect((closed?.afterSnapshotJson as { errorCode?: string })?.errorCode).toBe(
      "queue_unavailable",
    );

    // And it stays on the list, so the person who asked can see why.
    const listed = await listOpenDiagnosisRequests(tenant);
    expect(listed.map((row) => row.id)).toContain(submitted.request.id);
    expect(listed.find((row) => row.id === submitted.request.id)?.page?.path).toBe("/pricing");
  });
});

describe("the worker running a queued request", () => {
  it("runs it as the person who asked, exactly once", async () => {
    const tenant = await makeTenant("worker");
    const request = await createDiagnosisRequest(tenant, { pageId: tenant.pageId });

    const first = await runQueuedDiagnosis(request.id, { websiteId: tenant.website.id });
    expect(first.status).toBe("COMPLETED");
    expect(first.diagnosisId).toEqual(expect.any(String));

    const diagnosis = await prisma.diagnosis.findUniqueOrThrow({
      where: { id: first.diagnosisId! },
    });
    expect(diagnosis.createdByUserId).toBe(tenant.user.id);

    // Delivered twice - a retry, a duplicate - it does not diagnose twice.
    const second = await runQueuedDiagnosis(request.id, { websiteId: tenant.website.id });
    expect(second.status).toBe("skipped");
    expect(second.detail).toBe("already COMPLETED");
    expect(await prisma.diagnosis.count({ where: { requestId: request.id } })).toBe(1);
  });

  it("picks up a request a dead worker left mid-flight", async () => {
    const tenant = await makeTenant("stuck");
    const request = await createDiagnosisRequest(tenant, { pageId: tenant.pageId });

    await prisma.diagnosisRequest.update({
      where: { id: request.id },
      data: { status: "RUNNING", startedAt: new Date(Date.now() - 20 * 60 * 1000) },
    });

    const summary = await runQueuedDiagnosis(request.id);
    expect(summary.status).toBe("COMPLETED");
  });

  it("leaves alone a request that was cancelled while it waited, and one that does not exist", async () => {
    const tenant = await makeTenant("cancelled");
    const request = await createDiagnosisRequest(tenant, { pageId: tenant.pageId });

    await prisma.diagnosisRequest.update({
      where: { id: request.id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });

    expect((await runQueuedDiagnosis(request.id)).status).toBe("skipped");
    expect((await runQueuedDiagnosis(crypto.randomUUID())).status).toBe("skipped");
    expect(await prisma.diagnosis.count({ where: { requestId: request.id } })).toBe(0);
  });

  it("refuses a payload that points a request at another website", async () => {
    const tenant = await makeTenant("mismatch");
    const other = await makeTenant("elsewhere");
    const request = await createDiagnosisRequest(tenant, { pageId: tenant.pageId });

    const summary = await runQueuedDiagnosis(request.id, { websiteId: other.website.id });
    expect(summary).toMatchObject({ status: "skipped", detail: "payload website mismatch" });

    const untouched = await prisma.diagnosisRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(untouched.status).toBe("REQUESTED");
  });

  it("fails the request, on record, when the requester has lost access", async () => {
    const tenant = await makeTenant("revoked");
    const request = await createDiagnosisRequest(tenant, { pageId: tenant.pageId });

    await prisma.organizationMembership.update({
      where: { id: tenant.membership.id },
      data: { status: "REVOKED" },
    });

    const summary = await runQueuedDiagnosis(request.id);
    expect(summary.status).toBe("FAILED");
    expect(summary.detail).toBe("forbidden");

    const failed = await prisma.diagnosisRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(failed.errorCode).toBe("forbidden");
    expect(await prisma.diagnosis.count({ where: { requestId: request.id } })).toBe(0);

    // Closed by the system actor, since the requester could not be.
    const system = await getSystemUser();
    const closed = await prisma.auditEvent.findFirst({
      where: { entityType: "DiagnosisRequest", entityId: request.id, action: "COMPLETE" },
    });
    expect(closed?.actorUserId).toBe(system.id);
  });

  it("runs as the system actor when a request names nobody", async () => {
    const tenant = await makeTenant("nobody");
    const request = await createDiagnosisRequest(tenant, { pageId: tenant.pageId });
    await prisma.diagnosisRequest.update({
      where: { id: request.id },
      data: { requestedByUserId: null },
    });

    const summary = await runQueuedDiagnosis(request.id);
    expect(summary.status).toBe("COMPLETED");

    const system = await getSystemUser();
    const diagnosis = await prisma.diagnosis.findUniqueOrThrow({
      where: { id: summary.diagnosisId! },
    });
    expect(diagnosis.createdByUserId).toBe(system.id);
  });

  it("closes a request whose website was archived after it was made", async () => {
    const tenant = await makeTenant("archived");
    const request = await createDiagnosisRequest(tenant, { pageId: tenant.pageId });

    await prisma.website.update({
      where: { id: tenant.website.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    const summary = await runQueuedDiagnosis(request.id);
    expect(summary.status).toBe("FAILED");

    const failed = await prisma.diagnosisRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(failed.errorCode).toBe("website_inactive");
  });
});
