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
  | "none"
  | "queued"
  /**
   * A retry pg-boss is holding back on purpose. The previous attempt failed
   * and the queue has scheduled another; nothing is wrong with the worker.
   */
  | "retrying"
  | "starting"
  | "running"
  | "stale"
  | "succeeded"
  | "partial"
  | "failed";

export type LatestAttempt = {
  state: AttemptState;
  /** When the run began. Drives "Syncing since …" for a live run. */
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  /** When the waiting job was queued. */
  queuedAt: Date | null;
  /** When a scheduled retry becomes eligible to run. Null unless retrying. */
  retryAt: Date | null;
  /**
   * A queued job nobody has picked up for longer than the worker's polling
   * could explain. The worker claims within seconds; minutes means it is not
   * running, and the page should say so rather than show a hopeful "queued".
   *
   * Measured from when the job became eligible, not from when it was created:
   * a retry waiting out its backoff has not been ignored by anyone.
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
  retryAt: null,
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
    if (job.state === "active") {
      return {
        ...NONE,
        state: "starting",
        startedAt: job.startedOn ?? job.createdOn,
        queuedAt: job.createdOn,
      };
    }

    // A retry the queue is deliberately holding back. Until its backoff
    // passes it is not eligible to run, so nobody has failed to pick it up,
    // and asking whether the worker is running would blame the wrong thing.
    if (job.startAfter && job.startAfter.getTime() > now.getTime()) {
      return {
        ...NONE,
        state: job.state === "retry" ? "retrying" : "queued",
        queuedAt: job.createdOn,
        retryAt: job.startAfter,
      };
    }

    // Eligible now. Patience is counted from the moment it became eligible,
    // which for a plain job is its creation and for a retry is its backoff
    // expiring.
    const eligibleSince = Math.max(job.createdOn.getTime(), job.startAfter?.getTime() ?? 0);

    return {
      ...NONE,
      state: "queued",
      queuedAt: job.createdOn,
      unattended: now.getTime() - eligibleSince > QUEUE_PATIENCE_MS,
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

// ---------------------------------------------------------------------------
// Recent runs
// ---------------------------------------------------------------------------

/** Runs shown on one page of the Recent runs table. */
export const RUNS_PER_PAGE = 3;

export type SyncRunPage = {
  runs: SyncRun[];
  /** Every run this website has ever recorded. History is never pruned. */
  total: number;
  /** The page actually returned, after the requested one was normalized. */
  page: number;
  pageCount: number;
  perPage: number;
};

/**
 * Turns whatever arrived in the URL into a page number that exists.
 *
 * A query string is user input and can be anything: absent, empty, negative,
 * fractional, "abc", or a number past the end of the history. None of those is
 * an error worth showing a person, so each resolves to the nearest page that
 * does exist rather than to a crash or an empty table.
 */
export function normalizeRunsPage(raw: string | string[] | undefined, pageCount: number): number {
  const last = Math.max(1, pageCount);
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined) return 1;

  // Number() would accept "1e3" and " 12 "; parseInt would accept "3abc". Only
  // a plain run of digits is a page number.
  if (!/^\d+$/.test(text.trim())) return 1;

  const parsed = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;

  return Math.min(parsed, last);
}

/**
 * One page of this website's sync history, newest first.
 *
 * Paged in the database rather than in the page: the table shows three rows and
 * the history grows without limit, so loading all of it to render three would
 * get slower every day for no visible benefit.
 *
 * Ordering is by start time, which is what the table's first column shows. A
 * run that has not started has no start time and is put first: it is a sync
 * happening now, and burying it under yesterday's finished runs would be a
 * strange answer to "what is my pipeline doing".
 */
export async function listSyncRunPage(
  context: TenantContext,
  requestedPage: string | string[] | undefined,
  perPage: number = RUNS_PER_PAGE,
): Promise<SyncRunPage> {
  const size = Math.max(1, Math.floor(perPage));
  const total = await prisma.syncRun.count({ where: websiteScope(context) });
  const pageCount = Math.max(1, Math.ceil(total / size));
  const page = normalizeRunsPage(requestedPage, pageCount);

  const runs =
    total === 0
      ? []
      : await prisma.syncRun.findMany({
          where: websiteScope(context),
          orderBy: [{ startedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
          skip: (page - 1) * size,
          take: size,
        });

  return { runs, total, page, pageCount, perPage: size };
}

/**
 * The short note under a run's status badge.
 *
 * A recovered orphan is by far the most common failure, and its stored summary
 * is a full explanation — correct, but three lines of the same three lines on
 * every row of the table. The explanation is worth making once, above the
 * table; here the row only needs to say which kind of failure this was.
 *
 * Every other code keeps its own sentence, because the distinction between
 * "we were rate limited" and "that property no longer exists" is the whole
 * value of the column. The stored summary is used as-is: it is written from a
 * fixed table of our own sentences, never from a provider's response body.
 */
export function runFailureNote(run: Pick<SyncRun, "errorCode" | "errorSummary">): string | null {
  if (run.errorCode === "stale_run_recovered") return "Interrupted before completion";
  return run.errorSummary;
}

/**
 * Which page numbers to offer.
 *
 * Every page as its own link is fine at eight runs and absurd at eight
 * thousand: a website syncing hourly reaches a thousand pages within six weeks,
 * and a row of a thousand links is neither usable nor small. So the ends and
 * the neighbourhood of the current page are shown, and the stretches between
 * them collapse to a gap.
 *
 * A gap is a marker rather than a link, because the pages it stands for are
 * still reachable — by stepping, or by editing the number in the URL, which is
 * why the page number lives in the URL in the first place.
 */
export type PageStep = number | "gap";

export function runsPageWindow(page: number, pageCount: number, radius = 2): PageStep[] {
  if (pageCount <= 1) return [1];

  const wanted = new Set<number>([1, pageCount]);
  for (let step = page - radius; step <= page + radius; step += 1) {
    if (step >= 1 && step <= pageCount) wanted.add(step);
  }

  const steps: PageStep[] = [];
  let previous = 0;

  for (const target of [...wanted].sort((a, b) => a - b)) {
    // A gap standing for a single page is longer than the page number it hides.
    if (previous !== 0 && target - previous > 1) {
      steps.push(target - previous === 2 ? previous + 1 : "gap");
    }
    steps.push(target);
    previous = target;
  }

  return steps;
}
