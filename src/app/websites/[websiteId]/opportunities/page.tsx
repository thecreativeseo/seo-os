import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import {
  getOpportunityCounts,
  listOpportunities,
  type QueueFilters,
} from "@/server/services/opportunity";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import {
  PriorityBadge,
  ScorePill,
} from "@/components/opportunity/primitives";
import { DetectOpportunitiesButton } from "@/components/opportunity/controls";
import type {
  OpportunityPriority,
  OpportunityStatus,
  OpportunityType,
} from "@/generated/prisma/client";

export const metadata = { title: "Opportunity Queue · SEO OS" };

const PAGE_SIZE = 40;

const TYPES: OpportunityType[] = [
  "COMMERCIAL_RANKING",
  "KEYWORD_OWNERSHIP",
  "CTR",
  "TOPIC_GAP",
  "COMPETITOR_GAP",
  "CONTENT_REFRESH",
  "NO_OWNING_PAGE",
];

const STATUSES: OpportunityStatus[] = [
  "IDENTIFIED",
  "QUALIFIED",
  "SCHEDULED",
  "IN_PROGRESS",
  "DECLINED",
  "COMPLETED",
];

const PRIORITIES: OpportunityPriority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

const TYPE_LABELS: Record<string, string> = {
  COMMERCIAL_RANKING: "Commercial ranking",
  KEYWORD_OWNERSHIP: "Keyword ownership",
  CTR: "CTR",
  TOPIC_GAP: "Topic gap",
  COMPETITOR_GAP: "Competitor gap",
  CONTENT_REFRESH: "Content refresh",
  NO_OWNING_PAGE: "No owning page",
  KEYWORD_GAP: "Keyword gap",
  WEAK_OWNING_PAGE: "Weak owning page",
  RANKING_URL_DIVERGENCE: "Ranking divergence",
};

/**
 * The Opportunity Queue.
 *
 * P2's flagship screen, answering "what should we work on next" — and, one click
 * deeper, "why does the product think so". The second question is the one that
 * makes the first answer usable.
 */
export default async function OpportunitiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<{
    type?: string;
    status?: string;
    priority?: string;
    page?: string;
  }>;
}) {
  const { websiteId } = await params;
  const query = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const pageNumber = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);

  // Filters are matched against our own lists rather than passed through: a query
  // string is somebody's input, whatever the links on this page offer.
  const filters: QueueFilters = {
    type: TYPES.find((value) => value === query.type),
    status: STATUSES.find((value) => value === query.status),
    priority: PRIORITIES.find((value) => value === query.priority),
    limit: PAGE_SIZE + 1,
    offset: (pageNumber - 1) * PAGE_SIZE,
  };

  const [rows, counts] = await Promise.all([
    listOpportunities(context, filters),
    getOpportunityCounts(context),
  ]);

  const hasNext = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const canWrite = hasRole(context.membership.role, "MEMBER");

  const withFilter = (key: string, value: string | undefined) => {
    const next = new URLSearchParams();
    for (const [name, current] of Object.entries(query)) {
      if (name !== "page" && name !== key && current) next.set(name, current);
    }
    if (value) next.set(key, value);
    const search = next.toString();
    return `/websites/${websiteId}/opportunities${search ? `?${search}` : ""}`;
  };

  return (
    <main className="space-y-6">
      <PageHeader
        title="Opportunity Queue"
        description="Work ranked by business relevance, intent, demand, visibility, competitive gap, confidence and effort. Every score opens to show its reasoning."
      />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs">Open</dt>
            <dd className="font-medium tabular-nums">{counts.total}</dd>
          </div>
          {PRIORITIES.map((priority) =>
            counts.byPriority[priority] ? (
              <div key={priority}>
                <dt className="text-muted-foreground text-xs">{priority}</dt>
                <dd className="font-medium tabular-nums">{counts.byPriority[priority]}</dd>
              </div>
            ) : null,
          )}
        </dl>

        {canWrite ? <DetectOpportunitiesButton websiteId={websiteId} /> : null}
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">Type</span>
          <Link
            href={withFilter("type", undefined)}
            className={`rounded border px-2 py-0.5 text-xs ${query.type ? "border-border" : "border-foreground"}`}
          >
            All
          </Link>
          {TYPES.filter((type) => counts.byType[type]).map((type) => (
            <Link
              key={type}
              href={withFilter("type", type)}
              className={`rounded border px-2 py-0.5 text-xs ${
                query.type === type ? "border-foreground" : "border-border"
              }`}
            >
              {TYPE_LABELS[type] ?? type} ({counts.byType[type]})
            </Link>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">Status</span>
          <Link
            href={withFilter("status", undefined)}
            className={`rounded border px-2 py-0.5 text-xs ${query.status ? "border-border" : "border-foreground"}`}
          >
            All
          </Link>
          {STATUSES.map((status) => (
            <Link
              key={status}
              href={withFilter("status", status)}
              className={`rounded border px-2 py-0.5 text-xs ${
                query.status === status ? "border-foreground" : "border-border"
              }`}
            >
              {status.replace("_", " ").toLowerCase()}
            </Link>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState>
          {counts.total === 0
            ? "No opportunities yet. Import keyword data from Semrush or Ahrefs, then run Find opportunities."
            : "No opportunities match these filters."}
        </EmptyState>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left">
                <th className="px-4 py-2 font-medium">Opportunity</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Priority</th>
                <th className="px-3 py-2 text-right font-medium">Score</th>
                <th className="px-3 py-2 font-medium">Goal</th>
                <th className="px-3 py-2 font-medium">Effort</th>
                <th className="px-3 py-2 font-medium">Confidence</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {visible.map((row) => (
                <tr key={row.id}>
                  <td className="max-w-md px-4 py-3">
                    <Link
                      href={`/websites/${websiteId}/opportunities/${row.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {row.title}
                    </Link>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {row.keyword?.keyword ?? row.topic?.name ?? row.page?.path ?? ""}
                    </p>
                  </td>
                  <td className="text-muted-foreground px-3 py-3 text-xs whitespace-nowrap">
                    {TYPE_LABELS[row.type] ?? row.type}
                  </td>
                  <td className="px-3 py-3">
                    <PriorityBadge priority={row.priority} />
                  </td>
                  <td className="px-3 py-3 text-right">
                    <ScorePill score={row.score === null ? null : Number(row.score)} />
                  </td>
                  <td className="text-muted-foreground max-w-[12rem] truncate px-3 py-3 text-xs">
                    {row.businessGoal?.title ?? "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-3 text-xs">{row.effort}</td>
                  <td className="text-muted-foreground px-3 py-3 text-xs">{row.confidence}</td>
                  <td className="text-muted-foreground max-w-[10rem] truncate px-3 py-3 text-xs">
                    {row.owner?.displayName ?? row.owner?.email ?? "—"}
                  </td>
                  <td className="text-muted-foreground px-3 py-3 text-xs">
                    {row.status.replace("_", " ").toLowerCase()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(pageNumber > 1 || hasNext) && (
        <div className="flex items-center gap-4 text-sm">
          {pageNumber > 1 ? (
            <Link
              href={`/websites/${websiteId}/opportunities?page=${pageNumber - 1}`}
              className="underline underline-offset-4"
            >
              Previous
            </Link>
          ) : null}
          {hasNext ? (
            <Link
              href={`/websites/${websiteId}/opportunities?page=${pageNumber + 1}`}
              className="underline underline-offset-4"
            >
              Next
            </Link>
          ) : null}
        </div>
      )}
    </main>
  );
}
