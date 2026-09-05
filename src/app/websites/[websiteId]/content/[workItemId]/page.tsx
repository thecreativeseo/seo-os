import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getContentWorkItem } from "@/server/services/content-work";
import { currentBrief, listBriefVersions } from "@/server/services/content-brief";
import { getDraftForWorkItem } from "@/server/services/content-draft";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { PriorityBadge } from "@/components/opportunity/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";

/**
 * One work item (docs/P4_SPEC.md §6): what was approved, by whom, and where
 * it points. The stages that follow - brief, draft, QA, CMS - arrive with
 * their own milestones and will appear here as they do; nothing is promised
 * on the screen before it exists.
 */
export default async function ContentWorkItemPage({
  params,
}: {
  params: Promise<{ websiteId: string; workItemId: string }>;
}) {
  const { websiteId, workItemId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const item = await getContentWorkItem(context, workItemId);
  if (!item) notFound();

  const [brief, versions, draftView] = await Promise.all([
    currentBrief(context, item.id),
    listBriefVersions(context, item.id),
    getDraftForWorkItem(context, item.id),
  ]);
  const awaiting = versions.filter((row) => row.status === "AWAITING_REVIEW").length;
  const canWrite = hasRole(context.membership.role, REQUIRED.WRITE);
  const briefable =
    item.status === "QUEUED" || item.status === "BRIEFING" || item.status === "DRAFTING";

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title={item.title} description={item.objective} />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={item.status} />
        <PriorityBadge priority={item.priority} />
        <span className="text-muted-foreground text-xs">{humanize(item.type)}</span>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Where it came from</h2>
        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          <Row label="Recommendation">
            <Link
              href={`/websites/${websiteId}/review/${item.recommendation.id}`}
              className="hover:underline"
            >
              {item.recommendation.title}
            </Link>
            <span className="text-muted-foreground">
              {" "}
              · {humanize(item.recommendation.type)} · {humanize(item.recommendation.status)}
            </span>
          </Row>
          <Row label="Decision">
            {humanize(item.decision.decision)} by {item.decision.decidedBy.email} on{" "}
            {item.decision.decidedAt.toLocaleString("en-GB")}
            {item.decision.reason ? (
              <span className="text-muted-foreground"> · “{item.decision.reason}”</span>
            ) : null}
          </Row>
          <Row label="Page">
            {item.page ? (
              <Link
                href={`/websites/${websiteId}/pages/${item.page.id}`}
                className="font-mono text-xs hover:underline"
              >
                {item.page.path}
              </Link>
            ) : (
              <span className="text-muted-foreground">None yet — new content</span>
            )}
          </Row>
          <Row label="Keyword">
            {item.keyword ? (
              <Link
                href={`/websites/${websiteId}/keywords/${item.keyword.id}`}
                className="hover:underline"
              >
                {item.keyword.keyword}
              </Link>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="Topic">
            {item.topic ? (
              <Link
                href={`/websites/${websiteId}/topics/${item.topic.id}`}
                className="hover:underline"
              >
                {item.topic.name}
              </Link>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="Owner">
            {item.owner ? (
              (item.owner.displayName ?? item.owner.email)
            ) : (
              <span className="text-muted-foreground">Unassigned</span>
            )}
          </Row>
          <Row label="Started">{item.createdAt.toLocaleString("en-GB")}</Row>
        </dl>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Brief</h2>
          <Link
            href={`/websites/${websiteId}/content/${item.id}/brief`}
            className="text-sm hover:underline"
          >
            {brief ? "Open the brief" : "Brief"}
          </Link>
        </div>
        {brief ? (
          <div className="border-border space-y-2 rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">v{brief.version}</span>
              <StatusBadge status={brief.status} />
              <span className="text-muted-foreground text-xs">
                {versions.length} version{versions.length === 1 ? "" : "s"}
                {awaiting > 0 ? ` · ${awaiting} awaiting review` : ""}
              </span>
            </div>
            <p className="text-sm font-medium">{brief.title}</p>
            {brief.status === "AWAITING_REVIEW" ? (
              <p className="text-sm">
                <span className="font-medium">Review pending.</span> An SEO lead, admin or owner
                needs to approve it before drafting begins.
              </p>
            ) : brief.status === "APPROVED" ? (
              <p className="text-muted-foreground text-sm">
                Approved. Drafting is the next step and starts when a person chooses to.
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">A draft, not yet sent for review.</p>
            )}
          </div>
        ) : (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
            No brief yet.{" "}
            {canWrite && briefable ? (
              <Link
                href={`/websites/${websiteId}/content/${item.id}/brief`}
                className="text-foreground hover:underline"
              >
                Generate one from the evidence, or write it by hand.
              </Link>
            ) : null}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Draft</h2>
          <Link
            href={`/websites/${websiteId}/content/${item.id}/draft`}
            className="text-sm hover:underline"
          >
            {draftView ? "Open the draft" : "Draft"}
          </Link>
        </div>
        {draftView ? (
          <div className="border-border space-y-2 rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={draftView.draft.status} />
              <span className="text-muted-foreground text-xs">
                pinned to brief v{draftView.brief.version} · {draftView.revisionCount} revision
                {draftView.revisionCount === 1 ? "" : "s"}
              </span>
            </div>
            {draftView.current ? (
              <p className="text-sm font-medium">{draftView.current.title}</p>
            ) : (
              <p className="text-muted-foreground text-sm">No revision generated yet.</p>
            )}
            {draftView.briefMismatch ? (
              <p className="text-muted-foreground text-xs">
                A newer brief version (v{draftView.briefMismatch.approvedVersion}) is approved; the
                draft stays on v{draftView.brief.version}.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
            {brief?.status === "APPROVED"
              ? "No draft yet. Start one from the approved brief."
              : "A draft can start once a brief version is approved."}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Next</h2>
        <p className="text-muted-foreground border-border rounded-lg border border-dashed p-4 text-sm">
          {brief?.status === "APPROVED"
            ? "Editing, revision history and review arrive with the next milestone; nothing starts by itself."
            : "An approved brief comes first. Drafting, QA and CMS steps follow in later milestones."}
        </p>
      </section>

      <Link href={`/websites/${websiteId}/content`} className="text-sm hover:underline">
        ← Content Work Queue
      </Link>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5">
      <dt className="text-muted-foreground w-36 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
