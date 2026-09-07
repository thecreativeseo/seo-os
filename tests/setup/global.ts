import { config as loadEnv } from "dotenv";

/**
 * Runs once in the main vitest process, before any worker starts and after the
 * last one has exited.
 *
 * The end of a full run is when every suite tears down at once, and a
 * transaction that cannot start under that storm leaves a tenant behind. Each
 * suite writes what it could not remove to a ledger of exact ids; this sweeps
 * the ledger when the database is quiet again. The sweep at the start covers a
 * previous run that was killed before it reached its own.
 *
 * Nothing here matches on a name. It removes ids that a fixture wrote down.
 */

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

export async function setup(): Promise<void> {
  const { sweepLedger } = await import("../helpers/teardown");
  await sweepLedger("before run");
}

export async function teardown(): Promise<void> {
  const { sweepLedger } = await import("../helpers/teardown");
  await sweepLedger("after run");
  const { prisma } = await import("@/server/db/prisma");
  await prisma.$disconnect();
}
