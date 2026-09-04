import { createQueue, type Queue } from "./queue";

/**
 * The web app's handle on the queue: enqueue only.
 *
 * A client never schedules, supervises or migrates - that is the worker's job,
 * and two processes doing it would be one too many. It is created on first use
 * for the same reason the Prisma client is: a build must not need DIRECT_URL.
 * Outside production the instance is kept on globalThis so hot reloads do not
 * each open another pool.
 */

const globalForQueue = globalThis as unknown as { jobQueue?: Queue };

let instance: Queue | undefined = globalForQueue.jobQueue;

export function getJobQueue(): Queue {
  if (!instance) {
    instance = createQueue({
      role: "client",
      schema: process.env.PGBOSS_SCHEMA?.trim() || undefined,
    });

    if (process.env.NODE_ENV !== "production") {
      globalForQueue.jobQueue = instance;
    }
  }

  return instance;
}
