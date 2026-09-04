import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/server/db/prisma";
import { requireWebsiteAccess, websiteScope } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import {
  getDiagnosis,
  getDiagnosisEvidence,
  listDiagnosesForPage,
} from "@/server/services/diagnosis";
import { PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { MarkReviewedButton } from "@/components/diagnosis/controls";
import {
  ConfidenceBadge,
  EvidenceList,
  LevelBadge,
  MissingEvidenceList,
  StaleEvidenceNote,
  StatusBadge,
  VerdictBadge,
  humanize,
} from "@/components/diagnosis/primitives";

/**
 * One diagnosis, in the four sections §31 names: Evidence, Diagnosis,
 * Recommendations, History.
 *
 * Evidence comes first on the page for the same reason it comes first in the
 * pipeline. A finding is only as good as what it cites, and a reader who has
 * seen the records before the verdicts can judge the verdicts. Every record
 * shows its source and its reliability; a finding shows which records support
 * it, which contradict it, and what it could not know.
 */
export default async function DiagnosisPage({
  params,
}: {
  params: Promise<{ websiteId: string; diagnosisId: string }>;
}) {
  const { websiteId, diagnosisId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const diagnosis = await getDiagnosis(context, diagnosisId);
  if (!diagnosis) notFound();

  const [evidenceView, page, recommendations, run] = await Promise.all([
    getDiagnosisEvidence(context, diagnosis.id),
    diagnosis.targetType === "PAGE"
      ? prisma.page.findFirst({
          where: { id: diagnosis.targetId, ...websiteScope(context) },
          select: { id: true, url: true, path: true },
        })
      : Promise.resolve(null),
    prisma.recommendation.findMany({
      where: { diagnosisId: diagnosis.id, ...websiteScope(context) },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      include: { blockedByRule: { select: { id: true, rule: true } } },
    }),
    diagnosis.aiRunId
      ? prisma.aiRun.findFirst({
          where: { id: diagnosis.aiRunId, ...websiteScope(context) },
          select: { provider: true, model: true, promptTemplateVersion: true, status: true },
        })
      : Promise.resolve(null),
  ]);

  const history = page ? await listDiagnosesForPage(context, page.id, 20) : [];
  const byId = new Map((evidenceView?.evidence ?? []).map((record) => [record.id, record]));
  const canReview = hasRole(context.membership.role, REQUIRED.APPROVE);
  const reviewer = diagnosis.reviewedByUserId
    ? await prisma.user.findUnique({
        where: { id: diagnosis.reviewedByUserId },
        select: { email: true },
      })
    : null;

  return (
    <main className="space-y-10">
      <div>
        <Link
          href={`/websites/${websiteId}/diagnoses`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Diagnoses
        </Link>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title={page ? page.path : "Diagnosis"}
            description={diagnosis.executiveSummary}
          />
          {context.website.isDemo ? <DemoBadge /> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={diagnosis.status} />
          <ConfidenceBadge level={diagnosis.overallConfidence} />
          <span className="text-muted-foreground text-xs">
            {diagnosis.createdAt.toLocaleString("en-GB")}
            {run
              ? ` · ${run.provider} ${run.model} · prompt v${run.promptTemplateVersion}`
              : " · no model run"}
            {reviewer ? ` · reviewed by ${reviewer.email}` : ""}
          </span>
          {page ? (
            <Link
              href={`/websites/${websiteId}/pages/${page.id}`}
              className="text-xs hover:underline"
            >
              Open page
            </Link>
          ) : null}
        </div>

        {canReview && diagnosis.status === "AWAITING_REVIEW" ? (
          <MarkReviewedButton websiteId={websiteId} diagnosisId={diagnosis.id} />
        ) : null}
      </div>

      {/* ---------------------------------------------------------- Evidence */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Evidence</h2>
        <p className="text-muted-foreground text-xs">
          {evidenceView?.evidence.length ?? 0} records, sealed
          {evidenceView?.sealedAt ? ` ${evidenceView.sealedAt.toLocaleString("en-GB")}` : ""}.
          Ordered most direct first. This is the whole of what the model was shown.
        </p>
        <StaleEvidenceNote ids={evidenceView?.stale ?? []} />
        {evidenceView?.manifest?.notes.length ? (
          <div className="border-border space-y-1 rounded-md border border-dashed p-3">
            <p className="text-muted-foreground text-xs font-medium">Known gaps at assembly</p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {evidenceView.manifest.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {evidenceView?.manifest?.omitted.length ? (
          <p className="text-muted-foreground text-xs">
            Left out to fit the budget:{" "}
            {evidenceView.manifest.omitted
              .map((entry) => `${entry.count} ${humanize(entry.category).toLowerCase()}`)
              .join(", ")}
            .
          </p>
        ) : null}
        <EvidenceList
          evidence={evidenceView?.evidence ?? []}
          emptyText="No evidence could be assembled for this page."
        />
      </section>

      {/* --------------------------------------------------------- Diagnosis */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Diagnosis</h2>
        {diagnosis.findings.length === 0 ? (
          <p className="text-muted-foreground text-sm">No findings.</p>
        ) : (
          <ul className="space-y-3">
            {diagnosis.findings.map((finding) => {
              const supporting = finding.evidence
                .filter((link) => link.relationship === "SUPPORTS")
                .map((link) => byId.get(link.evidenceId))
                .filter((record): record is NonNullable<typeof record> => record !== undefined);
              const contradicting = finding.evidence
                .filter((link) => link.relationship === "CONTRADICTS")
                .map((link) => byId.get(link.evidenceId))
                .filter((record): record is NonNullable<typeof record> => record !== undefined);

              return (
                <li
                  key={finding.id}
                  className={`border-border space-y-3 rounded-lg border p-4 ${
                    finding.id === diagnosis.primaryFindingId ? "border-foreground/40" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold tracking-wide uppercase">
                      {humanize(finding.category)}
                    </span>
                    <VerdictBadge verdict={finding.verdict} />
                    <ConfidenceBadge level={finding.confidence} />
                    {finding.id === diagnosis.primaryFindingId ? (
                      <span className="text-muted-foreground text-xs">Primary finding</span>
                    ) : null}
                  </div>
                  <p className="font-medium">{finding.title}</p>
                  <p className="text-sm leading-relaxed">{finding.summary}</p>

                  {finding.downgradedFrom ? (
                    <p className="rounded-md border border-amber-700/40 p-2 text-xs">
                      Lowered by SEO OS from {humanize(finding.downgradedFrom).toLowerCase()}.{" "}
                      {finding.downgradeReason}
                    </p>
                  ) : null}

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-1">
                      <p className="text-muted-foreground text-xs font-medium">
                        Supporting evidence ({finding.supportingEvidenceCount})
                      </p>
                      <EvidenceList evidence={supporting} emptyText="None cited." />
                    </div>
                    <div className="space-y-1">
                      <p className="text-muted-foreground text-xs font-medium">
                        Contradicting evidence ({finding.contradictingEvidenceCount})
                      </p>
                      <EvidenceList evidence={contradicting} emptyText="None cited." />
                    </div>
                  </div>

                  <MissingEvidenceList items={finding.missingEvidenceJson} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --------------------------------------------------- Recommendations */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Recommendations</h2>
        {recommendations.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing proposed. A diagnosis with no supportable action says so rather than inventing
            one.
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {recommendations.map((recommendation) => (
              <li key={recommendation.id} className="space-y-2 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <Link
                    href={`/websites/${websiteId}/review/${recommendation.id}`}
                    className="font-medium hover:underline"
                  >
                    {recommendation.title}
                  </Link>
                  <StatusBadge status={recommendation.status} />
                </div>
                <p className="text-muted-foreground text-sm">{recommendation.summary}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground text-xs">
                    {humanize(recommendation.type)}
                  </span>
                  <LevelBadge label="Priority" level={recommendation.priority} />
                  <ConfidenceBadge level={recommendation.confidence} />
                  <LevelBadge label="Effort" level={recommendation.effort} />
                  <LevelBadge label="Risk" level={recommendation.risk} />
                  {recommendation.blockedByRule ? (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      Blocked by rule: {recommendation.blockedByRule.rule}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground text-xs">
          No execution in this phase. A person approves, modifies, rejects, or asks for more
          evidence in the review queue.
        </p>
      </section>

      {/* ----------------------------------------------------------- History */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">History</h2>
        {history.length <= 1 ? (
          <p className="text-muted-foreground text-sm">
            First diagnosis of this page. A newer one will supersede it; this one stays as it was.
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border text-sm">
            {history.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                {entry.id === diagnosis.id ? (
                  <span className="font-medium">This diagnosis</span>
                ) : (
                  <Link
                    href={`/websites/${websiteId}/diagnoses/${entry.id}`}
                    className="hover:underline"
                  >
                    {entry.createdAt.toLocaleString("en-GB")}
                  </Link>
                )}
                <StatusBadge status={entry.status} />
                <ConfidenceBadge level={entry.overallConfidence} />
                {entry.supersedesId ? (
                  <span className="text-muted-foreground text-xs">supersedes an earlier one</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
