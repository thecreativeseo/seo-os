import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prisma } from "@/server/db/prisma";

/**
 * Removing the tenants a test created.
 *
 * Fixtures build a tenant and are expected to remove it again. Two things used
 * to stop that happening. The removal was one transaction over every tenant a
 * suite had made, and Prisma gives an interactive transaction five seconds by
 * default; an organization cascades through websites, content, runs and audit
 * rows, and under load that took six to twelve. And the end of a full run is a
 * storm: dozens of suites tear down at once against one remote pooler, and a
 * transaction that cannot even start throws. Either way the suite left every
 * one of its tenants behind, the database grew, the next run was slower, and
 * more runs failed. That is how a shared database reached six hundred dead
 * tenants.
 *
 * So, three layers. Each batch is its own transaction with an explicit,
 * generous timeout, and is retried with a pause when it cannot start. What
 * still fails is said out loud, and written to a ledger of exact ids that the
 * run's global teardown sweeps once every worker has exited and the database
 * is quiet. A ledger left by a run that was killed outright is swept at the
 * start of the next one.
 *
 * Deletion is always by exact id. Nothing here matches on a name or a pattern:
 * a helper that deleted everything that looked like test data would eventually
 * be pointed at something that only looked like it.
 */

// Large enough that a typical suite tears down in one transaction, because a
// long chain of small ones is slower in wall clock than the single big one it
// replaced. The explicit transaction timeout is what fixed the original
// failure: Prisma defaults interactive transactions to five seconds.
const ORGANIZATION_BATCH = 25;
const USER_BATCH = 50;
const TRANSACTION = { timeout: 90_000, maxWait: 30_000 } as const;
/** Pauses before each retry of a batch that could not run. */
const RETRY_PAUSES_MS = [2_000, 6_000, 15_000] as const;

/** History-preserving rows refuse DELETE unless the session opts in, per transaction. */
const HISTORY_DELETE = "SET LOCAL app.allow_approved_context_delete = 'on'";

/** Exact ids that a suite could not remove, one JSON line each. */
export const LEDGER_PATH = join(tmpdir(), "seo-os-vitest-teardown-ledger.jsonl");

export type TeardownResult = {
  removed: number;
  /** Ids that could not be removed, with the first line of why. */
  failed: { id: string; reason: string }[];
};

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "unknown"
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function removeOrganizations(batch: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(HISTORY_DELETE);
    await tx.organization.deleteMany({ where: { id: { in: batch } } });
  }, TRANSACTION);
}

/** Tries a batch, pausing and trying again when the database is too busy to start it. */
async function withRetries(batch: string[]): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt <= RETRY_PAUSES_MS.length; attempt += 1) {
    try {
      await removeOrganizations(batch);
      return;
    } catch (error) {
      last = error;
      const pause = RETRY_PAUSES_MS[attempt];
      if (pause === undefined) break;
      await sleep(pause);
    }
  }
  throw last;
}

function recordInLedger(kind: "organization" | "user", ids: readonly string[]): void {
  if (ids.length === 0) return;
  try {
    appendFileSync(
      LEDGER_PATH,
      ids.map((id) => JSON.stringify({ kind, id, at: new Date().toISOString() })).join("\n") + "\n",
    );
  } catch {
    // The ledger is a safety net under a safety net. If it cannot be written,
    // the failure was already said aloud below.
  }
}

/**
 * Writes ids to the ledger the moment a fixture creates the organization.
 *
 * A worker that is killed - by a timeout, by the runner, by a person - never
 * reaches its afterAll, and a ledger written only at teardown time learns
 * nothing from it. Recording at creation means the global sweep, at the end of
 * this run or the start of the next, still knows exactly which rows were ours.
 * An id that its own suite has since removed is simply not found by the sweep.
 */
export function registerOrganizations(ids: readonly string[]): void {
  recordInLedger("organization", ids);
}

/**
 * Deletes organizations by id, in batches, letting the declared cascades run.
 *
 * A batch that still fails after its retries is tried one id at a time, so a
 * single stubborn tenant does not take its neighbours down with it. What
 * survives even that is reported and left for the ledger sweep.
 */
export async function deleteOrganizations(ids: readonly string[]): Promise<TeardownResult> {
  const result: TeardownResult = { removed: 0, failed: [] };
  if (ids.length === 0) return result;

  for (let index = 0; index < ids.length; index += ORGANIZATION_BATCH) {
    const batch = [...ids].slice(index, index + ORGANIZATION_BATCH);
    try {
      await withRetries(batch);
      result.removed += batch.length;
    } catch {
      for (const id of batch) {
        try {
          await withRetries([id]);
          result.removed += 1;
        } catch (error) {
          result.failed.push({ id, reason: firstLine(error) });
        }
      }
    }
  }

  if (result.failed.length > 0) {
    recordInLedger(
      "organization",
      result.failed.map((f) => f.id),
    );
    process.stderr.write(
      `[teardown] ${result.failed.length} organization(s) left for the ledger sweep: ${result.failed[0]!.reason}\n`,
    );
  }

  return result;
}

/**
 * Deletes users by id. A user is not owned by an organization, so the cascade
 * does not reach them; one still referenced by history a test kept is refused,
 * and that refusal is correct rather than a problem to work around.
 */
export async function deleteUsers(ids: readonly string[]): Promise<TeardownResult> {
  const result: TeardownResult = { removed: 0, failed: [] };
  if (ids.length === 0) return result;

  for (let index = 0; index < ids.length; index += USER_BATCH) {
    const batch = [...ids].slice(index, index + USER_BATCH);
    try {
      const deleted = await prisma.user.deleteMany({ where: { id: { in: batch } } });
      result.removed += deleted.count;
    } catch {
      for (const id of batch) {
        try {
          await prisma.user.delete({ where: { id } });
          result.removed += 1;
        } catch (error) {
          result.failed.push({ id, reason: firstLine(error) });
        }
      }
    }
  }

  return result;
}

/**
 * The whole teardown for a suite: organizations first, then the users they
 * left behind. Users are attempted even when some organizations could not be
 * removed, because the two failures are unrelated.
 */
export async function teardownTenants(
  organizationIds: readonly string[],
  userIds: readonly string[] = [],
): Promise<{ organizations: TeardownResult; users: TeardownResult }> {
  // Neither pass throws: both collect their failures instead, so the user
  // pass always runs even when organizations were left behind.
  const organizations = await deleteOrganizations(organizationIds);
  const users = await deleteUsers(userIds);
  return { organizations, users };
}

/**
 * Removes whatever the ledger names, then the ledger. Run by the global
 * teardown once every worker has exited, and again at the start of a run in
 * case the previous one was killed before it could.
 */
export async function sweepLedger(
  label: string,
): Promise<{ organizations: number; users: number }> {
  if (!existsSync(LEDGER_PATH)) return { organizations: 0, users: 0 };

  const organizations = new Set<string>();
  const users = new Set<string>();
  for (const line of readFileSync(LEDGER_PATH, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as { kind: string; id: string };
      if (entry.kind === "organization") organizations.add(entry.id);
      if (entry.kind === "user") users.add(entry.id);
    } catch {
      // A torn line from two workers writing at once names nothing we can act on.
    }
  }

  const removedOrganizations = await deleteOrganizations([...organizations]);
  const removedUsers = await deleteUsers([...users]);

  const residue = removedOrganizations.failed.length + removedUsers.failed.length;
  if (residue === 0) {
    try {
      unlinkSync(LEDGER_PATH);
    } catch {
      // Already gone.
    }
  }

  if (organizations.size + users.size > 0) {
    process.stderr.write(
      `[teardown] ${label}: ledger sweep removed ${removedOrganizations.removed} organization(s) and ${removedUsers.removed} user(s), ${residue} left\n`,
    );
  }

  return { organizations: removedOrganizations.removed, users: removedUsers.removed };
}
