import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { computeReadiness, type Readiness, type ReadinessSnapshot } from "@/lib/readiness/compute";
import { getCurrentApproved, getOpenDraft } from "@/server/services/business-context";
import { PROVIDER_COUNT, countConnected } from "@/server/services/connections";

/**
 * Gathers the facts the readiness calculation needs, then hands them to the pure
 * function. All counting rules live in compute.ts; this file only reads.
 */
export async function getReadiness(context: TenantContext): Promise<Readiness> {
  const scope = websiteScope(context);

  const [
    approved,
    draft,
    competitorCount,
    activeGoalCount,
    draftGoalCount,
    approvedBrandFactCount,
    proposedBrandFactCount,
    activeSeoRuleCount,
    connectedProviderCount,
  ] = await Promise.all([
    getCurrentApproved(context.website.id),
    getOpenDraft(context.website.id),
    prisma.competitor.count({ where: { ...scope, archivedAt: null } }),
    prisma.businessGoal.count({ where: { ...scope, status: "ACTIVE", archivedAt: null } }),
    prisma.businessGoal.count({ where: { ...scope, status: "DRAFT", archivedAt: null } }),
    prisma.brandFact.count({
      where: { ...scope, approvalStatus: "APPROVED", archivedAt: null },
    }),
    prisma.brandFact.count({
      where: { ...scope, approvalStatus: "PROPOSED", archivedAt: null },
    }),
    prisma.seoRule.count({ where: { ...scope, active: true, archivedAt: null } }),
    countConnected(context),
  ]);

  // Context fields are read from the published version when one exists, and from the
  // open draft otherwise — a draft answer is real, it just is not canonical yet.
  const contextSource = approved ?? draft;

  const snapshot: ReadinessSnapshot = {
    hasDomain: context.website.normalizedDomain.length > 0,
    hasWebsiteType: context.website.websiteType !== null,
    hasApprovedContext: approved !== null,
    hasPrimaryCustomer: Boolean(contextSource?.primaryCustomer),
    hasPrimaryConversion: Boolean(contextSource?.primaryConversion),
    hasPrimaryMarket: Boolean(contextSource?.primaryMarket),
    competitorCount,
    activeGoalCount,
    draftGoalCount,
    approvedBrandFactCount,
    proposedBrandFactCount,
    activeSeoRuleCount,
    connectedProviderCount,
    providerCount: PROVIDER_COUNT,
  };

  return computeReadiness(snapshot);
}
