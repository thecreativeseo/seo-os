import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import {
  getCurrentApproved,
  getOpenDraft,
  listVersions,
} from "@/server/services/business-context";
import { ContextView } from "@/components/context/context-view";
import { ContextEditor } from "@/components/context/context-editor";
import {
  ApproveVersionButton,
  DiscardDraftButton,
  StartDraftButton,
} from "@/components/context/context-actions";

export const metadata = { title: "Business Context · SEO OS" };

/**
 * Business Context.
 *
 * The page reads as one editor. Publishing and version history are still here —
 * approval is what makes a version canonical, and CLAUDE.md requires approved
 * versions to be immutable and historical ones retrievable — but they sit below and
 * behind the editing surface rather than competing with it.
 */
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
    <main className="mx-auto w-full max-w-3xl flex-1 space-y-8 px-6 py-12">
      <header className="space-y-1">
        <p className="text-muted-foreground font-mono text-xs">
          {context.website.normalizedDomain}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Business Context</h1>
        <p className="text-muted-foreground text-sm">
          What the business has confirmed to be true. Everything else in SEO OS works
          from this.
        </p>
      </header>

      {draft ? (
        <>
          <section className="space-y-4">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-sm font-medium">Draft · version {draft.versionNumber}</h2>
              {approved ? (
                <span className="text-muted-foreground text-xs">
                  Version {approved.versionNumber} stays current until you publish
                </span>
              ) : null}
            </div>

            {canWrite ? (
              <ContextEditor websiteId={websiteId} version={draft} />
            ) : (
              <ContextView version={draft} />
            )}
          </section>

          <section className="border-border space-y-2 border-t pt-6">
            <h2 className="text-sm font-medium">Publish this version</h2>
            <p className="text-muted-foreground text-sm">
              Publishing makes this the canonical context. It cannot be edited
              afterwards — changing it later starts a new draft, and this version stays
              on record.
              {approved
                ? " Discarding deletes this draft and keeps the published version."
                : null}
            </p>
            <div className="flex flex-wrap items-start gap-3 pt-1">
              {canApprove ? (
                <ApproveVersionButton websiteId={websiteId} versionId={draft.id} />
              ) : (
                <p className="text-muted-foreground text-sm">
                  An owner or admin publishes this.
                </p>
              )}
              {/* Only offered when a published version exists to fall back to. */}
              {canWrite && approved ? (
                <DiscardDraftButton websiteId={websiteId} versionId={draft.id} />
              ) : null}
            </div>
          </section>
        </>
      ) : (
        <section className="space-y-4">
          {approved ? (
            <>
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="text-sm font-medium">
                  Published · version {approved.versionNumber}
                </h2>
                {approved.approvedAt ? (
                  <span className="text-muted-foreground text-xs">
                    {approved.approvedAt.toLocaleDateString()}
                  </span>
                ) : null}
              </div>
              <ContextView version={approved} />
              {canWrite ? (
                <div className="pt-1">
                  <StartDraftButton websiteId={websiteId} />
                </div>
              ) : null}
            </>
          ) : (
            <p className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-sm">
              No context yet. Nothing downstream treats this website&rsquo;s context as
              canonical until a version is published.
            </p>
          )}
        </section>
      )}

      {versions.length > 0 ? (
        <details className="border-border border-t pt-4">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm">
            Version history ({versions.length})
          </summary>
          <ul className="divide-border border-border mt-3 divide-y rounded-lg border text-sm">
            {versions.map((version) => (
              <li
                key={version.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <Link
                  href={`/websites/${websiteId}/context/${version.id}`}
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
        </details>
      ) : null}
    </main>
  );
}
