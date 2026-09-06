import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { SYSTEM_AUTH_USER_ID } from "@/server/jobs/system-context";
import { transitionWorkItem } from "@/server/services/content-work";
import { assembleContentQaPackage, sealPackage } from "@/server/services/evidence-assembler";
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
import { QA_RUN_TRANSITIONS, canTransition } from "@/lib/execution/statuses";
import { parseEvidenceId } from "@/lib/evidence/id";
import { Prisma } from "@/generated/prisma/client";
import type {
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
      "not_found" | "forbidden" | "invalid_state" | "no_approved_revision" | "in_progress",
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
  if (item.status !== "QA" && item.status !== "AWAITING_EDITOR_REVIEW") {
    throw new ContentQaError(
      "QA runs on work that is ready for QA or awaiting final approval.",
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
    gathered = await gather(context, item, brief);
  } catch {
    return fail("package_error", "The evidence for QA could not be assembled.");
  }

  // The checks. A checker that throws is a product error, never NOT_CHECKED.
  const subject = subjectOf(item, revision);
  const ctx: QaContext = {
    ...gathered.ctx,
    aiAvailable: false,
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

  const outcome = deriveOutcome(results);
  const counts = countFindings(results);

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

      for (const result of results) {
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
          workItemStatus: workItem.status,
        },
      });

      return { row, workItem };
    });
    return { ok: true, run: completed.row, results, workItem: completed.workItem };
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

export type { ApprovedRevisionRef, ContentQaStatus };
