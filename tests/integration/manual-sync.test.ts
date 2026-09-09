import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import type { Ga4Result } from "@/server/connectors/google/analytics";
import {
  SearchConsoleError,
  type SearchAnalyticsResult,
} from "@/server/connectors/google/search-console";
import {
  RetryableJobError,
  connectionSyncPayload,
  runConnectionSync,
  type ConnectionSyncPayload,
} from "@/server/jobs/definitions";
import { JOB_NAMES, manualSyncKey } from "@/server/jobs/names";
import { createQueue, type Queue } from "@/server/jobs/queue";
import { hasLiveSyncJob, pendingManualSyncJob, type PendingJob } from "@/server/jobs/status";
import { getDataHealth } from "@/server/services/data-health";
import {
  idempotencyKeyFor,
  resolveSyncWindow,
  runGscSync,
  SyncError,
} from "@/server/services/sync";
import { requestManualSync } from "@/server/services/sync-request";
import { registerOrganizations } from "../helpers/teardown";

/**
 * "Sync now" as a durable job (docs/P1_SPEC.md section 23).
 *
 * The production failure this guards against: a provider pull run inside the
 * web request, cut off by a restart between committing its rows and finalising
 * its run. Three things are pinned here. The request only enqueues — no
 * provider, no run. The worker does the pull and closes the run, advancing
 * freshness only when it completes. And the two never disagree about whether a
 * sync is already on its way.
 *
 * No network: the Google connectors are injected. The queue is real pg-boss in
 * a throwaway schema for the round trip and the liveness rule; everywhere else
 * a fake queue records what would have been sent.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const NOW = new Date("2026-09-02T09:00:00Z");
const TOKEN = async () => "test-access-token";
const GSC = "GOOGLE_SEARCH_CONSOLE" as const;
const GA4 = "GOOGLE_ANALYTICS" as const;

type Role = "OWNER" | "ADMIN" | "SEO_LEAD" | "MEMBER" | "VIEWER";

async function makeTenant(label: string, role: Role = "OWNER"): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `msync-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Manual sync ${label}`, slug: `msync-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);
  registerOrganizations([organization.id]);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role,
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

async function connect(
  context: TenantContext,
  provider: typeof GSC | typeof GA4,
  options: { property?: boolean } = {},
) {
  const withProperty = options.property ?? true;

  return prisma.connection.create({
    data: {
      websiteId: context.website.id,
      workspaceId: context.workspace.id,
      provider,
      status: withProperty ? "CONNECTED" : "CONNECTING",
      externalPropertyId: withProperty
        ? provider === GSC
          ? `sc-domain:${context.website.normalizedDomain}`
          : "properties/123456"
        : null,
      externalPropertyName: withProperty ? "Test property" : null,
    },
  });
}

function gscPayload(
  host: string,
  rows: { date: string; path: string; query: string; clicks: number; impressions: number }[],
): SearchAnalyticsResult {
  return {
    rows: rows.map((row) => ({
      date: row.date,
      page: `https://${host}${row.path}`,
      query: row.query,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.impressions === 0 ? 0 : row.clicks / row.impressions,
      position: 4.5,
    })),
    truncated: false,
  };
}

function ga4Payload(
  rows: { date: string; landingPage: string; metrics: Record<string, number> }[],
): Ga4Result {
  return {
    rows,
    availableMetrics: ["sessions", "engagedSessions", "totalUsers", "newUsers", "keyEvents"],
    truncated: false,
  };
}

/** A queue that records what it was asked to send and answers with an id. */
function recordingQueue(answer: () => Promise<string | null> = async () => crypto.randomUUID()) {
  const sent: { name: string; data: unknown; singletonKey?: string }[] = [];
  const queue: Pick<Queue, "enqueue"> = {
    enqueue: async (name, data, options) => {
      sent.push({ name, data, singletonKey: options?.singletonKey });
      return answer();
    },
  };
  return { sent, queue };
}

const noJob = async (): Promise<PendingJob | null> => null;
const noDetect = async () => undefined;

async function runningRun(
  context: TenantContext,
  connectionId: string,
  provider: typeof GSC | typeof GA4,
  startedAt: Date,
  now: Date = NOW,
) {
  const window = resolveSyncWindow({ latestDataDate: null }, { now, days: 7 });
  const syncType = provider === GSC ? "GSC_METRICS" : "GA4_METRICS";

  return prisma.syncRun.create({
    data: {
      websiteId: context.website.id,
      connectionId,
      provider,
      syncType,
      status: "RUNNING",
      startedAt,
      idempotencyKey: idempotencyKeyFor(syncType, window),
      periodStart: new Date(`${window.startDate}T00:00:00.000Z`),
      periodEnd: new Date(`${window.endDate}T00:00:00.000Z`),
    },
  });
}

async function caught<T extends Error>(promise: Promise<unknown>, kind: new (...a: never[]) => T) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof kind) return error;
    throw error;
  }
  throw new Error(`expected a ${kind.name}`);
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

describe("asking for a sync: the web request", () => {
  it("enqueues a durable job and touches neither a provider nor a run", async () => {
    const context = await makeTenant("enqueue");
    await connect(context, GSC);
    const { sent, queue } = recordingQueue();

    const result = await requestManualSync(context, GSC, { queue, pendingJob: noJob, now: NOW });

    expect(result.status).toBe("queued");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: JOB_NAMES.CONNECTION_SYNC,
      singletonKey: manualSyncKey(context.website.id, GSC),
    });
    expect(sent[0]!.data).toMatchObject({
      websiteId: context.website.id,
      provider: GSC,
      requestedByUserId: context.user.id,
    });
    expect(connectionSyncPayload.safeParse(sent[0]!.data).success).toBe(true);

    // The request made no run: the worker claims one when it starts.
    expect(await prisma.syncRun.count({ where: { websiteId: context.website.id } })).toBe(0);
  });

  it("refuses a role below MEMBER before the queue is involved", async () => {
    const context = await makeTenant("viewer", "VIEWER");
    await connect(context, GSC);
    const { sent, queue } = recordingQueue();

    const error = await caught(
      requestManualSync(context, GSC, { queue, pendingJob: noJob }),
      SyncError,
    );
    expect(error.code).toBe("forbidden");
    expect(sent).toHaveLength(0);
  });

  it("makes the run's own refusals now, while there is a person to read them", async () => {
    const context = await makeTenant("refuse");
    const { sent, queue } = recordingQueue();

    const missing = await caught(
      requestManualSync(context, GSC, { queue, pendingJob: noJob }),
      SyncError,
    );
    expect(missing.code).toBe("not_connected");

    await connect(context, GA4, { property: false });
    const noProperty = await caught(
      requestManualSync(context, GA4, { queue, pendingJob: noJob }),
      SyncError,
    );
    expect(noProperty.code).toBe("no_property");

    expect(sent).toHaveLength(0);
  });

  it("reports a run already in flight rather than queueing a second", async () => {
    const context = await makeTenant("inflight");
    const connection = await connect(context, GSC);
    await runningRun(context, connection.id, GSC, new Date(NOW.getTime() - 60_000));
    const { sent, queue } = recordingQueue();

    const result = await requestManualSync(context, GSC, { queue, pendingJob: noJob, now: NOW });

    expect(result.status).toBe("already_running");
    expect(sent).toHaveLength(0);
  });

  it("collapses repeated clicks onto the job already waiting or running", async () => {
    const context = await makeTenant("repeat");
    await connect(context, GSC);
    const { sent, queue } = recordingQueue();
    const queuedAt = new Date(NOW.getTime() - 5_000);

    const waiting = await requestManualSync(context, GSC, {
      queue,
      now: NOW,
      pendingJob: async () => ({
        id: "j1",
        state: "created",
        createdOn: queuedAt,
        startedOn: null,
        heartbeatOn: null,
        startAfter: null,
      }),
    });
    expect(waiting.status).toBe("already_queued");

    const active = await requestManualSync(context, GSC, {
      queue,
      now: NOW,
      pendingJob: async () => ({
        id: "j1",
        state: "active",
        createdOn: queuedAt,
        startedOn: NOW,
        heartbeatOn: NOW,
        startAfter: null,
      }),
    });
    expect(active.status).toBe("already_running");

    expect(sent).toHaveLength(0);
  });

  it("treats the queue's own dedupe of a racing click as already queued", async () => {
    const context = await makeTenant("race");
    await connect(context, GSC);
    const { sent, queue } = recordingQueue(async () => null);

    const result = await requestManualSync(context, GSC, { queue, pendingJob: noJob, now: NOW });

    expect(result.status).toBe("already_queued");
    expect(sent).toHaveLength(1);
  });

  it("says so when the queue cannot take the job, and creates nothing", async () => {
    const context = await makeTenant("noqueue");
    await connect(context, GSC);
    const queue: Pick<Queue, "enqueue"> = {
      enqueue: async () => {
        throw new Error("connect ECONNREFUSED postgres://user:secret@db/postgres");
      },
    };

    const result = await requestManualSync(context, GSC, { queue, pendingJob: noJob, now: NOW });

    expect(result.status).toBe("queue_unavailable");
    expect(await prisma.syncRun.count({ where: { websiteId: context.website.id } })).toBe(0);
  });
});

describe("doing the sync: the worker", () => {
  it("pulls, finalises the run and advances freshness, in the requester's name", async () => {
    const context = await makeTenant("worker");
    const connection = await connect(context, GSC);
    const host = context.website.normalizedDomain;
    let detected = 0;

    const summary = await runConnectionSync(
      { websiteId: context.website.id, provider: GSC, requestedByUserId: context.user.id },
      {
        now: NOW,
        gsc: {
          days: 7,
          accessTokenFor: TOKEN,
          source: async () =>
            gscPayload(host, [
              { date: "2026-08-30", path: "/a", query: "alpha", clicks: 5, impressions: 100 },
              { date: "2026-08-31", path: "/b", query: "beta", clicks: 2, impressions: 40 },
            ]),
        },
        detect: async () => {
          detected += 1;
        },
      },
    );

    expect(summary.status).toBe("done");
    expect(summary.actor).toBe("requester");
    expect(summary.written).toBe(2);
    expect(detected).toBe(1);

    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: summary.runId! } });
    expect(run.status).toBe("SUCCEEDED");
    expect(run.finishedAt).not.toBeNull();
    expect(run.recordsReceived).toBe(2);
    expect(run.recordsWritten).toBe(2);

    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.lastSyncedAt).not.toBeNull();
    expect(refreshed.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-31");
  });

  it("does the same for GA4", async () => {
    const context = await makeTenant("ga4");
    const connection = await connect(context, GA4);

    const summary = await runConnectionSync(
      { websiteId: context.website.id, provider: GA4, requestedByUserId: context.user.id },
      {
        now: NOW,
        ga4: {
          days: 7,
          accessTokenFor: TOKEN,
          source: async () =>
            ga4Payload([
              {
                date: "2026-08-30",
                landingPage: "/pricing",
                metrics: {
                  sessions: 12,
                  engagedSessions: 8,
                  totalUsers: 10,
                  newUsers: 3,
                  keyEvents: 1,
                },
              },
            ]),
        },
        detect: noDetect,
      },
    );

    expect(summary.status).toBe("done");
    expect(summary.written).toBe(1);

    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
    expect(
      await prisma.ga4LandingPageMetricDaily.count({ where: { websiteId: context.website.id } }),
    ).toBe(1);
  });

  it("runs as the system actor when the requester can no longer write", async () => {
    const context = await makeTenant("revoked");
    await connect(context, GSC);
    const host = context.website.normalizedDomain;
    await prisma.organizationMembership.delete({ where: { id: context.membership.id } });

    const summary = await runConnectionSync(
      { websiteId: context.website.id, provider: GSC, requestedByUserId: context.user.id },
      {
        now: NOW,
        gsc: {
          days: 7,
          accessTokenFor: TOKEN,
          source: async () =>
            gscPayload(host, [
              { date: "2026-08-30", path: "/a", query: "alpha", clicks: 1, impressions: 10 },
            ]),
        },
        detect: noDetect,
      },
    );

    expect(summary.status).toBe("done");
    expect(summary.actor).toBe("system");
  });

  it("skips, without retry, a website archived after the click", async () => {
    const context = await makeTenant("archived");
    await connect(context, GSC);
    await prisma.website.update({
      where: { id: context.website.id },
      data: { status: "ARCHIVED" },
    });

    const summary = await runConnectionSync(
      { websiteId: context.website.id, provider: GSC },
      { now: NOW, gsc: { accessTokenFor: TOKEN, source: async () => gscPayload("x", []) } },
    );

    expect(summary).toMatchObject({ status: "skipped", detail: "context:inactive" });
  });

  it("leaves a provider refusal FAILED with no freshness, and does not retry it", async () => {
    const context = await makeTenant("denied");
    const connection = await connect(context, GSC);

    const summary = await runConnectionSync(
      { websiteId: context.website.id, provider: GSC },
      {
        now: NOW,
        gsc: {
          days: 7,
          accessTokenFor: TOKEN,
          source: async () => {
            throw new SearchConsoleError("Bearer ya29.SECRET was rejected", "permission_denied");
          },
        },
      },
    );

    expect(summary.status).toBe("failed");
    expect(summary.detail).toBe("sync:permission_denied");

    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: summary.runId! } });
    expect(run.status).toBe("FAILED");
    expect(run.finishedAt).not.toBeNull();
    expect(run.errorSummary).not.toContain("ya29");

    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.lastSyncedAt).toBeNull();
    expect(refreshed.latestDataDate).toBeNull();
  });

  it("hands a busy provider back to the queue for a bounded retry", async () => {
    const context = await makeTenant("busy");
    const connection = await connect(context, GSC);

    const error = await caught(
      runConnectionSync(
        { websiteId: context.website.id, provider: GSC },
        {
          now: NOW,
          gsc: {
            days: 7,
            accessTokenFor: TOKEN,
            source: async () => {
              throw new SearchConsoleError("slow down", "rate_limited");
            },
          },
        },
      ),
      RetryableJobError,
    );
    expect(error.code).toBe("rate_limited");

    // The run itself is closed and honest; only the job is retried.
    const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } });
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("rate_limited");
  });

  it("retires a stale RUNNING run left by a dead process, then completes", async () => {
    const context = await makeTenant("orphan");
    const connection = await connect(context, GSC);
    const host = context.website.normalizedDomain;
    const orphan = await runningRun(
      context,
      connection.id,
      GSC,
      new Date(NOW.getTime() - 30 * 60_000),
    );

    const summary = await runConnectionSync(
      { websiteId: context.website.id, provider: GSC },
      {
        now: NOW,
        gsc: {
          days: 7,
          accessTokenFor: TOKEN,
          source: async () =>
            gscPayload(host, [
              { date: "2026-08-30", path: "/a", query: "alpha", clicks: 3, impressions: 30 },
            ]),
        },
        detect: noDetect,
      },
    );

    expect(summary.status).toBe("done");

    const recovered = await prisma.syncRun.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(recovered.status).toBe("FAILED");
    expect(recovered.errorCode).toBe("stale_run_recovered");
    expect(await prisma.syncRun.count({ where: { connectionId: connection.id } })).toBe(2);
  });

  it("leaves a genuinely active run alone and asks to be retried later", async () => {
    const context = await makeTenant("active");
    const connection = await connect(context, GSC);
    const active = await runningRun(context, connection.id, GSC, new Date(NOW.getTime() - 60_000));

    const error = await caught(
      runConnectionSync(
        { websiteId: context.website.id, provider: GSC },
        {
          now: NOW,
          gsc: { days: 7, accessTokenFor: TOKEN, source: async () => gscPayload("x", []) },
        },
      ),
      RetryableJobError,
    );
    expect(error.code).toBe("already_running");

    const still = await prisma.syncRun.findUniqueOrThrow({ where: { id: active.id } });
    expect(still.status).toBe("RUNNING");
  });

  it("a finalisation the database refuses fails the run; the retry yields one dataset", async () => {
    const context = await makeTenant("finalise");
    const connection = await connect(context, GSC);
    const host = context.website.normalizedDomain;
    const rows = [
      { date: "2026-08-30", path: "/a", query: "alpha", clicks: 5, impressions: 100 },
      { date: "2026-08-30", path: "/b", query: "beta", clicks: 1, impressions: 20 },
    ];
    const gsc = { days: 7, accessTokenFor: TOKEN, source: async () => gscPayload(host, rows) };

    // An actor the audit trail cannot name makes completeRun's transaction fail
    // after the metric rows were already committed - the shape of a database
    // fault at the worst moment.
    const broken = await caught(
      runConnectionSync(
        { websiteId: context.website.id, provider: GSC },
        {
          now: NOW,
          gsc,
          contextFor: async () => ({
            context: { ...context, user: { ...context.user, id: crypto.randomUUID() } },
            actor: "requester",
          }),
        },
      ),
      RetryableJobError,
    );
    expect(broken.code).toBe("unknown");

    const failed = await prisma.syncRun.findFirstOrThrow({
      where: { connectionId: connection.id },
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.finishedAt).not.toBeNull();

    // Rows are there; freshness is not. Partial data never looks fresh.
    expect(await prisma.gscMetricDaily.count({ where: { websiteId: context.website.id } })).toBe(2);
    const before = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(before.latestDataDate).toBeNull();

    // The retry reuses the failed run, rewrites the same rows, and completes.
    const retried = await runConnectionSync(
      { websiteId: context.website.id, provider: GSC },
      { now: NOW, gsc, detect: noDetect },
    );

    expect(retried.status).toBe("done");
    expect(retried.runId).toBe(failed.id);
    expect(await prisma.gscMetricDaily.count({ where: { websiteId: context.website.id } })).toBe(2);
    expect(await prisma.syncRun.count({ where: { connectionId: connection.id } })).toBe(1);

    const after = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
  });
});

describe("what Data Health says while a sync is on its way", () => {
  const job = (state: PendingJob["state"], createdOn: Date): PendingJob => ({
    id: "j",
    state,
    createdOn,
    startedOn: state === "active" ? new Date(createdOn.getTime() + 1_000) : null,
    heartbeatOn: null,
    startAfter: null,
  });

  it("shows a waiting job as queued, and as unattended once it has waited too long", async () => {
    const context = await makeTenant("queued");
    await connect(context, GSC);

    const fresh = await getDataHealth(context, NOW, {
      pendingJob: async () => job("created", new Date(NOW.getTime() - 10_000)),
    });
    expect(fresh.find((s) => s.provider === GSC)?.attempt).toMatchObject({
      state: "queued",
      unattended: false,
    });

    const forgotten = await getDataHealth(context, NOW, {
      pendingJob: async () => job("created", new Date(NOW.getTime() - 5 * 60_000)),
    });
    expect(forgotten.find((s) => s.provider === GSC)?.attempt).toMatchObject({
      state: "queued",
      unattended: true,
    });
  });

  it("shows a claimed job as starting until its run exists, then the run itself", async () => {
    const context = await makeTenant("starting");
    const connection = await connect(context, GSC);
    const claimed = async () => job("active", new Date(NOW.getTime() - 3_000));

    const starting = await getDataHealth(context, NOW, { pendingJob: claimed });
    expect(starting.find((s) => s.provider === GSC)?.attempt.state).toBe("starting");

    await runningRun(context, connection.id, GSC, new Date(NOW.getTime() - 1_000));
    const running = await getDataHealth(context, NOW, { pendingJob: claimed });
    expect(running.find((s) => s.provider === GSC)?.attempt.state).toBe("running");
  });

  it("lets a new job outrank the orphan it is about to retire", async () => {
    const context = await makeTenant("outrank");
    const connection = await connect(context, GSC);
    await runningRun(context, connection.id, GSC, new Date(NOW.getTime() - 30 * 60_000));

    const alone = await getDataHealth(context, NOW, { pendingJob: noJob });
    expect(alone.find((s) => s.provider === GSC)?.attempt.state).toBe("stale");

    const queued = await getDataHealth(context, NOW, {
      pendingJob: async () => job("created", new Date(NOW.getTime() - 2_000)),
    });
    expect(queued.find((s) => s.provider === GSC)?.attempt.state).toBe("queued");
  });
});

describe("the real queue: round trip and the liveness rule", () => {
  // Throwaway schema: dropped afterwards, never the real queue. Also set as the
  // schema the sync service reads, so its liveness check looks here too.
  const schema = "pgboss_manual_test";
  let queue: Queue;
  let previousSchema: string | undefined;

  const pendingHere = (websiteId: string, provider: string) =>
    pendingManualSyncJob(websiteId, provider, { schema });

  beforeAll(async () => {
    previousSchema = process.env.PGBOSS_SCHEMA;
    process.env.PGBOSS_SCHEMA = schema;
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    queue = createQueue({ role: "worker", schema, max: 2 });
    await queue.start();
  }, 90_000);

  afterAll(async () => {
    await queue.stop({ graceful: false, timeoutMs: 5_000 });
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (previousSchema === undefined) delete process.env.PGBOSS_SCHEMA;
    else process.env.PGBOSS_SCHEMA = previousSchema;
  }, 60_000);

  /** A job row as pg-boss would leave it mid-handler, without a worker to hold it. */
  async function plantActiveJob(
    key: string,
    ages: { startedMinutesAgo: number; heartbeatSecondsAgo: number },
  ): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ${schema}.job
         (name, data, state, singleton_key, started_on, heartbeat_on, heartbeat_seconds, policy)
       VALUES ($1, '{}'::jsonb, 'active', $2,
               now() - ($3 * interval '1 minute'), now() - ($4 * interval '1 second'), 60, 'stately')
       RETURNING id`,
      JOB_NAMES.CONNECTION_SYNC,
      key,
      ages.startedMinutesAgo,
      ages.heartbeatSecondsAgo,
    );
    return rows[0]!.id;
  }

  it("a job still heartbeating owns the run it claimed; a silent one does not", async () => {
    const websiteId = crypto.randomUUID();
    const runStartedAt = new Date(Date.now() - 30 * 60_000);

    const alive = await plantActiveJob(manualSyncKey(websiteId, GSC), {
      startedMinutesAgo: 40,
      heartbeatSecondsAgo: 5,
    });
    expect(await hasLiveSyncJob(websiteId, GSC, runStartedAt, { schema })).toBe(true);
    // Another connection's run is not covered by this job.
    expect(await hasLiveSyncJob(websiteId, GA4, runStartedAt, { schema })).toBe(false);
    await prisma.$executeRawUnsafe(`DELETE FROM ${schema}.job WHERE id = $1::uuid`, alive);

    const silent = await plantActiveJob(manualSyncKey(websiteId, GSC), {
      startedMinutesAgo: 40,
      heartbeatSecondsAgo: 10 * 60,
    });
    expect(await hasLiveSyncJob(websiteId, GSC, runStartedAt, { schema })).toBe(false);
    await prisma.$executeRawUnsafe(`DELETE FROM ${schema}.job WHERE id = $1::uuid`, silent);

    // A job claimed after the run began cannot be the one executing it.
    const later = await plantActiveJob(manualSyncKey(websiteId, GSC), {
      startedMinutesAgo: 1,
      heartbeatSecondsAgo: 5,
    });
    expect(await hasLiveSyncJob(websiteId, GSC, runStartedAt, { schema })).toBe(false);
    await prisma.$executeRawUnsafe(`DELETE FROM ${schema}.job WHERE id = $1::uuid`, later);
  }, 30_000);

  it("stale-run recovery spares a long run whose job is alive, and retires it once the job is gone", async () => {
    const context = await makeTenant("longrun");
    const connection = await connect(context, GSC);
    const host = context.website.normalizedDomain;
    const now = new Date();
    const runStartedAt = new Date(now.getTime() - 30 * 60_000);
    await runningRun(context, connection.id, GSC, runStartedAt, now);

    const owner = await plantActiveJob(manualSyncKey(context.website.id, GSC), {
      startedMinutesAgo: 31,
      heartbeatSecondsAgo: 5,
    });

    // Old enough to be stale by age alone, but owned: refused, not recovered.
    const refused = await caught(
      runGscSync(context, {
        now,
        days: 7,
        accessTokenFor: TOKEN,
        source: async () => gscPayload(host, []),
      }),
      SyncError,
    );
    expect(refused.code).toBe("already_running");
    expect(
      await prisma.syncRun.count({ where: { connectionId: connection.id, status: "RUNNING" } }),
    ).toBe(1);

    // The job goes away; the same run is now an orphan and is retired.
    await prisma.$executeRawUnsafe(`DELETE FROM ${schema}.job WHERE id = $1::uuid`, owner);

    const day = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    const outcome = await runGscSync(context, {
      now,
      days: 7,
      accessTokenFor: TOKEN,
      source: async () =>
        gscPayload(host, [{ date: day, path: "/a", query: "alpha", clicks: 1, impressions: 10 }]),
    });
    expect(outcome.status).toBe("SUCCEEDED");

    const recovered = await prisma.syncRun.findFirst({
      where: { connectionId: connection.id, errorCode: "stale_run_recovered" },
    });
    expect(recovered?.status).toBe("FAILED");
  }, 60_000);

  it("round trip: the request queues, the worker runs, and repeated clicks are one sync", async () => {
    const context = await makeTenant("roundtrip");
    const connection = await connect(context, GSC);
    const host = context.website.normalizedDomain;
    const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    let pulls = 0;

    await queue.work<ConnectionSyncPayload>(JOB_NAMES.CONNECTION_SYNC, async (job) => {
      const payload = connectionSyncPayload.parse(job.data);
      return runConnectionSync(payload, {
        gsc: {
          days: 7,
          accessTokenFor: TOKEN,
          source: async () => {
            pulls += 1;
            return gscPayload(host, [
              { date: day, path: "/a", query: "alpha", clicks: 4, impressions: 40 },
            ]);
          },
        },
        detect: noDetect,
      });
    });

    const first = await requestManualSync(context, GSC, { queue, pendingJob: pendingHere });
    expect(first.status).toBe("queued");

    // Pressed again straight away: whichever state the job is in by now, the
    // answer is that one sync is already on its way.
    const second = await requestManualSync(context, GSC, { queue, pendingJob: pendingHere });
    expect(["already_queued", "already_running"]).toContain(second.status);

    const deadline = Date.now() + 40_000;
    let run = await prisma.syncRun.findFirst({ where: { connectionId: connection.id } });
    while ((!run || run.status === "RUNNING") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      run = await prisma.syncRun.findFirst({ where: { connectionId: connection.id } });
    }

    expect(run?.status).toBe("SUCCEEDED");
    expect(pulls).toBe(1);

    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.latestDataDate?.toISOString().slice(0, 10)).toBe(day);

    // Done: nothing is pending for this connection any more, and nothing is live.
    // The run reaches SUCCEEDED inside the handler, so the job is still active
    // for the moment it takes pg-boss to record its own completion. Waited for
    // rather than asserted instantly, which was a race.
    const settled = Date.now() + 15_000;
    let pending = await pendingHere(context.website.id, GSC);
    while (pending !== null && Date.now() < settled) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pending = await pendingHere(context.website.id, GSC);
    }

    expect(pending).toBeNull();
    expect(await hasLiveSyncJob(context.website.id, GSC, new Date(), { schema })).toBe(false);
  }, 60_000);
});

/**
 * The line an operator gets when a sync fails inside the database (P1 sync
 * observability).
 *
 * The retry event used to say `code: "unknown"` and nothing else, which is how
 * a production failure went undiagnosed. It now names the attempt, the class,
 * the Prisma code, the SQLSTATE and the stage — and still never the message,
 * because the message is where the SQL and the parameters live.
 */
describe("what a retry logs about its failure", () => {
  function capture(): { lines: Record<string, unknown>[]; restore: () => void } {
    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (typeof first !== "string") return;
      try {
        lines.push(JSON.parse(first) as Record<string, unknown>);
      } catch {
        // Not one of ours.
      }
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  const retryEvents = (lines: Record<string, unknown>[]) =>
    lines.filter((line) => line.at === JOB_NAMES.CONNECTION_SYNC && line.event === "retry");

  it("names a database refusal by class, code and stage, as attempt N of M", async () => {
    const context = await makeTenant("fingerprint");
    const connection = await connect(context, GSC);
    const host = context.website.normalizedDomain;
    const rows = [{ date: "2026-08-30", path: "/a", query: "alpha", clicks: 5, impressions: 100 }];

    const { lines, restore } = capture();
    try {
      // The same fault as the finalisation test above: an actor the audit
      // trail cannot name makes completeRun's transaction fail with a real
      // foreign-key error from Postgres.
      await caught(
        runConnectionSync(
          { websiteId: context.website.id, provider: GSC },
          {
            now: NOW,
            job: { id: "job-1", attempt: 1, retryLimit: 2 },
            gsc: { days: 7, accessTokenFor: TOKEN, source: async () => gscPayload(host, rows) },
            contextFor: async () => ({
              context: { ...context, user: { ...context.user, id: crypto.randomUUID() } },
              actor: "requester",
            }),
          },
        ),
        RetryableJobError,
      );
    } finally {
      restore();
    }

    const [event] = retryEvents(lines);
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      websiteId: context.website.id,
      provider: GSC,
      jobId: "job-1",
      attempt: 2,
      maxAttempts: 3,
      code: "unknown",
      errorName: "PrismaClientKnownRequestError",
      prismaCode: "P2003",
      stage: "sync_run_finalize",
    });

    const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } });
    expect(event!.runId).toBe(run.id);
    // The row keeps its sentence; the fingerprint travels in the log.
    expect(run.errorCode).toBe("unknown");
    expect(run.errorSummary).toBe("The sync did not complete.");
  });

  it("names a provider failure by its stage too", async () => {
    const context = await makeTenant("fingerprint-provider");
    await connect(context, GSC);

    const { lines, restore } = capture();
    try {
      await caught(
        runConnectionSync(
          { websiteId: context.website.id, provider: GSC },
          {
            now: NOW,
            gsc: {
              days: 7,
              accessTokenFor: TOKEN,
              source: async () => {
                throw new SearchConsoleError("slow down", "rate_limited");
              },
            },
          },
        ),
        RetryableJobError,
      );
    } finally {
      restore();
    }

    const [event] = retryEvents(lines);
    expect(event).toMatchObject({
      code: "rate_limited",
      errorName: "SearchConsoleError",
      prismaCode: null,
      sqlState: null,
      stage: "provider_fetch",
      // No job was supplied, so nothing is invented about the attempt.
      jobId: null,
      attempt: null,
      maxAttempts: null,
    });
  });

  it("never lets a message, a stack, SQL or a parameter into the log", async () => {
    const context = await makeTenant("fingerprint-redact");
    await connect(context, GSC);
    const host = context.website.normalizedDomain;
    const rows = [{ date: "2026-08-30", path: "/a", query: "alpha", clicks: 5, impressions: 100 }];

    const { lines, restore } = capture();
    try {
      await caught(
        runConnectionSync(
          { websiteId: context.website.id, provider: GSC },
          {
            now: NOW,
            gsc: { days: 7, accessTokenFor: TOKEN, source: async () => gscPayload(host, rows) },
            contextFor: async () => ({
              context: { ...context, user: { ...context.user, id: crypto.randomUUID() } },
              actor: "requester",
            }),
          },
        ),
        RetryableJobError,
      );
    } finally {
      restore();
    }

    const serialized = JSON.stringify(retryEvents(lines));
    expect(serialized.length).toBeGreaterThan(0);
    for (const forbidden of [
      "message",
      "stack",
      "Foreign key",
      "constraint",
      "INSERT",
      "SELECT",
      "audit_event",
      "at runConnectionSync",
      host,
      "alpha",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("writes the fingerprint to the audit trail when the actor can be named", async () => {
    const context = await makeTenant("fingerprint-audit");
    const connection = await connect(context, GSC);

    await caught(
      runConnectionSync(
        { websiteId: context.website.id, provider: GSC },
        {
          now: NOW,
          gsc: {
            days: 7,
            accessTokenFor: TOKEN,
            source: async () => {
              throw new SearchConsoleError("slow down", "rate_limited");
            },
          },
        },
      ),
      RetryableJobError,
    );

    const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } });
    const event = await prisma.auditEvent.findFirst({
      where: { entityType: "SyncRun", entityId: run.id, action: "UPDATE" },
    });

    expect(event).not.toBeNull();
    expect(event!.websiteId).toBe(context.website.id);
    expect(event!.afterSnapshotJson).toMatchObject({
      status: "FAILED",
      errorCode: "rate_limited",
      failure: { name: "SearchConsoleError", stage: "provider_fetch" },
    });
    expect(JSON.stringify(event!.afterSnapshotJson)).not.toContain("slow down");
  });
});
