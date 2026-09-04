import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { listRecommendations } from "@/server/services/decision";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import {
  ConfidenceBadge,
  LevelBadge,
  StatusBadge,
  humanize,
} from "@/components/diagnosis/primitives";
import type { RecommendationStatus } from "@/generated/prisma/client";

export const metadata = { title: "Recommendations · SEO OS" };

const STATUSES: RecommendationStatus[] = [
  "AWAITING_REVIEW",
  "NEEDS_EVIDENCE",
  "APPROVED",
  "MODIFIED",
  "REJECTED",
];

/**
 * Every recommendation, decided or not (docs/P3_SPEC.md §37).
 *
 * The review queue is where decisions happen; this is the record of what was
 * proposed and what became of it, filterable by status. Approved work is what
 * P4 will pick up. Nothing here executes.
 */
export default async function RecommendationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { websiteId } = await params;
  const { status } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const filter = STATUSES.includes(status as RecommendationStatus)
    ? [status as RecommendationStatus]
    : undefined;

  const recommendations = await listRecommendations(context, { status: filter }, 200);

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Recommendations"
          description="What the diagnoses proposed, and what a person decided. Approved work is handed to execution in a later phase; nothing here changes the site."
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <nav aria-label="Status" className="flex flex-wrap gap-2 text-sm">
        <Link
          href={`/websites/${websiteId}/recommendations`}
          className={`rounded-md border px-3 py-1 ${!filter ? "bg-foreground text-background border-foreground" : "border-border hover:bg-accent"}`}
        >
          All
        </Link>
        {STATUSES.map((entry) => (
          <Link
            key={entry}
            href={`/websites/${websiteId}/recommendations?status=${entry}`}
            className={`rounded-md border px-3 py-1 ${filter?.[0] === entry ? "bg-foreground text-background border-foreground" : "border-border hover:bg-accent"}`}
          >
            {humanize(entry)}
          </Link>
        ))}
      </nav>

      {recommendations.length === 0 ? (
        <EmptyState>
          {filter
            ? `Nothing ${humanize(filter[0]).toLowerCase()}.`
            : "No recommendations yet. They come from diagnoses; open a page and diagnose it."}
        </EmptyState>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {recommendations.map((recommendation) => (
            <li key={recommendation.id} className="space-y-2 px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <Link
                  href={`/websites/${websiteId}/review/${recommendation.id}`}
                  className="min-w-0 font-medium hover:underline"
                >
                  {recommendation.title}
                </Link>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={recommendation.status} />
                  <span className="text-muted-foreground text-xs">
                    {recommendation.createdAt.toLocaleDateString("en-GB")}
                  </span>
                </div>
              </div>
              <p className="text-muted-foreground line-clamp-2 text-sm">{recommendation.summary}</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  {humanize(recommendation.type)}
                  {recommendation.page ? ` · ${recommendation.page.path}` : ""}
                </span>
                <LevelBadge label="Priority" level={recommendation.priority} />
                <ConfidenceBadge level={recommendation.confidence} />
                <LevelBadge label="Effort" level={recommendation.effort} />
                <LevelBadge label="Risk" level={recommendation.risk} />
                {recommendation.blockedByRule ? (
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    Blocked by rule
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
