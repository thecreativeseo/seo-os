import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { SYSTEM_AUTH_USER_ID } from "@/server/jobs/system-context";
import { transitionWorkItem } from "@/server/services/content-work";
import { isAiConfigured } from "@/server/ai/registry";
import { runAgent } from "@/server/services/ai-run";
import {
  assembleContentQaPackage,
  renderPackage,
  sealPackage,
} from "@/server/services/evidence-assembler";
import {
  CONTENT_QA_SCHEMA_NAME,
  contentQaSchema,
  type ContentQaOutput,
} from "@/lib/ai/schemas/content-qa";
import type { Evidence } from "@/lib/evidence/types";
import {
  RUNNING_GUARD_MS,
  approvedRevisionFor,
  revisionClaims,
  revisionFindings,
  type ApprovedRevisionRef,
} from "@/server/services/content-draft";
import type { CitedClaim, LinkTarget } from "@/server/services/content-brief";
import {
  QA_CHECKER_VERSION,
  applyAiFailure,
  applyAiJudgments,
  approvedClaimTextsNow,
  countFindings,
  deriveOutcome,
  inputsFingerprint,
  runDeterministicChecks,
  type QaContext,
  type QaCoverage,
  type QaFinding,
  type QaSubject,
  type QaTypeResult,
  type FingerprintInputs,
} from "@/lib/content/qa";
import { revisionHash } from "@/lib/execution/hash";
import {
  CMS_APPROVAL_TRANSITIONS,
  QA_RUN_TRANSITIONS,
  canTransition,
} from "@/lib/execution/statuses";
import { parseEvidenceId } from "@/lib/evidence/id";
import { Prisma } from "@/generated/prisma/client";
import type {
  ContentBrief,
  ContentCmsApproval,
  ContentQaResult,
  ContentQaRun,
  ContentQaStatus,
  ContentRevision,
  ContentWorkItem,
} from "@/generated/prisma/client";

/**
 * ContentQaService (docs/P4_SPEC.md §12-§15, §39; M5 plan §1-§3, §15-§16).
 *
 * Runs QA over exactly the approved revision of a work item - the one the
 * M4.5 reader vouches for, by id and hash - against the facts, rules and
 * context approved now, and records what it found as a run with ten results.
 * The checks are pure; this service is the only thing that reads the
 * database for them and the only thing that writes what they said.
 *
 * What a run never does: read currentRevisionId to decide anything, change
 * the content, record a PASS for something it did not check, or write a
 * result when it could not finish. A checker that fails for a reason of its
 * own fails the run, and the run says so (D11).
 */

export class ContentQaError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_state"
      | "invalid_input"
      | "no_approved_revision"
      | "in_progress"
      /** M5.3: the gate. */
      | "qa_required"
      | "qa_failed"
      | "qa_stale"
      | "brief_superseded"
      | "not_checked_unacknowledged",
  ) {
    super(message);
    this.name = "ContentQaError";
  }
}

export const QA_FAILED_MESSAGE =
  "QA could not be completed. Nothing was recorded as passed; the run is recorded with its reason.";
export const QA_REVISION_CHANGED_MESSAGE =
  "The approved revision changed while QA was running. Nothing was recorded; run QA again.";

export type QaRunFailureCode = "revision_changed" | "checker_error" | "package_error";

/** Where QA may be run: at the gate, and on work already approved for CMS. */
const QA_RUNNABLE_STATUSES: string[] = ["QA", "AWAITING_EDITOR_REVIEW", "APPROVED_FOR_CMS"];

export type QaRunOutcome =
  | { ok: true; run: ContentQaRun; results: QaTypeResult[]; workItem: ContentWorkItem }
  | { ok: false; code: QaRunFailureCode; message: string; run: ContentQaRun };

/** A test may hand in the checks to run; the product always runs its own. */
export type QaRunDependencies = {
  checks?: (subject: QaSubject, ctx: QaContext) => QaTypeResult[] | Promise<QaTypeResult[]>;
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireHumanWriter(context: TenantContext, what: string): void {
  if (context.user.authUserId === SYSTEM_AUTH_USER_ID) {
    throw new ContentQaError(`${what} is done by a person, not by a job.`, "forbidden");
  }
  if (!hasRole(context.membership.role, REQUIRED.WRITE)) {
    throw new ContentQaError(`You do not have permission to ${what.toLowerCase()}.`, "forbidden");
  }
}

async function scopedItem(context: TenantContext, workItemId: string): Promise<ContentWorkItem> {
  const item = await prisma.contentWorkItem.findFirst({
    where: { id: workItemId, ...websiteScope(context) },
  });
  if (!item) throw new ContentQaError("That work item is not available.", "not_found");
  return item;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** The website's host, from however the domain was stored. */
export function siteHostOf(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
}

// ---------------------------------------------------------------------------
// Gathering: what the checks are given
// ---------------------------------------------------------------------------

type Gathered = {
  ctx: Omit<QaContext, "aiAvailable" | "checkerVersion">;
  fingerprint: string;
  contextVersionId: string | null;
};

async function fingerprintInputs(context: TenantContext): Promise<{
  inputs: FingerprintInputs;
  contextVersion: { id: string; prohibitedClaims: string[]; avoidTopics: string[] } | null;
}> {
  const [facts, rules, contextVersion] = await Promise.all([
    prisma.brandFact.findMany({
      where: websiteScope(context),
      select: { id: true, value: true, approvalStatus: true, archivedAt: true },
      orderBy: { id: "asc" },
    }),
    prisma.seoRule.findMany({
      where: { ...websiteScope(context), active: true, archivedAt: null },
      select: { id: true, rule: true, severity: true, checkJson: true },
      orderBy: { id: "asc" },
    }),
    prisma.businessContextVersion.findFirst({
      where: { status: "APPROVED", businessContext: { websiteId: context.website.id } },
      orderBy: { versionNumber: "desc" },
      select: { id: true, prohibitedClaims: true, avoidTopics: true },
    }),
  ]);
  return {
    inputs: {
      contextVersionId: contextVersion?.id ?? null,
      facts: facts.map((fact) => ({
        id: fact.id,
        value: fact.value,
        approved: fact.approvalStatus === "APPROVED" && fact.archivedAt === null,
      })),
      rules: rules.map((rule) => ({
        ruleId: rule.id,
        rule: rule.rule,
        severity: rule.severity,
        check: rule.checkJson ?? null,
      })),
    },
    contextVersion,
  };
}

/** The fingerprint of what QA would judge against right now. */
export async function currentInputsFingerprint(context: TenantContext): Promise<string> {
  const { inputs } = await fingerprintInputs(context);
  return inputsFingerprint(inputs);
}

async function gather(
  context: TenantContext,
  item: ContentWorkItem,
  brief: {
    targetPageId: string | null;
    primaryKeywordId: string | null;
    requiredSectionsJson: unknown;
    keyQuestionsJson: unknown;
    internalLinkTargetsJson: unknown;
    approvedClaimsJson: unknown;
    secondaryKeywordIdsJson: unknown;
    searchIntent: string | null;
    primaryConversion: string | null;
  },
): Promise<Gathered> {
  const { inputs, contextVersion } = await fingerprintInputs(context);

  const pageId = brief.targetPageId ?? item.pageId;
  const pages = await prisma.page.findMany({
    where: { ...websiteScope(context), status: "ACTIVE", archivedAt: null },
    select: { id: true, path: true },
    orderBy: { lastSeenAt: "desc" },
    take: 200,
  });
  const snapshots = pages.length
    ? await prisma.pageContentSnapshot.findMany({
        where: { ...websiteScope(context), pageId: { in: pages.map((page) => page.id) } },
        orderBy: [{ pageId: "asc" }, { capturedAt: "desc" }],
        distinct: ["pageId"],
        select: { pageId: true, title: true, metaDescription: true, bodyText: true },
      })
    : [];
  const snapshotByPage = new Map(snapshots.map((snapshot) => [snapshot.pageId, snapshot]));
  const toQaPage = (page: { id: string; path: string }) => {
    const snapshot = snapshotByPage.get(page.id);
    return {
      id: page.id,
      path: page.path,
      title: snapshot?.title ?? null,
      metaDescription: snapshot?.metaDescription ?? null,
      bodyText: snapshot?.bodyText ?? null,
    };
  };
  const target = pageId ? (pages.find((page) => page.id === pageId) ?? null) : null;

  const keywordId = brief.primaryKeywordId ?? item.keywordId;
  const primaryKeyword = keywordId
    ? await prisma.keyword.findFirst({
        where: { id: keywordId, ...websiteScope(context) },
        select: { keyword: true },
      })
    : null;

  // Secondary keywords: evidence ids from the brief, resolved to keywords and
  // the pages that own them, all under this website.
  const secondaryKeywordIds = new Set<string>();
  const ownershipIds = new Set<string>();
  for (const raw of asArray<unknown>(brief.secondaryKeywordIdsJson)) {
    const parsed = parseEvidenceId(raw);
    if (!parsed) continue;
    if (parsed.kind === "kwm" || parsed.kind === "rank") secondaryKeywordIds.add(parsed.keywordId);
    if (parsed.kind === "own") ownershipIds.add(parsed.ownershipId);
    if (parsed.kind === "topic" && parsed.keywordId) secondaryKeywordIds.add(parsed.keywordId);
  }
  if (ownershipIds.size > 0) {
    const owned = await prisma.keywordPageOwnership.findMany({
      where: { id: { in: [...ownershipIds] }, ...websiteScope(context) },
      select: { keywordId: true },
    });
    for (const row of owned) secondaryKeywordIds.add(row.keywordId);
  }
  const secondaryKeywords =
    secondaryKeywordIds.size > 0
      ? await prisma.keyword.findMany({
          where: { id: { in: [...secondaryKeywordIds] }, ...websiteScope(context) },
          select: {
            id: true,
            keyword: true,
            ownerships: {
              where: { status: "ACTIVE", archivedAt: null },
              select: { pageId: true, page: { select: { path: true } } },
            },
          },
        })
      : [];

  const ctx: Gathered["ctx"] = {
    siteHost: siteHostOf(context.website.normalizedDomain),
    facts: inputs.facts,
    rules: inputs.rules.map((rule) => ({
      ruleId: rule.ruleId,
      rule: rule.rule,
      severity: rule.severity as "INFO" | "WARNING" | "BLOCKING",
      check: rule.check,
    })),
    contextVersion,
    brief: {
      requiredSections: asArray<{ heading?: string } | string>(brief.requiredSectionsJson)
        .map((section) => (typeof section === "string" ? section : (section.heading ?? "")))
        .filter((heading) => heading.length > 0),
      keyQuestions: asArray<string>(brief.keyQuestionsJson).filter(
        (question) => typeof question === "string",
      ),
      linkTargets: asArray<LinkTarget>(brief.internalLinkTargetsJson).map((target) => ({
        pageId: target.pageId,
        path: target.path ?? null,
      })),
      approvedClaims: asArray<CitedClaim>(brief.approvedClaimsJson)
        .filter((claim) => typeof claim.text === "string" && claim.text.length > 0)
        .map((claim) => ({
          text: claim.text,
          evidenceId: claim.evidenceId ?? null,
          ref: claimRef(claim.evidenceId ?? null),
        })),
      primaryKeyword: primaryKeyword?.keyword ?? null,
      secondaryKeywords: secondaryKeywords.map((keyword) => ({
        keyword: keyword.keyword,
        pages: keyword.ownerships.map((own) => ({ pageId: own.pageId, path: own.page.path })),
      })),
      searchIntent: brief.searchIntent,
      primaryConversion: brief.primaryConversion,
    },
    targetPage: target ? toQaPage(target) : null,
    otherPages: pages.filter((page) => page.id !== target?.id).map(toQaPage),
  };

  return {
    ctx,
    fingerprint: inputsFingerprint(inputs),
    contextVersionId: contextVersion?.id ?? null,
  };
}

/** The evidence a claim cites, resolved to what the checks can look up. */
function claimRef(
  evidenceId: string | null,
):
  | { kind: "fact"; id: string }
  | { kind: "context"; id: string }
  | { kind: "unknown"; raw: string }
  | null {
  if (evidenceId === null) return null;
  const parsed = parseEvidenceId(evidenceId);
  if (parsed !== null && parsed.kind === "fact") return { kind: "fact", id: parsed.brandFactId };
  if (parsed !== null && parsed.kind === "ctx")
    return { kind: "context", id: parsed.contextVersionId };
  return { kind: "unknown", raw: evidenceId };
}

/**
 * What the judge is told (M5.2 §3): the trusted material only, with the
 * exact ids and texts it must use to refer to rules and questions. The
 * revision itself goes in the untrusted block.
 */
function buildQaTask(
  item: ContentWorkItem,
  brief: ContentBrief,
  subject: QaSubject,
  ctx: QaContext,
): string {
  const list = (rows: string[]) => (rows.length ? rows.map((row) => `- ${row}`) : ["- (none)"]);
  const prose = ctx.rules.filter((rule) => rule.check === null || rule.check === undefined);
  const lines: string[] = [];
  lines.push(
    "Judge the revision in the untrusted block against this approved brief. Report what you see; do not decide anything.",
    "",
  );
  lines.push("WORK ITEM", `Type: ${item.type}`, `Title: ${item.title}`, "");
  lines.push(
    `APPROVED BRIEF v${brief.version}`,
    `Title: ${brief.title}`,
    `Content type: ${brief.contentType}`,
    `Search intent: ${brief.searchIntent ?? "not stated"}`,
    `Audience: ${brief.audience ?? "not stated"}`,
    `Customer problem: ${brief.customerProblem ?? "not stated"}`,
    `Desired outcome: ${brief.desiredOutcome ?? "not stated"}`,
    `Primary conversion: ${brief.primaryConversion ?? "not stated"}`,
    `Primary keyword: ${ctx.brief.primaryKeyword ?? "not stated"}`,
    `Brand voice: ${brief.brandVoiceNotes ?? "not stated"}`,
    "",
  );
  lines.push(
    "KEY QUESTIONS (copy each exactly into answer_readiness.question)",
    ...list(ctx.brief.keyQuestions.map((question, index) => `Q${index + 1}: ${question}`)),
    "",
  );
  lines.push("REQUIRED SECTIONS", ...list(ctx.brief.requiredSections), "");
  lines.push(
    "RULES TO JUDGE (use the id exactly in rule_judgments.rule_id)",
    ...list(prose.map((rule) => `[rule:${rule.ruleId}] [${rule.severity}] ${rule.rule}`)),
    "",
  );
  lines.push(
    "APPROVED CLAIM TEXTS (a sentence carrying one word for word is not an unlisted claim)",
    ...list(approvedClaimTextsNow(subject, ctx).map((text) => `"${text}"`)),
    "",
  );
  lines.push(
    "PROHIBITED CLAIMS AND TOPICS (copy exactly into prohibited_paraphrases.prohibited_claim)",
    ...list([
      ...(ctx.contextVersion?.prohibitedClaims ?? []),
      ...(ctx.contextVersion?.avoidTopics ?? []),
    ]),
    "",
  );
  lines.push(
    ctx.targetPage
      ? "This is existing content: the current page is in the untrusted block as well."
      : "This is new content; there is no current page.",
  );
  lines.push(
    "Excerpts are short verbatim passages of the revision. Ids and question texts are those above, never others.",
  );
  return lines.join("\n");
}

/** The untrusted block: the evidence as data, then the revision, as data. */
function renderUntrusted(evidence: Evidence[], subject: QaSubject): string {
  return [
    renderPackage(evidence),
    "## REVISION UNDER REVIEW",
    `[revision title] ${subject.title}`,
    `[revision slug] ${subject.slug ?? ""}`,
    `[revision meta_title] ${subject.metaTitle ?? ""}`,
    `[revision meta_description] ${subject.metaDescription ?? ""}`,
    `[revision excerpt] ${subject.excerpt ?? ""}`,
    "[revision body]",
    subject.bodyMarkdown,
  ].join("\n");
}

function subjectOf(item: ContentWorkItem, revision: ContentRevision): QaSubject {
  return {
    workType: item.type,
    title: revision.title,
    slug: revision.slug,
    excerpt: revision.excerpt,
    metaTitle: revision.metaTitle,
    metaDescription: revision.metaDescription,
    bodyMarkdown: revision.bodyMarkdown,
    claims: revisionClaims(revision).map((claim) => ({
      text: claim.text,
      evidenceId: claim.evidenceId,
      ref: claimRef(claim.evidenceId),
    })),
    sectionsCovered: revisionFindings(revision)?.sectionsCovered ?? [],
  };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Runs QA over the exact approved revision of a work item.
 *
 * Refuses (throws) when there is nothing to run against or someone else is
 * running. Returns ok: false, with the run recorded as FAILED, when the run
 * could not finish. Returns ok: true with the completed run otherwise, and
 * moves the work item: a passing outcome to Awaiting final approval, a FAIL
 * back to (or staying in) QA.
 */
export async function runQa(
  context: TenantContext,
  workItemId: string,
  deps: QaRunDependencies = {},
): Promise<QaRunOutcome> {
  requireHumanWriter(context, "Run QA");
  const item = await scopedItem(context, workItemId);
  // Approved work may be checked again: when a fact or a rule moves, the
  // approval goes stale and the way back is a fresh run and a fresh approval.
  // Running QA never changes the work item beyond its own outcome.
  if (!QA_RUNNABLE_STATUSES.includes(item.status)) {
    throw new ContentQaError(
      "QA runs on work that is ready for QA, awaiting final approval, or approved for CMS.",
      "invalid_state",
    );
  }

  const ref = await approvedRevisionFor(context, item.id);
  if (!ref) {
    throw new ContentQaError(
      "This work item has no approved revision to check. Approve a draft first.",
      "no_approved_revision",
    );
  }

  // One run at a time. A RUNNING run older than the guard is a process that
  // died: it is closed as FAILED so the item does not stay locked forever.
  const running = await prisma.contentQaRun.findFirst({
    where: { contentWorkItemId: item.id, status: "RUNNING", ...websiteScope(context) },
  });
  if (running) {
    if (running.startedAt.getTime() >= Date.now() - RUNNING_GUARD_MS) {
      throw new ContentQaError("QA is already running for this work item.", "in_progress");
    }
    await prisma.contentQaRun.update({
      where: { id: running.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorCode: "abandoned",
        errorSummary: "The run did not finish within the time allowed.",
      },
    });
  }

  const [revision, brief, draft] = await Promise.all([
    prisma.contentRevision.findFirst({ where: { id: ref.revisionId, ...websiteScope(context) } }),
    prisma.contentBrief.findFirst({ where: { id: ref.briefId, ...websiteScope(context) } }),
    prisma.contentDraft.findFirst({ where: { id: ref.draftId, ...websiteScope(context) } }),
  ]);
  if (!revision || !brief || !draft) {
    throw new ContentQaError("The approved revision is not available.", "not_found");
  }
  const unchanged = (row: ContentRevision) =>
    row.contentHash === ref.revisionHash && revisionHash(row) === row.contentHash;
  if (!unchanged(revision)) {
    throw new ContentQaError(
      "The approved revision does not match its recorded hash.",
      "no_approved_revision",
    );
  }

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.contentQaRun.create({
      data: {
        websiteId: context.website.id,
        contentWorkItemId: item.id,
        contentDraftId: ref.draftId,
        contentRevisionId: ref.revisionId,
        revisionNumber: ref.revisionNumber,
        revisionHash: ref.revisionHash,
        briefId: ref.briefId,
        briefVersion: ref.briefVersion,
        inputsFingerprint: "pending",
        checkerVersion: QA_CHECKER_VERSION,
        requestedByUserId: context.user.id,
      },
    });
    await recordAudit(tx, context, {
      entityType: "ContentQaRun",
      entityId: created.id,
      action: "EXECUTE",
      after: {
        workItemId: item.id,
        draftId: ref.draftId,
        revisionId: ref.revisionId,
        revisionNumber: ref.revisionNumber,
        revisionHash: ref.revisionHash,
        briefVersion: ref.briefVersion,
        checkerVersion: QA_CHECKER_VERSION,
      },
    });
    return created;
  });

  const fail = async (code: QaRunFailureCode, summary: string): Promise<QaRunOutcome> => {
    const failed = await prisma.$transaction(async (tx) => {
      const row = await tx.contentQaRun.update({
        where: { id: run.id },
        data: { status: "FAILED", completedAt: new Date(), errorCode: code, errorSummary: summary },
      });
      await recordAudit(tx, context, {
        entityType: "ContentQaRun",
        entityId: run.id,
        action: "COMPLETE",
        after: { status: "FAILED", errorCode: code },
      });
      return row;
    });
    return {
      ok: false,
      code,
      message: code === "revision_changed" ? QA_REVISION_CHANGED_MESSAGE : QA_FAILED_MESSAGE,
      run: failed,
    };
  };

  // Evidence, sealed before anything is judged.
  let packageId: string | null = null;
  let evidence: Evidence[] = [];
  let gathered: Gathered;
  try {
    const assembled = await assembleContentQaPackage(context, {
      workItemId: item.id,
      revisionId: ref.revisionId,
      pageId: brief.targetPageId ?? item.pageId,
      keywordId: brief.primaryKeywordId ?? item.keywordId,
      topicId: brief.topicId ?? item.topicId,
      linkTargetPageIds: asArray<LinkTarget>(brief.internalLinkTargetsJson).map(
        (target) => target.pageId,
      ),
    });
    await sealPackage(context, assembled.package.id);
    packageId = assembled.package.id;
    evidence = assembled.evidence;
    gathered = await gather(context, item, brief);
  } catch {
    return fail("package_error", "The evidence for QA could not be assembled.");
  }

  // The checks. A checker that throws is a product error, never NOT_CHECKED.
  const subject = subjectOf(item, revision);
  const ctx: QaContext = {
    ...gathered.ctx,
    aiAvailable: isAiConfigured(),
    checkerVersion: QA_CHECKER_VERSION,
  };
  let results: QaTypeResult[];
  try {
    const checks = deps.checks ?? runDeterministicChecks;
    results = await checks(subject, ctx);
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error("no results");
    }
  } catch {
    return fail("checker_error", "A QA check failed for a reason of its own.");
  }

  // The judge. Its failure is never the run's failure: the deterministic
  // results stand, and the sub-checks that needed a judge say why they have
  // nothing (M5.2 §8). Its findings are capped, verified and resolved by the
  // server before they count (M5.2 §5-§7).
  let aiRunId: string | null = null;
  let merged: QaTypeResult[];
  if (!isAiConfigured()) {
    merged = applyAiFailure(results, "NO_PROVIDER");
  } else {
    try {
      const judged = await runAgent<ContentQaOutput>(context, {
        agentType: "CONTENT_QA",
        taskType: "QA_CONTENT",
        evidencePackageId: packageId,
        request: {
          task: buildQaTask(item, brief, subject, ctx),
          untrustedData: renderUntrusted(evidence, subject),
          schema: contentQaSchema,
          schemaName: CONTENT_QA_SCHEMA_NAME,
          maxOutputTokens: 4096,
        },
      });
      aiRunId = judged.run.id;
      merged = judged.ok
        ? applyAiJudgments(results, judged.value, subject, ctx, judged.run.id)
        : applyAiFailure(
            results,
            judged.error.code === "invalid_output" || judged.error.code === "output_truncated"
              ? "INVALID_AI_OUTPUT"
              : judged.error.code === "not_configured"
                ? "NO_PROVIDER"
                : "AI_RUN_FAILED",
          );
    } catch {
      merged = applyAiFailure(results, "AI_RUN_FAILED");
    }
  }

  const outcome = deriveOutcome(merged);
  const counts = countFindings(merged);

  try {
    const completed = await prisma.$transaction(async (tx) => {
      // The hash, once more, inside the transaction that records the verdict.
      const latest = await tx.contentRevision.findFirst({
        where: { id: ref.revisionId, ...websiteScope(context) },
      });
      const stillApproved = await tx.contentDraft.findFirst({
        where: {
          id: ref.draftId,
          status: "APPROVED",
          approvedRevisionId: ref.revisionId,
          approvedRevisionHash: ref.revisionHash,
          ...websiteScope(context),
        },
        select: { id: true },
      });
      if (!latest || !unchanged(latest) || !stillApproved) {
        throw new RevisionChanged();
      }

      for (const result of merged) {
        await tx.contentQaResult.create({
          data: {
            websiteId: context.website.id,
            contentRevisionId: ref.revisionId,
            qaRunId: run.id,
            revisionHash: ref.revisionHash,
            qaType: result.qaType,
            status: result.status,
            source: result.source,
            notCheckedReason: result.notCheckedReason,
            aiRunId: result.source === "DETERMINISTIC" ? null : aiRunId,
            issuesJson: {
              version: 1,
              findings: result.findings,
              coverage: result.coverage,
              considered: result.considered,
            } as Prisma.InputJsonValue,
            warningsJson: result.findings.filter(
              (finding) => finding.severity === "WARNING",
            ) as unknown as Prisma.InputJsonValue,
            blockingIssuesJson: result.findings.filter(
              (finding) => finding.severity === "BLOCKING",
            ) as unknown as Prisma.InputJsonValue,
            checkerVersion: QA_CHECKER_VERSION,
          },
        });
      }

      if (!canTransition(QA_RUN_TRANSITIONS, "RUNNING", "COMPLETED")) {
        throw new Error("QA run table does not allow completion");
      }
      const row = await tx.contentQaRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          outcome,
          completedAt: new Date(),
          inputsFingerprint: gathered.fingerprint,
          contextVersionId: gathered.contextVersionId,
          evidencePackageId: packageId,
          aiRunId,
          blockingCount: counts.blocking,
          warningCount: counts.warning,
          infoCount: counts.info,
          notCheckedCount: counts.notChecked,
        },
      });

      // The work item follows the outcome. Only a person's approval takes it
      // further than Awaiting final approval.
      const current = await tx.contentWorkItem.findFirstOrThrow({
        where: { id: item.id, ...websiteScope(context) },
      });
      let workItem = current;
      if (outcome === "FAIL" && current.status === "AWAITING_EDITOR_REVIEW") {
        workItem = await transitionWorkItem(tx, context, item.id, "QA", "QA failed");
      } else if (outcome !== "FAIL" && current.status === "QA") {
        workItem = await transitionWorkItem(
          tx,
          context,
          item.id,
          "AWAITING_EDITOR_REVIEW",
          "QA passed; awaiting final approval",
        );
      }

      await recordAudit(tx, context, {
        entityType: "ContentQaRun",
        entityId: run.id,
        action: "COMPLETE",
        after: {
          status: "COMPLETED",
          outcome,
          ...counts,
          inputsFingerprint: gathered.fingerprint,
          evidencePackageId: packageId,
          aiRunId,
          workItemStatus: workItem.status,
        },
      });

      return { row, workItem };
    });
    return { ok: true, run: completed.row, results: merged, workItem: completed.workItem };
  } catch (error) {
    if (error instanceof RevisionChanged) {
      return fail("revision_changed", "The approved revision changed while QA was running.");
    }
    return fail("checker_error", "QA could not be recorded.");
  }
}

class RevisionChanged extends Error {}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type QaResultView = ContentQaResult & {
  findings: QaFinding[];
  coverage: QaCoverage[];
  considered: Record<string, number | string | string[]>;
};

/** Whether a run still speaks for the work item's approved revision, and why not. */
export type QaCurrency = {
  /** The run's revision is still the exactly approved one. */
  revisionApproved: boolean;
  /** The facts, rules and context are those the run judged against. */
  inputsCurrent: boolean;
  /** No later completed run exists for the same revision. */
  latestForRevision: boolean;
  /** All three hold. */
  current: boolean;
};

export type QaRunView = {
  run: ContentQaRun & { requestedBy: { email: string } };
  results: QaResultView[];
  revision: { id: string; revisionNumber: number; contentHash: string; title: string };
  currency: QaCurrency;
};

function parseResult(row: ContentQaResult): QaResultView {
  const issues = (row.issuesJson ?? {}) as {
    findings?: QaFinding[];
    coverage?: QaCoverage[];
    considered?: Record<string, number | string | string[]>;
  };
  return {
    ...row,
    findings: Array.isArray(issues.findings) ? issues.findings : [],
    coverage: Array.isArray(issues.coverage) ? issues.coverage : [],
    considered: issues.considered ?? {},
  };
}

/** Whether a completed run still speaks for the work item. Read-only. */
export async function qaCurrency(context: TenantContext, run: ContentQaRun): Promise<QaCurrency> {
  const [ref, fingerprint, later] = await Promise.all([
    approvedRevisionFor(context, run.contentWorkItemId),
    currentInputsFingerprint(context),
    prisma.contentQaRun.findFirst({
      where: {
        contentRevisionId: run.contentRevisionId,
        status: "COMPLETED",
        createdAt: { gt: run.createdAt },
        ...websiteScope(context),
      },
      select: { id: true },
    }),
  ]);
  const revisionApproved =
    ref !== null &&
    ref.revisionId === run.contentRevisionId &&
    ref.revisionHash === run.revisionHash;
  const inputsCurrent = run.status === "COMPLETED" && run.inputsFingerprint === fingerprint;
  const latestForRevision = later === null;
  return {
    revisionApproved,
    inputsCurrent,
    latestForRevision,
    current: run.status === "COMPLETED" && revisionApproved && inputsCurrent && latestForRevision,
  };
}

export async function getQaRun(context: TenantContext, runId: string): Promise<QaRunView | null> {
  const run = await prisma.contentQaRun.findFirst({
    where: { id: runId, ...websiteScope(context) },
    include: {
      requestedBy: { select: { email: true } },
      results: { orderBy: { qaType: "asc" } },
      revision: { select: { id: true, revisionNumber: true, contentHash: true, title: true } },
    },
  });
  if (!run) return null;
  const { results, revision, ...rest } = run;
  return {
    run: rest,
    results: results.map(parseResult),
    revision,
    currency: await qaCurrency(context, rest),
  };
}

/** The most recent run of a work item, completed or not. */
export async function latestQaRun(
  context: TenantContext,
  workItemId: string,
): Promise<QaRunView | null> {
  const row = await prisma.contentQaRun.findFirst({
    where: { contentWorkItemId: workItemId, ...websiteScope(context) },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return row ? getQaRun(context, row.id) : null;
}

export type QaRunSummary = Pick<
  ContentQaRun,
  | "id"
  | "status"
  | "outcome"
  | "revisionNumber"
  | "revisionHash"
  | "briefVersion"
  | "blockingCount"
  | "warningCount"
  | "infoCount"
  | "notCheckedCount"
  | "errorCode"
  | "checkerVersion"
  | "startedAt"
  | "completedAt"
> & { requestedBy: string };

/** Every run of a work item, newest first: history stays reachable. */
export async function listQaRuns(
  context: TenantContext,
  workItemId: string,
): Promise<QaRunSummary[]> {
  const rows = await prisma.contentQaRun.findMany({
    where: { contentWorkItemId: workItemId, ...websiteScope(context) },
    orderBy: { createdAt: "desc" },
    include: { requestedBy: { select: { email: true } } },
  });
  return rows.map(({ requestedBy, ...row }) => ({
    id: row.id,
    status: row.status,
    outcome: row.outcome,
    revisionNumber: row.revisionNumber,
    revisionHash: row.revisionHash,
    briefVersion: row.briefVersion,
    blockingCount: row.blockingCount,
    warningCount: row.warningCount,
    infoCount: row.infoCount,
    notCheckedCount: row.notCheckedCount,
    errorCode: row.errorCode,
    checkerVersion: row.checkerVersion,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    requestedBy: requestedBy.email,
  }));
}

/** The runs that judged one revision, newest first. */
export async function qaRunsForRevision(
  context: TenantContext,
  revisionId: string,
): Promise<QaRunSummary[]> {
  const revision = await prisma.contentRevision.findFirst({
    where: { id: revisionId, ...websiteScope(context) },
    select: { contentDraftId: true, draft: { select: { contentWorkItemId: true } } },
  });
  if (!revision) return [];
  const all = await listQaRuns(context, revision.draft.contentWorkItemId);
  const rows = await prisma.contentQaRun.findMany({
    where: { contentRevisionId: revisionId, ...websiteScope(context) },
    select: { id: true },
  });
  const ids = new Set(rows.map((row) => row.id));
  return all.filter((row) => ids.has(row.id));
}

// ---------------------------------------------------------------------------
// The approval gate (M5 plan §17-§19; docs/P4_SPEC.md §25)
// ---------------------------------------------------------------------------

export type ApproveForCmsInput = {
  note?: string;
  /** The draft is pinned to a brief version that is no longer the approved one. */
  acknowledgeBriefMismatch?: boolean;
  /** Some QA types had nothing to check with, and the person accepts that (D11). */
  acknowledgeNotChecked?: boolean;
};

export type ApproveForCmsResult = {
  approval: ContentCmsApproval;
  workItem: ContentWorkItem;
  run: ContentQaRun;
};

/** What a person accepted by approving. Codes and ids only: no content. */
export type AcknowledgedJson = {
  version: 1;
  notChecked: { qaType: string; reason: string | null }[];
  needsHumanConfirmation: { qaType: string; code: string; ruleId?: string }[];
  warningCount: number;
  infoCount: number;
  briefSuperseded: boolean;
};

/** Why an approval that still says APPROVED may no longer authorize execution (D8). */
export type CmsApprovalStaleReason =
  "REVISION_CHANGED" | "QA_INPUTS_CHANGED" | "QA_SUPERSEDED" | "BRIEF_SUPERSEDED";

export type CmsApprovalView = {
  approval: ContentCmsApproval & { approvedBy: { email: string } };
  /** The run it rests on, if that run is still there. */
  run: ContentQaRun | null;
  /**
   * Whether it may authorize execution now. An approval is a historical fact
   * and never changes; this is computed, and M6 must refuse execution when it
   * is false (D8).
   */
  executable: boolean;
  staleReasons: CmsApprovalStaleReason[];
};

function requireHumanReviewer(context: TenantContext, what: string): void {
  if (context.user.authUserId === SYSTEM_AUTH_USER_ID) {
    throw new ContentQaError(`${what} is done by a person, not by a job.`, "forbidden");
  }
  if (!hasRole(context.membership.role, REQUIRED.REVIEW)) {
    throw new ContentQaError(`${what} needs an SEO lead, admin or owner.`, "forbidden");
  }
}

/**
 * Approves exactly one revision for execution, on the strength of one
 * completed QA run.
 *
 * Everything the M4.5 approval checks about the revision, this checks again -
 * the draft is approved, the pointer is intact, the hashes agree - and then
 * the QA run itself: it judged this revision, it did not fail, it is the
 * latest for the revision, and the facts, rules and context it judged against
 * are still the ones in force. A person may accept warnings, unchecked types
 * and a superseded brief; nobody may accept a blocking finding (D10).
 *
 * The approval is a record of a decision, not a state of the work: it pins
 * the revision, the hash and the run, and it is never edited. When the
 * content moves, it is invalidated with a reason and a fresh one is needed.
 */
export async function approveForCms(
  context: TenantContext,
  workItemId: string,
  input: ApproveForCmsInput = {},
): Promise<ApproveForCmsResult> {
  requireHumanReviewer(context, "Approving content for CMS");
  const item = await scopedItem(context, workItemId);
  if (item.status === "APPROVED_FOR_CMS") {
    throw new ContentQaError("This work is already approved for CMS.", "invalid_state");
  }
  if (item.status !== "AWAITING_EDITOR_REVIEW") {
    throw new ContentQaError(
      item.status === "QA"
        ? "QA has not passed for this work yet. Run QA, and resolve anything blocking."
        : `This work is ${item.status.toLowerCase().replace(/_/g, " ")}; it cannot be approved for CMS here.`,
      "invalid_state",
    );
  }

  const note = (input.note ?? "").trim();
  if (note.length > 2000) {
    throw new ContentQaError("Keep the note under 2,000 characters.", "invalid_input");
  }

  // The revision, exactly as M4.5 vouches for it.
  const ref = await approvedRevisionFor(context, item.id);
  if (!ref) {
    throw new ContentQaError(
      "This work has no approved revision to authorize. Approve a draft first.",
      "no_approved_revision",
    );
  }

  // The QA run: the latest one, on this revision, completed, not failed.
  const latest = await prisma.contentQaRun.findFirst({
    where: { contentWorkItemId: item.id, status: "COMPLETED", ...websiteScope(context) },
    orderBy: { createdAt: "desc" },
    include: { results: true },
  });
  if (!latest) {
    throw new ContentQaError("QA has not been run for this work yet.", "qa_required");
  }
  if (latest.contentRevisionId !== ref.revisionId || latest.revisionHash !== ref.revisionHash) {
    throw new ContentQaError(
      "The latest QA run judged a different revision. Run QA again on the approved revision.",
      "qa_stale",
    );
  }
  if (latest.outcome === "FAIL" || latest.blockingCount > 0) {
    throw new ContentQaError(
      `QA failed with ${latest.blockingCount} blocking finding${latest.blockingCount === 1 ? "" : "s"}. Return the draft for revision; blocking findings cannot be accepted.`,
      "qa_failed",
    );
  }
  const fingerprint = await currentInputsFingerprint(context);
  if (latest.inputsFingerprint !== fingerprint) {
    throw new ContentQaError(
      "The facts, rules or business context changed after this QA run. Run QA again before approving.",
      "qa_stale",
    );
  }

  // The brief the draft is pinned to, against the one approved now.
  const newer = await prisma.contentBrief.findFirst({
    where: { contentWorkItemId: item.id, status: "APPROVED", ...websiteScope(context) },
    select: { id: true, version: true },
  });
  const briefSuperseded = Boolean(newer && newer.id !== ref.briefId);
  if (briefSuperseded && !input.acknowledgeBriefMismatch) {
    throw new ContentQaError(
      `This revision was written for Brief v${ref.briefVersion}. Brief v${newer!.version} is now approved. To approve against v${ref.briefVersion} anyway, acknowledge the newer version explicitly.`,
      "brief_superseded",
    );
  }

  // What the person is accepting: types nothing could be checked for, and
  // judgments a person has to stand behind (D6, D11).
  const notChecked = latest.results
    .filter((result) => result.status === "NOT_CHECKED")
    .map((result) => ({ qaType: String(result.qaType), reason: result.notCheckedReason }));
  if (notChecked.length > 0 && !input.acknowledgeNotChecked) {
    throw new ContentQaError(
      `${notChecked.length} QA ${notChecked.length === 1 ? "check" : "checks"} had nothing to check with. To approve anyway, acknowledge them explicitly.`,
      "not_checked_unacknowledged",
    );
  }
  const needsHumanConfirmation = latest.results.flatMap((result) => {
    const issues = (result.issuesJson ?? {}) as { findings?: QaFinding[] };
    return (issues.findings ?? [])
      .filter((finding) => finding.needsHumanConfirmation)
      .map((finding) => ({
        qaType: String(result.qaType),
        code: String(finding.code),
        ...(finding.refs?.ruleId ? { ruleId: finding.refs.ruleId } : {}),
      }));
  });

  const acknowledged: AcknowledgedJson = {
    version: 1,
    notChecked,
    needsHumanConfirmation,
    warningCount: latest.warningCount,
    infoCount: latest.infoCount,
    briefSuperseded,
  };

  const draft = await prisma.contentDraft.findFirstOrThrow({
    where: { id: ref.draftId, ...websiteScope(context) },
    select: { approvedByUserId: true },
  });
  const revision = await prisma.contentRevision.findFirstOrThrow({
    where: { id: ref.revisionId, ...websiteScope(context) },
    select: { createdByUserId: true },
  });
  const selfDecided =
    revision.createdByUserId === context.user.id || draft.approvedByUserId === context.user.id;

  if (!canTransition(CMS_APPROVAL_TRANSITIONS, "APPROVED", "INVALIDATED")) {
    throw new ContentQaError("The approval table does not allow an approval.", "invalid_state");
  }

  return prisma.$transaction(async (tx) => {
    // The binding, once more, inside the transaction that records the decision.
    const stillApproved = await tx.contentDraft.findFirst({
      where: {
        id: ref.draftId,
        status: "APPROVED",
        approvedRevisionId: ref.revisionId,
        approvedRevisionHash: ref.revisionHash,
        ...websiteScope(context),
      },
      select: { id: true },
    });
    if (!stillApproved) {
      throw new ContentQaError(
        "The approved revision changed while this was being approved. Nothing was recorded.",
        "no_approved_revision",
      );
    }

    const approval = await tx.contentCmsApproval.create({
      data: {
        websiteId: context.website.id,
        contentWorkItemId: item.id,
        contentDraftId: ref.draftId,
        contentRevisionId: ref.revisionId,
        revisionNumber: ref.revisionNumber,
        revisionHash: ref.revisionHash,
        qaRunId: latest.id,
        briefId: ref.briefId,
        briefVersion: ref.briefVersion,
        briefSupersededAcknowledged: briefSuperseded,
        notCheckedAcknowledged: notChecked.length > 0,
        acknowledgedJson: acknowledged as unknown as Prisma.InputJsonValue,
        approvedByUserId: context.user.id,
        note: note || null,
        selfDecided,
      },
    });
    const workItem = await transitionWorkItem(
      tx,
      context,
      item.id,
      "APPROVED_FOR_CMS",
      "approved for CMS",
    );

    await recordAudit(tx, context, {
      entityType: "ContentCmsApproval",
      entityId: approval.id,
      action: "APPROVE",
      after: {
        workItemId: item.id,
        draftId: ref.draftId,
        revisionId: ref.revisionId,
        revisionNumber: ref.revisionNumber,
        revisionHash: ref.revisionHash,
        qaRunId: latest.id,
        qaOutcome: latest.outcome,
        briefVersion: ref.briefVersion,
        briefSupersededAcknowledged: briefSuperseded,
        notCheckedAcknowledged: notChecked.length > 0,
        notCheckedTypes: notChecked.map((row) => row.qaType),
        needsHumanConfirmation: needsHumanConfirmation.length,
        inputsFingerprint: latest.inputsFingerprint,
        selfDecided,
      },
    });
    await recordAudit(tx, context, {
      entityType: "ContentWorkItem",
      entityId: item.id,
      action: "APPROVE",
      before: { status: item.status },
      after: { status: workItem.status, approvalId: approval.id, qaRunId: latest.id },
    });

    const { results: _results, ...run } = latest;
    return { approval, workItem, run };
  });
}

/** The active approval of a work item, and whether it still authorizes execution. */
export async function cmsApprovalFor(
  context: TenantContext,
  workItemId: string,
): Promise<CmsApprovalView | null> {
  const approval = await prisma.contentCmsApproval.findFirst({
    where: { contentWorkItemId: workItemId, status: "APPROVED", ...websiteScope(context) },
    include: { approvedBy: { select: { email: true } } },
  });
  if (!approval) return null;

  const [ref, run, fingerprint, later, newerBrief] = await Promise.all([
    approvedRevisionFor(context, workItemId),
    prisma.contentQaRun.findFirst({ where: { id: approval.qaRunId, ...websiteScope(context) } }),
    currentInputsFingerprint(context),
    prisma.contentQaRun.findFirst({
      where: {
        contentRevisionId: approval.contentRevisionId,
        status: "COMPLETED",
        createdAt: { gt: approval.approvedAt },
        ...websiteScope(context),
      },
      select: { id: true },
    }),
    prisma.contentBrief.findFirst({
      where: { contentWorkItemId: workItemId, status: "APPROVED", ...websiteScope(context) },
      select: { id: true },
    }),
  ]);

  const staleReasons: CmsApprovalStaleReason[] = [];
  if (
    !ref ||
    ref.revisionId !== approval.contentRevisionId ||
    ref.revisionHash !== approval.revisionHash
  ) {
    staleReasons.push("REVISION_CHANGED");
  }
  if (!run || run.inputsFingerprint !== fingerprint) staleReasons.push("QA_INPUTS_CHANGED");
  if (later) staleReasons.push("QA_SUPERSEDED");
  if (newerBrief && newerBrief.id !== approval.briefId && !approval.briefSupersededAcknowledged) {
    staleReasons.push("BRIEF_SUPERSEDED");
  }

  return { approval, run, executable: staleReasons.length === 0, staleReasons };
}

/** Every approval a work item has had, newest first: history stays reachable. */
export async function listCmsApprovals(
  context: TenantContext,
  workItemId: string,
): Promise<(ContentCmsApproval & { approvedBy: { email: string } })[]> {
  return prisma.contentCmsApproval.findMany({
    where: { contentWorkItemId: workItemId, ...websiteScope(context) },
    orderBy: { approvedAt: "desc" },
    include: { approvedBy: { select: { email: true } } },
  });
}

// ---------------------------------------------------------------------------
// Reading for the screens (M5.4 §2, §16, §17)
// ---------------------------------------------------------------------------

/** One row of the QA queue: where the work stands, and what QA says about it. */
export type QaQueueRow = {
  workItemId: string;
  title: string;
  contentType: string | null;
  itemStatus: string;
  revisionNumber: number | null;
  revisionHash: string | null;
  briefVersion: number | null;
  runId: string | null;
  runStatus: string | null;
  outcome: string | null;
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  notCheckedCount: number;
  runAt: Date | null;
  runCurrent: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  approved: boolean;
  approvalStale: boolean;
  approvalStaleReasons: CmsApprovalStaleReason[];
  approvedBy: string | null;
  approvedAt: Date | null;
  selfDecided: boolean;
  updatedAt: Date;
};

const QA_QUEUE_STATUSES = ["QA", "AWAITING_EDITOR_REVIEW", "APPROVED_FOR_CMS"] as const;

/**
 * Every work item at or past the QA gate, with its latest run and its
 * approval. Batched: the queue is read in a handful of queries rather than
 * one per row, and the effective readiness of an approval is computed by the
 * same reader the gate uses.
 */
export async function listQaQueue(context: TenantContext): Promise<QaQueueRow[]> {
  const items = await prisma.contentWorkItem.findMany({
    where: { status: { in: [...QA_QUEUE_STATUSES] }, ...websiteScope(context) },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, type: true, status: true, updatedAt: true },
  });
  if (items.length === 0) return [];
  const ids = items.map((item) => item.id);

  const [drafts, runs, fingerprint] = await Promise.all([
    prisma.contentDraft.findMany({
      where: { contentWorkItemId: { in: ids }, status: "APPROVED", ...websiteScope(context) },
      include: {
        approvedRevision: { select: { id: true, revisionNumber: true, contentHash: true } },
        brief: { select: { version: true } },
      },
    }),
    prisma.contentQaRun.findMany({
      where: { contentWorkItemId: { in: ids }, ...websiteScope(context) },
      orderBy: { createdAt: "desc" },
      include: { aiRun: { select: { provider: true, model: true } } },
    }),
    currentInputsFingerprint(context),
  ]);

  const draftByItem = new Map(drafts.map((draft) => [draft.contentWorkItemId, draft]));
  const latestByItem = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!latestByItem.has(run.contentWorkItemId)) latestByItem.set(run.contentWorkItemId, run);
  }
  const laterForRevision = new Set<string>();
  for (const run of runs) {
    if (run.status !== "COMPLETED") continue;
    const later = runs.some(
      (other) =>
        other.status === "COMPLETED" &&
        other.contentRevisionId === run.contentRevisionId &&
        other.createdAt > run.createdAt,
    );
    if (later) laterForRevision.add(run.id);
  }

  const rows: QaQueueRow[] = [];
  for (const item of items) {
    const draft = draftByItem.get(item.id);
    const revision = draft?.approvedRevision ?? null;
    const bound =
      draft !== undefined &&
      revision !== null &&
      draft.approvedRevisionHash === revision.contentHash &&
      draft.currentRevisionId === revision.id;
    const run = latestByItem.get(item.id) ?? null;
    const approval =
      item.status === "APPROVED_FOR_CMS" ? await cmsApprovalFor(context, item.id) : null;
    const runCurrent =
      run !== null &&
      run.status === "COMPLETED" &&
      bound &&
      run.contentRevisionId === revision!.id &&
      run.revisionHash === revision!.contentHash &&
      run.inputsFingerprint === fingerprint &&
      !laterForRevision.has(run.id);

    rows.push({
      workItemId: item.id,
      title: item.title,
      contentType: item.type,
      itemStatus: item.status,
      revisionNumber: bound ? revision!.revisionNumber : null,
      revisionHash: bound ? revision!.contentHash : null,
      briefVersion: draft?.brief.version ?? null,
      runId: run?.id ?? null,
      runStatus: run?.status ?? null,
      outcome: run?.outcome ?? null,
      blockingCount: run?.blockingCount ?? 0,
      warningCount: run?.warningCount ?? 0,
      infoCount: run?.infoCount ?? 0,
      notCheckedCount: run?.notCheckedCount ?? 0,
      runAt: run?.completedAt ?? run?.startedAt ?? null,
      runCurrent,
      aiProvider: run?.aiRun?.provider ?? null,
      aiModel: run?.aiRun?.model ?? null,
      approved: approval !== null,
      approvalStale: approval !== null && !approval.executable,
      approvalStaleReasons: approval?.staleReasons ?? [],
      approvedBy: approval?.approval.approvedBy.email ?? null,
      approvedAt: approval?.approval.approvedAt ?? null,
      selfDecided: approval?.approval.selfDecided ?? false,
      updatedAt: item.updatedAt,
    });
  }
  return rows;
}

/** What the draft workspace and the report header need about one work item. */
export type QaSummary = {
  itemStatus: string;
  approvedRevision: ApprovedRevisionRef | null;
  latest:
    | (QaRunSummary & {
        current: boolean;
        aiProvider: string | null;
        aiModel: string | null;
        currency: QaCurrency;
      })
    | null;
  approval: CmsApprovalView | null;
  /** The approved revision is pinned to a brief version that is no longer the approved one. */
  briefSuperseded: boolean;
};

export async function qaSummaryFor(
  context: TenantContext,
  workItemId: string,
): Promise<QaSummary | null> {
  const item = await prisma.contentWorkItem.findFirst({
    where: { id: workItemId, ...websiteScope(context) },
    select: { id: true, status: true },
  });
  if (!item) return null;

  const [ref, run, approval, newerBrief] = await Promise.all([
    approvedRevisionFor(context, item.id),
    prisma.contentQaRun.findFirst({
      where: { contentWorkItemId: item.id, ...websiteScope(context) },
      orderBy: { createdAt: "desc" },
      include: {
        aiRun: { select: { provider: true, model: true } },
        requestedBy: { select: { email: true } },
      },
    }),
    cmsApprovalFor(context, item.id),
    prisma.contentBrief.findFirst({
      where: { contentWorkItemId: item.id, status: "APPROVED", ...websiteScope(context) },
      select: { id: true },
    }),
  ]);

  const currency = run ? await qaCurrency(context, run) : null;
  return {
    itemStatus: item.status,
    approvedRevision: ref,
    latest:
      run && currency
        ? {
            id: run.id,
            status: run.status,
            outcome: run.outcome,
            revisionNumber: run.revisionNumber,
            revisionHash: run.revisionHash,
            briefVersion: run.briefVersion,
            blockingCount: run.blockingCount,
            warningCount: run.warningCount,
            infoCount: run.infoCount,
            notCheckedCount: run.notCheckedCount,
            errorCode: run.errorCode,
            checkerVersion: run.checkerVersion,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            requestedBy: run.requestedBy.email,
            current: currency.current,
            currency,
            aiProvider: run.aiRun?.provider ?? null,
            aiModel: run.aiRun?.model ?? null,
          }
        : null,
    approval,
    briefSuperseded: Boolean(ref && newerBrief && newerBrief.id !== ref.briefId),
  };
}

/** The provenance of one run, for the report's provenance block (M5.4 §8). */
export type QaProvenance = {
  runId: string;
  checkerVersion: string;
  inputsFingerprint: string;
  contextVersionId: string | null;
  evidencePackage: {
    id: string;
    contentHash: string;
    sealedAt: Date | null;
    evidenceCount: number;
    retrievalPolicy: { name: string; version: number } | null;
  } | null;
  aiRun: {
    id: string;
    provider: string;
    model: string;
    promptTemplateVersion: number | null;
    outputSchemaVersion: string;
    status: string;
    inputTokens: number | null;
    outputTokens: number | null;
    errorCode: string | null;
  } | null;
  requestedBy: string;
  startedAt: Date;
  completedAt: Date | null;
};

export async function qaProvenanceFor(
  context: TenantContext,
  runId: string,
): Promise<QaProvenance | null> {
  const run = await prisma.contentQaRun.findFirst({
    where: { id: runId, ...websiteScope(context) },
    include: {
      requestedBy: { select: { email: true } },
      evidencePackage: {
        select: {
          id: true,
          contentHash: true,
          sealedAt: true,
          evidenceCount: true,
          retrievalPolicy: { select: { name: true, version: true } },
        },
      },
      aiRun: {
        select: {
          id: true,
          provider: true,
          model: true,
          promptTemplateVersion: true,
          outputSchemaVersion: true,
          status: true,
          inputTokens: true,
          outputTokens: true,
          errorCode: true,
        },
      },
    },
  });
  if (!run) return null;
  return {
    runId: run.id,
    checkerVersion: run.checkerVersion,
    inputsFingerprint: run.inputsFingerprint,
    contextVersionId: run.contextVersionId,
    evidencePackage: run.evidencePackage,
    aiRun: run.aiRun,
    requestedBy: run.requestedBy.email,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

export type { ApprovedRevisionRef, ContentQaStatus };
