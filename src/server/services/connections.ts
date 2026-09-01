import { prisma } from "@/server/db/prisma";
import { CONNECTION_PROVIDERS, type ProviderCard } from "@/lib/connections/registry";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import type { ConnectionStatus } from "@/generated/prisma/client";

/**
 * Connections (docs/P0_SPEC.md §18).
 *
 * P0 shows connection architecture only. Nothing connects, and no code path here
 * can make a provider appear connected — status comes from a stored row or defaults
 * to NOT_CONNECTED, and there is no writer.
 *
 * The view model deliberately omits credentialReference. A credential reference is
 * a pointer into a secret manager, not a secret, but there is no reason for it to
 * cross into a page or a client component, and omitting it means it cannot leak by
 * accident later. `hasCredentialReference` carries the only fact the UI needs.
 */
export type ConnectionCard = ProviderCard & {
  status: ConnectionStatus;
  connectedAt: Date | null;
  hasCredentialReference: boolean;
};

export async function listConnectionCards(
  context: TenantContext,
): Promise<ConnectionCard[]> {
  const rows = await prisma.connection.findMany({
    where: websiteScope(context),
    select: {
      provider: true,
      status: true,
      connectedAt: true,
      credentialReference: true,
    },
  });

  const byProvider = new Map(rows.map((row) => [row.provider, row]));

  // The registry is the source of truth for which providers exist. A provider with
  // no row has simply never been touched, which is NOT_CONNECTED.
  return CONNECTION_PROVIDERS.map((card) => {
    const row = byProvider.get(card.provider);

    return {
      ...card,
      status: row?.status ?? "NOT_CONNECTED",
      connectedAt: row?.connectedAt ?? null,
      hasCredentialReference: Boolean(row?.credentialReference),
    };
  });
}

/** Count of providers actually connected, for the Command Center in M10. */
export async function countConnected(context: TenantContext): Promise<number> {
  return prisma.connection.count({
    where: { ...websiteScope(context), status: "CONNECTED" },
  });
}

export const PROVIDER_COUNT = CONNECTION_PROVIDERS.length;
