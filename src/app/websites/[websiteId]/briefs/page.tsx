import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { listBriefs } from "@/server/services/content-brief";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";

export const metadata = { title: "Briefs · SEO OS" };

/**
 * Execution → Briefs (M4.4 §1): every brief version of the website, newest
 * first, with the work item it belongs to, who wrote and approved it, and
 * how many drafts are pinned to it.
 */
export default async function BriefsPage({ params }: { params: Promise<{ websiteId: string }> }) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const briefs = await listBriefs(context);

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Briefs"
          description="Every brief version: what it is for, who wrote it, who approved it, and the drafts pinned to it. Approved versions are immutable; edits make a new version."
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav className="text-muted-foreground flex flex-wrap gap-4 text-sm" aria-label="Execution">
        <Link href={`/websites/${websiteId}/content`} className="hover:underline">
          Content Work
        </Link>
        <span aria-current="page" className="text-foreground font-medium">
          Briefs
        </span>
        <Link href={`/websites/${websiteId}/drafts`} className="hover:underline">
          Drafts
        </Link>
      </nav>

      {briefs.length === 0 ? (
        <EmptyState>
          No briefs yet. Open a work item under Content Work and generate one from the evidence, or
          write it by hand.
        </EmptyState>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-left text-xs tracking-wide uppercase">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Brief
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Work item
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Version
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Written by
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Approved by
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Drafts
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {briefs.map((brief) => (
                <tr key={brief.id} className="align-top">
                  <td className="px-3 py-2">
                    <Link
                      href={`/websites/${websiteId}/content/${brief.contentWorkItemId}/brief?version=${brief.version}`}
                      className="font-medium hover:underline"
                    >
                      {brief.title}
                    </Link>
                    <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                      <span>{humanize(brief.contentType)}</span>
                      {context.website.isDemo ? <DemoBadge /> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/websites/${websiteId}/content/${brief.contentWorkItemId}`}
                      className="hover:underline"
                    >
                      {brief.contentWorkItem.title}
                    </Link>
                    <div className="text-muted-foreground text-xs">
                      {humanize(brief.contentWorkItem.type)} ·{" "}
                      {humanize(brief.contentWorkItem.status)}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">v{brief.version}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={brief.status} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {brief.createdByAiRun
                      ? `AI · ${brief.createdByAiRun.provider}`
                      : (brief.createdBy?.email ?? "—")}
                    <div className="text-muted-foreground">
                      {brief.createdAt.toLocaleDateString("en-GB")}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {brief.approvedBy ? (
                      <>
                        {brief.approvedBy.email}
                        <div className="text-muted-foreground">
                          {brief.approvedAt?.toLocaleDateString("en-GB")}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {brief._count.drafts > 0 ? (
                      <Link
                        href={`/websites/${websiteId}/content/${brief.contentWorkItemId}/draft`}
                        className="hover:underline"
                      >
                        {brief._count.drafts} pinned →
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
