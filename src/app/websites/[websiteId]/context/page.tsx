import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import {
  getCurrentApproved,
  getOpenDraft,
  listVersions,
} from "@/server/services/business-context";
import { ContextView } from "@/components/context/context-view";
import {
  ApproveVersionButton,
  StartDraftButton,
} from "@/components/context/context-actions";

export const metadata = { title: "Business Context · SEO OS" };

export default async function BusinessContextPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const [approved, draft, versions] = await Promise.all([
    getCurrentApproved(websiteId),
    getOpenDraft(websiteId),
    listVersions(websiteId),
  ]);

  const canApprove = hasRole(context.membership.role, "ADMIN");
  const canWrite = hasRole(context.membership.role, "MEMBER");

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 space-y-10 px-6 py-12">
      <header className="space-y-1">
        <p className="text-muted-foreground font-mono text-xs">
          {context.website.normalizedDomain}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Business Context</h1>
        <p className="text-muted-foreground text-sm">
          What the business has explicitly confirmed to be true. Approved versions
          cannot be edited — changes create a new draft.
        </p>
      </header>

      {draft ? (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-medium">
              Draft · version {draft.versionNumber}
            </h2>
            <span className="text-muted-foreground text-xs">Not yet approved</span>
          </div>
          <ContextView version={draft} />
          {canApprove ? (
            <ApproveVersionButton websiteId={websiteId} versionId={draft.id} />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin must approve this draft.
            </p>
          )}
        </section>
      ) : null}

      <section className="space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium">
            {approved ? `Approved · version ${approved.versionNumber}` : "Approved"}
          </h2>
          {approved?.approvedAt ? (
            <span className="text-muted-foreground text-xs">
              {approved.approvedAt.toLocaleDateString()}
            </span>
          ) : null}
        </div>

        {approved ? (
          <>
            <ContextView version={approved} />
            {canWrite && !draft ? <StartDraftButton websiteId={websiteId} /> : null}
          </>
        ) : (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-sm">
            No approved context yet. Nothing downstream treats this website&rsquo;s
            context as canonical until a version is approved.
          </p>
        )}
      </section>

      {versions.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">History</h2>
          <ul className="divide-border border-border divide-y rounded-lg border text-sm">
            {versions.map((version) => (
              <li key={version.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <Link
                  href={`/websites/${websiteId}/context/${version.id}` as never}
                  className="hover:underline"
                >
                  Version {version.versionNumber}
                </Link>
                <span className="text-muted-foreground font-mono text-xs">
                  {version.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
