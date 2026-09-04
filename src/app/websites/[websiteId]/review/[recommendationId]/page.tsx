import Link from "next/link";
import { notFound } from "next/navigation";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { getRecommendationForReview } from "@/server/services/decision";
import { PageHeader } from "@/components/governance/primitives";
import { DemoBadge } from "@/components/metrics/primitives";
import { DecisionPanel } from "@/components/review/controls";
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
 * The review screen (docs/P3_SPEC.md §24, §32).
 *
 * Before deciding, the reviewer sees everything §24 lists, in this order:
 * the recommendation with its priority, confidence, effort and risk; the
 * rationale; the evidence it cites, resolved now; the diagnosis and findings it
 * came from, with what they could not know; and every rule in force, BLOCKING
 * first. The decision panel comes last, after all of that, on purpose.
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ websiteId: string; recommendationId: string }>;
}) {
  const { websiteId, recommendationId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  const review = await getRecommendationForReview(context, recommendationId);
  if (!review) notFound();

  const { recommendation, evidence, staleEvidenceIds, diagnosis, rules, decisions } = review;
  const canDecide = hasRole(context.membership.role, REQUIRED.APPROVE);
  const byId = new Map(evidence.map((record) => [record.id, record]));

  return (
    <main className="space-y-10">
      <div>
        <Link
          href={`/websites/${websiteId}/review`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Review queue
        </Link>
      </div>

      {/* ---------------------------------------------------- Recommendation */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader title={recommendation.title} description={recommendation.summary} />
          {context.website.isDemo ? <DemoBadge /> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={recommendation.status} />
          <span className="text-muted-foreground text-xs">{humanize(recommendation.type)}</span>
          <LevelBadge label="Priority" level={recommendation.priority} />
          <ConfidenceBadge level={recommendation.confidence} />
          <LevelBadge label="Effort" level={recommendation.effort} />
          <LevelBadge label="Risk" level={recommendation.risk} />
          {recommendation.page ? (
            <Link
              href={`/websites/${websiteId}/pages/${recommendation.page.id}`}
              className="font-mono text-xs hover:underline"
            >
              {recommendation.page.path}
            </Link>
          ) : null}
        </div>

        {recommendation.blockedByRule ? (
          <p className="rounded-md border border-amber-700/40 p-3 text-sm">
            <span className="font-medium">Blocked by a BLOCKING SEO rule:</span>{" "}
            {recommendation.blockedByRule.rule}
            <span className="text-muted-foreground block text-xs">
              {recommendation.blockedReason}. Approval requires an explicit override naming this
              rule.
            </span>
          </p>
        ) : null}

        {recommendation.status === "NEEDS_EVIDENCE" ? (
          <p className="border-border text-muted-foreground rounded-md border border-dashed p-3 text-sm">
            This proposal has no evidence behind it, or asks for more. It cannot be approved until a
            diagnosis with the missing evidence supports it.
          </p>
        ) : null}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Rationale</h2>
        <p className="text-sm leading-relaxed">{recommendation.rationale}</p>
        {recommendation.expectedEffectDescription ? (
          <p className="text-muted-foreground text-sm">
            <span className="font-medium">Expected effect:</span>{" "}
            {recommendation.expectedEffectDescription}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            No expected effect stated. Any figure the model offered here was removed: the product
            makes no forecasts.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------- Evidence */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Evidence</h2>
        <p className="text-muted-foreground text-xs">
          {evidence.length} record{evidence.length === 1 ? "" : "s"} cited, resolved now. Source and
          reliability on each.
        </p>
        <StaleEvidenceNote ids={staleEvidenceIds} />
        <EvidenceList evidence={evidence} emptyText="Nothing cited." />
      </section>

      {/* --------------------------------------------------------- Diagnosis */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Diagnosis</h2>
          {diagnosis ? (
            <Link
              href={`/websites/${websiteId}/diagnoses/${diagnosis.id}`}
              className="text-sm hover:underline"
            >
              Open the full diagnosis
            </Link>
          ) : null}
        </div>
        {diagnosis ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <ConfidenceBadge level={diagnosis.overallConfidence} />
              <span className="text-muted-foreground text-xs">
                {diagnosis.createdAt.toLocaleString("en-GB")}
              </span>
            </div>
            <p className="text-sm leading-relaxed">{diagnosis.executiveSummary}</p>
            <ul className="space-y-2">
              {diagnosis.findings.map((finding) => (
                <li key={finding.id} className="border-border space-y-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{humanize(finding.category)}</span>
                    <VerdictBadge verdict={finding.verdict} />
                    <ConfidenceBadge level={finding.confidence} />
                    <span className="text-muted-foreground text-xs">
                      {finding.supportingEvidenceCount} supporting ·{" "}
                      {finding.contradictingEvidenceCount} contradicting
                    </span>
                  </div>
                  <p className="text-sm">{finding.summary}</p>
                  <MissingEvidenceList items={finding.missingEvidenceJson} />
                  {finding.evidence.some((link) => byId.has(link.evidenceId)) ? (
                    <p className="text-muted-foreground text-xs">
                      Shares evidence with this recommendation.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Not attached to a diagnosis.</p>
        )}
      </section>

      {/* ------------------------------------------------ Rules / Constraints */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Rules and constraints</h2>
        {rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">No active SEO rules for this website.</p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border text-sm">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className={`flex flex-wrap items-start gap-3 px-4 py-3 ${
                  rule.id === recommendation.blockedByRuleId ? "bg-amber-500/5" : ""
                }`}
              >
                <span
                  className={`inline-flex shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${
                    rule.severity === "BLOCKING"
                      ? "border-amber-700/40 text-amber-700 dark:text-amber-400"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {humanize(rule.severity)}
                </span>
                <span className="min-w-0 flex-1">
                  {rule.rule}
                  <span className="text-muted-foreground block text-xs">
                    {rule.category}
                    {rule.appliesTo ? ` · applies to ${rule.appliesTo}` : ""}
                    {rule.id === recommendation.blockedByRuleId
                      ? " · blocks this recommendation"
                      : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --------------------------------------------------------- Decisions */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Decision</h2>

        {decisions.length > 0 ? (
          <ul className="divide-border border-border divide-y rounded-lg border text-sm">
            {decisions.map((decision) => (
              <li key={decision.id} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={decision.decision} />
                  <span className="text-muted-foreground text-xs">
                    {decision.decidedBy.email} · {decision.decidedAt.toLocaleString("en-GB")}
                  </span>
                </div>
                {decision.reason ? <p>{decision.reason}</p> : null}
                {decision.overriddenRuleId ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Overrode a BLOCKING rule: {decision.overrideReason}
                  </p>
                ) : null}
                {decision.modifiedRecommendationJson ? (
                  <pre className="bg-muted/40 overflow-x-auto rounded-md p-2 text-xs">
                    {JSON.stringify(decision.modifiedRecommendationJson, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <DecisionPanel
          websiteId={websiteId}
          recommendationId={recommendation.id}
          status={recommendation.status}
          blockedRule={
            recommendation.blockedByRule
              ? { id: recommendation.blockedByRule.id, rule: recommendation.blockedByRule.rule }
              : null
          }
          canDecide={canDecide}
        />
      </section>
    </main>
  );
}
