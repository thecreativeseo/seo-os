import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { listDiagnoses } from "@/server/services/diagnosis";
import { EmptyState, PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import {
  ConfidenceBadge,
  StatusBadge,
  VerdictBadge,
  humanize,
} from "@/components/diagnosis/primitives";

export const metadata = { title: "Diagnoses · SEO OS" };

/**
 * Every diagnosis for the website, newest first (docs/P3_SPEC.md §31, §37).
 *
 * A diagnosis is requested from a page, not from here — it needs a target —
 * so this screen lists and links rather than offering a button that would have
 * to ask "which page?" first.
 */
export default async function DiagnosesPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const diagnoses = await listDiagnoses(context, 100);

  return (
    <main className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Diagnoses"
          description="Why a page performs as it does, in findings that cite their evidence. Requested from a page; decided on in the review queue."
        />
        {context.website.isDemo ? <DemoBadge /> : null}
      </div>

      {diagnoses.length === 0 ? (
        <EmptyState>
          No diagnoses yet. Open a page under Intelligence → Pages and choose “Diagnose this page”.
        </EmptyState>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {diagnoses.map((diagnosis) => {
            const open = diagnosis.recommendations.filter(
              (r) => r.status === "AWAITING_REVIEW" || r.status === "NEEDS_EVIDENCE",
            ).length;
            const lead = diagnosis.findings[0];

            return (
              <li key={diagnosis.id} className="space-y-2 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <Link
                    href={`/websites/${websiteId}/diagnoses/${diagnosis.id}`}
                    className="min-w-0 font-mono text-sm font-medium hover:underline"
                  >
                    {diagnosis.page?.path ?? "Unknown target"}
                  </Link>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <StatusBadge status={diagnosis.status} />
                    <ConfidenceBadge level={diagnosis.overallConfidence} />
                    <span className="text-muted-foreground text-xs">
                      {diagnosis.createdAt.toLocaleDateString("en-GB")}
                    </span>
                  </div>
                </div>
                <p className="text-muted-foreground line-clamp-2 text-sm">
                  {diagnosis.executiveSummary}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {lead ? (
                    <>
                      <span className="font-medium">{humanize(lead.category)}</span>
                      <VerdictBadge verdict={lead.verdict} />
                    </>
                  ) : null}
                  <span className="text-muted-foreground">
                    {diagnosis.findings.length} finding{diagnosis.findings.length === 1 ? "" : "s"}
                    {" · "}
                    {diagnosis.recommendations.length} recommendation
                    {diagnosis.recommendations.length === 1 ? "" : "s"}
                    {open > 0 ? ` · ${open} awaiting a decision` : ""}
                    {diagnosis.aiRunId ? "" : " · no model run"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
