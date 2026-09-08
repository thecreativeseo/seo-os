import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { freshnessInDays, isStale } from "@/lib/metrics/compare";
import { STALE_RUN_MINUTES } from "@/server/services/sync";
import { isManualSyncProvider } from "@/server/jobs/names";
import { pendingManualSyncJob, type PendingJob } from "@/server/jobs/status";
import { CONNECTION_PROVIDERS } from "@/lib/connections/registry";
import type { ConnectionStatus, SyncRun } from "@/generated/prisma/client";

/**
 * Data Health (docs/P1_SPEC.md §21).
 *
 * Answers one question honestly: can the numbers elsewhere in the product be
 * trusted right now? Every field is a fact about the pipeline — never a secret, and
 * never a reassurance the pipeline cannot support.
 */
/**
 * What the newest attempt is doing right now — independent of whether any
 * earlier attempt ever succeeded. "queued" and "starting" come from the job
 * queue, before any SyncRun exists for the attempt. "stale" is a RUNNING run
 * old enough that the process behind it is provably gone; the next sync will
 * retire it.
 */
export type AttemptState =
  "none" | "queued" | "starting" | "running" | "stale" | "succeeded" | "partial" | "failed";

export type LatestAttempt = {
  state: AttemptState;
  /** When the run began. Drives "Syncing since …" for a live run. */
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  /** When the waiting job was queued. */
  queuedAt: Date | null;
  /**
   * A queued job nobody has picked up for longer than the worker's polling
   * could explain. The worker claims within seconds; minutes means it is not
   * running, and the page should say so rather than show a hopeful "queued".
   */
  unattended: boolean;
};

/** How long a queued job may wait before it is called unattended. */
export const QUEUE_PATIENCE_MS = 2 * 60_000;

export type SourceHealth = {
  provider: string;
  name: string;
  status: ConnectionStatus;
  propertyName: string | null;
  lastSyncedAt: Date | null;
  latestDataDate: Date | null;
  freshnessDays: number | null;
  stale: boolean;
  /** The newest attempt's state — never conflated with successful freshness below. */
  attempt: LatestAttempt;
  /**
   * Rows this source has contributed to the database. Coverage, stated as a
   * count rather than a claim: rows can exist from an interrupted run that never
   * advanced freshness, so this is never on its own evidence of a good sync.
   */
  rowCount: number;
};

const STALE_RUN_MS = STALE_RUN_MINUTES * 60_000;

const NONE: LatestAttempt = {
  state: "none",
  startedAt: null,
  finishedAt: null,
  errorCode: null,
  queuedAt: null,
  unattended: false,
};

function describeAttempt(
  run: Pick<SyncRun, "status" | "startedAt" | "finishedAt" | "errorCode" | "createdAt"> | null,
  job: PendingJob | null,
  now: Date,
): LatestAttempt {
  const runStartedAt = run ? (run.startedAt ?? run.createdAt) : null;

  // A run inside the staleness window is live, whatever the queue says: the
  // job that claimed it is the same attempt.
  if (run && runStartedAt && run.status === "RUNNING") {
    if (now.getTime() - runStartedAt.getTime() < STALE_RUN_MS) {
      return { ...NONE, state: "running", startedAt: runStartedAt };
    }
  }

  // A job waiting or just claimed is the newest attempt, and it outranks
  // whatever the last run left behind — including an orphan it will retire.
  if (job) {
    return job.state === "active"
      ? {
          ...NONE,
          state: "starting",
          startedAt: job.startedOn ?? job.createdOn,
          queuedAt: job.createdOn,
        }
      : {
          ...NONE,
          state: "queued",
          queuedAt: job.createdOn,
          unattended: now.getTime() - job.createdOn.getTime() > QUEUE_PATIENCE_MS,
        };
  }

  if (!run) return NONE;

  const base = {
    ...NONE,
    startedAt: runStartedAt,
    finishedAt: run.finishedAt,
    errorCode: run.errorCode,
  };

  if (run.status === "RUNNING") return { ...base, state: "stale" };
  if (run.status === "SUCCEEDED") return { ...base, state: "succeeded" };
  if (run.status === "PARTIAL") return { ...base, state: "partial" };
  if (run.status === "FAILED") return { ...base, state: "failed" };
  // QUEUED or CANCELLED: nothing is being read and nothing succeeded.
  return { ...base, state: "none" };
}

export type DataHealthOptions = {
  /** Injected in tests; the page reads the real queue table. */
  pendingJob?: (websiteId: string, provider: string) => Promise<PendingJob | null>;
};

export async function getDataHealth(
  context: TenantContext,
  now: Date = new Date(),
  options: DataHealthOptions = {},
): Promise<SourceHealth[]> {
  const connections = await prisma.connection.findMany({
    where: websiteScope(context),
  });

  const health: SourceHealth[] = [];

  for (const card of CONNECTION_PROVIDERS) {
    const connection = connections.find((entry) => entry.provider === card.provider);

    if (!connection) {
      health.push({
        provider: card.provider,
        name: card.name,
        status: "NOT_CONNECTED",
        propertyName: null,
        lastSyncedAt: null,
        latestDataDate: null,
        freshnessDays: null,
        stale: false,
        attempt: NONE,
        rowCount: 0,
      });
      continue;
    }

    const [lastRun, rowCount] = await Promise.all([
      prisma.syncRun.findFirst({
        where: { connectionId: connection.id },
        orderBy: { createdAt: "desc" },
        select: {
          status: true,
          startedAt: true,
          finishedAt: true,
          errorCode: true,
          createdAt: true,
        },
      }),
      connection.provider === "GOOGLE_SEARCH_CONSOLE"
        ? prisma.gscMetricDaily.count({ where: { sourceConnectionId: connection.id } })
        : connection.provider === "GOOGLE_ANALYTICS"
          ? prisma.ga4LandingPageMetricDaily.count({
              where: { sourceConnectionId: connection.id },
            })
          : Promise.resolve(0),
    ]);

    // Only the providers a person can sync by hand have a manual job to look for.
    const job = isManualSyncProvider(connection.provider)
      ? await (options.pendingJob ?? pendingManualSyncJob)(context.website.id, connection.provider)
      : null;

    const latest = connection.latestDataDate
      ? connection.latestDataDate.toISOString().slice(0, 10)
      : null;

    health.push({
      provider: card.provider,
      name: card.name,
      status: connection.status,
      propertyName: connection.externalPropertyName,
      lastSyncedAt: connection.lastSyncedAt,
      latestDataDate: connection.latestDataDate,
      freshnessDays: freshnessInDays(latest, now),
      // Only meaningful once something has actually arrived.
      stale: latest !== null && isStale(latest, now),
      attempt: describeAttempt(lastRun, job, now),
      rowCount,
    });
  }

  return health;
}
