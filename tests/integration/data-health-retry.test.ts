import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import type { PendingJob } from "@/server/jobs/status";
import { QUEUE_PATIENCE_MS, getDataHealth, listSyncRunPage } from "@/server/services/data-health";
import { registerOrganizations } from "../helpers/teardown";

/**
 * A retry the queue is holding back (P1 sync observability).
 *
 * After a Search Console attempt failed inside the database, pg-boss did what
 * it should and scheduled another attempt twenty minutes later. Data Health
 * then said "Queued since 01:27 · not picked up yet — is the worker running?",
 * because it measured patience from the moment the job was created and had no
 * idea the job was not yet allowed to run. The worker was fine. The page was
 * blaming it for a delay the queue had chosen.
 *
 * So a job with a start time still in the future is a scheduled retry, said
 * as such, and the unattended warning is reserved for a job that could run now
 * and has not been picked up.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const NOW = new Date("2026-09-10T01:35:00Z");
const GSC = "GOOGLE_SEARCH_CONSOLE";

let tenant: TenantContext;
let other: TenantContext;
let connectionId: string;

beforeAll(async () => {
  tenant = await makeTenant("retry");
  other = await makeTenant("bystander");
  connectionId = (await connect(tenant)).id;

  // The attempt that failed, exactly as production recorded it.
  await prisma.syncRun.create({
    data: {
      websiteId: tenant.website.id,
      connectionId,
      provider: GSC,
      syncType: "GSC_METRICS",
      status: "FAILED",
      startedAt: new Date("2026-09-10T01:27:32Z"),
      finishedAt: new Date("2026-09-10T01:30:00Z"),
      errorCode: "unknown",
      errorSummary: "The sync did not complete.",
      idempotencyKey: "GSC_METRICS:2026-06-09:2026-09-06",
    },
  });
}, 120_000);

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
}, 60_000);

async function makeTenant(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `dhr-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Retry ${label}`, slug: `dhr-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);
  registerOrganizations([organization.id]);

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
    data: { workspaceId: workspace.id, domain: host, normalizedDomain: host },
  });

  return { user, membership, organization, workspace, website };
}

async function connect(context: TenantContext) {
  return prisma.connection.create({
    data: {
      websiteId: context.website.id,
      workspaceId: context.workspace.id,
      provider: GSC,
      status: "CONNECTED",
      externalPropertyId: `sc-domain:${context.website.normalizedDomain}`,
      externalPropertyName: "Test property",
    },
  });
}

/** A job row as the queue table would show it. */
function job(overrides: Partial<PendingJob> & { state: PendingJob["state"] }): PendingJob {
  return {
    id: "d9aaa737",
    createdOn: new Date("2026-09-10T01:27:30Z"),
    startedOn: null,
    heartbeatOn: null,
    startAfter: null,
    ...overrides,
  };
}

const gscOf = (health: Awaited<ReturnType<typeof getDataHealth>>) =>
  health.find((source) => source.provider === GSC)!;

describe("a retry the queue is holding back", () => {
  it("is a scheduled retry, not an unattended queue", async () => {
    const retryAt = new Date("2026-09-10T01:49:04Z");
    const health = await getDataHealth(tenant, NOW, {
      pendingJob: async () => job({ state: "retry", startAfter: retryAt }),
    });

    const attempt = gscOf(health).attempt;
    expect(attempt.state).toBe("retrying");
    expect(attempt.retryAt).toEqual(retryAt);
    // Eight minutes since creation is well past the patience threshold, and
    // still nobody has failed to pick this up: it is not allowed to run yet.
    expect(NOW.getTime() - attempt.queuedAt!.getTime()).toBeGreaterThan(QUEUE_PATIENCE_MS);
    expect(attempt.unattended).toBe(false);
  });

  it("becomes an ordinary queued job once its start time has passed", async () => {
    const health = await getDataHealth(tenant, NOW, {
      pendingJob: async () => job({ state: "retry", startAfter: new Date(NOW.getTime() - 30_000) }),
    });

    const attempt = gscOf(health).attempt;
    expect(attempt.state).toBe("queued");
    // Eligible for thirty seconds: within patience, so no accusation yet.
    expect(attempt.unattended).toBe(false);
  });

  it("still calls out a job that could run and has sat there too long", async () => {
    // Eligible five minutes ago and never claimed. That really is a worker
    // that is not running, and the warning is the right one.
    const health = await getDataHealth(tenant, NOW, {
      pendingJob: async () =>
        job({ state: "retry", startAfter: new Date(NOW.getTime() - 5 * 60_000) }),
    });

    const attempt = gscOf(health).attempt;
    expect(attempt.state).toBe("queued");
    expect(attempt.unattended).toBe(true);
  });

  it("measures patience from eligibility, never from creation", async () => {
    // Created long ago, eligible just now. Patience starts now.
    const health = await getDataHealth(tenant, NOW, {
      pendingJob: async () =>
        job({
          state: "retry",
          createdOn: new Date(NOW.getTime() - 60 * 60_000),
          startAfter: new Date(NOW.getTime() - 10_000),
        }),
    });

    expect(gscOf(health).attempt.unattended).toBe(false);
  });

  it("treats a plain job with no start time exactly as before", async () => {
    const fresh = await getDataHealth(tenant, NOW, {
      pendingJob: async () =>
        job({ state: "created", createdOn: new Date(NOW.getTime() - 10_000) }),
    });
    expect(gscOf(fresh).attempt).toMatchObject({ state: "queued", unattended: false });

    const forgotten = await getDataHealth(tenant, NOW, {
      pendingJob: async () =>
        job({ state: "created", createdOn: new Date(NOW.getTime() - 5 * 60_000) }),
    });
    expect(gscOf(forgotten).attempt).toMatchObject({ state: "queued", unattended: true });
  });
});

describe("what the retry does not change", () => {
  it("leaves the failed attempt FAILED in the run history", async () => {
    const health = await getDataHealth(tenant, NOW, {
      pendingJob: async () => job({ state: "retry", startAfter: new Date("2026-09-10T01:49:04Z") }),
    });
    expect(gscOf(health).attempt.state).toBe("retrying");

    // The source says a retry is coming. The history says what happened. Both
    // are true and neither rewrites the other.
    const page = await listSyncRunPage(tenant, "1");
    expect(page.runs[0]).toMatchObject({
      status: "FAILED",
      errorCode: "unknown",
      errorSummary: "The sync did not complete.",
    });
  });

  it("advances no freshness for a scheduled retry", async () => {
    await getDataHealth(tenant, NOW, {
      pendingJob: async () => job({ state: "retry", startAfter: new Date("2026-09-10T01:49:04Z") }),
    });

    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(connection.lastSyncedAt).toBeNull();
    expect(connection.latestDataDate).toBeNull();
  });

  it("is invisible to another tenant", async () => {
    const theirs = await getDataHealth(other, NOW, {
      pendingJob: async () => job({ state: "retry", startAfter: new Date("2026-09-10T01:49:04Z") }),
    });

    // The other tenant has no connection, so there is no source to attach a
    // retry to, and no run of ours to be seen.
    expect(theirs.filter((source) => source.status !== "NOT_CONNECTED")).toEqual([]);
    expect((await listSyncRunPage(other, "1")).total).toBe(0);
  });
});
