import { recordAudit } from "@/server/audit/record";
import type { TenantContext } from "@/server/auth/guards";
import { validateCitations, type CitationAudit } from "@/server/services/citations";
import type { Evidence } from "@/lib/evidence/types";
import type { RecommendationOutput } from "@/lib/ai/schemas/page-diagnosis";
import type { Prisma, Recommendation, SeoRuleSeverity } from "@/generated/prisma/client";

/**
 * RecommendationService (docs/P3_SPEC.md §21–§23, §38).
 *
 * A recommendation is the part of a diagnosis somebody might act on, which makes
 * it the part where an unchecked model answer does the most damage. So nothing a
 * model proposes is stored as proposed. Each guardrail in §23 is enforced here,
 * after the model has answered and before anything is written:
 *
 *   cite evidence          IDs re-resolved against the sealed package; a proposal
 *                          with none surviving is stored as NEEDS_EVIDENCE, not as
 *                          advice
 *   state confidence,      required by the output schema; confidence is lowered
 *   effort, risk           to UNKNOWN when the evidence behind it did not survive
 *   respect SEO Rules      a declared conflict with a BLOCKING rule, or a rule that
 *                          names this page or this kind of change, blocks approval
 *                          until a person overrides it by name
 *   no numeric forecasts   the one field that speaks about the future is stripped
 *                          of any digit
 *   state missing evidence carried through as written
 *   require human review   the only statuses this service can produce are ones a
 *                          reviewer has not yet decided on
 *
 * What it does not do: rank, merge, or improve the proposals. The model's list is
 * the model's list; this service decides what each entry is allowed to claim.
 */

export type RuleInPackage = {
  /** The `rule:` evidence ID as the model saw it. */
  evidenceId: string;
  ruleId: string;
  severity: SeoRuleSeverity;
  appliesTo: string | null;
  category: string | null;
  text: string | null;
};

/**
 * The SEO rules a package contained, in the shape the guardrails need.
 *
 * Derived from the evidence the model was actually shown rather than re-queried,
 * so a rule added after assembly cannot block a recommendation the model never
 * had the chance to respect.
 */
export function rulesInPackage(evidence: Evidence[]): RuleInPackage[] {
  return evidence
    .filter((record) => record.type === "SEO_RULE" && record.sourceEntityId !== null)
    .map((record) => {
      const context = record.contextJson ?? {};
      return {
        evidenceId: record.id,
        ruleId: record.sourceEntityId as string,
        severity: (context.severity as SeoRuleSeverity | undefined) ?? "INFO",
        appliesTo: typeof context.appliesTo === "string" ? context.appliesTo : null,
        category: typeof context.category === "string" ? context.category : null,
        text: record.textValue,
      };
    });
}

export type RecommendationAudit = {
  created: number;
  needsEvidence: number;
  blocked: number;
  forecastsRemoved: number;
};

export type PersistRecommendationsInput = {
  diagnosisId: string;
  aiRunId: string;
  page: { id: string; path: string };
  opportunityId: string | null;
  proposals: RecommendationOutput[];
  /** The sealed package's evidence IDs: the only IDs a proposal may cite. */
  packageIds: Set<string>;
  rules: RuleInPackage[];
  /** Shared with the findings so one report covers the whole answer. */
  citations: CitationAudit;
};

/**
 * Decides whether a BLOCKING rule applies to a proposal without the model's help.
 *
 * Deliberately narrow: an exact match on the page this diagnosis is about, or on
 * the kind of change proposed. A fuzzier match would block things the rule never
 * meant, and a person overriding a rule that did not apply is a person learning
 * to override rules. The model's own declared conflicts cover the judgement calls.
 */
function ruleNamesThis(rule: RuleInPackage, pagePath: string, type: string): boolean {
  const target = rule.appliesTo?.trim().toLowerCase();
  if (!target) return false;

  return target === pagePath.toLowerCase() || target === type.toLowerCase();
}

/** Any digit in a description of the future is a forecast (§23). */
const FORECAST = /\d/;

/**
 * Writes the proposals a diagnosis produced, each held to §23.
 *
 * Runs inside the diagnosis transaction so a diagnosis and its recommendations
 * appear together or not at all.
 */
export async function persistRecommendations(
  tx: Prisma.TransactionClient,
  context: TenantContext,
  input: PersistRecommendationsInput,
): Promise<{ rows: Recommendation[]; audit: RecommendationAudit }> {
  const rows: Recommendation[] = [];
  const audit: RecommendationAudit = {
    created: 0,
    needsEvidence: 0,
    blocked: 0,
    forecastsRemoved: 0,
  };

  const blockingRules = input.rules.filter((rule) => rule.severity === "BLOCKING");
  const ruleByEvidenceId = new Map(input.rules.map((rule) => [rule.evidenceId, rule]));

  for (const proposal of input.proposals) {
    const evidenceIds = await validateCitations(
      context,
      proposal.evidence_ids,
      input.packageIds,
      input.citations,
    );

    // Declared conflicts are validated like any other citation, then narrowed to
    // rules: a model that cites a metric as a "conflicting rule" has not named a
    // rule, and nothing should be blocked on its say-so.
    const declared = await validateCitations(
      context,
      proposal.conflicting_rule_ids,
      input.packageIds,
      input.citations,
    );
    const conflicts = declared
      .map((id) => ruleByEvidenceId.get(id))
      .filter((rule): rule is RuleInPackage => rule !== undefined);

    const blocking =
      conflicts.find((rule) => rule.severity === "BLOCKING") ??
      blockingRules.find((rule) => ruleNamesThis(rule, input.page.path, proposal.type));

    const forecast =
      proposal.expected_effect_description !== null &&
      FORECAST.test(proposal.expected_effect_description);

    const uncited = evidenceIds.length === 0;
    const needsEvidence = uncited || proposal.type === "REQUEST_MORE_EVIDENCE";

    const row = await tx.recommendation.create({
      data: {
        websiteId: context.website.id,
        diagnosisId: input.diagnosisId,
        opportunityId: input.opportunityId,
        pageId: input.page.id,
        type: proposal.type,
        // Never DRAFT: a stored proposal is ready for a person to look at, and
        // never anything a person has not yet decided.
        status: needsEvidence ? "NEEDS_EVIDENCE" : "AWAITING_REVIEW",
        priority: proposal.priority,
        title: proposal.title,
        summary: proposal.summary,
        rationale: proposal.rationale,
        // A number here would be a forecast, and the field is the only place one
        // could hide. Removed rather than rewritten: an effect the model could
        // only express as a figure is an effect it could not justify.
        expectedEffectDescription: forecast ? null : proposal.expected_effect_description,
        // A proposal whose evidence did not survive validation cannot be more
        // confident than the nothing it now rests on.
        confidence: uncited ? "UNKNOWN" : proposal.confidence,
        effort: proposal.effort,
        risk: proposal.risk,
        blockedByRuleId: blocking?.ruleId ?? null,
        blockedReason: blocking
          ? `Conflicts with a BLOCKING SEO rule: ${blocking.text ?? blocking.ruleId}`
          : null,
        createdByAiRunId: input.aiRunId,
      },
    });

    if (evidenceIds.length > 0) {
      await tx.recommendationEvidence.createMany({
        data: evidenceIds.map((evidenceId) => ({ recommendationId: row.id, evidenceId })),
        skipDuplicates: true,
      });
    }

    audit.created += 1;
    if (needsEvidence) audit.needsEvidence += 1;
    if (blocking) audit.blocked += 1;
    if (forecast) audit.forecastsRemoved += 1;

    // RECOMMENDATION_CREATED (§35). Counts and flags, not prose.
    await recordAudit(tx, context, {
      entityType: "Recommendation",
      entityId: row.id,
      action: "CREATE",
      after: {
        diagnosisId: input.diagnosisId,
        type: row.type,
        status: row.status,
        evidenceCount: evidenceIds.length,
        blockedByRuleId: row.blockedByRuleId,
        forecastRemoved: forecast,
        missingEvidence: proposal.missing_evidence.length,
      },
    });

    rows.push(row);
  }

  return { rows, audit };
}
