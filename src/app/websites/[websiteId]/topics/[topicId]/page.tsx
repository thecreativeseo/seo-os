import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getTopic, getTopicMapping } from "@/server/services/topic";
import { listOpportunities } from "@/server/services/opportunity";
import { AUTHORITY_CAVEAT, COVERAGE_LABELS, ROLE_LABELS } from "@/lib/topic/coverage";
import { Badge, EmptyState, PageHeader } from "@/components/governance/primitives";
import { PriorityBadge, ScorePill } from "@/components/opportunity/primitives";

export const metadata = { title: "Topic · SEO OS" };

export default async function TopicDetailPage({
  params,
}: {
  params: Promise<{ websiteId: string; topicId: string }>;
}) {
  const { websiteId, topicId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const topic = await getTopic(context, topicId);

  if (!topic) notFound();

  const [mapping, opportunities] = await Promise.all([
    getTopicMapping(context, topicId),
    listOpportunities(context, { topicId, limit: 50 }),
  ]);

  return (
    <main className="space-y-8">
      <div className="space-y-2">
        <Link
          href={`/websites/${websiteId}/topics`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Topics
        </Link>
        <PageHeader title={topic.name} description={topic.description ?? ""} />
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge>{COVERAGE_LABELS[topic.coverage.status]}</Badge>
          <span className="text-muted-foreground text-sm">{topic.coverage.reason}</span>
        </div>

        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          {[
            { label: "Customer language", value: topic.customerLanguage },
            { label: "Business outcome", value: topic.businessOutcome },
            { label: "Pillar page", value: topic.pillarPath },
            { label: "Commercial destination", value: topic.commercialPath },
          ]
            .filter((row) => row.value)
            .map((row) => (
              <div
                key={row.label}
                className="grid gap-1 px-4 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
            <dt className="text-muted-foreground">Authority</dt>
            <dd>
              {topic.authorityStatus.toLowerCase()}
              <p className="text-muted-foreground mt-0.5 text-xs">{AUTHORITY_CAVEAT}</p>
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Pages ({mapping.pages.length})</h2>

        {mapping.pages.length === 0 ? (
          <EmptyState>No pages are mapped to this topic.</EmptyState>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {mapping.pages.map((page) => (
              <li
                key={page.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
              >
                <Link
                  href={`/websites/${websiteId}/pages/${page.id}`}
                  className="text-sm underline underline-offset-4"
                >
                  {page.path}
                </Link>
                <span className="text-muted-foreground text-xs">
                  {ROLE_LABELS[page.role]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Keywords ({mapping.keywords.length})</h2>

        {mapping.keywords.length === 0 ? (
          <EmptyState>No keywords are mapped to this topic.</EmptyState>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {mapping.keywords.map((keyword) => (
              <li
                key={keyword.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
              >
                <Link
                  href={`/websites/${websiteId}/keywords/${keyword.id}`}
                  className="text-sm underline underline-offset-4"
                >
                  {keyword.keyword}
                </Link>
                <span className="text-muted-foreground text-xs">
                  {keyword.intent.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {opportunities.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Opportunities</h2>
          <ul className="divide-border border-border divide-y rounded-lg border">
            {opportunities.map((opportunity) => (
              <li
                key={opportunity.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <Link
                  href={`/websites/${websiteId}/opportunities/${opportunity.id}`}
                  className="text-sm underline underline-offset-4"
                >
                  {opportunity.title}
                </Link>
                <span className="flex items-center gap-3">
                  <PriorityBadge priority={opportunity.priority} />
                  <ScorePill
                    score={opportunity.score === null ? null : Number(opportunity.score)}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
