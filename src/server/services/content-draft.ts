import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { isAiConfigured } from "@/server/ai/registry";
import { SYSTEM_AUTH_USER_ID } from "@/server/jobs/system-context";
import { runAgent } from "@/server/services/ai-run";
import {
  assembleContentDraftPackage,
  renderPackage,
  sealPackage,
  type AssembledPackage,
} from "@/server/services/evidence-assembler";
import { emptyCitationAudit, validateCitations } from "@/server/services/citations";
import type {
  CitedClaim,
  LinkTarget,
  ProhibitedClaim,
  RuleConstraint,
} from "@/server/services/content-brief";
import {
  checkDraftConstraints,
  type DraftFinding,
  type MachineRule,
} from "@/lib/content/constraints";
import { renderMarkdown, wordCount } from "@/lib/content/markdown";
import { reconcileBriefClaims, type ReconciledClaim } from "@/lib/content/reconcile";
import { revisionHash } from "@/lib/execution/hash";
import type { Evidence } from "@/lib/evidence/types";
import {
  CONTENT_DRAFT_SCHEMA_NAME,
  contentDraftSchema,
  type ContentDraftOutput,
} from "@/lib/ai/schemas/content-draft";
import { Prisma } from "@/generated/prisma/client";
import type {
  AiRun,
  ContentBrief,
  ContentDraft,
  ContentRevision,
  ContentWorkItem,
  EvidenceCategory,
} from "@/generated/prisma/client";

/**
 * ContentDraftService (docs/P4_SPEC.md §9-§11; M4 plan, M4.2).
 *
 * A draft is written from an approved brief and nothing else. The brief is
 * pinned to the draft by id - an immutable APPROVED row - and is never moved
 * to a newer version behind anyone's back. What is true is decided at
 * generation time by a fresh content-draft package: a claim the brief allowed
 * is offered to the model only if its fact is still approved, and is marked
 * STALE for the editor if not.
 *
 * Every revision is immutable and carries what made it: the run, the
 * package, the token of the request that asked for it, the claims it makes
 * with their support, and what the server found and removed on the way in.
 * A revision with blocking findings is still stored - history is not edited
 * to look better - and the draft stays DRAFTING until a person does more.
 */

export class ContentDraftError extends Error {
  constructor(
    message: string,
    readonly code:
      "not_found" | "forbidden" | "invalid_state" | "brief_not_approved" | "version_conflict",
  ) {
    super(message);
    this.name = "ContentDraftError";
  }
}

export const NO_PROVIDER_MESSAGE =
  "No AI provider is configured — write the first revision by hand.";
export const IN_PROGRESS_MESSAGE =
  "A draft is already being generated for this work item. Wait for it to finish, then reload.";
export const GENERATION_FAILED_MESSAGE =
  "The draft could not be generated. Nothing was stored; the run is recorded with its reason.";

/** How long a RUNNING run holds the work item before it is treated as abandoned. */
export const RUNNING_GUARD_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// What a revision stores in its JSON columns
// ---------------------------------------------------------------------------

export type RevisionClaim = {
  text: string;
  evidenceId: string | null;
  status: "SUPPORTED" | "UNSUPPORTED";
  /** Why an unsupported claim is unsupported, in our words. */
  reason: string | null;
};

export type RevisionLink = {
  evidenceId: string;
  anchorText: string;
  valid: boolean;
};

export type RevisionFindings = {
  version: 1;
  findings: DraftFinding[];
  blocking: boolean;
  links: RevisionLink[];
  openQuestions: string[];
  sectionsCovered: string[];
  /** Brief claims that were stale at generation time, so the editor sees them. */
  staleClaims: ReconciledClaim[];
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireHumanWriter(context: TenantContext): void {
  if (context.user.authUserId === SYSTEM_AUTH_USER_ID) {
    throw new ContentDraftError("Drafting is started by a person, not by a job.", "forbidden");
  }
  if (!hasRole(context.membership.role, REQUIRED.WRITE)) {
    throw new ContentDraftError("You do not have permission to draft content.", "forbidden");
  }
}

async function draftingItem(context: TenantContext, workItemId: string): Promise<ContentWorkItem> {
  const item = await prisma.contentWorkItem.findFirst({
    where: { id: workItemId, ...websiteScope(context) },
  });
  if (!item) {
    throw new ContentDraftError("That work item is not available.", "not_found");
  }
  if (item.status !== "DRAFTING") {
    throw new ContentDraftError(
      item.status === "QUEUED" || item.status === "BRIEFING"
        ? "Drafting starts once a brief has been approved."
        : `Drafting is not open for work that is ${item.status.toLowerCase().replace(/_/g, " ")}.`,
      "invalid_state",
    );
  }
  return item;
}

/** The approved version that stands for this work item, or a refusal. */
async function approvedBrief(context: TenantContext, workItemId: string): Promise<ContentBrief> {
  const brief = await prisma.contentBrief.findFirst({
    where: { contentWorkItemId: workItemId, status: "APPROVED", ...websiteScope(context) },
  });
  if (!brief) {
    throw new ContentDraftError(
      "No approved brief. A draft can only be written from an approved brief version.",
      "brief_not_approved",
    );
  }
  return brief;
}

// ---------------------------------------------------------------------------
// The container (§9)
// ---------------------------------------------------------------------------

export type StartDraftResult = { draft: ContentDraft; brief: ContentBrief; created: boolean };

/**
 * One draft per work item and approved brief version. Returns the open draft
 * when there is one - even if a newer brief version has since been approved;
 * that mismatch is surfaced by the reader, never resolved silently here.
 */
export async function startDraft(
  context: TenantContext,
  workItemId: string,
): Promise<StartDraftResult> {
  requireHumanWriter(context);
  const item = await draftingItem(context, workItemId);
  const brief = await approvedBrief(context, item.id);

  const existing = await prisma.contentDraft.findFirst({
    where: {
      contentWorkItemId: item.id,
      status: { notIn: ["SUPERSEDED", "ARCHIVED"] },
      ...websiteScope(context),
    },
    orderBy: { createdAt: "desc" },
    include: { brief: true },
  });

  if (existing) {
    const { brief: pinned, ...draft } = existing;
    return { draft, brief: pinned, created: false };
  }

  const draft = await prisma.$transaction(async (tx) => {
    const created = await tx.contentDraft.create({
      data: {
        websiteId: context.website.id,
        contentWorkItemId: item.id,
        briefId: brief.id,
        status: "DRAFTING",
        createdByUserId: context.user.id,
      },
    });

    // CONTENT_DRAFT_CREATED (§36).
    await recordAudit(tx, context, {
      entityType: "ContentDraft",
      entityId: created.id,
      action: "CREATE",
      after: { workItemId: item.id, briefId: brief.id, briefVersion: brief.version },
    });

    return created;
  });

  return { draft, brief, created: true };
}

// ---------------------------------------------------------------------------
// Generation (§11)
// ---------------------------------------------------------------------------

export type GenerateRevisionOutcome =
  | {
      ok: true;
      revision: ContentRevision;
      draft: ContentDraft;
      run: AiRun | null;
      /** True when the token matched an earlier request and that revision was returned. */
      reused: boolean;
    }
  | {
      ok: false;
      code: "no_provider" | "generation_in_progress" | "generation_failed";
      message: string;
      run?: AiRun;
    };

type ActiveRule = { ruleId: string; evidenceId: string; severity: string; rule: string };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function contextString(record: Evidence | undefined, key: string): string | null {
  const value = record?.contextJson?.[key];
  return typeof value === "string" ? value : null;
}

/** The brief's structure rendered as instructions. Human-approved, so it is the task. */
function buildTask(input: {
  item: ContentWorkItem;
  brief: ContentBrief;
  validClaims: ReconciledClaim[];
  staleClaims: ReconciledClaim[];
  prohibited: ProhibitedClaim[];
  rules: ActiveRule[];
  links: LinkTarget[];
  hasPageContent: boolean;
}): string {
  const { item, brief } = input;
  const lines: string[] = [];
  const list = (rows: string[]) => (rows.length ? rows.map((row) => `- ${row}`) : ["- (none)"]);

  lines.push(`Write the piece this approved brief describes. Output markdown.`, ``);
  lines.push(
    `WORK ITEM`,
    `Type: ${item.type}`,
    `Title: ${item.title}`,
    `Objective: ${item.objective}`,
    ``,
  );
  lines.push(
    `APPROVED BRIEF v${brief.version}`,
    `Title: ${brief.title}`,
    `Content type: ${brief.contentType}`,
    `Search intent: ${brief.searchIntent ?? "not stated"}`,
    `Audience: ${brief.audience ?? "not stated"}`,
    `Customer problem: ${brief.customerProblem ?? "not stated"}`,
    `Desired outcome: ${brief.desiredOutcome ?? "not stated"}`,
    `Recommended angle: ${brief.recommendedAngle ?? "not stated"}`,
    `Primary conversion: ${brief.primaryConversion ?? "not stated"}`,
    `Brand voice: ${brief.brandVoiceNotes ?? "not stated"}`,
    ``,
  );
  lines.push(`KEY QUESTIONS TO ANSWER`, ...list(asArray<string>(brief.keyQuestionsJson)), ``);
  lines.push(
    `REQUIRED SECTIONS, IN ORDER`,
    ...list(
      asArray<{ heading: string; purpose: string }>(brief.requiredSectionsJson).map(
        (section, index) => `${index + 1}. ${section.heading} — ${section.purpose}`,
      ),
    ),
    ``,
  );
  lines.push(
    `OPTIONAL SECTIONS`,
    ...list(
      asArray<{ heading: string; purpose: string }>(brief.optionalSectionsJson).map(
        (section) => `${section.heading} — ${section.purpose}`,
      ),
    ),
    ``,
  );
  lines.push(
    `CLAIMS YOU MAY MAKE (cite the evidence ID in claims)`,
    ...list(input.validClaims.map((claim) => `"${claim.text}" [${claim.evidenceId}]`)),
    ``,
  );
  if (input.staleClaims.length > 0) {
    lines.push(
      `CLAIMS YOU MUST NOT MAKE - the fact behind each is no longer approved`,
      ...list(input.staleClaims.map((claim) => `"${claim.text}"`)),
      ``,
    );
  }
  lines.push(
    `PROHIBITED CLAIMS AND TOPICS - never, in any wording`,
    ...list(
      input.prohibited.map(
        (claim) => `${claim.text} (${claim.source.toLowerCase().replace(/_/g, " ")})`,
      ),
    ),
    ``,
  );
  lines.push(
    `ACTIVE SEO RULES`,
    ...list(input.rules.map((rule) => `[${rule.severity}] ${rule.rule} [${rule.evidenceId}]`)),
    ``,
  );
  lines.push(
    `INTERNAL LINK TARGETS - link only to these, by path, and list each in internal_links_used`,
    ...list(
      input.links.map(
        (link) =>
          `${link.path ?? link.pageId} — anchor: "${link.anchorText}" — ${link.reason} [${link.evidenceId}]`,
      ),
    ),
    ``,
  );
  const short = item.type === "TITLE_META_UPDATE";
  lines.push(
    `TARGET LENGTH: ${short ? "a title, meta title, meta description and a short body of 150-300 words" : "900-1,500 words"}.`,
  );
  lines.push(
    input.hasPageContent
      ? `This is existing content: the current page is in the untrusted block. Keep what the brief says to keep, change what it says to change, and say what you did in change_summary.`
      : `This is new content; there is no current page.`,
  );
  lines.push(`Use only the evidence package for facts. Cite evidence IDs exactly as they appear.`);
  return lines.join("\n");
}

async function activeRulesFrom(
  context: TenantContext,
  assembled: AssembledPackage,
): Promise<{ rules: ActiveRule[]; machine: MachineRule[] }> {
  const records = assembled.evidence.filter(
    (record) => record.type === "SEO_RULE" && record.sourceEntityId,
  );
  const ids = records.map((record) => record.sourceEntityId!);
  const rows = ids.length
    ? await prisma.seoRule.findMany({
        where: { id: { in: ids }, ...websiteScope(context) },
        select: { id: true, severity: true, checkJson: true, rule: true },
      })
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  const rules: ActiveRule[] = records.map((record) => ({
    ruleId: record.sourceEntityId!,
    evidenceId: record.id,
    severity:
      contextString(record, "severity") ?? byId.get(record.sourceEntityId!)?.severity ?? "INFO",
    rule: record.textValue ?? byId.get(record.sourceEntityId!)?.rule ?? "",
  }));
  const machine: MachineRule[] = rows
    .filter((row) => row.checkJson !== null)
    .map((row) => ({ ruleId: row.id, severity: row.severity, check: row.checkJson }));

  return { rules, machine };
}

/**
 * Generates the next revision of a draft from its pinned brief and a fresh
 * package. Inline: the caller waits. Idempotent by token, guarded against
 * concurrent runs, honest when nothing can run.
 */
export async function generateRevision(
  context: TenantContext,
  draftId: string,
  options: { generationToken: string },
): Promise<GenerateRevisionOutcome> {
  requireHumanWriter(context);
  const token = options.generationToken.trim();
  if (!token) {
    throw new ContentDraftError("A generation request needs a token.", "invalid_state");
  }

  const draft = await prisma.contentDraft.findFirst({
    where: { id: draftId, ...websiteScope(context) },
    include: { brief: true },
  });
  if (!draft) {
    throw new ContentDraftError("That draft is not available.", "not_found");
  }
  if (draft.status !== "DRAFTING") {
    throw new ContentDraftError(
      `This draft is ${draft.status.toLowerCase().replace(/_/g, " ")}; nothing can be generated for it.`,
      "invalid_state",
    );
  }
  const item = await draftingItem(context, draft.contentWorkItemId);
  const brief = draft.brief;
  // The pin is an approved version. A later version superseding it does not
  // un-approve it: the draft is of that version until a person starts one
  // from the new brief (M4.3). Archived or never-approved briefs are refused.
  if (!brief.approvedAt || (brief.status !== "APPROVED" && brief.status !== "SUPERSEDED")) {
    throw new ContentDraftError(
      "The brief this draft is pinned to is not an approved version.",
      "brief_not_approved",
    );
  }

  // Idempotency: the same request again returns what it already made.
  const already = await prisma.contentRevision.findFirst({
    where: { contentDraftId: draft.id, generationToken: token },
    include: { createdByAiRun: true },
  });
  if (already) {
    const { createdByAiRun, ...revision } = already;
    return { ok: true, revision, draft, run: createdByAiRun, reused: true };
  }

  if (!isAiConfigured()) {
    return { ok: false, code: "no_provider", message: NO_PROVIDER_MESSAGE };
  }

  // One generation per work item at a time. A RUNNING run older than the
  // guard window is a process that died; it does not block forever.
  const running = await prisma.aiRun.findFirst({
    where: {
      websiteId: context.website.id,
      agentType: "CONTENT_DRAFT",
      status: "RUNNING",
      createdAt: { gte: new Date(Date.now() - RUNNING_GUARD_MS) },
      evidencePackage: { targetType: "CONTENT_WORK_ITEM", targetId: item.id },
    },
    select: { id: true },
  });
  if (running) {
    return { ok: false, code: "generation_in_progress", message: IN_PROGRESS_MESSAGE };
  }

  // --- Fresh truth, and the brief reconciled against it (D-M4-2) -------------
  const links = asArray<LinkTarget>(brief.internalLinkTargetsJson);
  const assembled = await assembleContentDraftPackage(context, {
    workItemId: item.id,
    pageId: brief.targetPageId ?? item.pageId,
    keywordId: brief.primaryKeywordId ?? item.keywordId,
    topicId: brief.topicId ?? item.topicId,
    linkTargetPageIds: links.map((link) => link.pageId),
  });
  const index = new Map(assembled.evidence.map((record) => [record.id, record]));
  const packageTypes = new Map(
    assembled.evidence.map((record) => [record.id, record.type as string]),
  );

  const reconciled = reconcileBriefClaims(
    asArray<CitedClaim>(brief.approvedClaimsJson),
    packageTypes,
  );
  const prohibited = asArray<ProhibitedClaim>(brief.prohibitedClaimsJson);
  const { rules, machine } = await activeRulesFrom(context, assembled);
  const hasPageContent = assembled.evidence.some((record) => record.type === "PAGE_CONTENT");

  const task = buildTask({
    item,
    brief,
    validClaims: reconciled.valid,
    staleClaims: reconciled.stale,
    prohibited,
    rules,
    links,
    hasPageContent,
  });

  // CONTENT_GENERATION_STARTED (§36): on the draft, with what the run will see.
  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, context, {
      entityType: "ContentDraft",
      entityId: draft.id,
      action: "EXECUTE",
      after: {
        briefId: brief.id,
        briefVersion: brief.version,
        evidencePackageId: assembled.package.id,
        generationToken: token,
        staleClaims: reconciled.stale.length,
      },
    });
  });

  const result = await runAgent<ContentDraftOutput>(context, {
    agentType: "CONTENT_DRAFT",
    taskType: "GENERATE_DRAFT",
    evidencePackageId: assembled.package.id,
    request: {
      task,
      untrustedData: renderPackage(assembled.evidence),
      schema: contentDraftSchema,
      schemaName: CONTENT_DRAFT_SCHEMA_NAME,
      maxOutputTokens: 8192,
    },
  });

  // Sealed on both paths: a failed run is when someone will want to see it.
  await sealPackage(context, assembled.package.id);

  if (!result.ok) {
    await prisma.$transaction(async (tx) => {
      await recordAudit(tx, context, {
        entityType: "ContentDraft",
        entityId: draft.id,
        action: "COMPLETE",
        after: { status: "FAILED", aiRunId: result.run.id, errorCode: result.error.code },
      });
    });
    return {
      ok: false,
      code: "generation_failed",
      message: GENERATION_FAILED_MESSAGE,
      run: result.run,
    };
  }

  // --- Enforcement on the way in (§7 of the M4.2 brief) -----------------------
  const output = result.value;
  const packageIds = new Set(index.keys());
  const audit = emptyCitationAudit();
  const claimSources: EvidenceCategory[] = ["BRAND_FACT", "BUSINESS_CONTEXT"];

  const cited = output.claims
    .map((claim) => claim.evidence_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const accepted = new Set(await validateCitations(context, cited, packageIds, audit));

  const claims: RevisionClaim[] = output.claims.map((claim) => {
    if (!claim.evidence_id) {
      return {
        text: claim.text,
        evidenceId: null,
        status: "UNSUPPORTED",
        reason: "No fact was cited.",
      };
    }
    if (!accepted.has(claim.evidence_id)) {
      const reason = audit.malformed.includes(claim.evidence_id)
        ? "The cited ID is not an evidence ID."
        : audit.outsidePackage.includes(claim.evidence_id)
          ? "The cited record is not in the evidence the model was shown - it is not an approved fact of this website."
          : "The cited record no longer resolves.";
      return { text: claim.text, evidenceId: claim.evidence_id, status: "UNSUPPORTED", reason };
    }
    const record = index.get(claim.evidence_id);
    if (!record || !claimSources.includes(record.type)) {
      return {
        text: claim.text,
        evidenceId: claim.evidence_id,
        status: "UNSUPPORTED",
        reason: "The cited record is not a brand fact or business context record.",
      };
    }
    return { text: claim.text, evidenceId: claim.evidence_id, status: "SUPPORTED", reason: null };
  });

  const linkSources: EvidenceCategory[] = ["KEYWORD_OWNERSHIP", "PAGE_CONTENT"];
  const linksUsed: RevisionLink[] = output.internal_links_used.map((link) => {
    const record = index.get(link.evidence_id);
    return {
      evidenceId: link.evidence_id,
      anchorText: link.anchor_text,
      valid: Boolean(record && linkSources.includes(record.type)),
    };
  });

  const checked = checkDraftConstraints({
    mode: "ai",
    title: output.title,
    metaTitle: output.meta_title,
    metaDescription: output.meta_description,
    excerpt: output.excerpt,
    bodyMarkdown: output.body_markdown,
    prohibitedPhrases: prohibited
      .filter((claim) => claim.source !== "AVOID_TOPIC")
      .map((claim) => claim.text),
    avoidTopics: prohibited
      .filter((claim) => claim.source === "AVOID_TOPIC")
      .map((claim) => claim.text.replace(/^Avoid the topic:\s*/i, "")),
    staleClaims: reconciled.stale.map((claim) => claim.text),
    approvedClaimTexts: [
      ...reconciled.valid.map((claim) => claim.text),
      ...claims.filter((claim) => claim.status === "SUPPORTED").map((claim) => claim.text),
    ],
    allowedLinkPaths: links
      .map((link) => link.path)
      .filter((path): path is string => Boolean(path)),
    siteHost: context.website.normalizedDomain,
    rules: machine,
  });

  const findings: RevisionFindings = {
    version: 1,
    findings: checked.findings,
    blocking: checked.blocking,
    links: linksUsed,
    openQuestions: output.open_questions,
    sectionsCovered: output.sections_covered,
    staleClaims: reconciled.stale,
  };

  const content = {
    title: output.title,
    slug: output.slug,
    excerpt: output.excerpt,
    bodyMarkdown: checked.bodyMarkdown,
    metaTitle: output.meta_title,
    metaDescription: output.meta_description,
    schemaJson: null,
  };

  // --- The immutable revision, and the draft that now points at it ------------
  try {
    const stored = await prisma.$transaction(async (tx) => {
      const last = await tx.contentRevision.findFirst({
        where: { contentDraftId: draft.id },
        orderBy: { revisionNumber: "desc" },
        select: { revisionNumber: true },
      });
      const revisionNumber = (last?.revisionNumber ?? 0) + 1;

      const revision = await tx.contentRevision.create({
        data: {
          websiteId: context.website.id,
          contentDraftId: draft.id,
          revisionNumber,
          title: content.title,
          slug: content.slug,
          excerpt: content.excerpt,
          bodyMarkdown: content.bodyMarkdown,
          metaTitle: content.metaTitle,
          metaDescription: content.metaDescription,
          changeSummary: output.change_summary,
          contentHash: revisionHash(content),
          evidencePackageId: assembled.package.id,
          createdByAiRunId: result.run.id,
          basedOnRevisionNumber: last?.revisionNumber ?? null,
          claimsJson: claims as unknown as Prisma.InputJsonValue,
          constraintFindingsJson: findings as unknown as Prisma.InputJsonValue,
          wordCount: wordCount(content.bodyMarkdown),
          generationToken: token,
        },
      });

      const updatedDraft = await tx.contentDraft.update({
        where: { id: draft.id },
        data: { currentRevisionId: revision.id },
      });

      // CONTENT_REVISION_CREATED and CONTENT_GENERATION_COMPLETED (§36).
      await recordAudit(tx, context, {
        entityType: "ContentRevision",
        entityId: revision.id,
        action: "CREATE",
        after: {
          draftId: draft.id,
          revisionNumber,
          aiRunId: result.run.id,
          evidencePackageId: assembled.package.id,
          wordCount: revision.wordCount,
          claims: {
            supported: claims.filter((claim) => claim.status === "SUPPORTED").length,
            unsupported: claims.filter((claim) => claim.status === "UNSUPPORTED").length,
          },
          findings: {
            blocking: checked.findings.filter((row) => row.severity === "BLOCKING").length,
            warning: checked.findings.filter((row) => row.severity === "WARNING").length,
            info: checked.findings.filter((row) => row.severity === "INFO").length,
          },
          citations: {
            malformed: audit.malformed.length,
            outsidePackage: audit.outsidePackage.length,
            unresolved: audit.unresolved.length,
          },
        },
      });
      await recordAudit(tx, context, {
        entityType: "ContentDraft",
        entityId: draft.id,
        action: "COMPLETE",
        after: {
          status: "SUCCEEDED",
          aiRunId: result.run.id,
          revisionId: revision.id,
          revisionNumber,
        },
      });

      return { revision, draft: updatedDraft };
    });

    return {
      ok: true,
      revision: stored.revision,
      draft: stored.draft,
      run: result.run,
      reused: false,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // The same token landed twice at once, or two generations raced for a
      // number. The token wins its own row; a number race is told to retry.
      const winner = await prisma.contentRevision.findFirst({
        where: { contentDraftId: draft.id, generationToken: token },
        include: { createdByAiRun: true },
      });
      if (winner) {
        const { createdByAiRun, ...revision } = winner;
        return { ok: true, revision, draft, run: createdByAiRun, reused: true };
      }
      throw new ContentDraftError(
        "Another revision was created at the same moment. Reload and try again.",
        "version_conflict",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reading (§10, §12)
// ---------------------------------------------------------------------------

const REVISION_INCLUDE = {
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
} satisfies Prisma.ContentRevisionInclude;

export type RevisionView = Prisma.ContentRevisionGetPayload<{ include: typeof REVISION_INCLUDE }>;

export type DraftView = {
  draft: ContentDraft;
  /** The exact approved brief version the draft is pinned to. */
  brief: ContentBrief;
  /** A newer approved version exists; the draft was not moved to it. */
  briefMismatch: { approvedVersion: number; approvedBriefId: string } | null;
  current: RevisionView | null;
  revisionCount: number;
};

/** The open draft for a work item, with its pinned brief and current revision. */
export async function getDraftForWorkItem(
  context: TenantContext,
  workItemId: string,
): Promise<DraftView | null> {
  const draft = await prisma.contentDraft.findFirst({
    where: {
      contentWorkItemId: workItemId,
      status: { notIn: ["SUPERSEDED", "ARCHIVED"] },
      ...websiteScope(context),
    },
    orderBy: { createdAt: "desc" },
    include: { brief: true },
  });
  if (!draft) return null;

  const [current, approved, revisionCount] = await Promise.all([
    draft.currentRevisionId
      ? prisma.contentRevision.findFirst({
          where: { id: draft.currentRevisionId, ...websiteScope(context) },
          include: REVISION_INCLUDE,
        })
      : Promise.resolve(null),
    prisma.contentBrief.findFirst({
      where: { contentWorkItemId: workItemId, status: "APPROVED", ...websiteScope(context) },
      select: { id: true, version: true },
    }),
    prisma.contentRevision.count({ where: { contentDraftId: draft.id } }),
  ]);

  const { brief, ...rest } = draft;
  return {
    draft: rest,
    brief,
    briefMismatch:
      approved && approved.id !== brief.id
        ? { approvedVersion: approved.version, approvedBriefId: approved.id }
        : null,
    current,
    revisionCount,
  };
}

export async function getRevision(
  context: TenantContext,
  revisionId: string,
): Promise<RevisionView | null> {
  return prisma.contentRevision.findFirst({
    where: { id: revisionId, ...websiteScope(context) },
    include: REVISION_INCLUDE,
  });
}

/** Sanitized HTML of a revision's body, for the preview. */
export function previewHtml(revision: Pick<ContentRevision, "bodyMarkdown">): string {
  return renderMarkdown(revision.bodyMarkdown);
}

export function revisionClaims(revision: Pick<ContentRevision, "claimsJson">): RevisionClaim[] {
  return asArray<RevisionClaim>(revision.claimsJson);
}

export function revisionFindings(
  revision: Pick<ContentRevision, "constraintFindingsJson">,
): RevisionFindings | null {
  const value = revision.constraintFindingsJson;
  return value && typeof value === "object" && "findings" in value
    ? (value as unknown as RevisionFindings)
    : null;
}

export type { RuleConstraint };
