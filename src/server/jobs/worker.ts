import { prisma } from "@/server/db/prisma";

import { registerJobs, resolveDailyCron } from "./definitions";
import { createQueue, JOB_NAMES } from "./queue";

/**
 * The worker process.
 *
 * A second process of the same codebase, started with `npm run worker`. It
 * owns the cron schedule, runs the job handlers, and does nothing else: no
 * HTTP, no UI. It shares the web service's database and the same environment
 * variables, so a credential that the app can decrypt, the worker can too.
 *
 * Shutdown is graceful: on SIGTERM the queue stops taking jobs, waits for the
 * one in flight to finish (up to a minute), then closes. A host that restarts
 * the worker mid-sync therefore gets a completed sync run or a run that the
 * next attempt will notice was left RUNNING and take over - never a half.
 */

function log(payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: "worker", ...payload }));
}

async function main(): Promise<void> {
  const schema = process.env.PGBOSS_SCHEMA?.trim() || undefined;
  const cron = resolveDailyCron(process.env.SYNC_DAILY_CRON);

  const queue = createQueue({ role: "worker", schema });

  await queue.start();
  await registerJobs(queue);
  await queue.schedule(JOB_NAMES.SYNC_DAILY, cron, {});

  log({ event: "started", cron, schema: schema ?? "pgboss", pid: process.pid });

  // A first deploy should not have to wait until 03:00 to prove itself.
  if (process.env.SYNC_ON_START === "1") {
    const id = await queue.enqueue(
      JOB_NAMES.SYNC_DAILY,
      { reason: "SYNC_ON_START" },
      { singletonKey: "on-start" },
    );
    log({ event: "sync-on-start", jobId: id });
  }

  let stopping = false;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;

    log({ event: "stopping", signal });

    try {
      await queue.stop({ graceful: true, timeoutMs: 60_000 });
      await prisma.$disconnect();
      log({ event: "stopped" });
      process.exit(0);
    } catch (error) {
      log({ event: "stop-failed", error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      at: "worker",
      event: "failed-to-start",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
