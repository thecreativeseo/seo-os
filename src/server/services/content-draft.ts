import { z } from "zod";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { isAiConfigured } from "@/server/ai/registry";
import { SYSTEM_AUTH_USER_ID } from "@/server/jobs/system-context";
import { runAgent } from "@/server/services/ai-run";
import { transitionWorkItem } from "@/server/services/content-work";
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
import { plainText, renderMarkdown, wordCount } from "@/lib/content/markdown";
import { reconcileBriefClaims, type ReconciledClaim } from "@/lib/content/reconcile";
import { targetLengthFor } from "@/lib/content/draft-ux";
import {
  diffLines,
  revisionChanges,
  type DiffLine,
  type RevisionChanges,
  type RevisionFields,
} from "@/lib/content/diff";
import { revisionHash } from "@/lib/execution/hash";
import { DRAFT_TRANSITIONS, REVIEW_TRANSITIONS, canTransition } from "@/lib/execution/statuses";
import { buildEvidenceId, parseEvidenceId } from "@/lib/evidence/id";
import type { Evidence } from "@/lib/evidence/types";
import {
  CONTENT_DRAFT_SCHEMA_NAME,
  SLUG_PATTERN,
  contentDraftSchema,
  type ContentDraftOutput,
} from "@/lib/ai/schemas/content-draft";
import { Prisma } from "@/generated/prisma/client";
import type {
  AiRun,
  ContentBrief,
  ContentDraft,
  ContentDraftReview,
  ContentDraftReviewStatus,
  ContentDraftStatus,
  ContentRevision,
  ContentWorkItem,
  EvidenceCategory,
} from "@/generated/prisma/client";

/**
 * ContentDraftService (docs/P4_SPEC.md §9-§12, §25; M4 plan, M4.2-M4.5).
 *
 * A draft is written from an approved brief and nothing else. The brief is
 * pinned to the draft by id - an immutable APPROVED row - and is never moved
 * to a newer version behind anyone's back. When a newer version is approved
 * the draft stays where it is, generation against the old version stops, and
 * a person may start a separate draft from the new one; the old draft is then
 * SUPERSEDED with every revision still inspectable.
 *
 * What is true is decided at the moment of writing: for a generation, by a
 * fresh content-draft package; for a hand-written revision, by the facts
 * approved right now. A claim the brief allowed is offered only while its
 * fact is still approved, and is marked STALE for the editor if not.
 *
 * Every revision is immutable and carries what made it. Review is a record
 * of its own (M4.5): a request pins the exact revision by id and hash and
 * the exact brief version; a person with REVIEW decides it once - approved
 * or returned - and the row never changes again. Approval sets the draft's
 * standing pointer to that one revision and hands the work item to QA;
 * nothing edits an approved draft until a person reopens it, which clears
 * the pointer and leaves the approval in history where it was.
 */

export class ContentDraftError extends Error {
  readonly findings: DraftFinding[];
  readonly issues: string[];

  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_state"
      | "invalid_input"
      | "brief_not_approved"
      | "brief_superseded"
      | "nothing_changed"
      | "blocked"
      | "version_conflict",
    details: { findings?: DraftFinding[]; issues?: string[] } = {},
  ) {
    super(message);
    this.name = "ContentDraftError";
    this.findings = details.findings ?? [];
    this.issues = details.issues ?? [];
  }
}

export const NO_PROVIDER_MESSAGE =
  "No AI provider is configured — write the first revision by hand.";
export const IN_PROGRESS_MESSAGE =
  "A draft is already being generated for this work item. Wait for it to finish, then reload.";
export const GENERATION_FAILED_MESSAGE =
  "The draft could not be generated. Nothing was stored; the run is recorded with its reason.";
export const APPROVED_LOCKED_MESSAGE =
  "This draft is approved. Reopen it for revision first; the approval stays in history.";

/** How long a RUNNING run holds the work item before it is treated as abandoned. */
export const RUNNING_GUARD_MS = 10 * 60 * 1000;

/** Draft statuses a person can still write into. An approved draft is not one until reopened. */
const EDITABLE_STATUSES: ContentDraftStatus[] = ["DRAFTING", "AWAITING_EDITOR_REVIEW"];
/** Draft statuses that count as "the draft" for a work item. */
const OPEN_STATUSES: ContentDraftStatus[] = ["DRAFTING", "AWAITING_EDITOR_REVIEW", "APPROVED"];

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
  /** Brief claims that were stale at writing time, so the editor sees them. */
  staleClaims: ReconciledClaim[];
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireHuman(context: TenantContext, what: string): void {
  if (context.user.authUserId === SYSTEM_AUTH_USER_ID) {
    throw new ContentDraftError(`${what} is done by a person, not by a job.`, "forbidden");
  }
}

function requireHumanWriter(context: TenantContext): void {
  requireHuman(context, "Drafting");
  if (!hasRole(context.membership.role, REQUIRED.WRITE)) {
    throw new ContentDraftError("You do not have permission to draft content.", "forbidden");
  }
}

function requireHumanReviewer(context: TenantContext, what: string): void {
  requireHuman(context, "Reviewing");
  if (!hasRole(context.membership.role, REQUIRED.REVIEW)) {
    throw new ContentDraftError(`${what} needs an SEO lead, admin or owner.`, "forbidden");
  }
}

async function scopedItem(context: TenantContext, workItemId: string): Promise<ContentWorkItem> {
  const item = await prisma.contentWorkItem.findFirst({
    where: { id: workItemId, ...websiteScope(context) },
  });
  if (!item) {
    throw new ContentDraftError("That work item is not available.", "not_found");
  }
  return item;
}

async function draftingItem(context: TenantContext, workItemId: string): Promise<ContentWorkItem> {
  const item = await scopedItem(context, workItemId);
  if (item.status !== "DRAFTING") {
    throw new ContentDraftError(
      item.status === "QUEUED" || item.status === "BRIEFING"
        ? "Drafting starts once a brief has been approved."
        : item.status === "QA"
          ? "The draft is approved and ready for QA. Reopen it for revision to change it."
          : `Drafting is not open for work that is ${statusWords(item.status)}.`,
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

type DraftWithBrief = ContentDraft & { brief: ContentBrief };

async function scopedDraft(context: TenantContext, draftId: string): Promise<DraftWithBrief> {
  const draft = await prisma.contentDraft.findFirst({
    where: { id: draftId, ...websiteScope(context) },
    include: { brief: true },
  });
  if (!draft) {
    throw new ContentDraftError("That draft is not available.", "not_found");
  }
  return draft;
}

function statusWords(status: string): string {
  return status.toLowerCase().replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// The container (§9)
// ---------------------------------------------------------------------------

export type StartDraftResult = { draft: ContentDraft; brief: ContentBrief; created: boolean };

/**
 * One draft per work item and approved brief version. Returns the open draft
 * when there is one - drafting, under review, or approved - even if a newer
 * brief version has since been approved; that mismatch is surfaced by the
 * reader and resolved only by startDraftFromBrief, never here.
 */
export async function startDraft(
  context: TenantContext,
  workItemId: string,
): Promise<StartDraftResult> {
  requireHumanWriter(context);
  const item = await scopedItem(context, workItemId);

  const existing = await prisma.contentDraft.findFirst({
    where: { contentWorkItemId: item.id, status: { in: OPEN_STATUSES }, ...websiteScope(context) },
    orderBy: { createdAt: "desc" },
    include: { brief: true },
  });
  if (existing) {
    const { brief: pinned, ...draft } = existing;
    return { draft, brief: pinned, created: false };
  }

  await draftingItem(context, item.id);
  const brief = await approvedBrief(context, item.id);

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

export type StartFromBriefResult = StartDraftResult & { supersededDraftIds: string[] };

/**
 * The explicit act of moving on to a newer approved brief (M4.3, superseded
 * brief rule). A new draft is pinned to that version; the open draft(s) for
 * the work item become SUPERSEDED with every revision kept. Nothing is copied
 * across: the new draft starts from the new brief and, when generated, a
 * fresh package. An open review request is invalidated; a standing approval
 * stops applying (its row stays in history) and the work item leaves QA.
 */
export async function startDraftFromBrief(
  context: TenantContext,
  workItemId: string,
  briefId: string,
): Promise<StartFromBriefResult> {
  requireHumanWriter(context);
  const item = await scopedItem(context, workItemId);
  if (item.status !== "DRAFTING" && item.status !== "QA") {
    throw new ContentDraftError(
      item.status === "QUEUED" || item.status === "BRIEFING"
        ? "Drafting starts once a brief has been approved."
        : `Drafting is not open for work that is ${statusWords(item.status)}.`,
      "invalid_state",
    );
  }

  const brief = await prisma.contentBrief.findFirst({
    where: { id: briefId, contentWorkItemId: item.id, ...websiteScope(context) },
  });
  if (!brief) {
    throw new ContentDraftError("That brief version is not available.", "not_found");
  }
  if (brief.status !== "APPROVED") {
    throw new ContentDraftError(
      `Brief v${brief.version} is ${statusWords(brief.status)}; a draft can only start from the approved version.`,
      "brief_not_approved",
    );
  }

  const open = await prisma.contentDraft.findMany({
    where: { contentWorkItemId: item.id, status: { in: OPEN_STATUSES }, ...websiteScope(context) },
    orderBy: { createdAt: "asc" },
  });
  const already = open.find((row) => row.briefId === brief.id);
  if (already) {
    return { draft: already, brief, created: false, supersededDraftIds: [] };
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

    for (const previous of open) {
      if (!canTransition(DRAFT_TRANSITIONS, previous.status, "SUPERSEDED")) {
        throw new ContentDraftError(
          `The draft that is ${statusWords(previous.status)} cannot be superseded.`,
          "invalid_state",
        );
      }
      await invalidateOpenRequests(tx, context, previous.id, "draft_superseded");
      await tx.contentDraft.update({
        where: { id: previous.id },
        data: {
          status: "SUPERSEDED",
          approvedRevisionId: null,
          approvedRevisionHash: null,
          approvedByUserId: null,
          approvedAt: null,
          approvedReviewId: null,
        },
      });
      if (previous.approvedReviewId) {
        await recordAudit(tx, context, {
          entityType: "ContentDraftReview",
          entityId: previous.approvedReviewId,
          action: "RETIRE",
          after: {
            reason: "draft_superseded",
            draftId: previous.id,
            supersededByDraftId: created.id,
          },
        });
      }
      await recordAudit(tx, context, {
        entityType: "ContentDraft",
        entityId: previous.id,
        action: "SUPERSEDE",
        before: {
          status: previous.status,
          briefId: previous.briefId,
          approvedReviewId: previous.approvedReviewId,
        },
        after: { status: "SUPERSEDED", supersededByDraftId: created.id, briefId: brief.id },
      });
    }

    if (item.status === "QA") {
      await transitionWorkItem(tx, context, item.id, "DRAFTING", "approved draft superseded");
    }

    await recordAudit(tx, context, {
      entityType: "ContentDraft",
      entityId: created.id,
      action: "CREATE",
      after: {
        workItemId: item.id,
        briefId: brief.id,
        briefVersion: brief.version,
        previousDraftIds: open.map((row) => row.id),
      },
    });

    return created;
  });

  return { draft, brief, created: true, supersededDraftIds: open.map((row) => row.id) };
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

/** The website's active rules that carry a machine check - for hand-written revisions. */
async function activeMachineRules(context: TenantContext): Promise<MachineRule[]> {
  const rows = await prisma.seoRule.findMany({
    where: { ...websiteScope(context), active: true, archivedAt: null },
    select: { id: true, severity: true, checkJson: true },
  });
  return rows
    .filter((row) => row.checkJson !== null)
    .map((row) => ({ ruleId: row.id, severity: row.severity, check: row.checkJson }));
}

function prohibitedPhrasesOf(prohibited: ProhibitedClaim[]): string[] {
  return prohibited.filter((claim) => claim.source !== "AVOID_TOPIC").map((claim) => claim.text);
}

function avoidTopicsOf(prohibited: ProhibitedClaim[]): string[] {
  return prohibited
    .filter((claim) => claim.source === "AVOID_TOPIC")
    .map((claim) => claim.text.replace(/^Avoid the topic:\s*/i, ""));
}

/**
 * Generates the next revision of a draft from its pinned brief and a fresh
 * package. Inline: the caller waits. Idempotent by token, guarded against
 * concurrent runs, honest when nothing can run. Refused once the pinned
 * brief has been superseded, while review is requested, and while the draft
 * is approved: the person acts first.
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

  const draft = await scopedDraft(context, draftId);
  if (draft.status !== "DRAFTING") {
    throw new ContentDraftError(
      draft.status === "AWAITING_EDITOR_REVIEW"
        ? "Review has been requested for this draft. Return it to drafting, or save a hand-written revision, before generating again."
        : draft.status === "APPROVED"
          ? APPROVED_LOCKED_MESSAGE
          : `This draft is ${statusWords(draft.status)}; nothing can be generated for it.`,
      "invalid_state",
    );
  }
  const item = await draftingItem(context, draft.contentWorkItemId);
  const brief = draft.brief;
  if (brief.status === "SUPERSEDED") {
    const newer = await prisma.contentBrief.findFirst({
      where: { contentWorkItemId: item.id, status: "APPROVED", ...websiteScope(context) },
      select: { version: true },
    });
    throw new ContentDraftError(
      `This draft was created from brief v${brief.version}, which has been superseded${newer ? ` by v${newer.version}` : ""}. Generation against it is closed; start a draft from the approved version.`,
      "brief_superseded",
    );
  }
  if (brief.status !== "APPROVED") {
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
    prohibitedPhrases: prohibitedPhrasesOf(prohibited),
    avoidTopics: avoidTopicsOf(prohibited),
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
          author: "AI",
          aiRunId: result.run.id,
          evidencePackageId: assembled.package.id,
          wordCount: revision.wordCount,
          claims: {
            supported: claims.filter((claim) => claim.status === "SUPPORTED").length,
            unsupported: claims.filter((claim) => claim.status === "UNSUPPORTED").length,
          },
          findings: countFindings(checked.findings),
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
// Hand-written revisions (M4.3 §1)
// ---------------------------------------------------------------------------

export const revisionInputSchema = z.object({
  title: z.string().trim().min(1, "A title is required.").max(200),
  slug: z
    .string()
    .trim()
    .max(200)
    .regex(SLUG_PATTERN, "A slug is lowercase words joined by hyphens.")
    .nullable(),
  excerpt: z.string().trim().max(1000).nullable(),
  metaTitle: z.string().trim().max(200).nullable(),
  metaDescription: z.string().trim().max(500).nullable(),
  bodyMarkdown: z.string().min(1, "The body is required.").max(80_000),
  changeSummary: z.string().trim().min(1, "Say what changed.").max(500),
});

export type RevisionInput = z.input<typeof revisionInputSchema>;

/** Empty strings from a form mean "not set". */
function normaliseInput(input: RevisionInput): RevisionInput {
  const orNull = (value: string | null | undefined) =>
    typeof value === "string" && value.trim().length > 0 ? value : null;
  return {
    title: input.title,
    slug: orNull(input.slug),
    excerpt: orNull(input.excerpt),
    metaTitle: orNull(input.metaTitle),
    metaDescription: orNull(input.metaDescription),
    bodyMarkdown: input.bodyMarkdown,
    changeSummary: input.changeSummary,
  };
}

function countFindings(findings: DraftFinding[]): {
  blocking: number;
  warning: number;
  info: number;
} {
  return {
    blocking: findings.filter((row) => row.severity === "BLOCKING").length,
    warning: findings.filter((row) => row.severity === "WARNING").length,
    info: findings.filter((row) => row.severity === "INFO").length,
  };
}

/**
 * What is true right now for a set of evidence ids: the brand facts among
 * them that are APPROVED, and the business context version among them that
 * is the approved one. Anything else is not current, whatever a brief or an
 * earlier revision said.
 */
async function currentTruth(
  context: TenantContext,
  evidenceIds: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const factIds: string[] = [];
  const versionIds: string[] = [];
  for (const raw of evidenceIds) {
    const parsed = raw ? parseEvidenceId(raw) : null;
    if (!parsed) continue;
    if (parsed.kind === "fact") factIds.push(parsed.brandFactId);
    if (parsed.kind === "ctx") versionIds.push(parsed.contextVersionId);
  }

  const truth = new Map<string, string>();
  if (factIds.length > 0) {
    const facts = await prisma.brandFact.findMany({
      where: { id: { in: factIds }, ...websiteScope(context), approvalStatus: "APPROVED" },
      select: { id: true },
    });
    for (const fact of facts) {
      truth.set(buildEvidenceId({ kind: "fact", brandFactId: fact.id }), "BRAND_FACT");
    }
  }
  if (versionIds.length > 0) {
    const versions = await prisma.businessContextVersion.findMany({
      where: {
        id: { in: versionIds },
        status: "APPROVED",
        businessContext: { websiteId: context.website.id },
      },
      select: { id: true },
    });
    for (const version of versions) {
      truth.set(buildEvidenceId({ kind: "ctx", contextVersionId: version.id }), "BUSINESS_CONTEXT");
    }
  }
  return truth;
}

function normaliseText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The claims a hand-written revision makes: those the brief allows and those
 * the previous revision declared, kept when their words are still in the
 * text, each judged against what is approved now.
 */
function carriedClaims(input: {
  previous: RevisionClaim[];
  valid: ReconciledClaim[];
  truth: Map<string, string>;
  text: string;
}): RevisionClaim[] {
  const haystack = normaliseText(input.text);
  const candidates = new Map<string, RevisionClaim>();
  for (const claim of input.valid) {
    candidates.set(normaliseText(claim.text), {
      text: claim.text,
      evidenceId: claim.evidenceId,
      status: "SUPPORTED",
      reason: null,
    });
  }
  for (const claim of input.previous) {
    const key = normaliseText(claim.text);
    if (!candidates.has(key)) candidates.set(key, claim);
  }

  const claims: RevisionClaim[] = [];
  for (const [key, claim] of candidates) {
    if (!key || !haystack.includes(key)) continue;
    if (claim.evidenceId && input.truth.has(claim.evidenceId)) {
      claims.push({ ...claim, status: "SUPPORTED", reason: null });
    } else if (claim.evidenceId) {
      claims.push({
        ...claim,
        status: "UNSUPPORTED",
        reason:
          claim.status === "UNSUPPORTED" && claim.reason
            ? claim.reason
            : "The cited fact is no longer approved.",
      });
    } else {
      claims.push({
        ...claim,
        status: "UNSUPPORTED",
        reason: claim.reason ?? "No fact was cited.",
      });
    }
  }
  return claims;
}

export type SaveRevisionResult = {
  revision: ContentRevision;
  draft: ContentDraft;
  /** True when the draft was awaiting review and this edit sent it back to drafting. */
  returnedToDrafting: boolean;
};

/**
 * A person's revision. Always a new immutable row, written from the current
 * one; never an edit in place. Checked like a generated one, with the
 * human-mode link rule: safe http(s) links are kept and flagged, unsafe
 * schemes and rule-prohibited links are removed. If the draft was awaiting
 * review, it is drafting again and the open request is invalidated: what
 * the reviewer was looking at has changed. An approved draft is refused
 * until a person reopens it.
 */
export async function saveRevision(
  context: TenantContext,
  draftId: string,
  rawInput: RevisionInput,
): Promise<SaveRevisionResult> {
  requireHumanWriter(context);

  const parsed = revisionInputSchema.safeParse(normaliseInput(rawInput));
  if (!parsed.success) {
    throw new ContentDraftError("The revision could not be saved as entered.", "invalid_input", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }
  const input = parsed.data;

  const draft = await scopedDraft(context, draftId);
  if (draft.status === "APPROVED") {
    throw new ContentDraftError(APPROVED_LOCKED_MESSAGE, "invalid_state");
  }
  if (!EDITABLE_STATUSES.includes(draft.status)) {
    throw new ContentDraftError(
      `This draft is ${statusWords(draft.status)}; it can be read but not written to.`,
      "invalid_state",
    );
  }
  await draftingItem(context, draft.contentWorkItemId);
  const brief = draft.brief;

  const current = draft.currentRevisionId
    ? await prisma.contentRevision.findFirst({
        where: { id: draft.currentRevisionId, ...websiteScope(context) },
      })
    : null;
  const previousClaims = current ? revisionClaims(current) : [];

  // What is true now, for everything the brief and the last revision cited.
  const briefClaims = asArray<CitedClaim>(brief.approvedClaimsJson);
  const truth = await currentTruth(context, [
    ...briefClaims.map((claim) => claim.evidenceId),
    ...previousClaims.map((claim) => claim.evidenceId),
  ]);
  const reconciled = reconcileBriefClaims(briefClaims, truth);
  const prohibited = asArray<ProhibitedClaim>(brief.prohibitedClaimsJson);
  const links = asArray<LinkTarget>(brief.internalLinkTargetsJson);

  const checked = checkDraftConstraints({
    mode: "human",
    title: input.title,
    metaTitle: input.metaTitle,
    metaDescription: input.metaDescription,
    excerpt: input.excerpt,
    bodyMarkdown: input.bodyMarkdown,
    prohibitedPhrases: prohibitedPhrasesOf(prohibited),
    avoidTopics: avoidTopicsOf(prohibited),
    staleClaims: reconciled.stale.map((claim) => claim.text),
    approvedClaimTexts: reconciled.valid.map((claim) => claim.text),
    allowedLinkPaths: links
      .map((link) => link.path)
      .filter((path): path is string => Boolean(path)),
    siteHost: context.website.normalizedDomain,
    rules: await activeMachineRules(context),
  });

  const content = {
    title: input.title,
    slug: input.slug,
    excerpt: input.excerpt,
    bodyMarkdown: checked.bodyMarkdown,
    metaTitle: input.metaTitle,
    metaDescription: input.metaDescription,
    schemaJson: null,
  };
  const contentHash = revisionHash(content);
  if (current && current.contentHash === contentHash) {
    throw new ContentDraftError(
      "Nothing changed. The text is the same as the current revision.",
      "nothing_changed",
    );
  }

  const claims = carriedClaims({
    previous: previousClaims,
    valid: reconciled.valid,
    truth,
    text: plainText([content.title, content.excerpt ?? "", content.bodyMarkdown].join("\n\n")),
  });
  const findings: RevisionFindings = {
    version: 1,
    findings: checked.findings,
    blocking: checked.blocking,
    links: [],
    openQuestions: [],
    sectionsCovered: [],
    staleClaims: reconciled.stale,
  };
  const returnedToDrafting = draft.status === "AWAITING_EDITOR_REVIEW";
  if (returnedToDrafting && !canTransition(DRAFT_TRANSITIONS, draft.status, "DRAFTING")) {
    throw new ContentDraftError("This draft cannot return to drafting from here.", "invalid_state");
  }

  try {
    return await prisma.$transaction(async (tx) => {
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
          changeSummary: input.changeSummary,
          contentHash,
          createdByUserId: context.user.id,
          basedOnRevisionNumber: current?.revisionNumber ?? null,
          claimsJson: claims as unknown as Prisma.InputJsonValue,
          constraintFindingsJson: findings as unknown as Prisma.InputJsonValue,
          wordCount: wordCount(content.bodyMarkdown),
        },
      });

      const updatedDraft = await tx.contentDraft.update({
        where: { id: draft.id },
        data: {
          currentRevisionId: revision.id,
          ...(returnedToDrafting ? { status: "DRAFTING" as const } : {}),
        },
      });

      // CONTENT_REVISION_CREATED (§36).
      await recordAudit(tx, context, {
        entityType: "ContentRevision",
        entityId: revision.id,
        action: "CREATE",
        after: {
          draftId: draft.id,
          revisionNumber,
          author: "HUMAN",
          basedOnRevisionNumber: current?.revisionNumber ?? null,
          wordCount: revision.wordCount,
          findings: countFindings(checked.findings),
          claims: {
            supported: claims.filter((claim) => claim.status === "SUPPORTED").length,
            unsupported: claims.filter((claim) => claim.status === "UNSUPPORTED").length,
          },
        },
      });
      if (returnedToDrafting) {
        await invalidateOpenRequests(tx, context, draft.id, "content_changed");
        await recordAudit(tx, context, {
          entityType: "ContentDraft",
          entityId: draft.id,
          action: "UPDATE",
          before: { status: draft.status },
          after: {
            status: "DRAFTING",
            reason: "The content under review changed.",
            revisionId: revision.id,
          },
        });
      }

      return { revision, draft: updatedDraft, returnedToDrafting };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ContentDraftError(
        "Another revision was created at the same moment. Reload and try again.",
        "version_conflict",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Review: request, return, approve, reopen (M4.3 §5-§6; M4.5 D1-D8)
// ---------------------------------------------------------------------------

/** Open requests of a draft stop applying: the content changed or the draft was superseded. */
async function invalidateOpenRequests(
  tx: Prisma.TransactionClient,
  context: TenantContext,
  draftId: string,
  reason: "content_changed" | "draft_superseded",
): Promise<void> {
  const open = await tx.contentDraftReview.findMany({
    where: { contentDraftId: draftId, status: "REQUESTED", websiteId: context.website.id },
    select: { id: true, contentRevisionId: true, revisionNumber: true },
  });
  for (const request of open) {
    if (!canTransition(REVIEW_TRANSITIONS, "REQUESTED", "INVALIDATED")) {
      throw new ContentDraftError("A review request cannot be invalidated.", "invalid_state");
    }
    await tx.contentDraftReview.update({
      where: { id: request.id },
      data: { status: "INVALIDATED", invalidatedReason: reason },
    });
    await recordAudit(tx, context, {
      entityType: "ContentDraftReview",
      entityId: request.id,
      action: "UPDATE",
      before: { status: "REQUESTED" },
      after: {
        status: "INVALIDATED",
        reason,
        revisionId: request.contentRevisionId,
        revisionNumber: request.revisionNumber,
      },
    });
  }
}

/**
 * Sends the current revision for editorial review. Refused while the
 * current revision has blocking findings: the person sees exactly which, and
 * clears them with a new revision. Warnings do not stand in the way. The
 * request is a row pinned to the exact revision and the pinned brief (D2).
 */
export async function requestDraftReview(
  context: TenantContext,
  draftId: string,
): Promise<ContentDraft> {
  requireHumanWriter(context);
  const draft = await scopedDraft(context, draftId);
  if (draft.status === "AWAITING_EDITOR_REVIEW") {
    throw new ContentDraftError("Review has already been requested.", "invalid_state");
  }
  if (draft.status === "APPROVED") {
    throw new ContentDraftError("This draft is already approved.", "invalid_state");
  }
  if (draft.status !== "DRAFTING") {
    throw new ContentDraftError(
      `This draft is ${statusWords(draft.status)}; it cannot go for review.`,
      "invalid_state",
    );
  }
  await draftingItem(context, draft.contentWorkItemId);

  const current = draft.currentRevisionId
    ? await prisma.contentRevision.findFirst({
        where: { id: draft.currentRevisionId, ...websiteScope(context) },
      })
    : null;
  if (!current) {
    throw new ContentDraftError(
      "Nothing to review yet. Generate or write a revision first.",
      "invalid_state",
    );
  }

  const blocking = (revisionFindings(current)?.findings ?? []).filter(
    (finding) => finding.severity === "BLOCKING",
  );
  if (blocking.length > 0) {
    throw new ContentDraftError(
      `Revision ${current.revisionNumber} has ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}. Resolve them in a new revision before requesting review.`,
      "blocked",
      { findings: blocking },
    );
  }

  if (!canTransition(DRAFT_TRANSITIONS, draft.status, "AWAITING_EDITOR_REVIEW")) {
    throw new ContentDraftError("This draft cannot go for review from here.", "invalid_state");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const request = await tx.contentDraftReview.create({
        data: {
          websiteId: context.website.id,
          contentWorkItemId: draft.contentWorkItemId,
          contentDraftId: draft.id,
          contentRevisionId: current.id,
          revisionNumber: current.revisionNumber,
          revisionHash: current.contentHash,
          briefId: draft.briefId,
          briefVersion: draft.brief.version,
          status: "REQUESTED",
          requestedByUserId: context.user.id,
        },
      });
      const updated = await tx.contentDraft.update({
        where: { id: draft.id },
        data: { status: "AWAITING_EDITOR_REVIEW" },
      });
      await recordAudit(tx, context, {
        entityType: "ContentDraftReview",
        entityId: request.id,
        action: "CREATE",
        after: {
          draftId: draft.id,
          revisionId: current.id,
          revisionNumber: current.revisionNumber,
          revisionHash: current.contentHash,
          briefId: draft.briefId,
          briefVersion: draft.brief.version,
        },
      });
      await recordAudit(tx, context, {
        entityType: "ContentDraft",
        entityId: draft.id,
        action: "UPDATE",
        before: { status: draft.status },
        after: {
          status: "AWAITING_EDITOR_REVIEW",
          reviewId: request.id,
          revisionId: current.id,
          revisionNumber: current.revisionNumber,
          briefVersion: draft.brief.version,
          briefSuperseded: draft.brief.status !== "APPROVED",
        },
      });
      return updated;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ContentDraftError(
        "A review request for this draft is already open. Reload and try again.",
        "version_conflict",
      );
    }
    throw error;
  }
}

/** The one open request of a draft, when there is one. */
async function openRequestOf(
  tx: Prisma.TransactionClient,
  context: TenantContext,
  draftId: string,
): Promise<ContentDraftReview | null> {
  return tx.contentDraftReview.findFirst({
    where: { contentDraftId: draftId, status: "REQUESTED", websiteId: context.website.id },
  });
}

/**
 * A reviewer sends the draft back with a note. The note is required: a
 * draft returned without a reason tells the editor nothing. The open request
 * is decided as RETURNED; the note lives on it and in the audit trail.
 */
export async function returnDraftToDrafting(
  context: TenantContext,
  draftId: string,
  note: string,
): Promise<ContentDraft> {
  requireHumanReviewer(context, "Returning a draft to drafting");
  const draft = await scopedDraft(context, draftId);
  if (draft.status !== "AWAITING_EDITOR_REVIEW") {
    throw new ContentDraftError(
      `This draft is ${statusWords(draft.status)}; only a draft awaiting review can be returned.`,
      "invalid_state",
    );
  }
  const trimmed = note.trim();
  if (!trimmed) {
    throw new ContentDraftError("Say why the draft is going back.", "invalid_input", {
      issues: ["note: A note is required."],
    });
  }
  if (trimmed.length > 2000) {
    throw new ContentDraftError("Keep the note under 2,000 characters.", "invalid_input", {
      issues: ["note: Too long."],
    });
  }
  if (!canTransition(DRAFT_TRANSITIONS, draft.status, "DRAFTING")) {
    throw new ContentDraftError("This draft cannot return to drafting from here.", "invalid_state");
  }

  return prisma.$transaction(async (tx) => {
    const request = await openRequestOf(tx, context, draft.id);
    if (request) {
      const reviewed = await tx.contentRevision.findFirst({
        where: { id: request.contentRevisionId },
        select: { createdByUserId: true },
      });
      await tx.contentDraftReview.update({
        where: { id: request.id },
        data: {
          status: "RETURNED",
          decidedByUserId: context.user.id,
          decidedAt: new Date(),
          note: trimmed,
          selfDecided: reviewed?.createdByUserId === context.user.id,
          briefSupersededAtDecision: draft.brief.status !== "APPROVED",
        },
      });
      await recordAudit(tx, context, {
        entityType: "ContentDraftReview",
        entityId: request.id,
        action: "DECLINE",
        before: { status: "REQUESTED" },
        after: {
          status: "RETURNED",
          revisionId: request.contentRevisionId,
          revisionNumber: request.revisionNumber,
          note: trimmed,
        },
      });
    }
    const updated = await tx.contentDraft.update({
      where: { id: draft.id },
      data: { status: "DRAFTING" },
    });
    await recordAudit(tx, context, {
      entityType: "ContentDraft",
      entityId: draft.id,
      action: "DECLINE",
      before: { status: draft.status },
      after: {
        status: "DRAFTING",
        note: trimmed,
        revisionId: draft.currentRevisionId,
        reviewId: request?.id ?? null,
      },
    });
    return updated;
  });
}

/**
 * The claims of a revision judged against the facts approved right now, as
 * findings: a supported claim whose fact was revoked since, or a brief claim
 * that went stale and still stands in the text (D5).
 */
async function staleClaimFindings(
  context: TenantContext,
  brief: ContentBrief,
  revision: ContentRevision,
): Promise<DraftFinding[]> {
  const claims = revisionClaims(revision);
  const briefClaims = asArray<CitedClaim>(brief.approvedClaimsJson);
  const truth = await currentTruth(context, [
    ...claims.map((claim) => claim.evidenceId),
    ...briefClaims.map((claim) => claim.evidenceId),
  ]);

  const findings: DraftFinding[] = [];
  for (const claim of claims) {
    if (claim.status === "SUPPORTED" && claim.evidenceId && !truth.has(claim.evidenceId)) {
      findings.push({
        kind: "STALE_CLAIM",
        severity: "BLOCKING",
        message: `The fact behind "${claim.text}" is no longer approved.`,
        excerpt: claim.text,
      });
    }
  }
  const text = normaliseText(
    plainText([revision.title, revision.excerpt ?? "", revision.bodyMarkdown].join("\n\n")),
  );
  for (const stale of reconcileBriefClaims(briefClaims, truth).stale) {
    const key = normaliseText(stale.text);
    if (!key || !text.includes(key)) continue;
    if (findings.some((finding) => finding.excerpt === stale.text)) continue;
    findings.push({
      kind: "STALE_CLAIM",
      severity: "BLOCKING",
      message: `This claim rests on a fact that is no longer approved: "${stale.text}".`,
      excerpt: stale.text,
    });
  }
  return findings;
}

export type ApproveDraftInput = {
  /** Optional (D8). Kept on the review row and in the audit event. */
  note?: string | null;
  /** Required when a newer brief version has been approved since the draft was pinned (D6). */
  acknowledgeBriefMismatch?: boolean;
};

export type ApproveDraftResult = {
  draft: ContentDraft;
  review: ContentDraftReview;
  revision: ContentRevision;
  workItem: ContentWorkItem;
};

/**
 * Approves exactly the revision that was requested for review (D1, D2).
 *
 * Refused unless: the caller has REVIEW and is a person; the draft is
 * awaiting review with one open request; that request still names the
 * draft's current revision and its hash still matches; the revision has no
 * blocking finding, and none of its claims went stale since it was written;
 * and, when a newer brief version has been approved meanwhile, the reviewer
 * has said so explicitly.
 *
 * Atomic: the decision on the review row, the draft's standing pointer and
 * status, the work item's move to QA, and every audit write happen in one
 * transaction or not at all.
 */
export async function approveDraft(
  context: TenantContext,
  draftId: string,
  input: ApproveDraftInput = {},
): Promise<ApproveDraftResult> {
  requireHumanReviewer(context, "Approving a draft");
  const draft = await scopedDraft(context, draftId);
  if (draft.status === "APPROVED") {
    throw new ContentDraftError("This draft is already approved.", "invalid_state");
  }
  if (draft.status === "SUPERSEDED" || draft.status === "ARCHIVED") {
    throw new ContentDraftError(
      `This draft is ${statusWords(draft.status)} and cannot be approved.`,
      "invalid_state",
    );
  }
  if (draft.status !== "AWAITING_EDITOR_REVIEW") {
    throw new ContentDraftError(
      "No review has been requested for this draft. A draft is approved from a review request.",
      "invalid_state",
    );
  }
  const item = await draftingItem(context, draft.contentWorkItemId);

  const note = (input.note ?? "").trim();
  if (note.length > 2000) {
    throw new ContentDraftError("Keep the note under 2,000 characters.", "invalid_input", {
      issues: ["note: Too long."],
    });
  }

  const request = await prisma.contentDraftReview.findFirst({
    where: { contentDraftId: draft.id, status: "REQUESTED", ...websiteScope(context) },
  });
  if (!request) {
    throw new ContentDraftError(
      "The review request for this draft is no longer open. Request review again.",
      "invalid_state",
    );
  }

  const revision = draft.currentRevisionId
    ? await prisma.contentRevision.findFirst({
        where: { id: draft.currentRevisionId, ...websiteScope(context) },
      })
    : null;
  if (
    !revision ||
    revision.id !== request.contentRevisionId ||
    revision.contentHash !== request.revisionHash
  ) {
    throw new ContentDraftError(
      "The content changed after review was requested. Request review again for the current revision.",
      "version_conflict",
    );
  }

  const blocking = [
    ...(revisionFindings(revision)?.findings ?? []).filter(
      (finding) => finding.severity === "BLOCKING",
    ),
    ...(await staleClaimFindings(context, draft.brief, revision)),
  ];
  if (blocking.length > 0) {
    throw new ContentDraftError(
      `Revision ${revision.revisionNumber} has ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}. It cannot be approved until a new revision resolves them.`,
      "blocked",
      { findings: blocking },
    );
  }

  const newer = await prisma.contentBrief.findFirst({
    where: { contentWorkItemId: item.id, status: "APPROVED", ...websiteScope(context) },
    select: { id: true, version: true },
  });
  const briefSuperseded = Boolean(newer && newer.id !== draft.briefId);
  if (briefSuperseded && !input.acknowledgeBriefMismatch) {
    throw new ContentDraftError(
      `This draft is based on Brief v${draft.brief.version}. Brief v${newer!.version} is now approved. To approve against v${draft.brief.version} anyway, acknowledge the newer version explicitly.`,
      "brief_superseded",
    );
  }

  if (!canTransition(DRAFT_TRANSITIONS, draft.status, "APPROVED")) {
    throw new ContentDraftError("This draft cannot be approved from here.", "invalid_state");
  }
  if (!canTransition(REVIEW_TRANSITIONS, request.status, "APPROVED")) {
    throw new ContentDraftError("This review request cannot be approved.", "invalid_state");
  }

  const selfDecided = revision.createdByUserId === context.user.id;
  const decidedAt = new Date();

  return prisma.$transaction(async (tx) => {
    const review = await tx.contentDraftReview.update({
      where: { id: request.id },
      data: {
        status: "APPROVED",
        decidedByUserId: context.user.id,
        decidedAt,
        note: note || null,
        selfDecided,
        briefSupersededAtDecision: briefSuperseded,
        briefMismatchAcknowledged: briefSuperseded && Boolean(input.acknowledgeBriefMismatch),
      },
    });
    const updated = await tx.contentDraft.update({
      where: { id: draft.id },
      data: {
        status: "APPROVED",
        approvedRevisionId: revision.id,
        approvedRevisionHash: revision.contentHash,
        approvedByUserId: context.user.id,
        approvedAt: decidedAt,
        approvedReviewId: review.id,
      },
    });
    const workItem = await transitionWorkItem(tx, context, item.id, "QA", "draft approved");

    await recordAudit(tx, context, {
      entityType: "ContentDraftReview",
      entityId: review.id,
      action: "APPROVE",
      before: { status: "REQUESTED" },
      after: {
        status: "APPROVED",
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        revisionHash: revision.contentHash,
        selfDecided,
        briefSupersededAtDecision: briefSuperseded,
        briefMismatchAcknowledged: review.briefMismatchAcknowledged,
      },
    });
    // CONTENT_DRAFT_APPROVED (§36).
    await recordAudit(tx, context, {
      entityType: "ContentDraft",
      entityId: draft.id,
      action: "APPROVE",
      before: { status: draft.status, approvedReviewId: draft.approvedReviewId },
      after: {
        status: "APPROVED",
        reviewId: review.id,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        revisionHash: revision.contentHash,
        briefId: draft.briefId,
        briefVersion: draft.brief.version,
        briefSupersededAtDecision: briefSuperseded,
        briefMismatchAcknowledged: review.briefMismatchAcknowledged,
        note: note || null,
        selfDecided,
        workItemStatus: workItem.status,
      },
    });

    return { draft: updated, review, revision, workItem };
  });
}

export type ReopenDraftResult = { draft: ContentDraft; workItem: ContentWorkItem };

/**
 * Reopens an approved draft for revision (D3). The standing approval stops
 * applying - the pointer is cleared, the draft is DRAFTING, the work item
 * leaves QA - and the approval row stays in history exactly as decided. A
 * reason is required and audited.
 */
export async function reopenDraft(
  context: TenantContext,
  draftId: string,
  reason: string,
): Promise<ReopenDraftResult> {
  requireHumanWriter(context);
  const draft = await scopedDraft(context, draftId);
  if (draft.status !== "APPROVED") {
    throw new ContentDraftError(
      `This draft is ${statusWords(draft.status)}; only an approved draft can be reopened.`,
      "invalid_state",
    );
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new ContentDraftError("Say why the draft is being reopened.", "invalid_input", {
      issues: ["reason: A reason is required."],
    });
  }
  if (trimmed.length > 2000) {
    throw new ContentDraftError("Keep the reason under 2,000 characters.", "invalid_input", {
      issues: ["reason: Too long."],
    });
  }
  const item = await scopedItem(context, draft.contentWorkItemId);
  if (item.status !== "QA" && item.status !== "DRAFTING") {
    throw new ContentDraftError(
      `The work item is ${statusWords(item.status)}; the draft cannot be reopened here.`,
      "invalid_state",
    );
  }
  if (!canTransition(DRAFT_TRANSITIONS, draft.status, "DRAFTING")) {
    throw new ContentDraftError("This draft cannot be reopened from here.", "invalid_state");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.contentDraft.update({
      where: { id: draft.id },
      data: {
        status: "DRAFTING",
        approvedRevisionId: null,
        approvedRevisionHash: null,
        approvedByUserId: null,
        approvedAt: null,
        approvedReviewId: null,
      },
    });
    const workItem =
      item.status === "QA"
        ? await transitionWorkItem(tx, context, item.id, "DRAFTING", "draft reopened for revision")
        : item;

    if (draft.approvedReviewId) {
      await recordAudit(tx, context, {
        entityType: "ContentDraftReview",
        entityId: draft.approvedReviewId,
        action: "RETIRE",
        after: {
          reason: trimmed,
          draftId: draft.id,
          revisionId: draft.approvedRevisionId,
          noLongerCurrent: true,
        },
      });
    }
    await recordAudit(tx, context, {
      entityType: "ContentDraft",
      entityId: draft.id,
      action: "UPDATE",
      before: {
        status: draft.status,
        approvedReviewId: draft.approvedReviewId,
        approvedRevisionId: draft.approvedRevisionId,
      },
      after: { status: "DRAFTING", reason: trimmed, workItemStatus: workItem.status },
    });

    return { draft: updated, workItem };
  });
}

// ---------------------------------------------------------------------------
// Reading (§10, §12; M4.3 §2-§4; M4.5 readers)
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

const REVIEW_INCLUDE = {
  requestedBy: { select: { id: true, email: true } },
  decidedBy: { select: { id: true, email: true } },
} satisfies Prisma.ContentDraftReviewInclude;

export type ReviewView = Prisma.ContentDraftReviewGetPayload<{ include: typeof REVIEW_INCLUDE }>;

export type ReturnNote = { note: string; by: string | null; at: Date };

/** The standing approval of a draft, from its pointer. */
export type StandingApproval = {
  reviewId: string;
  revisionId: string;
  revisionNumber: number;
  revisionHash: string;
  by: string | null;
  at: Date;
  note: string | null;
  briefVersion: number;
  briefSupersededAtDecision: boolean;
  briefMismatchAcknowledged: boolean;
  selfDecided: boolean;
};

export type DraftView = {
  draft: ContentDraft;
  /** The exact approved brief version the draft is pinned to. */
  brief: ContentBrief;
  /** A newer approved version exists; the draft was not moved to it. */
  briefMismatch: { approvedVersion: number; approvedBriefId: string } | null;
  current: RevisionView | null;
  revisionCount: number;
  /** The latest time a reviewer sent the draft back, with their note. */
  lastReturn: ReturnNote | null;
  /** M4.5: the open request, the standing approval, and every review cycle. */
  review: {
    open: ReviewView | null;
    approval: StandingApproval | null;
    history: ReviewView[];
  };
};

async function buildView(context: TenantContext, draft: DraftWithBrief): Promise<DraftView> {
  const [current, approved, revisionCount, returned, reviews, approvedBy] = await Promise.all([
    draft.currentRevisionId
      ? prisma.contentRevision.findFirst({
          where: { id: draft.currentRevisionId, ...websiteScope(context) },
          include: REVISION_INCLUDE,
        })
      : Promise.resolve(null),
    prisma.contentBrief.findFirst({
      where: {
        contentWorkItemId: draft.contentWorkItemId,
        status: "APPROVED",
        ...websiteScope(context),
      },
      select: { id: true, version: true },
    }),
    prisma.contentRevision.count({ where: { contentDraftId: draft.id } }),
    prisma.auditEvent.findFirst({
      where: {
        entityType: "ContentDraft",
        entityId: draft.id,
        action: "DECLINE",
        websiteId: context.website.id,
      },
      orderBy: { createdAt: "desc" },
      include: { actor: { select: { email: true } } },
    }),
    prisma.contentDraftReview.findMany({
      where: { contentDraftId: draft.id, ...websiteScope(context) },
      orderBy: { createdAt: "desc" },
      include: REVIEW_INCLUDE,
    }),
    draft.approvedByUserId
      ? prisma.user.findUnique({ where: { id: draft.approvedByUserId }, select: { email: true } })
      : Promise.resolve(null),
  ]);

  const { brief, ...rest } = draft;
  const note = (returned?.afterSnapshotJson as { note?: unknown } | null)?.note;
  const approvedRow = draft.approvedReviewId
    ? (reviews.find((row) => row.id === draft.approvedReviewId) ?? null)
    : null;
  const approval: StandingApproval | null =
    draft.approvedRevisionId && draft.approvedRevisionHash && draft.approvedAt && approvedRow
      ? {
          reviewId: approvedRow.id,
          revisionId: draft.approvedRevisionId,
          revisionNumber: approvedRow.revisionNumber,
          revisionHash: draft.approvedRevisionHash,
          by: approvedBy?.email ?? approvedRow.decidedBy?.email ?? null,
          at: draft.approvedAt,
          note: approvedRow.note,
          briefVersion: approvedRow.briefVersion,
          briefSupersededAtDecision: approvedRow.briefSupersededAtDecision,
          briefMismatchAcknowledged: approvedRow.briefMismatchAcknowledged,
          selfDecided: approvedRow.selfDecided,
        }
      : null;

  return {
    draft: rest,
    brief,
    briefMismatch:
      approved && approved.id !== brief.id
        ? { approvedVersion: approved.version, approvedBriefId: approved.id }
        : null,
    current,
    revisionCount,
    lastReturn:
      returned && typeof note === "string"
        ? { note, by: returned.actor?.email ?? null, at: returned.createdAt }
        : null,
    review: {
      open: reviews.find((row) => row.status === "REQUESTED") ?? null,
      approval,
      history: reviews,
    },
  };
}

/** The open draft for a work item, with its pinned brief and current revision. */
export async function getDraftForWorkItem(
  context: TenantContext,
  workItemId: string,
): Promise<DraftView | null> {
  const draft = await prisma.contentDraft.findFirst({
    where: {
      contentWorkItemId: workItemId,
      status: { in: OPEN_STATUSES },
      ...websiteScope(context),
    },
    orderBy: { createdAt: "desc" },
    include: { brief: true },
  });
  return draft ? buildView(context, draft) : null;
}

/** Any draft by id - open or superseded - for inspection. */
export async function getDraft(context: TenantContext, draftId: string): Promise<DraftView | null> {
  const draft = await prisma.contentDraft.findFirst({
    where: { id: draftId, ...websiteScope(context) },
    include: { brief: true },
  });
  return draft ? buildView(context, draft) : null;
}

/** Every review cycle of a draft, newest first. */
export async function listDraftReviews(
  context: TenantContext,
  draftId: string,
): Promise<ReviewView[]> {
  return prisma.contentDraftReview.findMany({
    where: { contentDraftId: draftId, ...websiteScope(context) },
    orderBy: { createdAt: "desc" },
    include: REVIEW_INCLUDE,
  });
}

/** What M5 consumes: the one approved revision of a work item, or nothing. */
export type ApprovedRevisionRef = {
  workItemId: string;
  draftId: string;
  reviewId: string;
  revisionId: string;
  revisionNumber: number;
  revisionHash: string;
  briefId: string;
  briefVersion: number;
  approvedByUserId: string;
  approvedAt: Date;
};

/**
 * The exact approved revision of a work item, for QA and publishing. Returns
 * nothing unless every binding still holds: the draft is APPROVED, its
 * pointer names an APPROVED review row for the same revision, the hashes
 * agree with the revision's own content hash, and that revision is still
 * the draft's current one. Anything else is not an approval.
 */
export async function approvedRevisionFor(
  context: TenantContext,
  workItemId: string,
): Promise<ApprovedRevisionRef | null> {
  const draft = await prisma.contentDraft.findFirst({
    where: { contentWorkItemId: workItemId, status: "APPROVED", ...websiteScope(context) },
    include: { approvedRevision: true, approvedReview: true },
  });
  if (!draft?.approvedRevision || !draft.approvedReview || !draft.approvedByUserId) return null;
  const { approvedRevision: revision, approvedReview: review } = draft;
  const bound =
    review.status === "APPROVED" &&
    review.contentRevisionId === revision.id &&
    review.revisionHash === revision.contentHash &&
    draft.approvedRevisionHash === revision.contentHash &&
    draft.currentRevisionId === revision.id &&
    draft.approvedAt !== null;
  if (!bound) return null;

  return {
    workItemId,
    draftId: draft.id,
    reviewId: review.id,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    revisionHash: revision.contentHash,
    briefId: draft.briefId,
    briefVersion: review.briefVersion,
    approvedByUserId: draft.approvedByUserId,
    approvedAt: draft.approvedAt!,
  };
}

export type DraftSummary = {
  id: string;
  status: ContentDraftStatus;
  briefId: string;
  briefVersion: number;
  revisionCount: number;
  currentTitle: string | null;
  createdAt: Date;
};

/** Every draft a work item has had, oldest first, so superseded ones stay reachable. */
export async function listDraftsForWorkItem(
  context: TenantContext,
  workItemId: string,
): Promise<DraftSummary[]> {
  const rows = await prisma.contentDraft.findMany({
    where: { contentWorkItemId: workItemId, ...websiteScope(context) },
    orderBy: { createdAt: "asc" },
    include: {
      brief: { select: { version: true } },
      currentRevision: { select: { title: true } },
      _count: { select: { revisions: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    briefId: row.briefId,
    briefVersion: row.brief.version,
    revisionCount: row._count.revisions,
    currentTitle: row.currentRevision?.title ?? null,
    createdAt: row.createdAt,
  }));
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

export type RevisionAuthor = { kind: "AI" | "HUMAN" | "UNKNOWN"; label: string };

/** Who wrote a revision, for a screen. */
export function describeAuthor(
  revision: Pick<RevisionView, "createdByAiRun" | "createdBy" | "createdByUserId">,
  viewerUserId?: string,
): RevisionAuthor {
  if (revision.createdByAiRun) {
    return {
      kind: "AI",
      label: `Generated by AI (${revision.createdByAiRun.provider} · ${revision.createdByAiRun.model})`,
    };
  }
  if (revision.createdBy) {
    const who =
      viewerUserId && revision.createdByUserId === viewerUserId ? "you" : revision.createdBy.email;
    return { kind: "HUMAN", label: `Edited by ${who}` };
  }
  return { kind: "UNKNOWN", label: "Author not recorded" };
}

/** What review did with a revision, for history. */
export type RevisionReviewMark = {
  status: ContentDraftReviewStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  /** For APPROVED: this approval is the draft's standing one. */
  current: boolean;
};

export type RevisionSummary = {
  id: string;
  revisionNumber: number;
  basedOnRevisionNumber: number | null;
  author: RevisionAuthor;
  createdAt: Date;
  wordCount: number | null;
  findings: { blocking: number; warning: number; info: number };
  changeSummary: string;
  contentHash: string;
  /** One line: provider, model, prompt and schema versions, package - or the person. */
  provenance: string;
  /** M4.5: the latest decided review of this revision, if any. */
  review: RevisionReviewMark | null;
};

/** The lineage of a draft, newest first. */
export async function listRevisions(
  context: TenantContext,
  draftId: string,
  viewerUserId?: string,
): Promise<RevisionSummary[]> {
  const [rows, reviews, draft] = await Promise.all([
    prisma.contentRevision.findMany({
      where: { contentDraftId: draftId, ...websiteScope(context) },
      orderBy: { revisionNumber: "desc" },
      include: REVISION_INCLUDE,
    }),
    prisma.contentDraftReview.findMany({
      where: { contentDraftId: draftId, status: { not: "REQUESTED" }, ...websiteScope(context) },
      orderBy: { createdAt: "desc" },
      include: REVIEW_INCLUDE,
    }),
    prisma.contentDraft.findFirst({
      where: { id: draftId, ...websiteScope(context) },
      select: { approvedRevisionId: true, approvedReviewId: true },
    }),
  ]);
  return rows.map((row) => {
    const author = describeAuthor(row, viewerUserId);
    const provenance = row.createdByAiRun
      ? `${row.createdByAiRun.provider} · ${row.createdByAiRun.model} · prompt v${row.createdByAiRun.promptTemplateVersion} · schema v${row.createdByAiRun.outputSchemaVersion}${row.evidencePackage ? ` · package ${row.evidencePackage.contentHash.slice(0, 19)}…` : ""}`
      : row.createdBy
        ? `Hand-written by ${row.createdBy.email}`
        : "Not recorded";
    // The approval, when there is one, outranks a later return or invalidation of another cycle.
    const ofThis = reviews.filter((review) => review.contentRevisionId === row.id);
    const mark = ofThis.find((review) => review.status === "APPROVED") ?? ofThis[0] ?? null;
    return {
      id: row.id,
      revisionNumber: row.revisionNumber,
      basedOnRevisionNumber: row.basedOnRevisionNumber,
      author,
      createdAt: row.createdAt,
      wordCount: row.wordCount,
      findings: countFindings(revisionFindings(row)?.findings ?? []),
      changeSummary: row.changeSummary,
      contentHash: row.contentHash,
      provenance,
      review: mark
        ? {
            status: mark.status,
            decidedBy: mark.decidedBy?.email ?? null,
            decidedAt: mark.decidedAt,
            note: mark.note,
            current:
              mark.status === "APPROVED" &&
              draft?.approvedReviewId === mark.id &&
              draft?.approvedRevisionId === row.id,
          }
        : null,
    };
  });
}

export type RevisionComparison = {
  from: RevisionView;
  to: RevisionView;
  changes: RevisionChanges;
  diff: DiffLine[];
};

function fieldsOf(revision: ContentRevision): RevisionFields {
  return {
    title: revision.title,
    slug: revision.slug,
    excerpt: revision.excerpt,
    bodyMarkdown: revision.bodyMarkdown,
    metaTitle: revision.metaTitle,
    metaDescription: revision.metaDescription,
  };
}

/**
 * Two revisions of the same draft, side by side. Both ids must name revisions
 * of that draft in this website; anything else - another draft, another
 * tenant, a made-up id - is simply not found.
 */
export async function compareRevisions(
  context: TenantContext,
  draftId: string,
  fromRevisionId: string,
  toRevisionId: string,
): Promise<RevisionComparison | null> {
  if (fromRevisionId === toRevisionId) return null;
  const rows = await prisma.contentRevision.findMany({
    where: {
      id: { in: [fromRevisionId, toRevisionId] },
      contentDraftId: draftId,
      ...websiteScope(context),
    },
    include: REVISION_INCLUDE,
  });
  const from = rows.find((row) => row.id === fromRevisionId);
  const to = rows.find((row) => row.id === toRevisionId);
  if (!from || !to) return null;

  return {
    from,
    to,
    changes: revisionChanges(fieldsOf(from), fieldsOf(to)),
    diff: diffLines(from.bodyMarkdown, to.bodyMarkdown),
  };
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

// ---------------------------------------------------------------------------
// The drafts list, and the brief as constraints (M4.4 §2, §3)
// ---------------------------------------------------------------------------

export type DraftListRow = {
  id: string;
  workItemId: string;
  workItemTitle: string;
  workItemType: string;
  workItemStatus: string;
  contentType: string | null;
  briefId: string;
  briefVersion: number;
  briefStatus: string;
  /** A newer approved brief exists for the work item; this draft stays pinned. */
  briefMismatch: { approvedVersion: number; approvedBriefId: string } | null;
  status: ContentDraftStatus;
  awaitingReview: boolean;
  currentRevisionNumber: number | null;
  currentTitle: string | null;
  revisionCount: number;
  authorKind: "AI" | "HUMAN" | null;
  findings: { blocking: number; warning: number; info: number };
  blocking: boolean;
  /** M4.5: the standing approval's revision number, when the draft is approved. */
  approvedRevisionNumber: number | null;
  /** The later of the draft's own change and its current revision's creation. */
  updatedAt: Date;
};

/** Every draft of the website, most recently updated first. */
export async function listDrafts(context: TenantContext): Promise<DraftListRow[]> {
  const rows = await prisma.contentDraft.findMany({
    where: websiteScope(context),
    include: {
      brief: { select: { id: true, version: true, status: true, contentType: true } },
      contentWorkItem: { select: { id: true, title: true, type: true, status: true } },
      currentRevision: {
        select: {
          revisionNumber: true,
          title: true,
          createdAt: true,
          createdByAiRunId: true,
          createdByUserId: true,
          constraintFindingsJson: true,
        },
      },
      approvedRevision: { select: { revisionNumber: true } },
      _count: { select: { revisions: true } },
    },
  });

  const itemIds = [...new Set(rows.map((row) => row.contentWorkItemId))];
  const approved = itemIds.length
    ? await prisma.contentBrief.findMany({
        where: {
          contentWorkItemId: { in: itemIds },
          status: "APPROVED",
          ...websiteScope(context),
        },
        select: { id: true, version: true, contentWorkItemId: true },
      })
    : [];
  const approvedByItem = new Map(approved.map((row) => [row.contentWorkItemId, row]));

  return rows
    .map((row): DraftListRow => {
      const current = row.currentRevision;
      const findings = countFindings((current ? revisionFindings(current)?.findings : null) ?? []);
      const approvedBrief = approvedByItem.get(row.contentWorkItemId) ?? null;
      const updatedAt =
        current && current.createdAt > row.updatedAt ? current.createdAt : row.updatedAt;
      return {
        id: row.id,
        workItemId: row.contentWorkItemId,
        workItemTitle: row.contentWorkItem.title,
        workItemType: row.contentWorkItem.type,
        workItemStatus: row.contentWorkItem.status,
        contentType: row.brief.contentType ?? null,
        briefId: row.briefId,
        briefVersion: row.brief.version,
        briefStatus: row.brief.status,
        briefMismatch:
          approvedBrief && approvedBrief.id !== row.briefId
            ? { approvedVersion: approvedBrief.version, approvedBriefId: approvedBrief.id }
            : null,
        status: row.status,
        awaitingReview: row.status === "AWAITING_EDITOR_REVIEW",
        currentRevisionNumber: current?.revisionNumber ?? null,
        currentTitle: current?.title ?? null,
        revisionCount: row._count.revisions,
        authorKind: current
          ? current.createdByAiRunId
            ? "AI"
            : current.createdByUserId
              ? "HUMAN"
              : null
          : null,
        findings,
        blocking: findings.blocking > 0,
        approvedRevisionNumber:
          row.status === "APPROVED" ? (row.approvedRevision?.revisionNumber ?? null) : null,
        updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export type BriefPanelView = {
  version: number;
  status: string;
  title: string;
  contentType: string;
  searchIntent: string | null;
  audience: string | null;
  customerProblem: string | null;
  desiredOutcome: string | null;
  recommendedAngle: string | null;
  primaryConversion: string | null;
  brandVoiceNotes: string | null;
  businessGoal: { title: string } | null;
  primaryKeyword: { keyword: string } | null;
  secondaryKeywords: { keyword: string }[];
  targetPage: { path: string } | null;
  keyQuestions: string[];
  requiredSections: { heading: string; purpose: string }[];
  optionalSections: { heading: string; purpose: string }[];
  /** Brief claims whose fact is approved right now. */
  validClaims: ReconciledClaim[];
  /** Brief claims whose fact has since been revoked or removed. */
  staleClaims: ReconciledClaim[];
  prohibitedClaims: { text: string; source: string }[];
  rules: { rule: string; severity: string; constraint: string | null }[];
  linkTargets: { path: string | null; anchorText: string; reason: string }[];
  targetLength: string;
};

/**
 * The pinned brief as the constraints a writer works under, with its claims
 * judged against the facts approved now. The brief row is never changed;
 * what changes is the verdict on each claim.
 */
export async function getBriefPanel(
  context: TenantContext,
  briefId: string,
): Promise<BriefPanelView | null> {
  const brief = await prisma.contentBrief.findFirst({
    where: { id: briefId, ...websiteScope(context) },
    include: {
      businessGoal: { select: { title: true } },
      primaryKeyword: { select: { keyword: true } },
      targetPage: { select: { path: true } },
      contentWorkItem: { select: { type: true } },
    },
  });
  if (!brief) return null;

  const secondaryIds = asArray<unknown>(brief.secondaryKeywordIdsJson).filter(
    (id): id is string => typeof id === "string",
  );
  const secondaryKeywords = secondaryIds.length
    ? await prisma.keyword.findMany({
        where: { id: { in: secondaryIds }, ...websiteScope(context) },
        select: { keyword: true },
      })
    : [];

  const claims = asArray<CitedClaim>(brief.approvedClaimsJson);
  const truth = await currentTruth(
    context,
    claims.map((claim) => claim.evidenceId),
  );
  const reconciled = reconcileBriefClaims(claims, truth);

  return {
    version: brief.version,
    status: brief.status,
    title: brief.title,
    contentType: brief.contentType,
    searchIntent: brief.searchIntent,
    audience: brief.audience,
    customerProblem: brief.customerProblem,
    desiredOutcome: brief.desiredOutcome,
    recommendedAngle: brief.recommendedAngle,
    primaryConversion: brief.primaryConversion,
    brandVoiceNotes: brief.brandVoiceNotes,
    businessGoal: brief.businessGoal,
    primaryKeyword: brief.primaryKeyword,
    secondaryKeywords,
    targetPage: brief.targetPage,
    keyQuestions: asArray<string>(brief.keyQuestionsJson),
    requiredSections: asArray<{ heading: string; purpose: string }>(brief.requiredSectionsJson),
    optionalSections: asArray<{ heading: string; purpose: string }>(brief.optionalSectionsJson),
    validClaims: reconciled.valid,
    staleClaims: reconciled.stale,
    prohibitedClaims: asArray<ProhibitedClaim>(brief.prohibitedClaimsJson).map((claim) => ({
      text: claim.text,
      source: claim.source,
    })),
    rules: asArray<RuleConstraint>(brief.seoRuleConstraintsJson).map((rule) => ({
      rule: rule.rule,
      severity: rule.severity,
      constraint: rule.constraint,
    })),
    linkTargets: asArray<LinkTarget>(brief.internalLinkTargetsJson).map((target) => ({
      path: target.path,
      anchorText: target.anchorText,
      reason: target.reason,
    })),
    targetLength: targetLengthFor(brief.contentWorkItem.type),
  };
}
