import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getContentWorkItem } from "@/server/services/content-work";
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

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Next</h2>
        <p className="text-muted-foreground border-border rounded-lg border border-dashed p-4 text-sm">
          The brief comes next. Briefing, drafting, QA and CMS steps are being built milestone by
          milestone; this item will pick them up as they land.
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
