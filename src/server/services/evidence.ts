import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import {
  buildEvidenceId,
  parseEvidenceId,
  partitionEvidenceIds,
  type EvidenceId,
} from "@/lib/evidence/id";
import { RELIABILITY_BY_TYPE, type Evidence } from "@/lib/evidence/types";
import { Prisma } from "@/generated/prisma/client";

/**
 * EvidenceService — resolving an evidence ID to the thing it names
 * (docs/P3_SPEC.md §9, §36).
 *
 * This is where the central security property of P3 is actually enforced. Three
 * of the automatic-FAIL conditions are about evidence IDs: hallucinated ones,
 * cross-tenant ones, and ones accepted without validation. They all close here,
 * through one mechanism.
 *
 * An evidence ID is not a token we issued and remember. It is a description of a
 * row. So validating one is a *scoped resolution*: parse it, then go and fetch
 * what it describes inside the caller's tenant scope. That single path handles
 * every failure mode without a separate check for each:
 *
 *   - an ID that does not parse           → refused by the parser
 *   - an ID a model invented              → describes no row, resolves to nothing
 *   - an ID belonging to another tenant   → outside websiteScope, resolves to nothing
 *   - an ID that was valid and now is not → resolves to nothing
 *
 * There is deliberately no code path that turns an evidence ID into a record
 * without going through a website-scoped query. A resolver that trusted the ID
 * because it "came from our own package" would be a resolver that leaks the first
 * time a package is passed the wrong way round.
 *
 * Every query below therefore spreads websiteScope(context) or joins through a
 * row that does. Nothing here takes a websiteId as an argument.
 */

export type ResolutionResult = {
  resolved: Evidence[];
  /** Strings that were not evidence IDs at all. */
  invalid: string[];
  /** Well-formed IDs that name nothing this tenant can see. */
  unresolved: string[];
};

/**
 * Resolves a batch, keeping the three outcomes separate.
 *
 * The distinction matters when validating a model's answer: an unparseable ID
 * suggests the model was improvising, while a well-formed ID that resolves to
 * nothing suggests it was reaching outside the package. Both are refused; they
 * are worth telling apart in a report.
 */
export async function resolveEvidenceIds(
  context: TenantContext,
  raw: unknown[],
): Promise<ResolutionResult> {
  const { valid, invalid } = partitionEvidenceIds(raw);

  const resolved: Evidence[] = [];
  const unresolved: string[] = [];

  for (const candidate of valid) {
    const evidence = await resolveEvidence(context, candidate.id);

    if (evidence) {
      resolved.push(evidence);
    } else {
      unresolved.push(candidate.raw);
    }
  }

  return { resolved, invalid, unresolved };
}

/** Convenience for a single string of unknown provenance. */
export async function resolveEvidenceId(
  context: TenantContext,
  raw: unknown,
): Promise<Evidence | null> {
  const parsed = parseEvidenceId(raw);
  return parsed ? resolveEvidence(context, parsed) : null;
}

export async function resolveEvidence(
  context: TenantContext,
  id: EvidenceId,
): Promise<Evidence | null> {
  switch (id.kind) {
    case "ctx":
      return resolveContext(context, id);
    case "goal":
      return resolveGoal(context, id);
    case "fact":
      return resolveFact(context, id);
    case "rule":
      return resolveRule(context, id);
    case "gsc":
      return resolveGsc(context, id);
    case "ga4":
      return resolveGa4(context, id);
    case "kwm":
      return resolveKeywordMetric(context, id);
    case "rank":
      return resolveRanking(context, id);
    case "own":
      return resolveOwnership(context, id);
    case "topic":
      return resolveTopic(context, id);
    case "comp":
      return resolveCompetitor(context, id);
    case "content":
      return resolveContent(context, id);
    case "signal":
      return resolveSignal(context, id);
    case "opp":
      return resolveOpportunity(context, id);
    case "diag":
      return resolveDiagnosis(context, id);
    case "dec":
      return resolveDecision(context, id);
  }
}

const base = (context: TenantContext, id: EvidenceId) => ({
  id: buildEvidenceId(id),
  websiteId: context.website.id,
});

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

async function resolveContext(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "ctx" }>,
): Promise<Evidence | null> {
  // Joined through BusinessContext, which carries the websiteId. A version id
  // from another tenant finds no row.
  const version = await prisma.businessContextVersion.findFirst({
    where: {
      id: id.contextVersionId,
      status: "APPROVED",
      businessContext: { websiteId: context.website.id },
    },
  });

  if (!version) return null;

  return {
    ...base(context, id),
    type: "BUSINESS_CONTEXT",
    source: "Business Context",
    sourceEntityType: "BusinessContextVersion",
    sourceEntityId: version.id,
    capturedAt: version.approvedAt,
    asOfDate: null,
    metricKey: null,
    numericValue: null,
    textValue: summariseContext(version),
    contextJson: {
      version: version.versionNumber,
      primaryMarket: version.primaryMarket,
      languages: version.languages,
      primaryConversion: version.primaryConversion,
      businessPriorities: version.businessPriorities,
      seoPriorities: version.seoPriorities,
      priorityTopics: version.priorityTopics,
      avoidTopics: version.avoidTopics,
      approvedClaims: version.approvedClaims,
      prohibitedClaims: version.prohibitedClaims,
    },
    reliability: RELIABILITY_BY_TYPE.BUSINESS_CONTEXT,
  };
}

function summariseContext(version: {
  companySummary: string | null;
  productService: string | null;
  primaryCustomer: string | null;
  businessModel: string | null;
}): string {
  return [
    version.companySummary,
    version.productService,
    version.primaryCustomer ? `Primary customer: ${version.primaryCustomer}` : null,
    version.businessModel ? `Business model: ${version.businessModel}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

async function resolveGoal(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "goal" }>,
): Promise<Evidence | null> {
  const goal = await prisma.businessGoal.findFirst({
    where: { id: id.goalId, ...websiteScope(context) },
  });

  if (!goal) return null;

  return {
    ...base(context, id),
    type: "BUSINESS_GOAL",
    source: "Business Goal",
    sourceEntityType: "BusinessGoal",
    sourceEntityId: goal.id,
    capturedAt: goal.createdAt,
    asOfDate: goal.periodStart,
    metricKey: goal.primaryMetric,
    numericValue: goal.baseline === null ? null : Number(goal.baseline),
    textValue: [goal.title, goal.businessObjective, goal.seoOutcome].filter(Boolean).join(" — "),
    contextJson: {
      status: goal.status,
      periodStart: goal.periodStart?.toISOString().slice(0, 10) ?? null,
      periodEnd: goal.periodEnd?.toISOString().slice(0, 10) ?? null,
      leadingIndicator: goal.leadingIndicator,
      baselineSource: goal.baselineSource,
    },
    reliability: RELIABILITY_BY_TYPE.BUSINESS_GOAL,
  };
}

async function resolveFact(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "fact" }>,
): Promise<Evidence | null> {
  const fact = await prisma.brandFact.findFirst({
    where: { id: id.brandFactId, ...websiteScope(context) },
  });

  if (!fact) return null;

  return {
    ...base(context, id),
    type: "BRAND_FACT",
    source: "Brand Fact",
    sourceEntityType: "BrandFact",
    sourceEntityId: fact.id,
    capturedAt: fact.verifiedAt ?? fact.createdAt,
    asOfDate: null,
    metricKey: fact.factKey,
    numericValue: null,
    textValue: fact.value,
    contextJson: {
      category: fact.category,
      approvalStatus: fact.approvalStatus,
      // Provenance travels: an unapproved fact must not be cited as settled.
      provenance: fact.source,
      sourceUrl: fact.sourceUrl,
    },
    reliability: RELIABILITY_BY_TYPE.BRAND_FACT,
  };
}

async function resolveRule(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "rule" }>,
): Promise<Evidence | null> {
  const rule = await prisma.seoRule.findFirst({
    where: { id: id.seoRuleId, ...websiteScope(context) },
  });

  if (!rule) return null;

  return {
    ...base(context, id),
    type: "SEO_RULE",
    source: "SEO Rule",
    sourceEntityType: "SeoRule",
    sourceEntityId: rule.id,
    capturedAt: rule.createdAt,
    asOfDate: rule.effectiveFrom,
    metricKey: null,
    numericValue: null,
    textValue: rule.rule,
    contextJson: {
      category: rule.category,
      severity: rule.severity,
      appliesTo: rule.appliesTo,
      active: rule.active,
    },
    reliability: RELIABILITY_BY_TYPE.SEO_RULE,
  };
}

// ---------------------------------------------------------------------------
// Measurements
//
// A windowed metric names no single row, so resolving one re-runs the same
// aggregate the assembler ran. That is the point: the ID describes a
// calculation over this website's data, and the calculation is what gets
// re-performed under tenant scope. CTR is SUM(clicks)/SUM(impressions) and
// position is impression-weighted, exactly as everywhere else in the product.
// ---------------------------------------------------------------------------

type WindowRow = {
  clicks: bigint | null;
  impressions: bigint | null;
  position: number | null;
};

async function resolveGsc(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "gsc" }>,
): Promise<Evidence | null> {
  const subjectFilter = await gscSubjectFilter(context, id.subject, id.subjectId);
  if (subjectFilter === null) return null;

  const [row] = await prisma.$queryRaw<WindowRow[]>`
    SELECT
      SUM(m.clicks) AS clicks,
      SUM(m.impressions) AS impressions,
      CASE WHEN SUM(m.impressions) > 0
        THEN SUM(m.position * m.impressions) / SUM(m.impressions)
        ELSE NULL END AS position
    FROM gsc_metric_daily m
    WHERE m.website_id = ${context.website.id}::uuid
      AND m.date >= ${id.start}::date
      AND m.date <= ${id.end}::date
      ${subjectFilter}
  `;

  const impressions = Number(row?.impressions ?? 0);
  const clicks = Number(row?.clicks ?? 0);

  // No rows in the window means the ID describes nothing observed. That is an
  // unresolved ID, not a zero: reporting zero clicks we never measured would be
  // fabricating a measurement.
  if (impressions === 0 && clicks === 0) return null;

  return {
    ...base(context, id),
    type: "GSC_METRIC",
    source: "Google Search Console",
    sourceEntityType: "GscMetricDaily",
    sourceEntityId: id.subject === "site" ? null : id.subjectId,
    capturedAt: null,
    asOfDate: new Date(`${id.end}T00:00:00.000Z`),
    metricKey: `gsc_${id.subject}_window`,
    numericValue: clicks,
    textValue: null,
    contextJson: {
      subject: id.subject,
      periodStart: id.start,
      periodEnd: id.end,
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : null,
      position: row?.position === null || row?.position === undefined ? null : Number(row.position),
    },
    reliability: RELIABILITY_BY_TYPE.GSC_METRIC,
  };
}

/**
 * Builds the subject predicate, having first confirmed the subject belongs here.
 *
 * The existence check is not redundant with the website_id filter in the
 * aggregate. Without it, a page id from another tenant would simply match no
 * rows and produce a legitimate-looking empty result; with it, the ID is refused
 * for the right reason.
 */
async function gscSubjectFilter(
  context: TenantContext,
  subject: "page" | "query" | "site",
  subjectId: string,
): Promise<Prisma.Sql | null> {
  if (subject === "site") return Prisma.empty;

  if (subject === "page") {
    const page = await prisma.page.findFirst({
      where: { id: subjectId, ...websiteScope(context) },
      select: { id: true },
    });
    return page ? Prisma.sql`AND m.page_id = ${subjectId}::uuid` : null;
  }

  const query = await prisma.query.findFirst({
    where: { id: subjectId, ...websiteScope(context) },
    select: { id: true },
  });
  return query ? Prisma.sql`AND m.query_id = ${subjectId}::uuid` : null;
}

type Ga4Row = {
  sessions: bigint | null;
  engaged_sessions: bigint | null;
  key_events: bigint | null;
  revenue: number | null;
};

async function resolveGa4(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "ga4" }>,
): Promise<Evidence | null> {
  // GA4 in this product is landing-page scoped; a query subject has no meaning.
  if (id.subject === "query") return null;

  let filter: Prisma.Sql = Prisma.empty;

  if (id.subject === "page") {
    const page = await prisma.page.findFirst({
      where: { id: id.subjectId, ...websiteScope(context) },
      select: { id: true },
    });
    if (!page) return null;
    filter = Prisma.sql`AND g.page_id = ${id.subjectId}::uuid`;
  }

  const [row] = await prisma.$queryRaw<Ga4Row[]>`
    SELECT
      SUM(g.sessions) AS sessions,
      SUM(g.engaged_sessions) AS engaged_sessions,
      SUM(g.key_events) AS key_events,
      SUM(g.revenue) AS revenue
    FROM ga4_landing_page_metric_daily g
    WHERE g.website_id = ${context.website.id}::uuid
      AND g.date >= ${id.start}::date
      AND g.date <= ${id.end}::date
      ${filter}
  `;

  const sessions = Number(row?.sessions ?? 0);
  if (sessions === 0) return null;

  const engaged = Number(row?.engaged_sessions ?? 0);

  return {
    ...base(context, id),
    type: "GA4_METRIC",
    source: "Google Analytics 4",
    sourceEntityType: "Ga4LandingPageMetricDaily",
    sourceEntityId: id.subject === "site" ? null : id.subjectId,
    capturedAt: null,
    asOfDate: new Date(`${id.end}T00:00:00.000Z`),
    metricKey: `ga4_${id.subject}_window`,
    numericValue: sessions,
    textValue: null,
    contextJson: {
      subject: id.subject,
      periodStart: id.start,
      periodEnd: id.end,
      sessions,
      engagedSessions: engaged,
      engagementRate: sessions > 0 ? engaged / sessions : null,
      keyEvents: Number(row?.key_events ?? 0),
      // Null, not zero: many properties do not report revenue at all, and zero
      // would be a claim that nothing was earned.
      revenue: row?.revenue === null || row?.revenue === undefined ? null : Number(row.revenue),
    },
    reliability: RELIABILITY_BY_TYPE.GA4_METRIC,
  };
}

// ---------------------------------------------------------------------------
// Keywords, rankings, competitors
// ---------------------------------------------------------------------------

async function resolveKeywordMetric(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "kwm" }>,
): Promise<Evidence | null> {
  const snapshot = await prisma.keywordMetricsSnapshot.findFirst({
    where: {
      keywordId: id.keywordId,
      sourceProvider: id.provider as never,
      capturedAt: new Date(`${id.capturedAt}T00:00:00.000Z`),
      ...websiteScope(context),
    },
    include: { keyword: { select: { keyword: true, locale: true } } },
  });

  if (!snapshot) return null;

  return {
    ...base(context, id),
    type: "KEYWORD_METRIC",
    source: providerLabel(snapshot.sourceProvider),
    sourceEntityType: "KeywordMetricsSnapshot",
    sourceEntityId: snapshot.id,
    capturedAt: snapshot.createdAt,
    asOfDate: snapshot.capturedAt,
    metricKey: "search_volume",
    numericValue: snapshot.searchVolume,
    textValue: snapshot.keyword.keyword,
    contextJson: {
      keywordId: snapshot.keywordId,
      locale: snapshot.keyword.locale,
      keywordDifficulty:
        snapshot.keywordDifficulty === null ? null : Number(snapshot.keywordDifficulty),
      cpc: snapshot.cpc === null ? null : Number(snapshot.cpc),
      currency: snapshot.currency,
    },
    reliability: RELIABILITY_BY_TYPE.KEYWORD_METRIC,
  };
}

async function resolveRanking(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "rank" }>,
): Promise<Evidence | null> {
  const snapshot = await prisma.rankingSnapshot.findFirst({
    where: {
      keywordId: id.keywordId,
      sourceProvider: id.provider as never,
      capturedAt: new Date(`${id.capturedAt}T00:00:00.000Z`),
      ...websiteScope(context),
    },
    include: { keyword: { select: { keyword: true } } },
  });

  if (!snapshot) return null;

  return {
    ...base(context, id),
    type: "RANKING_SNAPSHOT",
    source: providerLabel(snapshot.sourceProvider),
    sourceEntityType: "RankingSnapshot",
    sourceEntityId: snapshot.id,
    capturedAt: snapshot.createdAt,
    asOfDate: snapshot.capturedAt,
    metricKey: "position",
    numericValue: snapshot.position === null ? null : Number(snapshot.position),
    textValue: snapshot.keyword.keyword,
    contextJson: {
      keywordId: snapshot.keywordId,
      pageId: snapshot.pageId,
      previousPosition:
        snapshot.previousPosition === null ? null : Number(snapshot.previousPosition),
      rankingUrl: snapshot.rankingUrl,
      rankingType: snapshot.rankingType,
    },
    reliability: RELIABILITY_BY_TYPE.RANKING_SNAPSHOT,
  };
}

async function resolveCompetitor(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "comp" }>,
): Promise<Evidence | null> {
  const snapshot = await prisma.competitorKeywordSnapshot.findFirst({
    where: {
      competitorId: id.competitorId,
      keywordId: id.keywordId,
      sourceProvider: id.provider as never,
      capturedAt: new Date(`${id.capturedAt}T00:00:00.000Z`),
      ...websiteScope(context),
    },
    include: {
      competitor: { select: { domain: true } },
      keyword: { select: { keyword: true } },
    },
  });

  if (!snapshot) return null;

  return {
    ...base(context, id),
    type: "COMPETITOR_OBSERVATION",
    source: providerLabel(snapshot.sourceProvider),
    sourceEntityType: "CompetitorKeywordSnapshot",
    sourceEntityId: snapshot.id,
    capturedAt: snapshot.createdAt,
    asOfDate: snapshot.capturedAt,
    metricKey: "competitor_position",
    numericValue: snapshot.position === null ? null : Number(snapshot.position),
    textValue: `${snapshot.competitor.domain} on "${snapshot.keyword.keyword}"`,
    contextJson: {
      competitorDomain: snapshot.competitor.domain,
      keywordId: snapshot.keywordId,
      rankingUrl: snapshot.rankingUrl,
    },
    reliability: RELIABILITY_BY_TYPE.COMPETITOR_OBSERVATION,
  };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

async function resolveOwnership(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "own" }>,
): Promise<Evidence | null> {
  const ownership = await prisma.keywordPageOwnership.findFirst({
    where: { id: id.ownershipId, ...websiteScope(context) },
    include: {
      keyword: { select: { keyword: true } },
      page: { select: { path: true } },
    },
  });

  if (!ownership) return null;

  return {
    ...base(context, id),
    type: "KEYWORD_OWNERSHIP",
    source: "Keyword ownership",
    sourceEntityType: "KeywordPageOwnership",
    sourceEntityId: ownership.id,
    capturedAt: ownership.assignedAt,
    asOfDate: null,
    metricKey: null,
    numericValue: null,
    textValue: `${ownership.page.path} owns "${ownership.keyword.keyword}" (${ownership.ownershipType})`,
    contextJson: {
      keywordId: ownership.keywordId,
      pageId: ownership.pageId,
      ownershipType: ownership.ownershipType,
      status: ownership.status,
      locale: ownership.locale,
    },
    reliability: RELIABILITY_BY_TYPE.KEYWORD_OWNERSHIP,
  };
}

async function resolveTopic(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "topic" }>,
): Promise<Evidence | null> {
  const topic = await prisma.topic.findFirst({
    where: { id: id.topicId, ...websiteScope(context) },
  });

  if (!topic) return null;

  let keywordText: string | null = null;

  if (id.keywordId !== null) {
    const mapping = await prisma.topicKeyword.findFirst({
      where: { topicId: topic.id, keywordId: id.keywordId },
      include: { keyword: { select: { keyword: true, websiteId: true } } },
    });

    // The join goes through Topic, which is scoped — but a keyword from another
    // tenant mapped by accident would still be another tenant's word.
    if (!mapping || mapping.keyword.websiteId !== context.website.id) return null;

    keywordText = mapping.keyword.keyword;
  }

  return {
    ...base(context, id),
    type: "TOPIC_MAPPING",
    source: "Topic map",
    sourceEntityType: "Topic",
    sourceEntityId: topic.id,
    capturedAt: topic.createdAt,
    asOfDate: null,
    metricKey: null,
    numericValue: null,
    textValue: keywordText
      ? `"${keywordText}" belongs to topic "${topic.name}"`
      : `Topic "${topic.name}"`,
    contextJson: { topicId: topic.id, keywordId: id.keywordId },
    reliability: RELIABILITY_BY_TYPE.TOPIC_MAPPING,
  };
}

async function resolveContent(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "content" }>,
): Promise<Evidence | null> {
  const snapshot = await prisma.pageContentSnapshot.findFirst({
    where: {
      pageId: id.pageId,
      contentHash: id.contentHash,
      ...websiteScope(context),
    },
    include: { page: { select: { path: true } } },
  });

  if (!snapshot) return null;

  return {
    ...base(context, id),
    type: "PAGE_CONTENT",
    // FETCH reads the live site; paste and upload are somebody's copy of it.
    // The distinction is carried rather than flattened.
    source: snapshot.source === "FETCH" ? "Page (fetched)" : "Page (supplied)",
    sourceEntityType: "PageContentSnapshot",
    sourceEntityId: snapshot.id,
    capturedAt: snapshot.capturedAt,
    asOfDate: null,
    metricKey: "word_count",
    numericValue: snapshot.wordCount,
    textValue: snapshot.bodyText,
    contextJson: {
      pageId: snapshot.pageId,
      path: snapshot.page.path,
      title: snapshot.title,
      metaDescription: snapshot.metaDescription,
      headings: snapshot.headingsJson,
      captureMethod: snapshot.source,
    },
    reliability:
      snapshot.source === "FETCH"
        ? RELIABILITY_BY_TYPE.PAGE_CONTENT
        : // Pasted or uploaded text is what somebody says the page says.
          "USER_PROVIDED",
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function resolveSignal(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "signal" }>,
): Promise<Evidence | null> {
  const signal = await prisma.signal.findFirst({
    where: { id: id.signalId, ...websiteScope(context) },
  });

  if (!signal) return null;

  return {
    ...base(context, id),
    type: "TECHNICAL_FINDING",
    source: "SEO OS signal",
    sourceEntityType: "Signal",
    sourceEntityId: signal.id,
    capturedAt: signal.detectedAt,
    asOfDate: signal.currentPeriodEnd,
    metricKey: signal.type,
    numericValue: signal.score === null ? null : Number(signal.score),
    textValue: [signal.headline, signal.summary].filter(Boolean).join(" — "),
    contextJson: {
      severity: signal.severity,
      status: signal.status,
      pageId: signal.pageId,
      queryId: signal.queryId,
      currentPeriod: `${signal.currentPeriodStart.toISOString().slice(0, 10)}..${signal.currentPeriodEnd.toISOString().slice(0, 10)}`,
      // A signal is an observation. It has never claimed a cause, and citing one
      // as if it had would undo the distinction P1 was careful to draw.
      note: "Observation only. States no cause.",
    },
    reliability: RELIABILITY_BY_TYPE.TECHNICAL_FINDING,
  };
}

async function resolveOpportunity(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "opp" }>,
): Promise<Evidence | null> {
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: id.opportunityId, ...websiteScope(context) },
  });

  if (!opportunity) return null;

  return {
    ...base(context, id),
    type: "PREVIOUS_CHANGE",
    source: "SEO OS opportunity",
    sourceEntityType: "Opportunity",
    sourceEntityId: opportunity.id,
    capturedAt: opportunity.createdAt,
    asOfDate: null,
    metricKey: opportunity.type,
    numericValue: opportunity.score === null ? null : Number(opportunity.score),
    textValue: [opportunity.title, opportunity.summary].filter(Boolean).join(" — "),
    contextJson: {
      status: opportunity.status,
      priority: opportunity.priority,
      pageId: opportunity.pageId,
      keywordId: opportunity.keywordId,
    },
    reliability: RELIABILITY_BY_TYPE.PREVIOUS_CHANGE,
  };
}

async function resolveDiagnosis(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "diag" }>,
): Promise<Evidence | null> {
  const diagnosis = await prisma.diagnosis.findFirst({
    where: { id: id.diagnosisId, ...websiteScope(context) },
  });

  if (!diagnosis) return null;

  return {
    ...base(context, id),
    type: "PREVIOUS_DIAGNOSIS",
    source: "Previous diagnosis",
    sourceEntityType: "Diagnosis",
    sourceEntityId: diagnosis.id,
    capturedAt: diagnosis.createdAt,
    asOfDate: null,
    metricKey: null,
    numericValue: null,
    textValue: diagnosis.executiveSummary,
    contextJson: {
      status: diagnosis.status,
      overallConfidence: diagnosis.overallConfidence,
      targetType: diagnosis.targetType,
      targetId: diagnosis.targetId,
      reviewed: diagnosis.reviewedAt !== null,
    },
    // AI_INFERRED, per §10. A model's earlier opinion may inform the next one and
    // must never be weighed as a measurement.
    reliability: RELIABILITY_BY_TYPE.PREVIOUS_DIAGNOSIS,
  };
}

async function resolveDecision(
  context: TenantContext,
  id: Extract<EvidenceId, { kind: "dec" }>,
): Promise<Evidence | null> {
  const decision = await prisma.decision.findFirst({
    where: { id: id.decisionId, ...websiteScope(context) },
  });

  if (!decision) return null;

  return {
    ...base(context, id),
    type: "PREVIOUS_CHANGE",
    source: "Human decision",
    sourceEntityType: "Decision",
    sourceEntityId: decision.id,
    capturedAt: decision.decidedAt,
    asOfDate: null,
    metricKey: null,
    numericValue: null,
    textValue: [decision.decision, decision.reason].filter(Boolean).join(" — "),
    contextJson: {
      decision: decision.decision,
      recommendationId: decision.recommendationId,
      overriddenRuleId: decision.overriddenRuleId,
    },
    // A person decided this. It is the most reliable kind of record there is.
    reliability: "USER_PROVIDED",
  };
}

function providerLabel(provider: string): string {
  return provider
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}
