import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { freshnessInDays, isStale } from "@/lib/metrics/compare";
import { STALE_RUN_MINUTES } from "@/server/services/sync";
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
 * earlier attempt ever succeeded. "stale" is a RUNNING run old enough that the
 * process behind it is provably gone; the next sync will retire it.
 */
export type AttemptState = "none" | "running" | "stale" | "succeeded" | "partial" | "failed";

export type LatestAttempt = {
  state: AttemptState;
  /** When the run began. Drives "Syncing since …" for a live run. */
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
};

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

function describeAttempt(
  run: Pick<SyncRun, "status" | "startedAt" | "finishedAt" | "errorCode" | "createdAt"> | null,
  now: Date,
): LatestAttempt {
  if (!run) return { state: "none", startedAt: null, finishedAt: null, errorCode: null };

  const startedAt = run.startedAt ?? run.createdAt;
  const base = { startedAt, finishedAt: run.finishedAt, errorCode: run.errorCode };

  if (run.status === "RUNNING") {
    const stale = now.getTime() - startedAt.getTime() >= STALE_RUN_MS;
    return { ...base, state: stale ? "stale" : "running" };
  }
  if (run.status === "SUCCEEDED") return { ...base, state: "succeeded" };
  if (run.status === "PARTIAL") return { ...base, state: "partial" };
  if (run.status === "FAILED") return { ...base, state: "failed" };
  // QUEUED or CANCELLED: nothing is being read and nothing succeeded.
  return { ...base, state: "none" };
}

export async function getDataHealth(
  context: TenantContext,
  now: Date = new Date(),
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
        attempt: { state: "none", startedAt: null, finishedAt: null, errorCode: null },
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
      attempt: describeAttempt(lastRun, now),
      rowCount,
    });
  }

  return health;
}
