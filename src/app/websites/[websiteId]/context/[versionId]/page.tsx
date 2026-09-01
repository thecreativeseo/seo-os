import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db/prisma";
import { getOrCreateContext } from "@/server/services/business-context";
import { ContextView } from "@/components/context/context-view";

export const metadata = { title: "Context version · SEO OS" };

/**
 * A historical version, read-only.
 *
 * "Historical versions remain accessible" (CLAUDE.md) — this is that guarantee.
 * The version id is scoped to the caller's website, so it cannot be used to read
 * another tenant's history.
 */
export default async function ContextVersionPage({
  params,
}: {
  params: Promise<{ websiteId: string; versionId: string }>;
}) {
  const { websiteId, versionId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const businessContext = await getOrCreateContext(context.website.id);

  const version = await prisma.businessContextVersion.findFirst({
    where: { id: versionId, businessContextId: businessContext.id },
    include: {
      approvedBy: { select: { email: true, displayName: true } },
      createdBy: { select: { email: true, displayName: true } },
    },
  });

  if (!version) {
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 space-y-8 px-6 py-12">
      <div>
        <Link
          href={`/websites/${websiteId}/context` as never}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Business Context
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Version {version.versionNumber}
        </h1>
        <p className="text-muted-foreground text-sm">
          <span className="font-mono text-xs">{version.status}</span>
          {version.approvedAt
            ? ` · approved ${version.approvedAt.toLocaleString()} by ${
                version.approvedBy?.displayName ?? version.approvedBy?.email ?? "unknown"
              }`
            : ` · created ${version.createdAt.toLocaleString()} by ${
                version.createdBy.displayName ?? version.createdBy.email
              }`}
        </p>
      </header>

      {version.status === "APPROVED" ? (
        <p className="border-border text-muted-foreground rounded-md border border-dashed px-4 py-3 text-sm">
          This version is approved and immutable. Editing the business context
          creates a new draft.
        </p>
      ) : null}

      <ContextView version={version} />
    </main>
  );
}
