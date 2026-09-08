import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { getJobQueue } from "@/server/jobs/client";
import type { ConnectionSyncPayload } from "@/server/jobs/definitions";
import { JOB_NAMES, manualSyncKey, type ManualSyncProvider } from "@/server/jobs/names";
import type { Queue } from "@/server/jobs/queue";
import { pendingManualSyncJob, type PendingJob } from "@/server/jobs/status";
import { connectionFor, STALE_RUN_MINUTES, SyncError } from "@/server/services/sync";

/**
 * "Sync now" (docs/P1_SPEC.md section 23).
 *
 * The button used to run the whole provider pull inside the web request. On a
 * property of any size that is minutes of work, and a request is the wrong
 * place for minutes of work: a deploy, a dropped connection or a restart ends
 * it silently, and the run it had claimed stays RUNNING with nothing behind
 * it. That is exactly what happened in production.
 *
 * Now the request does only what a request should. It checks that this person
 * may ask for this sync, refuses if one is already on its way, and puts a
 * durable job in the queue — a row in Postgres, which outlives the request,
 * the browser tab and the web process alike. The worker does the pull and
 * closes the run.
 */

export type ManualSyncRequest =
  | { status: "queued"; jobId: string }
  | { status: "already_queued" }
  | { status: "already_running"; since: Date }
  | { status: "queue_unavailable" };

export type RequestManualSyncOptions = {
  now?: Date;
  /** Injected in tests; the web app uses its enqueue-only client. */
  queue?: Pick<Queue, "enqueue">;
  pendingJob?: (websiteId: string, provider: string) => Promise<PendingJob | null>;
};

export async function requestManualSync(
  context: TenantContext,
  provider: ManualSyncProvider,
  options: RequestManualSyncOptions = {},
): Promise<ManualSyncRequest> {
  // The action already required WRITE. A service that can be called from
  // anywhere checks for itself rather than trusting its caller did.
  if (!hasRole(context.membership.role, REQUIRED.WRITE)) {
    throw new SyncError("This role cannot start a sync.", "forbidden");
  }

  // The same refusals the run itself would make, made now, while there is
  // still a person to read them: not connected, no property chosen.
  const { connection } = await connectionFor(context, provider);
  const now = options.now ?? new Date();

  // A run inside the staleness window is genuinely in flight. One beyond it is
  // an orphan, and the worker retires it when the new job claims its run.
  const running = await prisma.syncRun.findFirst({
    where: { connectionId: connection.id, status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });

  if (running) {
    const since = running.startedAt ?? running.createdAt;
    if (now.getTime() - since.getTime() < STALE_RUN_MINUTES * 60_000) {
      return { status: "already_running", since };
    }
  }

  // One logical sync per connection: a job already waiting or running for it
  // is the answer to this click as well.
  const pending = await (options.pendingJob ?? pendingManualSyncJob)(context.website.id, provider);

  if (pending?.state === "active") {
    return { status: "already_running", since: pending.startedOn ?? pending.createdOn };
  }
  if (pending) {
    return { status: "already_queued" };
  }

  const payload: ConnectionSyncPayload = {
    websiteId: context.website.id,
    provider,
    requestedByUserId: context.user.id,
    requestedAt: now.toISOString(),
  };
  const queue = options.queue ?? getJobQueue();

  let jobId: string | null;

  try {
    jobId = await queue.enqueue(JOB_NAMES.CONNECTION_SYNC, payload, {
      singletonKey: manualSyncKey(context.website.id, provider),
    });
  } catch (error) {
    // Ours to log, with ids and an error name. Never the queue's own message,
    // which can carry a connection string.
    console.error(
      JSON.stringify({
        at: "sync.request",
        event: "enqueue-failed",
        websiteId: context.website.id,
        provider,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return { status: "queue_unavailable" };
  }

  // The queue's own singleton rule caught a click that raced this one.
  if (!jobId) {
    return { status: "already_queued" };
  }

  return { status: "queued", jobId };
}
