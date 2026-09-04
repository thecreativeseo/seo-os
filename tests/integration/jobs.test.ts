import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { runDailySync, runWebsiteSync, websiteSyncPayload } from "@/server/jobs/definitions";
import { createQueue, JOB_NAMES, type Queue } from "@/server/jobs/queue";
import {
  SYSTEM_AUTH_USER_ID,
  SYSTEM_MEMBERSHIP_ID,
  SystemContextError,
  getSystemUser,
  listSyncableWebsiteIds,
  systemContextFor,
} from "@/server/jobs/system-context";

/**
 * The worker's building blocks against the real database: the system actor,
 * the context a job runs under, the per-website sync with nothing connected,
 * the fan-out, and one real round trip through pg-boss in a throwaway schema.
 */

const organizationIds: string[] = [];

type Fixture = {
  organizationId: string;
  workspaceId: string;
  active: string;
  demo: string;
  archived: string;
};

async function makeFixture(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const organization = await prisma.organization.create({
    data: { name: `Jobs ${label}`, slug: `jobs-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });

  const site = (kind: string, extra: { isDemo?: boolean; status?: "ACTIVE" | "ARCHIVED" } = {}) => {
    const host = `${kind}-${label}-${suffix}.example.com`;
    return prisma.website.create({
      data: {
        workspaceId: workspace.id,
        domain: host,
        normalizedDomain: host,
        primaryLanguage: "en",
        primaryMarket: "PH",
        isDemo: extra.isDemo ?? false,
        status: extra.status ?? "ACTIVE",
      },
      select: { id: true },
    });
  };

  const [active, demo, archived] = await Promise.all([
    site("live"),
    site("demo", { isDemo: true }),
    site("old", { status: "ARCHIVED" }),
  ]);

  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    active: active.id,
    demo: demo.id,
    archived: archived.id,
  };
}

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  // The system user is deliberately left in place: it is one row, shared by
  // every job, and deleting it would orphan any audit event a job has written.
  await prisma.$disconnect();
});

describe("the system actor", () => {
  it("is one user, created once, that no sign-in can resolve to", async () => {
    const first = await getSystemUser();
    const second = await getSystemUser();

    expect(second.id).toBe(first.id);
    expect(first.authUserId).toBe(SYSTEM_AUTH_USER_ID);
    // A fixed nil-ish UUID: version-4 shaped, never issued by Supabase Auth.
    expect(SYSTEM_AUTH_USER_ID).toMatch(/^00000000-0000-4000-8000-/);

    const rows = await prisma.user.count({ where: { authUserId: SYSTEM_AUTH_USER_ID } });
    expect(rows).toBe(1);
  });
});

describe("the context a job runs under", () => {
  it("carries an ADMIN membership that exists only in memory", async () => {
    const fixture = await makeFixture("ctx");

    const context = await systemContextFor(fixture.active);

    expect(context.website.id).toBe(fixture.active);
    expect(context.workspace.id).toBe(fixture.workspaceId);
    expect(context.organization.id).toBe(fixture.organizationId);
    expect(context.membership.role).toBe("ADMIN");
    expect(context.membership.status).toBe("ACTIVE");
    expect(context.membership.id).toBe(SYSTEM_MEMBERSHIP_ID);
    expect(context.user.authUserId).toBe(SYSTEM_AUTH_USER_ID);

    // Nothing was written: the system user is not a member anyone can list,
    // edit, or remove.
    const persisted = await prisma.organizationMembership.count({
      where: { organizationId: fixture.organizationId, userId: context.user.id },
    });
    expect(persisted).toBe(0);
  });

  it("refuses an archived website and an unknown one, with different reasons", async () => {
    const fixture = await makeFixture("refuse");

    await expect(systemContextFor(fixture.archived)).rejects.toMatchObject({
      name: "SystemContextError",
      code: "inactive",
    });

    await expect(systemContextFor(crypto.randomUUID())).rejects.toMatchObject({
      name: "SystemContextError",
      code: "not_found",
    });

    await expect(systemContextFor(fixture.archived)).rejects.toBeInstanceOf(SystemContextError);
  });
});

describe("which websites the daily sync covers", () => {
  it("includes the active one and leaves demo and archived websites alone", async () => {
    const fixture = await makeFixture("cover");

    const ids = await listSyncableWebsiteIds();

    expect(ids).toContain(fixture.active);
    expect(ids).not.toContain(fixture.demo);
    expect(ids).not.toContain(fixture.archived);
  });

  it("enqueues one website.sync per website, keyed so a waiting site is not queued twice", async () => {
    const fixture = await makeFixture("fanout");

    const calls: Array<{
      name: string;
      data: object;
      options?: { singletonKey?: string; startAfterSeconds?: number };
    }> = [];
    const fake: Pick<Queue, "enqueue"> = {
      async enqueue(name, data, options) {
        calls.push({ name, data, options });
        return `job-${calls.length}`;
      },
    };

    const summary = await runDailySync(fake, { staggerSeconds: 1 });

    const mine = calls.filter(
      (call) => (call.data as { websiteId: string }).websiteId === fixture.active,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.name).toBe(JOB_NAMES.WEBSITE_SYNC);
    expect(mine[0]!.options?.singletonKey).toBe(fixture.active);
    expect(websiteSyncPayload.safeParse(mine[0]!.data).success).toBe(true);

    expect(
      calls.some((call) => (call.data as { websiteId: string }).websiteId === fixture.demo),
    ).toBe(false);
    expect(
      calls.some((call) => (call.data as { websiteId: string }).websiteId === fixture.archived),
    ).toBe(false);

    expect(summary.websites).toBe(calls.length);
    expect(summary.enqueued).toBe(calls.length);

    // Staggered: the nth job waits n seconds, so a fleet does not hit Google at once.
    const delays = calls.map((call) => call.options?.startAfterSeconds ?? 0);
    expect(delays).toEqual(delays.map((_, index) => index));
  });
});

describe("syncing one website", () => {
  it("skips every provider that is not connected and still runs detection", async () => {
    const fixture = await makeFixture("sync");

    const summary = await runWebsiteSync(fixture.active);

    const byStep = Object.fromEntries(summary.steps.map((row) => [row.step, row]));

    for (const step of ["gsc", "ga4", "semrush", "ahrefs"]) {
      expect(byStep[step]).toMatchObject({ status: "skipped", detail: "not connected" });
    }
    expect(byStep["sitemaps"]).toMatchObject({ status: "skipped", detail: "none registered" });
    // No metrics have ever been written, so there is nothing for signals to read.
    expect(byStep["signals"]).toMatchObject({ status: "skipped", detail: "no metrics yet" });
    // Opportunities read keywords and pages, of which there are none: a clean zero.
    expect(byStep["opportunities"]?.status).toBe("done");

    expect(summary.wroteMetrics).toBe(false);
    expect(summary.websiteId).toBe(fixture.active);
    expect(Date.parse(summary.finishedAt)).toBeGreaterThanOrEqual(Date.parse(summary.startedAt));
  });

  it("completes, rather than fails, for a website that is no longer active", async () => {
    const fixture = await makeFixture("gone");

    const summary = await runWebsiteSync(fixture.archived);

    expect(summary.steps).toEqual([
      { step: "context", status: "skipped", detail: "context:inactive" },
    ]);
    expect(summary.wroteMetrics).toBe(false);
  });
});

describe("the queue itself", () => {
  // pg-boss keeps its tables in its own schema; the test uses a throwaway one
  // so it can drop everything it created and never touch the real queue.
  const schema = "pgboss_test";
  let queue: Queue;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    queue = createQueue({ role: "worker", schema });
    await queue.start();
  }, 90_000);

  afterAll(async () => {
    await queue.stop({ graceful: false, timeoutMs: 5_000 });
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }, 60_000);

  it("delivers a job to its handler exactly once, and refuses a duplicate while one is waiting", async () => {
    const websiteId = crypto.randomUUID();
    const seen: string[] = [];

    // Both sends happen before a worker exists, so the second one can only be
    // refused for the right reason: the first is still waiting.
    const first = await queue.enqueue(
      JOB_NAMES.WEBSITE_SYNC,
      { websiteId },
      { singletonKey: websiteId },
    );
    const second = await queue.enqueue(
      JOB_NAMES.WEBSITE_SYNC,
      { websiteId },
      { singletonKey: websiteId },
    );

    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();

    await queue.work<{ websiteId: string }>(JOB_NAMES.WEBSITE_SYNC, async (job) => {
      seen.push(job.data.websiteId);
    });

    const deadline = Date.now() + 30_000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(seen).toEqual([websiteId]);

    // Once the first has run, the key is free again.
    const third = await queue.enqueue(
      JOB_NAMES.WEBSITE_SYNC,
      { websiteId },
      { singletonKey: websiteId },
    );
    expect(third).toEqual(expect.any(String));
  }, 60_000);

  it("installs and removes the daily schedule without complaint", async () => {
    await queue.schedule(JOB_NAMES.SYNC_DAILY, "0 3 * * *", {});
    await queue.schedule(JOB_NAMES.SYNC_DAILY, "30 3 * * *", {});
    await queue.unschedule(JOB_NAMES.SYNC_DAILY);
  }, 30_000);
});
