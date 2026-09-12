import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { Ga4Result } from "@/server/connectors/google/analytics";
import {
  SearchConsoleError,
  type SearchAnalyticsResult,
} from "@/server/connectors/google/search-console";
import { runWebsiteSync, type WebsiteSyncOptions } from "@/server/jobs/definitions";
import { createQueue, JOB_NAMES, type Queue } from "@/server/jobs/queue";
import { registerOrganizations } from "../helpers/teardown";

/**
 * What happens after the pull, on the scheduled sync (P1 scheduled sync
 * post-processing).
 *
 * The daily job runs each connected provider, then signal detection over what
 * is now stored. Its attempt() records an expected failure and rethrows an
 * unexpected one — right for a provider step, where the sync service has
 * already recorded the run and there is nothing left for the queue to know,
 * but wrong for detection: an unexpected error there left the handler, pg-boss
 * retried the whole job, and every provider that had just finished was pulled
 * again for a fault it had no part in. The scheduled twin of the "Sync now"
 * defect.
 *
 * Detection now reports instead of throwing, on this path as on the manual
 * one. Provider and database failures inside ingestion are recorded on their
 * run exactly as before; a detection failure after them is logged, noted in
 * the audit trail against each run it followed, and reported as a failed step.
 *
 * No network: the Google connectors are injected.
 */

const organizationIds: string[] = [];

const NOW = new Date("2026-09-02T09:00:00Z");
const TOKEN = async () => "test-access-token";
const GSC = "GOOGLE_SEARCH_CONSOLE" as const;
const GA4 = "GOOGLE_ANALYTICS" as const;

type Site = { websiteId: string; host: string };

async function makeSite(label: string): Promise<Site> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const organization = await prisma.organization.create({
    data: { name: `Website sync ${label}`, slug: `wsync-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);
  registerOrganizations([organization.id]);

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

  return { websiteId: website.id, host };
}

async function connect(site: Site, provider: typeof GSC | typeof GA4) {
  const website = await prisma.website.findUniqueOrThrow({ where: { id: site.websiteId } });
  return prisma.connection.create({
    data: {
      websiteId: site.websiteId,
      workspaceId: website.workspaceId,
      provider,
      status: "CONNECTED",
      externalPropertyId: provider === GSC ? `sc-domain:${site.host}` : "properties/123456",
      externalPropertyName: "Test property",
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

const ROWS = [
  { date: "2026-08-30", path: "/a", query: "alpha", clicks: 5, impressions: 100 },
  { date: "2026-08-30", path: "/b", query: "beta", clicks: 1, impressions: 20 },
];

/** A Search Console fake that counts its pulls. */
function gscFake(host: string, rows = ROWS) {
  const counter = { pulls: 0 };
  const gsc: WebsiteSyncOptions["gsc"] = {
    days: 7,
    accessTokenFor: TOKEN,
    source: async () => {
      counter.pulls += 1;
      return gscPayload(host, rows);
    },
  };
  return { gsc, counter };
}

function ga4Fake() {
  const counter = { pulls: 0 };
  const ga4: WebsiteSyncOptions["ga4"] = {
    days: 7,
    accessTokenFor: TOKEN,
    source: async () => {
      counter.pulls += 1;
      return ga4Payload([
        {
          date: "2026-08-30",
          landingPage: "/pricing",
          metrics: { sessions: 12, engagedSessions: 8, totalUsers: 10, newUsers: 3, keyEvents: 1 },
        },
      ]);
    },
  };
  return { ga4, counter };
}

/** The production fault, with a message that must never travel. */
const overflow = () =>
  new Prisma.PrismaClientKnownRequestError(
    "numeric field overflow: value 188993 in column score SECRET-PARAMETER",
    { code: "P2020", clientVersion: "test" },
  );

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

const byStep = (steps: { step: string }[]) =>
  Object.fromEntries(steps.map((row) => [row.step, row]));

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  await prisma.$disconnect();
});

describe("the scheduled sync, after the pull", () => {
  it("records a successful detection alongside the completed run", async () => {
    const site = await makeSite("ok");
    const connection = await connect(site, GSC);
    const { gsc } = gscFake(site.host);

    const summary = await runWebsiteSync(site.websiteId, {
      now: NOW,
      gsc,
      detect: async () => ({ detected: 2, resolved: 0 }),
    });

    const steps = byStep(summary.steps);
    expect(steps["gsc"]).toMatchObject({ status: "done", written: 2 });
    expect(steps["signals"]).toEqual({
      step: "signals",
      status: "done",
      detail: "2 detected, 0 resolved",
    });
    expect(summary.wroteMetrics).toBe(true);

    const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } });
    expect(run.status).toBe("SUCCEEDED");
    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
  });

  it("an unexpected detection failure after a completed pull does not fail the job", async () => {
    const site = await makeSite("throws");
    const connection = await connect(site, GSC);
    const { gsc, counter } = gscFake(site.host);

    const { lines, restore } = capture();
    let summary;
    try {
      // Resolves. Before, attempt() rethrew this and the whole job was retried.
      summary = await runWebsiteSync(site.websiteId, {
        now: NOW,
        job: { id: "ws-job", attempt: 0, retryLimit: 3 },
        gsc,
        detect: async () => {
          throw overflow();
        },
      });
    } finally {
      restore();
    }

    const steps = byStep(summary.steps);
    expect(steps["gsc"]).toMatchObject({ status: "done", written: 2 });
    expect(steps["signals"]).toEqual({
      step: "signals",
      status: "failed",
      detail: "PrismaClientKnownRequestError",
    });
    // The step after detection still ran: one failure does not end the job.
    expect(steps["opportunities"]?.status).toBe("done");
    expect(summary.wroteMetrics).toBe(true);

    // The run is the ingestion's result, untouched: SUCCEEDED, closed, fresh.
    const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } });
    expect(run.status).toBe("SUCCEEDED");
    expect(run.finishedAt).not.toBeNull();
    expect(run.errorCode).toBeNull();
    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");

    // One pull. What a retry would have done is nothing: the window is reused.
    expect(counter.pulls).toBe(1);
    const again = await runWebsiteSync(site.websiteId, { now: NOW, gsc, detect: async () => undefined });
    expect(byStep(again.steps)["gsc"]?.status).toBe("reused");
    expect(counter.pulls).toBe(1);
    expect(await prisma.syncRun.count({ where: { connectionId: connection.id } })).toBe(1);

    // Logged as the attempt it was, against the run it followed, safe shape only.
    const event = lines.find(
      (line) => line.at === JOB_NAMES.WEBSITE_SYNC && line.event === "signals_failed",
    );
    expect(event).toMatchObject({
      websiteId: site.websiteId,
      provider: GSC,
      jobId: "ws-job",
      attempt: 1,
      maxAttempts: 4,
      runId: run.id,
      runStatus: "SUCCEEDED",
      step: "signals",
      errorName: "PrismaClientKnownRequestError",
      prismaCode: "P2020",
    });
    expect(lines.some((line) => line.event === "failed")).toBe(false);
    expect(JSON.stringify(lines)).not.toContain("SECRET-PARAMETER");

    // And in the audit trail, as the system actor, without rewriting the run.
    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: "SyncRun", entityId: run.id, action: "UPDATE" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.websiteId).toBe(site.websiteId);
    expect(audit!.afterSnapshotJson).toMatchObject({
      status: "SUCCEEDED",
      provider: GSC,
      signals: "FAILED",
      failure: { name: "PrismaClientKnownRequestError", prismaCode: "P2020" },
    });
    expect(JSON.stringify(audit!.afterSnapshotJson)).not.toContain("SECRET-PARAMETER");
  });

  it("a PARTIAL pull followed by a detection failure stays PARTIAL, never FAILED", async () => {
    const site = await makeSite("partial");
    const connection = await connect(site, GSC);
    const payload = gscPayload(site.host, ROWS);
    // One row the provider gave that belongs to no page of this website: it is
    // skipped, which makes the run PARTIAL although the period was read whole.
    payload.rows.push({
      date: "2026-08-30",
      page: "https://elsewhere.invalid/x",
      query: "",
      clicks: 1,
      impressions: 1,
      ctr: 1,
      position: 1,
    });

    const summary = await runWebsiteSync(site.websiteId, {
      now: NOW,
      gsc: { days: 7, accessTokenFor: TOKEN, source: async () => payload },
      detect: async () => {
        throw new Error("detection broke, and this sentence must not travel");
      },
    });

    const steps = byStep(summary.steps);
    expect(steps["gsc"]?.status).toBe("done");
    expect(steps["signals"]).toMatchObject({ status: "failed", detail: "Error" });

    const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } });
    expect(run.status).toBe("PARTIAL");
    expect(run.recordsSkipped).toBe(1);
    expect(run.recordsWritten).toBe(2);
    expect(run.errorCode).toBeNull();
    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.lastSyncedAt).not.toBeNull();

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: "SyncRun", entityId: run.id, action: "UPDATE" },
    });
    expect(audit!.afterSnapshotJson).toMatchObject({ status: "PARTIAL", signals: "FAILED" });
  });

  it("a provider failure is still recorded on its step, and detection never runs", async () => {
    const site = await makeSite("provider");
    const connection = await connect(site, GSC);
    const detect = vi.fn(async () => undefined);

    // As before this change: attempt() records the expected failure and the
    // job completes with the step marked failed. Nothing goes back to the queue.
    const summary = await runWebsiteSync(site.websiteId, {
      now: NOW,
      gsc: {
        days: 7,
        accessTokenFor: TOKEN,
        source: async () => {
          throw new SearchConsoleError("slow down", "rate_limited");
        },
      },
      detect,
    });

    const steps = byStep(summary.steps);
    expect(steps["gsc"]?.status).toBe("failed");
    expect(steps["signals"]).toMatchObject({ status: "skipped", detail: "no metrics yet" });
    expect(detect).not.toHaveBeenCalled();
    expect(summary.wroteMetrics).toBe(false);

    const run = await prisma.syncRun.findFirst({ where: { connectionId: connection.id } });
    expect(run?.status ?? "FAILED").toBe("FAILED");
    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.latestDataDate).toBeNull();
  });

  it("a database fault inside ingestion still fails the run, and detection never runs", async () => {
    const site = await makeSite("db");
    const connection = await connect(site, GSC);
    const detect = vi.fn(async () => undefined);

    // Postgres refuses a statement made while the provider is being read:
    // a database fault at the ingestion stage, which the sync service
    // records on the run with its safe fingerprint, as before.
    const summary = await runWebsiteSync(site.websiteId, {
      now: NOW,
      gsc: {
        days: 7,
        accessTokenFor: TOKEN,
        source: async () => {
          await prisma.$executeRawUnsafe("SELECT 1/0");
          return gscPayload(site.host, ROWS);
        },
      },
      detect,
    });

    const steps = byStep(summary.steps);
    expect(steps["gsc"]?.status).toBe("failed");
    expect(detect).not.toHaveBeenCalled();
    expect(summary.wroteMetrics).toBe(false);

    const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } });
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("unknown");
    const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(refreshed.latestDataDate).toBeNull();
  });

  it("with two providers, one detection failure reruns neither", async () => {
    const site = await makeSite("two");
    const gscConnection = await connect(site, GSC);
    const ga4Connection = await connect(site, GA4);
    const { gsc, counter: gscCount } = gscFake(site.host);
    const { ga4, counter: ga4Count } = ga4Fake();

    const { lines, restore } = capture();
    let summary;
    try {
      summary = await runWebsiteSync(site.websiteId, {
        now: NOW,
        gsc,
        ga4,
        detect: async () => {
          throw overflow();
        },
      });
    } finally {
      restore();
    }

    const steps = byStep(summary.steps);
    expect(steps["gsc"]).toMatchObject({ status: "done", written: 2 });
    expect(steps["ga4"]).toMatchObject({ status: "done", written: 1 });
    expect(steps["signals"]?.status).toBe("failed");

    for (const connection of [gscConnection, ga4Connection]) {
      const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } });
      expect(run.status).toBe("SUCCEEDED");
      const refreshed = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(refreshed.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
    }

    // One line and one audit note per run the detection followed.
    const events = lines.filter(
      (line) => line.at === JOB_NAMES.WEBSITE_SYNC && line.event === "signals_failed",
    );
    expect(events.map((line) => line.provider).sort()).toEqual([GA4, GSC].sort());
    const audits = await prisma.auditEvent.count({
      where: { entityType: "SyncRun", websiteId: site.websiteId, action: "UPDATE" },
    });
    expect(audits).toBe(2);

    // Neither provider was pulled twice, and a second job would reuse both.
    expect(gscCount.pulls).toBe(1);
    expect(ga4Count.pulls).toBe(1);
    const again = await runWebsiteSync(site.websiteId, { now: NOW, gsc, ga4, detect: async () => undefined });
    expect(byStep(again.steps)["gsc"]?.status).toBe("reused");
    expect(byStep(again.steps)["ga4"]?.status).toBe("reused");
    expect(gscCount.pulls).toBe(1);
    expect(ga4Count.pulls).toBe(1);
  });
});

describe("the real queue: a detection failure completes the job", () => {
  const schema = "pgboss_website_test";
  let queue: Queue;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    queue = createQueue({ role: "worker", schema, max: 2 });
    await queue.start();
  }, 90_000);

  afterAll(async () => {
    await queue.stop({ graceful: false, timeoutMs: 5_000 });
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }, 60_000);

  async function jobState(websiteId: string): Promise<string | null> {
    const rows = await prisma.$queryRawUnsafe<{ state: string }[]>(
      `SELECT state FROM ${schema}.job
        WHERE name = $1 AND data->>'websiteId' = $2
        ORDER BY created_on DESC LIMIT 1`,
      JOB_NAMES.WEBSITE_SYNC,
      websiteId,
    );
    return rows[0]?.state ?? null;
  }

  it("round trip: the worker runs, detection throws, and pg-boss records completed", async () => {
    const site = await makeSite("roundtrip");
    const connection = await connect(site, GSC);
    const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const { gsc, counter } = gscFake(site.host, [
      { date: day, path: "/a", query: "alpha", clicks: 4, impressions: 40 },
    ]);

    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await queue.work<{ websiteId: string }>(JOB_NAMES.WEBSITE_SYNC, async (job) =>
        runWebsiteSync(job.data.websiteId, {
          signal: job.signal,
          job: { id: job.id, attempt: job.attempt, retryLimit: job.retryLimit },
          gsc,
          detect: async () => {
            throw overflow();
          },
        }),
      );

      const jobId = await queue.enqueue(
        JOB_NAMES.WEBSITE_SYNC,
        { websiteId: site.websiteId },
        { singletonKey: site.websiteId },
      );
      expect(jobId).toEqual(expect.any(String));

      const deadline = Date.now() + 40_000;
      let run = await prisma.syncRun.findFirst({ where: { connectionId: connection.id } });
      while ((!run || run.status === "RUNNING") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        run = await prisma.syncRun.findFirst({ where: { connectionId: connection.id } });
      }
      expect(run?.status).toBe("SUCCEEDED");

      // Completed — not retry, not failed — so no second pull is ever scheduled.
      const settled = Date.now() + 15_000;
      let state = await jobState(site.websiteId);
      while (!["completed", "failed", "retry"].includes(state ?? "") && Date.now() < settled) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        state = await jobState(site.websiteId);
      }
      expect(state).toBe("completed");
      expect(counter.pulls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
