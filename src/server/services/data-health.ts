import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { freshnessInDays, isStale } from "@/lib/metrics/compare";
import { CONNECTION_PROVIDERS } from "@/lib/connections/registry";
import type { ConnectionStatus, SyncRun } from "@/generated/prisma/client";

/**
 * Data Health (docs/P1_SPEC.md §21).
 *
 * Answers one question honestly: can the numbers elsewhere in the product be
 * trusted right now? Every field is a fact about the pipeline — never a secret, and
 * never a reassurance the pipeline cannot support.
 */
export type SourceHealth = {
  provider: string;
  name: string;
  status: ConnectionStatus;
  propertyName: string | null;
  lastSyncedAt: Date | null;
  latestDataDate: Date | null;
  freshnessDays: number | null;
  stale: boolean;
  lastRun: Pick<SyncRun, "status" | "finishedAt" | "recordsWritten" | "errorCode"> | null;
  /** Rows this source has contributed. Coverage, stated as a count rather than a claim. */
  rowCount: number;
};

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
        lastRun: null,
        rowCount: 0,
      });
      continue;
    }

    const [lastRun, rowCount] = await Promise.all([
      prisma.syncRun.findFirst({
        where: { connectionId: connection.id },
        orderBy: { createdAt: "desc" },
        select: { status: true, finishedAt: true, recordsWritten: true, errorCode: true },
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
      lastRun,
      rowCount,
    });
  }

  return health;
}
