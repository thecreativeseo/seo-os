import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { SYSTEM_AUTH_USER_ID } from "@/server/jobs/system-context";
import { runAgent } from "@/server/services/ai-run";
import {
  assembleContentBriefPackage,
  getPackage,
  renderPackage,
  sealPackage,
  type AssembledPackage,
  type RetrievalManifest,
} from "@/server/services/evidence-assembler";
import { resolveEvidenceIds } from "@/server/services/evidence";
import {
  emptyCitationAudit,
  validateCitations,
  type CitationAudit,
} from "@/server/services/citations";
import { ContentWorkError, transitionWorkItem } from "@/server/services/content-work";
import { BRIEF_TRANSITIONS, canTransition } from "@/lib/execution/statuses";
import { reliabilityRank, type Evidence } from "@/lib/evidence/types";
import {
  CONTENT_BRIEF_SCHEMA_NAME,
  CONTENT_TYPES,
  SEARCH_INTENTS,
  contentBriefSchema,
  type BriefSection,
  type ContentBriefOutput,
} from "@/lib/ai/schemas/content-brief";
import { Prisma } from "@/generated/prisma/client";
import type {
  AiRun,
  ContentBrief,
  ContentBriefStatus,
  ContentWorkItem,
  EvidenceCategory,
  KeywordIntent,
} from "@/generated/prisma/client";

/**
 * ContentBriefService (docs/P4_SPEC.md §7, §8, §11).
 *
 * A brief is the governed statement of what a piece of content must do and
 * must not do. Two things make it trustworthy. First, everything that
 * constrains the writer - claims, prohibitions, rules, link targets - is tied
 * to an evidence record in a sealed package, and the server drops anything the
 * model cited that is not in that package, not in this tenant, or not the
 * kind of record that field may rest on. Second, an approved version never
 * changes: editing it creates the next version, and approving that one
 * supersedes the last. "What did the AI see when it wrote this?" is always
 * answerable from the row: the run, the package, the policy, the context
 * version.
 */

export class ContentBriefError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_state"
      | "generation_failed"
      | "version_conflict"
      | "nothing_changed",
  ) {
    super(message);
    this.name = "ContentBriefError";
  }
}

// ---------------------------------------------------------------------------
// The shapes stored in the brief's JSON columns
// ---------------------------------------------------------------------------

export type CitedClaim = { text: string; evidenceId: string; source: string };
export type ProhibitedClaim = {
  text: string;
  evidenceId: string | null;
  source: "BUSINESS_CONTEXT" | "AVOID_TOPIC" | "SEO_RULE";
};
export type RuleConstraint = {
  ruleId: string;
  evidenceId: string;
  severity: string;
  rule: string;
  /** What the rule means for this piece, in the model's words, when it said. */
  constraint: string | null;
};
export type LinkTarget = {
  pageId: string;
  path: string | null;
  evidenceId: string;
  anchorText: string;
  reason: string;
};

/** What happened to the IDs the model cited, field by field. */
export type BriefCitations = CitationAudit & {
  /** Real records from the package, cited for a field they cannot support. */
  wrongField: string[];
};

/** The fields a person edits by hand. Evidence-backed fields are not among them. */
export type BriefInput = {
  title: string;
  contentType: string;
  searchIntent: KeywordIntent | null;
  primaryConversion: string | null;
  audience: string | null;
  customerProblem: string | null;
  desiredOutcome: string | null;
  recommendedAngle: string | null;
  keyQuestions: string[];
  requiredSections: BriefSection[];
  optionalSections: BriefSection[];
  externalEvidenceRequirements: string[];
  brandVoiceNotes: string | null;
};

const EDITABLE_FIELDS = [
  "title",
  "contentType",
  "searchIntent",
  "primaryConversion",
  "audience",
  "customerProblem",
  "desiredOutcome",
  "recommendedAngle",
  "keyQuestionsJson",
  "requiredSectionsJson",
  "optionalSectionsJson",
  "externalEvidenceRequirementsJson",
  "brandVoiceNotes",
] as const;

const EVIDENCE_FIELDS = [
  "internalLinkTargetsJson",
  "approvedClaimsJson",
  "prohibitedClaimsJson",
  "seoRuleConstraintsJson",
  "secondaryKeywordIdsJson",
] as const;

/** Human labels for the changed-fields summary between versions. */
export const BRIEF_FIELD_LABELS: Record<string, string> = {
  title: "Title",
  contentType: "Content type",
  searchIntent: "Search intent",
  primaryConversion: "Primary conversion",
  audience: "Audience",
  customerProblem: "Customer problem",
  desiredOutcome: "Desired outcome",
  recommendedAngle: "Recommended angle",
  keyQuestionsJson: "Key questions",
  requiredSectionsJson: "Required sections",
  optionalSectionsJson: "Optional sections",
  externalEvidenceRequirementsJson: "External evidence requirements",
  brandVoiceNotes: "Brand voice notes",
  internalLinkTargetsJson: "Internal link targets",
  approvedClaimsJson: "Approved claims",
  prohibitedClaimsJson: "Prohibited claims",
  seoRuleConstraintsJson: "SEO rule constraints",
  secondaryKeywordIdsJson: "Secondary keywords",
  businessGoalId: "Business goal",
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireWrite(context: TenantContext): void {
  if (!hasRole(context.membership.role, REQUIRED.WRITE)) {
    throw new ContentBriefError("You do not have permission to work on briefs.", "forbidden");
  }
}

/**
 * Approval is a person's act (§11: the agent cannot approve). REVIEW is the
 * role; the system actor, whatever role its in-memory membership carries, is
 * refused by identity so no job can ever approve a brief.
 */
function requireHumanReviewer(context: TenantContext): void {
  if (context.user.authUserId === SYSTEM_AUTH_USER_ID) {
    throw new ContentBriefError("A brief can only be approved by a person.", "forbidden");
  }
  if (!hasRole(context.membership.role, REQUIRED.REVIEW)) {
    throw new ContentBriefError(
      "Only an SEO lead, admin or owner can approve a brief.",
      "forbidden",
    );
  }
}

const BRIEFABLE: ContentWorkItem["status"][] = ["QUEUED", "BRIEFING", "DRAFTING"];

async function briefableItem(context: TenantContext, workItemId: string): Promise<ContentWorkItem> {
  const item = await prisma.contentWorkItem.findFirst({
    where: { id: workItemId, ...websiteScope(context) },
  });

  if (!item) {
    throw new ContentWorkError("That work item is not available.", "not_found");
  }

  if (!BRIEFABLE.includes(item.status)) {
    throw new ContentBriefError(
      `A brief cannot be written for work that is ${item.status.toLowerCase().replace(/_/g, " ")}.`,
      "invalid_state",
    );
  }

  return item;
}

async function scopedBrief(context: TenantContext, briefId: string): Promise<ContentBrief> {
  const brief = await prisma.contentBrief.findFirst({
    where: { id: briefId, ...websiteScope(context) },
  });

  if (!brief) {
    throw new ContentBriefError("That brief is not available.", "not_found");
  }

  return brief;
}

/** The next version number, decided inside the caller's transaction. */
async function nextVersion(tx: Prisma.TransactionClient, workItemId: string): Promise<number> {
  const last = await tx.contentBrief.aggregate({
    where: { contentWorkItemId: workItemId },
    _max: { version: true },
  });
  return (last._max.version ?? 0) + 1;
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ---------------------------------------------------------------------------
// Generation (§7, §8)
// ---------------------------------------------------------------------------

/** The task block: what a person approved, in their words. Everything else is evidence. */
function buildTask(
  item: ContentWorkItem,
  page: { url: string; path: string } | null,
  effectiveTitle: string,
): string {
  const lines = [
    `Write a content brief for one work item on this website.`,
    ``,
    `Work item type: ${item.type}`,
    `Work item title (approved by a person): ${effectiveTitle}`,
    `Objective (approved by a person): ${item.objective}`,
    page
      ? `Target page: ${page.url} (path ${page.path}). This is existing content: say what changes and what stays.`
      : `Target page: none. This is new content; the brief describes a page that does not exist yet.`,
    item.keywordId
      ? `Primary keyword: the keyword named in the package's ownership and demand records for this work.`
      : `Primary keyword: none named. Choose nothing; say so in missing_evidence.`,
    ``,
    `Use only the evidence package. Cite evidence IDs exactly as they appear.`,
  ];
  return lines.join("\n");
}

type Materialised = {
  columns: Pick<
    Prisma.ContentBriefUncheckedCreateInput,
    | "title"
    | "contentType"
    | "searchIntent"
    | "primaryConversion"
    | "audience"
    | "customerProblem"
    | "desiredOutcome"
    | "recommendedAngle"
    | "keyQuestionsJson"
    | "requiredSectionsJson"
    | "optionalSectionsJson"
    | "internalLinkTargetsJson"
    | "externalEvidenceRequirementsJson"
    | "approvedClaimsJson"
    | "prohibitedClaimsJson"
    | "brandVoiceNotes"
    | "seoRuleConstraintsJson"
    | "secondaryKeywordIdsJson"
    | "businessGoalId"
  >;
  citations: BriefCitations;
};

const CLAIM_SOURCES: EvidenceCategory[] = ["BRAND_FACT", "BUSINESS_CONTEXT"];
const PROHIBITION_SOURCES: EvidenceCategory[] = ["BUSINESS_CONTEXT", "SEO_RULE"];
const RULE_SOURCES: EvidenceCategory[] = ["SEO_RULE"];
const LINK_SOURCES: EvidenceCategory[] = ["KEYWORD_OWNERSHIP", "PAGE_CONTENT"];
const KEYWORD_SOURCES: EvidenceCategory[] = [
  "KEYWORD_METRIC",
  "KEYWORD_OWNERSHIP",
  "TOPIC_MAPPING",
];

function contextString(record: Evidence | undefined, key: string): string | null {
  const value = record?.contextJson?.[key];
  return typeof value === "string" ? value : null;
}

function contextStrings(record: Evidence | undefined, key: string): string[] {
  const value = record?.contextJson?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function dedupeByText<T extends { text: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.text.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Turns the model's answer into columns, keeping only what the package can
 * vouch for (§6 of the M3 brief). Each evidence-backed field has its own list
 * of categories it may cite; a real record cited for the wrong field is
 * dropped and counted, just as a fabricated ID is.
 *
 * Two fields are canonical before the model gets a say. Prohibited claims
 * always include the approved context's prohibited claims and avoid-topics;
 * the model may add phrasing that cites the context or a rule, never a new
 * prohibition of its own. SEO rule constraints always include every rule in
 * the package; the model contributes what each means for this piece.
 */
async function materialise(
  context: TenantContext,
  output: ContentBriefOutput,
  assembled: AssembledPackage,
  item: ContentWorkItem,
): Promise<Materialised> {
  const index = new Map(assembled.evidence.map((record) => [record.id, record]));
  const packageIds = new Set(index.keys());
  const citations: BriefCitations = { ...emptyCitationAudit(), wrongField: [] };

  const cited = async (ids: string[], allowed: EvidenceCategory[]): Promise<Set<string>> => {
    const accepted = await validateCitations(context, ids, packageIds, citations);
    const kept = new Set<string>();
    for (const id of accepted) {
      const record = index.get(id);
      if (record && allowed.includes(record.type)) kept.add(id);
      else citations.wrongField.push(id);
    }
    return kept;
  };

  // Approved claims: only facts and the approved context can back one. If the
  // model cited nothing usable, the approved facts themselves are the list.
  const claimIds = await cited(
    output.approved_claims.map((row) => row.evidence_id),
    CLAIM_SOURCES,
  );
  let approvedClaims: CitedClaim[] = dedupeByText(
    output.approved_claims
      .filter((row) => claimIds.has(row.evidence_id))
      .map((row) => ({
        text: row.text,
        evidenceId: row.evidence_id,
        source: index.get(row.evidence_id)!.type,
      })),
  );
  if (approvedClaims.length === 0) {
    approvedClaims = assembled.evidence
      .filter((record) => record.type === "BRAND_FACT" && record.textValue)
      .map((record) => ({ text: record.textValue!, evidenceId: record.id, source: record.type }));
  }

  // Prohibited claims: the canonical list first, then what the model added
  // with a real context or rule record behind it.
  const contextRecord = assembled.evidence.find((record) => record.type === "BUSINESS_CONTEXT");
  const canonicalProhibited: ProhibitedClaim[] = [
    ...contextStrings(contextRecord, "prohibitedClaims").map((text) => ({
      text,
      evidenceId: contextRecord?.id ?? null,
      source: "BUSINESS_CONTEXT" as const,
    })),
    ...contextStrings(contextRecord, "avoidTopics").map((text) => ({
      text: `Avoid the topic: ${text}`,
      evidenceId: contextRecord?.id ?? null,
      source: "AVOID_TOPIC" as const,
    })),
  ];
  const prohibitedIds = await cited(
    output.prohibited_claims.map((row) => row.evidence_id),
    PROHIBITION_SOURCES,
  );
  const prohibitedClaims = dedupeByText<ProhibitedClaim>([
    ...canonicalProhibited,
    ...output.prohibited_claims
      .filter((row) => prohibitedIds.has(row.evidence_id))
      .map((row) => ({
        text: row.text,
        evidenceId: row.evidence_id,
        source: (index.get(row.evidence_id)!.type === "SEO_RULE"
          ? "SEO_RULE"
          : "BUSINESS_CONTEXT") as ProhibitedClaim["source"],
      })),
  ]);

  // Rules: every rule in the package, with the model's reading where it gave one.
  const ruleIds = await cited(
    output.seo_rule_constraints.map((row) => row.evidence_id),
    RULE_SOURCES,
  );
  const phrasing = new Map(
    output.seo_rule_constraints
      .filter((row) => ruleIds.has(row.evidence_id))
      .map((row) => [row.evidence_id, row.constraint]),
  );
  const seoRuleConstraints: RuleConstraint[] = assembled.evidence
    .filter((record) => record.type === "SEO_RULE" && record.sourceEntityId)
    .map((record) => ({
      ruleId: record.sourceEntityId!,
      evidenceId: record.id,
      severity: contextString(record, "severity") ?? "INFO",
      rule: record.textValue ?? "",
      constraint: phrasing.get(record.id) ?? null,
    }));

  // Link targets: a page named by an ownership or content record in the package.
  const linkIds = await cited(
    output.internal_link_targets.map((row) => row.evidence_id),
    LINK_SOURCES,
  );
  const targetsRaw = output.internal_link_targets
    .filter((row) => linkIds.has(row.evidence_id))
    .map((row) => ({ row, pageId: contextString(index.get(row.evidence_id), "pageId") }))
    .filter(
      (entry): entry is { row: (typeof output.internal_link_targets)[number]; pageId: string } =>
        Boolean(entry.pageId),
    );
  const pageIds = [...new Set(targetsRaw.map((entry) => entry.pageId))];
  const pages = pageIds.length
    ? await prisma.page.findMany({
        where: { id: { in: pageIds }, ...websiteScope(context) },
        select: { id: true, path: true },
      })
    : [];
  const pathById = new Map(pages.map((page) => [page.id, page.path]));
  const internalLinkTargets: LinkTarget[] = targetsRaw
    .filter((entry) => pathById.has(entry.pageId) && entry.pageId !== item.pageId)
    .map((entry) => ({
      pageId: entry.pageId,
      path: pathById.get(entry.pageId) ?? null,
      evidenceId: entry.row.evidence_id,
      anchorText: entry.row.anchor_text,
      reason: entry.row.reason,
    }));

  // Secondary keywords: keyword records from the package, never the primary.
  const keywordEvidence = await cited(output.secondary_keyword_evidence_ids, KEYWORD_SOURCES);
  const secondaryKeywordIds = [
    ...new Set(
      [...keywordEvidence]
        .map((id) => contextString(index.get(id), "keywordId"))
        .filter((id): id is string => Boolean(id) && id !== item.keywordId),
    ),
  ];

  // The goal: the keyword's, the topic's, or the first active goal in the package.
  const goalFromPackage = assembled.evidence.find((record) => record.type === "BUSINESS_GOAL");
  const [keyword, topic] = await Promise.all([
    item.keywordId
      ? prisma.keyword.findFirst({
          where: { id: item.keywordId, ...websiteScope(context) },
          select: { businessGoalId: true },
        })
      : null,
    item.topicId
      ? prisma.topic.findFirst({
          where: { id: item.topicId, ...websiteScope(context) },
          select: { businessGoalId: true },
        })
      : null,
  ]);
  const businessGoalId =
    keyword?.businessGoalId ?? topic?.businessGoalId ?? goalFromPackage?.sourceEntityId ?? null;

  return {
    columns: {
      title: output.title,
      contentType: output.content_type,
      searchIntent: output.search_intent,
      primaryConversion: output.primary_conversion,
      audience: output.audience,
      customerProblem: output.customer_problem,
      desiredOutcome: output.desired_outcome,
      recommendedAngle: output.recommended_angle,
      keyQuestionsJson: output.key_questions,
      requiredSectionsJson: output.required_sections,
      optionalSectionsJson: output.optional_sections,
      internalLinkTargetsJson: internalLinkTargets as unknown as Prisma.InputJsonValue,
      externalEvidenceRequirementsJson: [
        ...output.external_evidence_requirements,
        ...output.missing_evidence.map((line) => `Missing evidence: ${line}`),
      ],
      approvedClaimsJson: approvedClaims as unknown as Prisma.InputJsonValue,
      prohibitedClaimsJson: prohibitedClaims as unknown as Prisma.InputJsonValue,
      brandVoiceNotes: output.brand_voice_notes,
      seoRuleConstraintsJson: seoRuleConstraints as unknown as Prisma.InputJsonValue,
      secondaryKeywordIdsJson: secondaryKeywordIds,
      businessGoalId,
    },
    citations,
  };
}

export type GenerateBriefOutcome =
  | { ok: true; brief: ContentBrief; run: AiRun; citations: BriefCitations; item: ContentWorkItem }
  | { ok: false; run: AiRun; error: { code: string; message: string } };

/**
 * Generates the next brief version for a work item from a sealed package.
 *
 * Runs in the request. The package is sealed whether or not the model
 * answered, because a failed run is exactly when someone will want to see
 * what it was shown. A new version is always DRAFT: nothing a model writes is
 * approved by being written.
 */
export async function generateBrief(
  context: TenantContext,
  workItemId: string,
): Promise<GenerateBriefOutcome> {
  requireWrite(context);
  const item = await briefableItem(context, workItemId);

  const page = item.pageId
    ? await prisma.page.findFirst({
        where: { id: item.pageId, ...websiteScope(context) },
        select: { url: true, path: true },
      })
    : null;

  const assembled = await assembleContentBriefPackage(context, item);

  const result = await runAgent<ContentBriefOutput>(context, {
    agentType: "CONTENT_BRIEF",
    taskType: "GENERATE_BRIEF",
    evidencePackageId: assembled.package.id,
    request: {
      task: buildTask(item, page, item.title),
      untrustedData: renderPackage(assembled.evidence),
      schema: contentBriefSchema,
      schemaName: CONTENT_BRIEF_SCHEMA_NAME,
      maxOutputTokens: 6144,
    },
  });

  await sealPackage(context, assembled.package.id);

  if (!result.ok) {
    return {
      ok: false,
      run: result.run,
      error: { code: result.error.code, message: result.error.message },
    };
  }

  const materialised = await materialise(context, result.value, assembled, item);

  try {
    const { brief, updatedItem } = await prisma.$transaction(async (tx) => {
      const version = await nextVersion(tx, item.id);

      const created = await tx.contentBrief.create({
        data: {
          websiteId: context.website.id,
          contentWorkItemId: item.id,
          version,
          ...materialised.columns,
          targetPageId: item.pageId,
          primaryKeywordId: item.keywordId,
          topicId: item.topicId,
          status: "DRAFT",
          evidencePackageId: assembled.package.id,
          createdByAiRunId: result.run.id,
        },
      });

      // CONTENT_BRIEF_CREATED (§36).
      await recordAudit(tx, context, {
        entityType: "ContentBrief",
        entityId: created.id,
        action: "CREATE",
        after: {
          workItemId: item.id,
          version,
          title: created.title,
          aiRunId: result.run.id,
          evidencePackageId: assembled.package.id,
          citations: {
            accepted: materialised.citations.accepted,
            malformed: materialised.citations.malformed.length,
            outsidePackage: materialised.citations.outsidePackage.length,
            unresolved: materialised.citations.unresolved.length,
            wrongField: materialised.citations.wrongField.length,
          },
        },
      });

      const updatedItem =
        item.status === "QUEUED"
          ? await transitionWorkItem(tx, context, item.id, "BRIEFING", "brief generated")
          : item;

      return { brief: created, updatedItem };
    });

    return {
      ok: true,
      brief,
      run: result.run,
      citations: materialised.citations,
      item: updatedItem,
    };
  } catch (error) {
    if (isVersionConflict(error)) {
      throw new ContentBriefError(
        "Someone else created a brief version at the same moment. Try again.",
        "version_conflict",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Writing and editing by hand (§7)
// ---------------------------------------------------------------------------

function cleanInput(input: BriefInput): BriefInput {
  const text = (value: string | null | undefined) => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  };
  const lines = (values: string[]) => values.map((v) => v.trim()).filter(Boolean);
  const sections = (values: BriefSection[]) =>
    values
      .map((s) => ({ heading: s.heading.trim(), purpose: s.purpose.trim() }))
      .filter((s) => s.heading.length > 0);

  const title = input.title.trim();
  if (!title) throw new ContentBriefError("Give the brief a title.", "nothing_changed");
  const contentType = (CONTENT_TYPES as readonly string[]).includes(input.contentType)
    ? input.contentType
    : "OTHER";
  const searchIntent =
    input.searchIntent && (SEARCH_INTENTS as readonly string[]).includes(input.searchIntent)
      ? input.searchIntent
      : null;

  return {
    title,
    contentType,
    searchIntent,
    primaryConversion: text(input.primaryConversion),
    audience: text(input.audience),
    customerProblem: text(input.customerProblem),
    desiredOutcome: text(input.desiredOutcome),
    recommendedAngle: text(input.recommendedAngle),
    keyQuestions: lines(input.keyQuestions),
    requiredSections: sections(input.requiredSections),
    optionalSections: sections(input.optionalSections),
    externalEvidenceRequirements: lines(input.externalEvidenceRequirements),
    brandVoiceNotes: text(input.brandVoiceNotes),
  };
}

function editableColumns(input: BriefInput) {
  return {
    title: input.title,
    contentType: input.contentType,
    searchIntent: input.searchIntent,
    primaryConversion: input.primaryConversion,
    audience: input.audience,
    customerProblem: input.customerProblem,
    desiredOutcome: input.desiredOutcome,
    recommendedAngle: input.recommendedAngle,
    keyQuestionsJson: input.keyQuestions,
    requiredSectionsJson: input.requiredSections,
    optionalSectionsJson: input.optionalSections,
    externalEvidenceRequirementsJson: input.externalEvidenceRequirements,
    brandVoiceNotes: input.brandVoiceNotes,
  };
}

/** Evidence-backed columns travel from one version to the next untouched. */
function carriedColumns(source: ContentBrief) {
  return {
    targetPageId: source.targetPageId,
    primaryKeywordId: source.primaryKeywordId,
    topicId: source.topicId,
    businessGoalId: source.businessGoalId,
    secondaryKeywordIdsJson: source.secondaryKeywordIdsJson ?? undefined,
    internalLinkTargetsJson: source.internalLinkTargetsJson ?? undefined,
    approvedClaimsJson: source.approvedClaimsJson ?? undefined,
    prohibitedClaimsJson: source.prohibitedClaimsJson ?? undefined,
    seoRuleConstraintsJson: source.seoRuleConstraintsJson ?? undefined,
    evidencePackageId: source.evidencePackageId,
  };
}

/**
 * A brief written by hand, when nothing has been generated or a person would
 * rather start from their own words. Carries no evidence-backed fields; the
 * canonical prohibitions and rules arrive with a generated version.
 */
export async function createManualBrief(
  context: TenantContext,
  workItemId: string,
  rawInput: BriefInput,
): Promise<ContentBrief> {
  requireWrite(context);
  const item = await briefableItem(context, workItemId);
  const input = cleanInput(rawInput);

  try {
    return await prisma.$transaction(async (tx) => {
      const version = await nextVersion(tx, item.id);
      const created = await tx.contentBrief.create({
        data: {
          websiteId: context.website.id,
          contentWorkItemId: item.id,
          version,
          ...editableColumns(input),
          targetPageId: item.pageId,
          primaryKeywordId: item.keywordId,
          topicId: item.topicId,
          status: "DRAFT",
          createdByUserId: context.user.id,
        },
      });

      await recordAudit(tx, context, {
        entityType: "ContentBrief",
        entityId: created.id,
        action: "CREATE",
        after: { workItemId: item.id, version, title: created.title, byHand: true },
      });

      if (item.status === "QUEUED") {
        await transitionWorkItem(tx, context, item.id, "BRIEFING", "brief written");
      }

      return created;
    });
  } catch (error) {
    if (isVersionConflict(error)) {
      throw new ContentBriefError(
        "Someone else created a brief version at the same moment. Try again.",
        "version_conflict",
      );
    }
    throw error;
  }
}

/**
 * Saves a person's edits. A DRAFT or AWAITING_REVIEW version is changed in
 * place and goes back to DRAFT, so review starts again from what is there
 * now. An APPROVED, SUPERSEDED or ARCHIVED version is never changed: the edit
 * becomes the next version, carrying the evidence-backed fields and the
 * package it inherited them from.
 */
export async function saveBrief(
  context: TenantContext,
  briefId: string,
  rawInput: BriefInput,
): Promise<{ brief: ContentBrief; newVersion: boolean }> {
  requireWrite(context);
  const source = await scopedBrief(context, briefId);
  const input = cleanInput(rawInput);
  const columns = editableColumns(input);

  if (source.status === "DRAFT" || source.status === "AWAITING_REVIEW") {
    const changed = changedFields(source, { ...source, ...columns });
    if (changed.length === 0) {
      throw new ContentBriefError("Nothing changed.", "nothing_changed");
    }

    const brief = await prisma.$transaction(async (tx) => {
      const updated = await tx.contentBrief.update({
        where: { id: source.id },
        data: { ...columns, status: "DRAFT" },
      });
      await recordAudit(tx, context, {
        entityType: "ContentBrief",
        entityId: source.id,
        action: "UPDATE",
        before: { status: source.status },
        after: { status: "DRAFT", changed },
      });
      return updated;
    });

    return { brief, newVersion: false };
  }

  const item = await briefableItem(context, source.contentWorkItemId);

  try {
    const brief = await prisma.$transaction(async (tx) => {
      const version = await nextVersion(tx, item.id);
      const created = await tx.contentBrief.create({
        data: {
          websiteId: context.website.id,
          contentWorkItemId: item.id,
          version,
          ...carriedColumns(source),
          ...columns,
          status: "DRAFT",
          createdByUserId: context.user.id,
        },
      });

      await recordAudit(tx, context, {
        entityType: "ContentBrief",
        entityId: created.id,
        action: "CREATE",
        after: {
          workItemId: item.id,
          version,
          title: created.title,
          editedFrom: { id: source.id, version: source.version, status: source.status },
          changed: changedFields(source, created),
        },
      });

      return created;
    });

    return { brief, newVersion: true };
  } catch (error) {
    if (isVersionConflict(error)) {
      throw new ContentBriefError(
        "Someone else created a brief version at the same moment. Try again.",
        "version_conflict",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Review (§7): request, approve, supersede, archive
// ---------------------------------------------------------------------------

function assertTransition(brief: ContentBrief, to: ContentBriefStatus): void {
  if (!canTransition(BRIEF_TRANSITIONS, brief.status, to)) {
    throw new ContentBriefError(
      `A ${brief.status.toLowerCase().replace(/_/g, " ")} brief cannot become ${to
        .toLowerCase()
        .replace(/_/g, " ")}.`,
      "invalid_state",
    );
  }
}

export async function requestBriefReview(
  context: TenantContext,
  briefId: string,
): Promise<ContentBrief> {
  requireWrite(context);
  const brief = await scopedBrief(context, briefId);
  assertTransition(brief, "AWAITING_REVIEW");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.contentBrief.update({
      where: { id: brief.id },
      data: { status: "AWAITING_REVIEW" },
    });
    await recordAudit(tx, context, {
      entityType: "ContentBrief",
      entityId: brief.id,
      action: "UPDATE",
      before: { status: brief.status },
      after: { status: "AWAITING_REVIEW", version: brief.version },
    });
    return updated;
  });
}

/**
 * Approves a version. In the same transaction the previously approved version
 * - if any - becomes SUPERSEDED, and a work item still being briefed moves on
 * to DRAFTING. Drafting does not start by itself: that is a person's next act.
 */
export async function approveBrief(context: TenantContext, briefId: string): Promise<ContentBrief> {
  requireHumanReviewer(context);
  const brief = await scopedBrief(context, briefId);
  assertTransition(brief, "APPROVED");

  return prisma.$transaction(async (tx) => {
    const previous = await tx.contentBrief.findMany({
      where: {
        contentWorkItemId: brief.contentWorkItemId,
        status: "APPROVED",
        id: { not: brief.id },
      },
      select: { id: true, version: true },
    });

    for (const old of previous) {
      // Only the status moves: the trigger refuses anything else on an approved row.
      await tx.contentBrief.update({ where: { id: old.id }, data: { status: "SUPERSEDED" } });
      await recordAudit(tx, context, {
        entityType: "ContentBrief",
        entityId: old.id,
        action: "SUPERSEDE",
        before: { status: "APPROVED", version: old.version },
        after: { status: "SUPERSEDED", supersededBy: { id: brief.id, version: brief.version } },
      });
    }

    const approved = await tx.contentBrief.update({
      where: { id: brief.id },
      data: { status: "APPROVED", approvedByUserId: context.user.id, approvedAt: new Date() },
    });

    // CONTENT_BRIEF_APPROVED (§36).
    await recordAudit(tx, context, {
      entityType: "ContentBrief",
      entityId: brief.id,
      action: "APPROVE",
      before: { status: brief.status },
      after: { status: "APPROVED", version: brief.version, supersededCount: previous.length },
    });

    const item = await tx.contentWorkItem.findFirst({
      where: { id: brief.contentWorkItemId, ...websiteScope(context) },
      select: { status: true },
    });
    if (item?.status === "BRIEFING") {
      await transitionWorkItem(tx, context, brief.contentWorkItemId, "DRAFTING", "brief approved");
    }

    return approved;
  });
}

/** Retires a version that never stood, or one that has been superseded. */
export async function archiveBrief(context: TenantContext, briefId: string): Promise<ContentBrief> {
  requireHumanReviewer(context);
  const brief = await scopedBrief(context, briefId);
  if (brief.status === "APPROVED") {
    throw new ContentBriefError(
      "The approved brief cannot be archived while it stands. Approve another version first.",
      "invalid_state",
    );
  }
  assertTransition(brief, "ARCHIVED");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.contentBrief.update({
      where: { id: brief.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    await recordAudit(tx, context, {
      entityType: "ContentBrief",
      entityId: brief.id,
      action: "ARCHIVE",
      before: { status: brief.status },
      after: { status: "ARCHIVED", version: brief.version },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Reading (§10, §11, §12)
// ---------------------------------------------------------------------------

const BRIEF_INCLUDE = {
  createdByAiRun: {
    select: {
      id: true,
      provider: true,
      model: true,
      promptTemplateVersion: true,
      outputSchemaVersion: true,
      status: true,
      createdAt: true,
    },
  },
  createdBy: { select: { id: true, email: true } },
  approvedBy: { select: { id: true, email: true } },
  evidencePackage: {
    select: {
      id: true,
      contentHash: true,
      sealedAt: true,
      evidenceCount: true,
      retrievalPolicyVersion: true,
      contextVersionId: true,
      assembledAt: true,
      retrievalPolicy: { select: { name: true, version: true } },
    },
  },
  businessGoal: { select: { id: true, title: true } },
  primaryKeyword: { select: { id: true, keyword: true } },
  topic: { select: { id: true, name: true } },
  targetPage: { select: { id: true, path: true, url: true } },
} satisfies Prisma.ContentBriefInclude;

export type BriefVersion = Prisma.ContentBriefGetPayload<{ include: typeof BRIEF_INCLUDE }>;

export async function listBriefVersions(
  context: TenantContext,
  workItemId: string,
): Promise<BriefVersion[]> {
  return prisma.contentBrief.findMany({
    where: { contentWorkItemId: workItemId, ...websiteScope(context) },
    orderBy: { version: "desc" },
    include: BRIEF_INCLUDE,
  });
}

export async function getBrief(
  context: TenantContext,
  briefId: string,
): Promise<BriefVersion | null> {
  return prisma.contentBrief.findFirst({
    where: { id: briefId, ...websiteScope(context) },
    include: BRIEF_INCLUDE,
  });
}

/** The version that stands: approved if there is one, else the newest that is not archived. */
export async function currentBrief(
  context: TenantContext,
  workItemId: string,
): Promise<BriefVersion | null> {
  const approved = await prisma.contentBrief.findFirst({
    where: { contentWorkItemId: workItemId, status: "APPROVED", ...websiteScope(context) },
    include: BRIEF_INCLUDE,
  });
  if (approved) return approved;

  return prisma.contentBrief.findFirst({
    where: {
      contentWorkItemId: workItemId,
      status: { not: "ARCHIVED" },
      ...websiteScope(context),
    },
    orderBy: { version: "desc" },
    include: BRIEF_INCLUDE,
  });
}

export type BriefEvidenceView = {
  packageId: string | null;
  sealedAt: Date | null;
  manifest: RetrievalManifest | null;
  evidence: Evidence[];
  stale: string[];
};

/** What the model was shown, re-resolved now (§12); stale IDs are listed, not hidden. */
export async function getBriefEvidence(
  context: TenantContext,
  briefId: string,
): Promise<BriefEvidenceView | null> {
  const brief = await prisma.contentBrief.findFirst({
    where: { id: briefId, ...websiteScope(context) },
    select: { evidencePackageId: true },
  });
  if (!brief) return null;

  const empty: BriefEvidenceView = {
    packageId: null,
    sealedAt: null,
    manifest: null,
    evidence: [],
    stale: [],
  };
  if (!brief.evidencePackageId) return empty;

  const pkg = await getPackage(context, brief.evidencePackageId);
  if (!pkg) return empty;

  const resolution = await resolveEvidenceIds(
    context,
    pkg.refs.map((ref) => ref.evidenceId),
  );
  const evidence = [...resolution.resolved].sort((a, b) => {
    const byReliability = reliabilityRank(a.reliability) - reliabilityRank(b.reliability);
    if (byReliability !== 0) return byReliability;
    const byType = a.type.localeCompare(b.type);
    return byType !== 0 ? byType : a.id.localeCompare(b.id);
  });

  return {
    packageId: pkg.id,
    sealedAt: pkg.sealedAt,
    manifest: (pkg.retrievalManifestJson as RetrievalManifest | null) ?? null,
    evidence,
    stale: [...resolution.unresolved, ...resolution.invalid],
  };
}

/** The fields that differ between two versions, as labels a person recognises. */
export function changedFields(
  from: Pick<
    ContentBrief,
    (typeof EDITABLE_FIELDS)[number] | (typeof EVIDENCE_FIELDS)[number] | "businessGoalId"
  >,
  to: Pick<
    ContentBrief,
    (typeof EDITABLE_FIELDS)[number] | (typeof EVIDENCE_FIELDS)[number] | "businessGoalId"
  >,
): string[] {
  const keys = [...EDITABLE_FIELDS, ...EVIDENCE_FIELDS, "businessGoalId"] as const;
  const changed: string[] = [];
  for (const key of keys) {
    const a = JSON.stringify(from[key] ?? null);
    const b = JSON.stringify(to[key] ?? null);
    if (a !== b) changed.push(key);
  }
  return changed;
}
