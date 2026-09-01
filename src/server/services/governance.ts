import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { normalizeDomain } from "@/lib/domain/normalize-domain";
import { requireTenantMember, websiteScope, type TenantContext } from "@/server/auth/guards";
import type {
  BrandFact,
  BusinessGoal,
  Competitor,
  SeoRule,
  TechnicalContext,
} from "@/generated/prisma/client";

/**
 * Governance entities (docs/P0_SPEC.md §12, §14–§17).
 *
 * Shared rules across all of them:
 *
 *   - Every read and write is scoped with websiteScope(), which re-asserts the
 *     website -> workspace -> organization chain. A child id from another tenant
 *     resolves to nothing rather than leaking.
 *   - Mutation and audit event share one transaction.
 *   - Unknown values stay null. Nothing is inferred, classified, or defaulted into
 *     a business fact.
 *   - Archiving is a soft delete: history stays retrievable.
 */

export class GovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceError";
  }
}

async function ensureOwner(context: TenantContext, ownerUserId?: string | null) {
  if (!ownerUserId) return null;
  // An owner must be a member of THIS organization — never a user id from elsewhere.
  await requireTenantMember(context, ownerUserId);
  return ownerUserId;
}

/* ------------------------------------------------------------------ goals */

export type GoalInput = {
  title: string;
  description?: string | null;
  businessObjective?: string | null;
  seoOutcome?: string | null;
  primaryMetric?: string | null;
  leadingIndicator?: string | null;
  baseline?: string | null;
  baselineSource?: string | null;
  ownerUserId?: string | null;
};

export async function listGoals(context: TenantContext): Promise<BusinessGoal[]> {
  return prisma.businessGoal.findMany({
    where: { ...websiteScope(context), archivedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

export async function createGoal(
  context: TenantContext,
  input: GoalInput,
): Promise<BusinessGoal> {
  const ownerUserId = await ensureOwner(context, input.ownerUserId);

  return prisma.$transaction(async (tx) => {
    const goal = await tx.businessGoal.create({
      data: {
        websiteId: context.website.id,
        title: input.title,
        description: input.description ?? null,
        businessObjective: input.businessObjective ?? null,
        seoOutcome: input.seoOutcome ?? null,
        primaryMetric: input.primaryMetric ?? null,
        leadingIndicator: input.leadingIndicator ?? null,
        // An unknown baseline stays null. A zero would be a fabricated measurement.
        baseline: input.baseline ? input.baseline : null,
        baselineSource: input.baselineSource ?? null,
        ownerUserId,
        status: "DRAFT",
      },
    });

    await recordAudit(tx, context, {
      entityType: "BusinessGoal",
      entityId: goal.id,
      action: "CREATE",
      after: { title: goal.title, status: goal.status },
    });

    return goal;
  });
}

export async function updateGoal(
  context: TenantContext,
  goalId: string,
  input: Partial<GoalInput> & { status?: BusinessGoal["status"] },
): Promise<BusinessGoal> {
  const existing = await prisma.businessGoal.findFirst({
    where: { id: goalId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new GovernanceError("That goal is not available.");
  }

  const ownerUserId =
    input.ownerUserId === undefined
      ? existing.ownerUserId
      : await ensureOwner(context, input.ownerUserId);

  return prisma.$transaction(async (tx) => {
    const goal = await tx.businessGoal.update({
      where: { id: existing.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.businessObjective !== undefined
          ? { businessObjective: input.businessObjective }
          : {}),
        ...(input.primaryMetric !== undefined ? { primaryMetric: input.primaryMetric } : {}),
        ...(input.baseline !== undefined ? { baseline: input.baseline || null } : {}),
        ...(input.baselineSource !== undefined
          ? { baselineSource: input.baselineSource }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ownerUserId,
      },
    });

    await recordAudit(tx, context, {
      entityType: "BusinessGoal",
      entityId: goal.id,
      action: "UPDATE",
      before: { title: existing.title, status: existing.status },
      after: { title: goal.title, status: goal.status },
    });

    return goal;
  });
}

export async function retireGoal(
  context: TenantContext,
  goalId: string,
): Promise<BusinessGoal> {
  const existing = await prisma.businessGoal.findFirst({
    where: { id: goalId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new GovernanceError("That goal is not available.");
  }

  return prisma.$transaction(async (tx) => {
    const goal = await tx.businessGoal.update({
      where: { id: existing.id },
      data: { status: "RETIRED", archivedAt: new Date() },
    });

    await recordAudit(tx, context, {
      entityType: "BusinessGoal",
      entityId: goal.id,
      action: "RETIRE",
      before: { status: existing.status },
      after: { status: goal.status },
    });

    return goal;
  });
}

/* ------------------------------------------------------------- brand facts */

export type BrandFactInput = {
  category: string;
  factKey: string;
  value: string;
  sourceUrl?: string | null;
};

export async function listBrandFacts(context: TenantContext): Promise<BrandFact[]> {
  return prisma.brandFact.findMany({
    where: { ...websiteScope(context), archivedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * A new fact is PROPOSED, never canonical. sourceUrl is optional and recorded
 * exactly as given — nothing here invents a citation.
 */
export async function proposeBrandFact(
  context: TenantContext,
  input: BrandFactInput,
): Promise<BrandFact> {
  return prisma.$transaction(async (tx) => {
    const fact = await tx.brandFact.create({
      data: {
        websiteId: context.website.id,
        category: input.category,
        factKey: input.factKey,
        value: input.value,
        sourceUrl: input.sourceUrl || null,
        source: "USER_PROVIDED",
        approvalStatus: "PROPOSED",
        ownerUserId: context.user.id,
      },
    });

    await recordAudit(tx, context, {
      entityType: "BrandFact",
      entityId: fact.id,
      action: "CREATE",
      after: { factKey: fact.factKey, approvalStatus: fact.approvalStatus },
    });

    return fact;
  });
}

export async function decideBrandFact(
  context: TenantContext,
  factId: string,
  decision: "APPROVED" | "REJECTED",
): Promise<BrandFact> {
  if (context.membership.role !== "OWNER" && context.membership.role !== "ADMIN") {
    throw new GovernanceError("You do not have permission to approve brand facts.");
  }

  const existing = await prisma.brandFact.findFirst({
    where: { id: factId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new GovernanceError("That fact is not available.");
  }

  return prisma.$transaction(async (tx) => {
    const fact = await tx.brandFact.update({
      where: { id: existing.id },
      data: {
        approvalStatus: decision,
        // verifiedAt records when a human confirmed it, only on approval.
        verifiedAt: decision === "APPROVED" ? new Date() : null,
      },
    });

    await recordAudit(tx, context, {
      entityType: "BrandFact",
      entityId: fact.id,
      action: decision === "APPROVED" ? "APPROVE" : "REJECT",
      before: { approvalStatus: existing.approvalStatus },
      after: { approvalStatus: fact.approvalStatus },
    });

    return fact;
  });
}

export async function archiveBrandFact(
  context: TenantContext,
  factId: string,
): Promise<BrandFact> {
  const existing = await prisma.brandFact.findFirst({
    where: { id: factId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new GovernanceError("That fact is not available.");
  }

  return prisma.$transaction(async (tx) => {
    const fact = await tx.brandFact.update({
      where: { id: existing.id },
      data: { approvalStatus: "ARCHIVED", archivedAt: new Date() },
    });

    await recordAudit(tx, context, {
      entityType: "BrandFact",
      entityId: fact.id,
      action: "ARCHIVE",
      before: { approvalStatus: existing.approvalStatus },
      after: { approvalStatus: fact.approvalStatus },
    });

    return fact;
  });
}

/** Only approved facts are canonical (P0_SPEC.md §14). */
export async function listCanonicalBrandFacts(
  context: TenantContext,
): Promise<BrandFact[]> {
  return prisma.brandFact.findMany({
    where: { ...websiteScope(context), approvalStatus: "APPROVED", archivedAt: null },
    orderBy: { factKey: "asc" },
  });
}

/* ------------------------------------------------------------- competitors */

export type CompetitorInput = {
  name: string;
  domain?: string | null;
  notes?: string | null;
  type?: Competitor["type"];
};

export async function listCompetitors(context: TenantContext): Promise<Competitor[]> {
  return prisma.competitor.findMany({
    where: { ...websiteScope(context), archivedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

export async function addCompetitor(
  context: TenantContext,
  input: CompetitorInput,
): Promise<Competitor> {
  const normalized = input.domain ? normalizeDomain(input.domain) : null;

  return prisma.$transaction(async (tx) => {
    const competitor = await tx.competitor.create({
      data: {
        websiteId: context.website.id,
        name: input.name,
        domain: input.domain || null,
        normalizedDomain: normalized?.ok ? normalized.normalized : null,
        notes: input.notes || null,
        // P0 does not classify competitors. A type is recorded only when a human
        // chooses one; otherwise it stays UNKNOWN.
        type: input.type ?? "UNKNOWN",
        providedByUser: true,
        source: "USER_PROVIDED",
      },
    });

    await recordAudit(tx, context, {
      entityType: "Competitor",
      entityId: competitor.id,
      action: "CREATE",
      after: { name: competitor.name, type: competitor.type },
    });

    return competitor;
  });
}

export async function updateCompetitor(
  context: TenantContext,
  competitorId: string,
  input: CompetitorInput,
): Promise<Competitor> {
  const existing = await prisma.competitor.findFirst({
    where: { id: competitorId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new GovernanceError("That competitor is not available.");
  }

  const normalized = input.domain ? normalizeDomain(input.domain) : null;

  return prisma.$transaction(async (tx) => {
    const competitor = await tx.competitor.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        domain: input.domain || null,
        normalizedDomain: normalized?.ok ? normalized.normalized : null,
        notes: input.notes || null,
        type: input.type ?? existing.type,
      },
    });

    await recordAudit(tx, context, {
      entityType: "Competitor",
      entityId: competitor.id,
      action: "UPDATE",
      before: { name: existing.name, type: existing.type },
      after: { name: competitor.name, type: competitor.type },
    });

    return competitor;
  });
}

export async function archiveCompetitor(
  context: TenantContext,
  competitorId: string,
): Promise<Competitor> {
  const existing = await prisma.competitor.findFirst({
    where: { id: competitorId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new GovernanceError("That competitor is not available.");
  }

  return prisma.$transaction(async (tx) => {
    const competitor = await tx.competitor.update({
      where: { id: existing.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    await recordAudit(tx, context, {
      entityType: "Competitor",
      entityId: competitor.id,
      action: "ARCHIVE",
      before: { status: existing.status },
      after: { status: competitor.status },
    });

    return competitor;
  });
}

/* --------------------------------------------------------------- seo rules */

export type SeoRuleInput = {
  category: string;
  rule: string;
  severity: SeoRule["severity"];
  appliesTo?: string | null;
};

export async function listSeoRules(context: TenantContext): Promise<SeoRule[]> {
  return prisma.seoRule.findMany({
    where: { ...websiteScope(context), archivedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

export async function createSeoRule(
  context: TenantContext,
  input: SeoRuleInput,
): Promise<SeoRule> {
  return prisma.$transaction(async (tx) => {
    const rule = await tx.seoRule.create({
      data: {
        websiteId: context.website.id,
        category: input.category,
        rule: input.rule,
        severity: input.severity,
        appliesTo: input.appliesTo || null,
        ownerUserId: context.user.id,
        active: true,
      },
    });

    await recordAudit(tx, context, {
      entityType: "SeoRule",
      entityId: rule.id,
      action: "CREATE",
      after: { rule: rule.rule, severity: rule.severity },
    });

    return rule;
  });
}

export async function setSeoRuleActive(
  context: TenantContext,
  ruleId: string,
  active: boolean,
): Promise<SeoRule> {
  const existing = await prisma.seoRule.findFirst({
    where: { id: ruleId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new GovernanceError("That rule is not available.");
  }

  return prisma.$transaction(async (tx) => {
    const rule = await tx.seoRule.update({
      where: { id: existing.id },
      data: { active },
    });

    await recordAudit(tx, context, {
      entityType: "SeoRule",
      entityId: rule.id,
      action: "UPDATE",
      before: { active: existing.active },
      after: { active: rule.active },
    });

    return rule;
  });
}

/* ------------------------------------------------------- technical context */

export type TechnicalContextInput = {
  hostingNotes?: string | null;
  knownMigrations?: string | null;
  knownConstraints?: string | null;
  stagingAvailable?: boolean | null;
  developerContact?: string | null;
  publicationProcess?: string | null;
  technicalNotes?: string | null;
};

export async function getTechnicalContext(
  context: TenantContext,
): Promise<TechnicalContext | null> {
  return prisma.technicalContext.findUnique({
    where: { websiteId: context.website.id },
  });
}

/**
 * Shell only. Every field here is something a human told us. P0 must not infer
 * crawl, indexation, or technical health (P0_SPEC.md §17).
 */
export async function saveTechnicalContext(
  context: TenantContext,
  input: TechnicalContextInput,
): Promise<TechnicalContext> {
  const existing = await getTechnicalContext(context);

  const data = {
    hostingNotes: input.hostingNotes || null,
    knownMigrations: input.knownMigrations || null,
    knownConstraints: input.knownConstraints || null,
    stagingAvailable: input.stagingAvailable ?? null,
    developerContact: input.developerContact || null,
    publicationProcess: input.publicationProcess || null,
    technicalNotes: input.technicalNotes || null,
  };

  return prisma.$transaction(async (tx) => {
    const saved = await tx.technicalContext.upsert({
      where: { websiteId: context.website.id },
      update: data,
      create: {
        ...data,
        websiteId: context.website.id,
        cms: context.website.cmsType,
        ownerUserId: context.user.id,
      },
    });

    await recordAudit(tx, context, {
      entityType: "TechnicalContext",
      entityId: saved.id,
      action: existing ? "UPDATE" : "CREATE",
      after: { stagingAvailable: saved.stagingAvailable },
    });

    return saved;
  });
}
