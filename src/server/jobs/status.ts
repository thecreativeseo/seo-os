import { prisma } from "@/server/db/prisma";

import { JOB_NAMES, manualSyncKey, resolveQueueSchema } from "./names";

/**
 * Reading the queue's own table.
 *
 * pg-boss keeps every job as a row in `<schema>.job`, and two parts of the
 * product need to look at those rows without owning a queue client: Data
 * Health, to say "queued" before a SyncRun exists, and the sync service, to
 * tell a run that is still being executed from one a dead process abandoned.
 * Both are plain selects over the pooled connection; nothing here writes.
 *
 * The schema may not exist at all — a database the worker has never started
 * against. That is an answer rather than an error: nothing is queued and
 * nothing is live, and the caller carries on with what the application's own
 * tables say.
 */

export type PendingJobState = "created" | "retry" | "active";

export type PendingJob = {
  id: string;
  state: PendingJobState;
  createdOn: Date;
  startedOn: Date | null;
  heartbeatOn: Date | null;
  /**
   * When pg-boss will let the job run. A retry is deliberately held back by
   * its backoff, and until this passes it is waiting on purpose rather than
   * waiting on a worker — the two look identical without it.
   */
  startAfter: Date | null;
};

type JobRow = {
  id: string;
  state: string;
  createdOn: Date;
  startedOn: Date | null;
  heartbeatOn: Date | null;
  startAfter: Date | null;
};

export type QueueReadOptions = {
  /** Defaults to PGBOSS_SCHEMA, then "pgboss". Tests point this at their own. */
  schema?: string;
};

/** The manual sync job waiting or running for one connection, if any. */
export async function pendingManualSyncJob(
  websiteId: string,
  provider: string,
  options: QueueReadOptions = {},
): Promise<PendingJob | null> {
  const schema = resolveQueueSchema(options.schema);

  try {
    const rows = await prisma.$queryRawUnsafe<JobRow[]>(
      `SELECT id, state::text AS state, created_on AS "createdOn",
              started_on AS "startedOn", heartbeat_on AS "heartbeatOn",
              start_after AS "startAfter"
       FROM ${schema}.job
       WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry', 'active')
       ORDER BY created_on DESC
       LIMIT 1`,
      JOB_NAMES.CONNECTION_SYNC,
      manualSyncKey(websiteId, provider),
    );

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      state: row.state as PendingJobState,
      createdOn: row.createdOn,
      startedOn: row.startedOn,
      heartbeatOn: row.heartbeatOn,
      startAfter: row.startAfter,
    };
  } catch {
    return null;
  }
}

/** Beyond the job's own heartbeat interval, how much silence still counts as alive. */
const HEARTBEAT_GRACE_MULTIPLIER = 2;

/** Clock tolerance between the app that stamped the run and the database that stamped the job. */
const OWNERSHIP_SKEW_SECONDS = 5;

/**
 * Whether a live job owns a run that began at `runStartedAt` for this
 * connection: a manual connection.sync for it, or the daily website.sync for
 * its website, in the active state, claimed before the run began, and with a
 * heartbeat pg-boss has refreshed recently.
 *
 * A job the worker is still heartbeating is executing, however long it has
 * been going. One that stopped heartbeating is dead, whatever its state says.
 * The "claimed before the run began" clause is what lets a fresh job retire an
 * orphan from an earlier crash rather than shelter it behind its own heartbeat.
 */
export async function hasLiveSyncJob(
  websiteId: string,
  provider: string,
  runStartedAt: Date,
  options: QueueReadOptions = {},
): Promise<boolean> {
  const schema = resolveQueueSchema(options.schema);

  try {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id
       FROM ${schema}.job
       WHERE state = 'active'
         AND heartbeat_on IS NOT NULL
         AND heartbeat_on + (COALESCE(heartbeat_seconds, 60) * ${HEARTBEAT_GRACE_MULTIPLIER}) * interval '1 second' > now()
         AND started_on <= $5::timestamptz + interval '${OWNERSHIP_SKEW_SECONDS} seconds'
         AND ((name = $1 AND singleton_key = $2) OR (name = $3 AND singleton_key = $4))
       LIMIT 1`,
      JOB_NAMES.CONNECTION_SYNC,
      manualSyncKey(websiteId, provider),
      JOB_NAMES.WEBSITE_SYNC,
      websiteId,
      runStartedAt,
    );

    return rows.length > 0;
  } catch {
    return false;
  }
}
