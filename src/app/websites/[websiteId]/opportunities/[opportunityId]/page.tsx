import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/server/db/prisma";
import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { getOpportunity, verifyStoredScore } from "@/server/services/opportunity";
import type { SubScore } from "@/lib/opportunity/scoring";
import { PageHeader } from "@/components/governance/primitives";
import { PriorityBadge, ProviderTag, ScoreBreakdown } from "@/components/opportunity/primitives";
import { AssignOwnerForm, StatusActions } from "@/components/opportunity/controls";

export const metadata = { title: "Opportunity · SEO OS" };

/**
 * Opportunity detail.
 *
 * The screen the release rule is really about. Everything shown here was recorded
 * when the opportunity was detected: the evidence, the eight sub-scores, and the
 * sentence explaining each. Nothing is recomputed to look convincing at render
 * time.
 */
export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ websiteId: string; opportunityId: string }>;
}) {
  const { websiteId, opportunityId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const opportunity = await getOpportunity(context, opportunityId);

  // Scoped, so another tenant's id is indistinguishable from one that does not
  // exist.
  if (!opportunity) notFound();

  const canWrite = hasRole(context.membership.role, "MEMBER");
  const inputs = opportunity.scoreInputsJson as { subScores?: SubScore[] } | null;
  const verification = verifyStoredScore(opportunity);

  const members = canWrite
    ? await prisma.organizationMembership.findMany({
        where: { organizationId: context.organization.id, status: "ACTIVE" },
        include: { user: { select: { id: true, email: true, displayName: true } } },
      })
    : [];

  return (
    <main className="space-y-8">
      <div className="space-y-2">
        <Link
          href={`/websites/${websiteId}/opportunities`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Opportunity Queue
        </Link>
        <PageHeader title={opportunity.title} description={opportunity.summary ?? ""} />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <PriorityBadge priority={opportunity.priority} />
        <span className="text-muted-foreground">
          {opportunity.status.replace("_", " ").toLowerCase()}
        </span>
        <span className="text-muted-foreground">Effort: {opportunity.effort}</span>
        <span className="text-muted-foreground">Confidence: {opportunity.confidence}</span>
        <span className="text-muted-foreground">
          Identified {opportunity.identifiedAt.toLocaleDateString("en-GB")}
        </span>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">What this concerns</h2>
        <dl className="divide-border border-border divide-y rounded-lg border text-sm">
          {[
            {
              label: "Keyword",
              value: opportunity.keyword?.keyword ?? null,
              href: opportunity.keyword
                ? `/websites/${websiteId}/keywords/${opportunity.keyword.id}`
                : null,
            },
            {
              label: "Page",
              value: opportunity.page?.path ?? null,
              href: opportunity.page
                ? `/websites/${websiteId}/pages/${opportunity.page.id}`
                : null,
            },
            {
              label: "Topic",
              value: opportunity.topic?.name ?? null,
              href: opportunity.topic
                ? `/websites/${websiteId}/topics/${opportunity.topic.id}`
                : null,
            },
            {
              label: "Business goal",
              value: opportunity.businessGoal?.title ?? null,
              href: null,
            },
          ]
            .filter((row) => row.value !== null)
            .map((row) => (
              <div
                key={row.label}
                className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd>
                  {row.href ? (
                    <Link href={row.href} className="underline underline-offset-4">
                      {row.value}
                    </Link>
                  ) : (
                    row.value
                  )}
                </dd>
              </div>
            ))}
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Why this was identified</h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          {opportunity.expectedEffectDescription}
        </p>

        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left">
                <th className="px-4 py-2 font-medium">Evidence</th>
                <th className="px-3 py-2 font-medium">From</th>
                <th className="px-3 py-2 text-right font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Recorded</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {opportunity.evidence.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-2.5 font-mono text-xs">{row.metricKey}</td>
                  <td className="text-muted-foreground px-3 py-2.5 text-xs">
                    {row.sourceEntityType}
                    <ProviderTag provider={row.sourceProvider} />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {row.numericValue !== null
                      ? Number(row.numericValue).toLocaleString("en-GB")
                      : (row.textValue ?? "—")}
                  </td>
                  <td className="text-muted-foreground px-3 py-2.5 text-xs">
                    {row.capturedAt?.toLocaleDateString("en-GB") ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">How this was scored</h2>

        {inputs?.subScores ? (
          <ScoreBreakdown
            subScores={inputs.subScores}
            score={opportunity.score === null ? null : Number(opportunity.score)}
          />
        ) : (
          <p className="text-sm text-red-600">
            No scoring breakdown was stored for this opportunity, so its priority
            cannot be explained. Re-run detection.
          </p>
        )}

        <p className="text-muted-foreground text-xs">
          Model {opportunity.scoringModelVersion}
          {verification.matches
            ? " · the score above recomputes exactly from these inputs"
            : " · the stored score does not match these inputs; the stored value is shown"}
        </p>
      </section>

      {canWrite ? (
        <section className="space-y-4">
          <h2 className="text-sm font-medium">Decide</h2>

          <StatusActions
            websiteId={websiteId}
            opportunityId={opportunity.id}
            status={opportunity.status}
          />

          <AssignOwnerForm
            websiteId={websiteId}
            opportunityId={opportunity.id}
            currentOwnerId={opportunity.ownerUserId}
            members={members.map((membership) => ({
              id: membership.user.id,
              label: membership.user.displayName ?? membership.user.email,
            }))}
          />
        </section>
      ) : null}
    </main>
  );
}
