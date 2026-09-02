import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { listTopics } from "@/server/services/topic";
import { getTopicCompetitorOverlap } from "@/server/services/competitor-intel";
import { AUTHORITY_CAVEAT, COVERAGE_LABELS } from "@/lib/topic/coverage";
import { Badge, EmptyState, PageHeader } from "@/components/governance/primitives";

export const metadata = { title: "Topics · SEO OS" };

/**
 * Topic Explorer.
 *
 * Coverage is shown with its reason attached, because the status on its own is a
 * judgement and a reader is entitled to know how it was reached — including when
 * the answer is "somebody on your team decided".
 */
export default async function TopicsPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const [topics, overlap] = await Promise.all([
    listTopics(context),
    getTopicCompetitorOverlap(context),
  ]);

  const overlapByTopic = new Map(overlap.map((row) => [row.topicId, row]));

  return (
    <main className="space-y-6">
      <PageHeader
        title="Topics"
        description="Subjects this business wants to be known for, and whether there are enough pages behind them."
      />

      {topics.length === 0 ? (
        <EmptyState>
          No topics yet. Topics are written by your team rather than generated — a
          cluster that is mostly right produces a map nobody trusts.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {topics.map((topic) => {
            const competitors = overlapByTopic.get(topic.id);

            return (
              <article key={topic.id} className="border-border space-y-3 rounded-lg border p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Link
                      href={`/websites/${websiteId}/topics/${topic.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {topic.name}
                    </Link>
                    {topic.customerLanguage ? (
                      <p className="text-muted-foreground mt-1 text-sm">
                        “{topic.customerLanguage}”
                      </p>
                    ) : null}
                  </div>
                  <Badge>{COVERAGE_LABELS[topic.coverage.status]}</Badge>
                </div>

                {/* The status never travels without its reason. */}
                <p className="text-muted-foreground text-xs">{topic.coverage.reason}</p>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground text-xs">Keywords</dt>
                    <dd className="tabular-nums">{topic.keywordCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Pages</dt>
                    <dd className="tabular-nums">{topic.pageCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Authority</dt>
                    <dd title={AUTHORITY_CAVEAT}>
                      {topic.authorityStatus.toLowerCase()}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Competitors on</dt>
                    <dd className="tabular-nums">
                      {competitors?.keywordsCompetitorsRankFor ?? 0}
                    </dd>
                  </div>
                </dl>

                {topic.pillarPath || topic.commercialPath ? (
                  <p className="text-muted-foreground text-xs">
                    {topic.pillarPath ? `Pillar ${topic.pillarPath}` : ""}
                    {topic.pillarPath && topic.commercialPath ? " · " : ""}
                    {topic.commercialPath ? `Sells at ${topic.commercialPath}` : ""}
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      <p className="text-muted-foreground text-xs">{AUTHORITY_CAVEAT}</p>
    </main>
  );
}
