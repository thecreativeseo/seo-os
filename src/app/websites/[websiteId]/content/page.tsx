import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { listApprovedNotStarted, listContentWorkItems } from "@/server/services/content-work";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { PriorityBadge } from "@/components/opportunity/primitives";
import { StatusBadge, humanize } from "@/components/diagnosis/primitives";
import { StartContentWorkButton } from "@/components/execution/controls";

export const metadata = { title: "Content Work · SEO OS" };

/**
 * The Content Work Queue (docs/P4_SPEC.md §31), and above it the approved
 * recommendations nobody has started yet.
 *
 * Two lists on purpose. The top one is the handoff from P3: every approved
 * recommendation, with a button where P4 can execute it and a reason where it
 * cannot. The bottom one is the work itself, once a person has started it.
 */
export default async function ContentWorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { websiteId } = await params;
  const { status } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);

  const showAll = status === "all";
  const canStart = hasRole(context.membership.role, REQUIRED.WRITE);

  const [approved, items] = await Promise.all([
    listApprovedNotStarted(context),
    listContentWorkItems(context, { status: showAll ? "all" : "open" }),
  ]);

  const eligible = approved.filter((row) => row.eligibility.eligible);
  const ineligible = approved.filter((row) => !row.eligibility.eligible);

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Content Work"
          description="Approved recommendations become work here, one deliberate step at a time: brief, draft, QA, review, CMS draft, publish approval, publish, verification."
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Approved, not started</h2>
          <span className="text-muted-foreground text-xs">
            {eligible.length} ready
            {ineligible.length > 0 ? ` · ${ineligible.length} not content work` : ""}
          </span>
        </div>

        {eligible.length === 0 && ineligible.length === 0 ? (
          <EmptyState>
            Nothing is waiting. Approved recommendations from the Review Queue appear here until
            someone starts work on them.
          </EmptyState>
        ) : null}

        {eligible.length > 0 ? (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {eligible.map(({ recommendation, effective, eligibility, decision }) => (
              <li
                key={recommendation.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <Link
                    href={`/websites/${websiteId}/review/${recommendation.id}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {effective.title}
                  </Link>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                    <span>
                      {humanize(eligibility.eligible ? eligibility.workType : effective.type)}
                    </span>
                    <PriorityBadge priority={effective.priority} />
                    {recommendation.page ? (
                      <span className="font-mono">{recommendation.page.path}</span>
                    ) : null}
                    <span>
                      {humanize(decision.decision)} by {decision.decidedBy.email} ·{" "}
                      {decision.decidedAt.toLocaleDateString("en-GB")}
                    </span>
                  </div>
                </div>
                {canStart ? (
                  <StartContentWorkButton
                    websiteId={websiteId}
                    recommendationId={recommendation.id}
                    compact
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {ineligible.length > 0 ? (
          <details className="text-sm">
            <summary className="text-muted-foreground cursor-pointer">
              {ineligible.length} approved recommendation{ineligible.length === 1 ? "" : "s"} that
              cannot become content work
            </summary>
            <ul className="divide-border border-border mt-2 divide-y rounded-lg border">
              {ineligible.map(({ recommendation, effective, eligibility }) => (
                <li key={recommendation.id} className="space-y-1 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/websites/${websiteId}/review/${recommendation.id}`}
                      className="font-medium hover:underline"
                    >
                      {effective.title}
                    </Link>
                    <span className="text-muted-foreground text-xs">
                      {humanize(effective.type)}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {eligibility.eligible ? "" : eligibility.reason}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Content Work Queue</h2>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">
              {items.length} item{items.length === 1 ? "" : "s"}
            </span>
            <Link
              href={`/websites/${websiteId}/content${showAll ? "" : "?status=all"}`}
              className="hover:underline"
            >
              {showAll ? "Show open only" : "Show all, including finished"}
            </Link>
          </div>
        </div>

        {items.length === 0 ? (
          <EmptyState>
            {showAll
              ? "No content work yet."
              : "No open content work. Start one from an approved recommendation above."}
          </EmptyState>
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-left text-xs tracking-wide uppercase">
                <tr>
                  <th className="px-3 py-2 font-medium">Work item</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Priority</th>
                  <th className="px-3 py-2 font-medium">Recommendation</th>
                  <th className="px-3 py-2 font-medium">Page / Topic</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {items.map((item) => (
                  <tr key={item.id} className="align-top">
                    <td className="px-3 py-2">
                      <Link
                        href={`/websites/${websiteId}/content/${item.id}`}
                        className="font-medium hover:underline"
                      >
                        {item.title}
                      </Link>
                      <div className="text-muted-foreground text-xs">
                        started {item.createdAt.toLocaleDateString("en-GB")}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{humanize(item.type)}</td>
                    <td className="px-3 py-2">
                      <PriorityBadge priority={item.priority} />
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/websites/${websiteId}/review/${item.recommendation.id}`}
                        className="hover:underline"
                      >
                        {item.recommendation.title}
                      </Link>
                      <div className="text-muted-foreground text-xs">
                        {humanize(item.recommendation.type)} ·{" "}
                        {humanize(item.recommendation.status)}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {item.page ? (
                        <Link
                          href={`/websites/${websiteId}/pages/${item.page.id}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {item.page.path}
                        </Link>
                      ) : null}
                      {item.topic ? (
                        <div className="text-muted-foreground text-xs">
                          <Link
                            href={`/websites/${websiteId}/topics/${item.topic.id}`}
                            className="hover:underline"
                          >
                            {item.topic.name}
                          </Link>
                        </div>
                      ) : null}
                      {!item.page && !item.topic ? (
                        <span className="text-muted-foreground text-xs">—</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {item.owner ? (
                        (item.owner.displayName ?? item.owner.email)
                      ) : (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
