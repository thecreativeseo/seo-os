/**
 * Queue names and the queue's schema, with no pg-boss import.
 *
 * Split from queue.ts so that code which only needs to name a queue or read
 * the job table — the sync service asking whether a run is still owned by a
 * live job, Data Health saying "queued" before a SyncRun exists — does not pull
 * the queue client into its module graph.
 */

export const JOB_NAMES = {
  /** Once a day: enqueue one website.sync per active website. */
  SYNC_DAILY: "sync.daily",
  /** Everything one website needs pulled, then re-detected. */
  WEBSITE_SYNC: "website.sync",
  /** One provider for one website, asked for by a person pressing "Sync now". */
  CONNECTION_SYNC: "connection.sync",
  /** One diagnosis request, run to completion by the worker. */
  DIAGNOSIS_RUN: "diagnosis.run",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const DEFAULT_QUEUE_SCHEMA = "pgboss";

const SCHEMA_SHAPE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The Postgres schema the queue lives in. Validated as a plain identifier
 * because it is interpolated into SQL by the readers in status.ts; an operator
 * setting is trusted to be well-meaning, not to be well-formed.
 */
export function resolveQueueSchema(value: string | undefined = process.env.PGBOSS_SCHEMA): string {
  const trimmed = value?.trim();

  if (!trimmed) return DEFAULT_QUEUE_SCHEMA;

  if (!SCHEMA_SHAPE.test(trimmed)) {
    throw new Error(`PGBOSS_SCHEMA must be a plain lowercase identifier (got "${trimmed}").`);
  }

  return trimmed;
}

/** The providers a person can sync by hand. The others are pulled by the daily job. */
export const MANUAL_SYNC_PROVIDERS = ["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS"] as const;

export type ManualSyncProvider = (typeof MANUAL_SYNC_PROVIDERS)[number];

export function isManualSyncProvider(value: string): value is ManualSyncProvider {
  return (MANUAL_SYNC_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The singleton key of a manual sync: one logical sync per connection at a
 * time. The queue enforces it per state, the request checks it across them.
 */
export function manualSyncKey(websiteId: string, provider: string): string {
  return `${websiteId}:${provider}`;
}
