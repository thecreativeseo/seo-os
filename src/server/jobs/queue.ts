import { PgBoss } from "pg-boss";

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

export const JOB_NAMES = {
  /** Once a day: enqueue one website.sync per active website. */
  SYNC_DAILY: "sync.daily",
  /** Everything one website needs pulled, then re-detected. */
  WEBSITE_SYNC: "website.sync",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

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
    policy: "short";
    retryLimit: number;
    retryDelay: number;
    retryBackoff: boolean;
    expireInSeconds: number;
    retentionSeconds: number;
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
    max: worker ? 4 : 2,
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

  async function ensureQueues(): Promise<void> {
    for (const [name, options] of Object.entries(QUEUE_OPTIONS)) {
      const existing = await boss.getQueue(name);
      if (!existing) {
        await boss.createQueue(name, options);
      }
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
