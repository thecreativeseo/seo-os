import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { listReviewQueue } from "@/server/services/decision";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import {
  ConfidenceBadge,
  LevelBadge,
  StatusBadge,
  humanize,
} from "@/components/diagnosis/primitives";

export const metadata = { title: "Review Queue · SEO OS" };

/**
 * What is waiting for a person (docs/P3_SPEC.md §24, §32).
 *
 * Ordered by priority, then newest. Blocked recommendations are marked in the
 * list rather than hidden, because a reviewer should see what the rules are
 * holding back — and decide, by name, whether to hold it back too.
 */
export default async function ReviewQueuePage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const queue = await listReviewQueue(context, 100);
  const canDecide = hasRole(context.membership.role, REQUIRED.APPROVE);

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Review Queue"
          description="Recommendations waiting for a decision. Approve, modify, reject, or ask for more evidence. Nothing is executed in this phase."
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      {!canDecide ? (
        <p className="text-muted-foreground text-sm">
          An owner or admin decides. You can read everything in the queue.
        </p>
      ) : null}

      {queue.length === 0 ? (
        <EmptyState>Nothing waiting for a decision.</EmptyState>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {queue.map((item) => (
            <li key={item.id} className="space-y-2 px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <Link
                  href={`/websites/${websiteId}/review/${item.id}`}
                  className="min-w-0 font-medium hover:underline"
                >
                  {item.title}
                </Link>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={item.status} />
                  <LevelBadge label="Priority" level={item.priority} />
                </div>
              </div>
              <p className="text-muted-foreground line-clamp-2 text-sm">{item.summary}</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  {humanize(item.type)}
                  {item.page ? ` · ${item.page.path}` : ""}
                  {" · "}
                  {item.createdAt.toLocaleDateString("en-GB")}
                </span>
                <ConfidenceBadge level={item.confidence} />
                <LevelBadge label="Effort" level={item.effort} />
                <LevelBadge label="Risk" level={item.risk} />
                {item.blockedByRule ? (
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    Blocked by rule: {item.blockedByRule.rule}
                  </span>
                ) : null}
                {item.status === "NEEDS_EVIDENCE" ? (
                  <span className="text-muted-foreground text-xs">
                    Cannot be approved until evidence is added
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
