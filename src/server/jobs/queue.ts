import { PgBoss } from "pg-boss";

import { JOB_NAMES, type JobName } from "./names";

/**
 * The job queue (docs/P1_SPEC.md section 23, "Background jobs").
 *
 * pg-boss keeps the queue in Postgres, in its own schema beside the application
 * tables. That is the whole reason it was chosen: the database is already the
 * source of truth, so a job that was enqueued is as durable as any other row,
 * and there is no second system to keep running, back up, or explain. The spec's
 * one instruction here - "do not make the browser the durable job engine" - is
 * satisfied by having an engine that is not the browser.
 *
 * Everything the rest of the application touches goes through the small
 * interface below. pg-boss is a dependency of this file, not of the code that
 * enqueues work, so it can be swapped later without a search-and-replace.
 *
 * Connection: the worker talks to Postgres over DIRECT_URL, not the transaction
 * pooler the app uses. pg-boss holds a session for its polling loop, and a
 * transaction pooler hands out a different backend per statement, which is not a
 * session. LISTEN/NOTIFY is left off for the same reason: Supabase's pooler does
 * not carry notifications, and pg-boss polls perfectly well without them.
 */

// The names live in names.ts so that readers of the job table need no pg-boss
// import; they are re-exported here for everything that already imports them.
export { JOB_NAMES, resolveQueueSchema, type JobName } from "./names";

/**
 * Per-queue retry policy. A provider that is down at 03:00 is usually back by
 * 03:30; three tries with backoff covers that without hammering anyone.
 * expireInSeconds is the ceiling for one attempt: a website sync that takes
 * longer than an hour has something else wrong with it.
 *
 * The "short" policy is what makes singletonKey mean anything: one queued job
 * per key, so a website that is still waiting is not queued again behind
 * itself. (Under the default policy the key is only used for throttling.)
 * A policy cannot be changed on an existing queue, only set when it is created.
 */
const QUEUE_OPTIONS: Record<
  JobName,
  {
    policy: "short" | "stately";
    retryLimit: number;
    retryDelay: number;
    retryBackoff: boolean;
    expireInSeconds: number;
    retentionSeconds: number;
    /**
     * While a handler runs, pg-boss stamps the job every half of this. A job
     * whose stamp goes stale is released for retry — which is how a worker
     * that died mid-sync gives its job back in a couple of minutes rather
     * than at the expiry ceiling, and how a live long-running job proves it
     * is still there.
     */
    heartbeatSeconds?: number;
  }
> = {
  [JOB_NAMES.SYNC_DAILY]: {
    policy: "short",
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
  },
  [JOB_NAMES.WEBSITE_SYNC]: {
    policy: "short",
    retryLimit: 3,
    retryDelay: 600,
    retryBackoff: true,
    expireInSeconds: 60 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
    heartbeatSeconds: 60,
  },
  // "stately" rather than "short": one job per key in each of created, retry
  // and active, so two clicks never run two pulls at once. A second click
  // while one is active is caught before it is sent (see sync-request.ts).
  // The expiry is a ceiling for a handler that is alive but stuck; a dead one
  // is caught by the heartbeat long before that.
  [JOB_NAMES.CONNECTION_SYNC]: {
    policy: "stately",
    retryLimit: 2,
    retryDelay: 600,
    retryBackoff: true,
    expireInSeconds: 2 * 60 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
    heartbeatSeconds: 60,
  },
  // A model call is a minute; fifteen is a stuck one. Retries cover a provider
  // outage - a guardrail failure closes the request and completes the job.
  [JOB_NAMES.DIAGNOSIS_RUN]: {
    policy: "short",
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
    retentionSeconds: 14 * 24 * 60 * 60,
  },
};

export type EnqueueOptions = {
  /**
   * One queued job per key at a time. A website that is already waiting for a
   * sync does not get a second one behind it.
   */
  singletonKey?: string;
  /** Delay before the job becomes eligible, in seconds. */
  startAfterSeconds?: number;
};

export type QueueConfig = {
  /** Defaults to DIRECT_URL. */
  connectionString?: string;
  /** Defaults to "pgboss". Tests use their own so they can drop it afterwards. */
  schema?: string;
  /**
   * Whether this process runs the cron scheduler and the maintenance loop. The
   * worker does; a process that only enqueues (the web app, later) should not,
   * so two schedulers never fire the same cron.
   */
  role: "worker" | "client";
  /**
   * Connections pg-boss may open. Defaults to four for a worker and two for a
   * client. Tests that start a real queue beside a hundred other suites pass
   * a smaller number: DIRECT_URL is a session pooler with a small ceiling.
   */
  max?: number;
};

export type Queue = {
  /** Idempotent. Creates the queues and starts pg-boss. */
  start(): Promise<void>;
  enqueue(name: JobName, data: object, options?: EnqueueOptions): Promise<string | null>;
  /** Upserts a cron entry; the same key twice replaces rather than duplicates. */
  schedule(name: JobName, cron: string, data?: object): Promise<void>;
  unschedule(name: JobName): Promise<void>;
  /**
   * Registers a handler. Jobs arrive one at a time per handler invocation;
   * pg-boss's batch shape is folded away here so handlers stay simple.
   */
  work<T>(
    name: JobName,
    handler: (job: { id: string; data: T; signal: AbortSignal }) => Promise<unknown>,
  ): Promise<void>;
  /** Drains in-flight work, then closes the pool. */
  stop(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void>;
  /** The underlying instance, for tests that need to inspect job rows. */
  readonly boss: PgBoss;
};

function connectionStringFor(config: QueueConfig): string {
  const value = config.connectionString ?? process.env.DIRECT_URL;

  if (!value) {
    throw new Error(
      "DIRECT_URL is not set. The job queue needs a session-mode Postgres connection; the transaction pooler will not do.",
    );
  }

  return value;
}

export function createQueue(config: QueueConfig): Queue {
  const worker = config.role === "worker";

  const boss = new PgBoss({
    connectionString: connectionStringFor(config),
    schema: config.schema ?? "pgboss",
    application_name: `seo-os-${config.role}`,
    // Two connections are plenty: one polling, one for whatever the handler is
    // doing through pg-boss itself. Application queries go through Prisma.
    max: config.max ?? (worker ? 4 : 2),
    schedule: worker,
    supervise: worker,
    migrate: worker,
    createSchema: worker,
    useListenNotify: false,
  });

  // pg-boss reports problems on an emitter. Left unhandled, an 'error' event
  // takes the process down; logged, it is a line in the worker's output. No job
  // payload is included: the payload is ids, but the habit matters.
  boss.on("error", (error: Error) => {
    console.error(
      JSON.stringify({ at: "queue", event: "error", name: error.name, message: error.message }),
    );
  });
  boss.on("warning", (warning: unknown) => {
    const message =
      typeof warning === "object" && warning !== null && "message" in warning
        ? String((warning as { message: unknown }).message)
        : String(warning);
    console.warn(JSON.stringify({ at: "queue", event: "warning", message }));
  });

  let started: Promise<void> | null = null;

  const ensured = new Set<JobName>();

  /**
   * Creates a queue that does not exist yet and, on the worker, brings an
   * existing one's tunables up to date. The policy is fixed at creation and
   * is the one thing this cannot change. A client ensures only the queue it
   * is about to send to, so the web app can enqueue before the worker has
   * been redeployed with a new queue name.
   */
  async function ensureQueue(name: JobName): Promise<void> {
    if (ensured.has(name)) return;

    const options = QUEUE_OPTIONS[name];
    const existing = await boss.getQueue(name);

    if (!existing) {
      await boss.createQueue(name, options);
    } else if (worker) {
      const { retryLimit, retryDelay, retryBackoff, expireInSeconds, heartbeatSeconds } = options;
      try {
        await boss.updateQueue(name, {
          retryLimit,
          retryDelay,
          retryBackoff,
          expireInSeconds,
          heartbeatSeconds,
        });
      } catch (error) {
        // A tunable pg-boss would not take is a warning, not a reason the
        // worker cannot start.
        console.warn(
          JSON.stringify({
            at: "queue",
            event: "update-queue-failed",
            queue: name,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    }

    ensured.add(name);
  }

  async function ensureQueues(): Promise<void> {
    for (const name of Object.keys(QUEUE_OPTIONS) as JobName[]) {
      await ensureQueue(name);
    }
  }

  function start(): Promise<void> {
    if (!started) {
      started = (async () => {
        await boss.start();
        if (worker) {
          await ensureQueues();
        }
      })().catch((error: unknown) => {
        started = null;
        throw error;
      });
    }
    return started;
  }

  return {
    boss,

    start,

    async enqueue(name, data, options = {}) {
      await start();
      await ensureQueue(name);
      return boss.send(name, data, {
        singletonKey: options.singletonKey,
        startAfter: options.startAfterSeconds,
      });
    },

    async schedule(name, cron, data) {
      await start();
      await boss.schedule(name, cron, data ?? null, { tz: "UTC", key: name });
    },

    async unschedule(name) {
      await start();
      await boss.unschedule(name, name);
    },

    async work(name, handler) {
      await start();
      await boss.work(name, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          await handler({ id: job.id, data: job.data as never, signal: job.signal });
        }
      });
    },

    async stop(options = {}) {
      if (!started) return;
      await boss.stop({
        graceful: options.graceful ?? true,
        timeout: options.timeoutMs ?? 60_000,
        close: true,
      });
      started = null;
    },
  };
}
