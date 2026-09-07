import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { SYSTEM_AUTH_USER_ID } from "@/server/jobs/system-context";
import { cmsApprovalFor, currentInputsFingerprint } from "@/server/services/content-qa";
import { approvedRevisionFor } from "@/server/services/content-draft";
import { revisionHash } from "@/lib/execution/hash";
import {
  EXECUTION_ERROR_MESSAGES,
  isRetrySafeFailure,
  type ExecutionErrorCode,
} from "@/lib/execution/errors";
import { ACTIVE_EXECUTION_STATUSES } from "@/lib/execution/statuses";
import { parseCmsBaseUrl, type CanonicalSiteUrl } from "@/lib/cms/url";
import { executionIdempotencyKey } from "@/lib/cms/idempotency";
import { isCmsEntityType, suggestEntityType, type EntityTypeSuggestion } from "@/lib/cms/target";
import { Prisma } from "@/generated/prisma/client";
import type {
  CmsEntityType,
  Execution,
  ExecutionStep,
  ExecutionType,
  PublishingMode,
} from "@/generated/prisma/client";

/**
 * Turning a human authorization into a durable local record of an intent to
 * change something outside SEO OS (docs/P4_SPEC.md sections 21, 26; the M6
 * plan, sections 1 to 5).
 *
 * M6.1 stops one step short of the outside world. It decides whether an
 * external action is allowed, names the exact operation, and writes the record
 * that a later milestone will act on. No provider exists yet and nothing here
 * opens a socket.
 *
 * Three ideas carry the whole file.
 *
 * Preflight is asked twice. Once as a read, to show a person what would happen,
 * and again inside the transaction that writes the execution. The first answer
 * is advisory and may be minutes old; only the second one authorizes anything.
 *
 * The operation has an identity, derived from what it is rather than when it
 * was asked for, so asking twice is recognisably the same request. That is what
 * stops a double-click becoming two drafts in someone's CMS.
 *
 * The transaction ends before any external call ever begins. A record of the
 * intent is committed first, so an attempt that vanishes into a timeout still
 * has something local to reconcile against. This service commits at READY; the
 * milestone that adds a provider takes it from there.
 */

export class ExecutionServiceError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    message: string = EXECUTION_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "ExecutionServiceError";
  }
}

/** Publishing modes under which creating a CMS draft is permitted at all. */
const MODES_PERMITTING_DRAFT_CREATION: readonly PublishingMode[] = [
  "DRAFT_ONLY",
  "DRAFT_AND_UPDATE",
  "PUBLISH_WITH_APPROVAL",
];

const CMS_DRAFT: ExecutionType = "CREATE_CMS_DRAFT";

// ---------------------------------------------------------------------------
// The preflight report
// ---------------------------------------------------------------------------

export const PREFLIGHT_CHECK_IDS = [
  "human_actor",
  "role",
  "work_item",
  "work_item_status",
  "connection",
  "connection_status",
  "site_url",
  "policy",
  "policy_mode",
  "target_type",
  "capability",
  "approval",
  "approval_current",
  "qa_run",
  "revision_pinned",
  "revision_hash",
  "draft_approved",
  "not_checked_acknowledged",
  "brief_acknowledged",
  "idempotency",
  "no_external_draft",
  "no_open_execution",
] as const;

export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];

export const PREFLIGHT_CHECK_LABELS: Record<PreflightCheckId, string> = {
  human_actor: "A person is asking",
  role: "That person may authorize CMS work",
  work_item: "The work item belongs to this website",
  work_item_status: "The work is approved for the CMS",
  connection: "A WordPress connection exists",
  connection_status: "That connection is connected",
  site_url: "The connection has a usable site address",
  policy: "A publishing policy exists for it",
  policy_mode: "The policy permits creating a draft",
  target_type: "The target is a post or a page",
  capability: "The connection may create that kind of draft",
  approval: "A person approved this for the CMS",
  approval_current: "That approval is still current",
  qa_run: "Its QA run completed with no blocking finding",
  revision_pinned: "The approved revision is still the pinned one",
  revision_hash: "The words still hash to what was approved",
  draft_approved: "The draft is still editorially approved",
  not_checked_acknowledged: "Unchecked QA was acknowledged",
  brief_acknowledged: "A superseded brief was acknowledged",
  idempotency: "The operation has a stable identity",
  no_external_draft: "No CMS draft exists for this work yet",
  no_open_execution: "No earlier attempt is open or unresolved",
};

export type PreflightCheckStatus = "PASS" | "FAIL" | "NOT_RUN";

export type PreflightCheck = {
  id: PreflightCheckId;
  label: string;
  status: PreflightCheckStatus;
  /** Present on FAIL. The code a refusal would carry. */
  code?: ExecutionErrorCode;
  /** Present where the check has something specific to say. Never a secret. */
  detail?: string;
};

/** Everything a later milestone needs to make the call, decided here. */
export type CmsDraftPlan = {
  websiteId: string;
  contentWorkItemId: string;
  recommendationId: string;
  decisionId: string;
  contentDraftId: string;
  contentRevisionId: string;
  revisionNumber: number;
  revisionHash: string;
  contentCmsApprovalId: string;
  qaRunId: string;
  connectionId: string;
  siteHost: string;
  canonicalSite: string;
  targetEntityType: CmsEntityType;
  permissionMode: PublishingMode;
  executionType: ExecutionType;
  idempotencyKey: string;
};

export type PreflightRefusal = {
  checkId: PreflightCheckId;
  code: ExecutionErrorCode;
  message: string;
};

export type PreflightResult = {
  ok: boolean;
  checks: PreflightCheck[];
  /** Present only when every check passed. */
  plan: CmsDraftPlan | null;
  /** Present when something refused. The first failing check, in evaluation order. */
  refusal: PreflightRefusal | null;
  /** What the product would propose as a target, for a person to confirm. */
  suggestion: EntityTypeSuggestion;
};

export type PreflightOptions = {
  /** Post or page. Required for the write path; optional when only reading. */
  targetEntityType?: CmsEntityType | null;
};

type CheckRecorder = {
  pass(id: PreflightCheckId, detail?: string): void;
  fail(id: PreflightCheckId, code: ExecutionErrorCode, detail?: string): void;
  notRun(id: PreflightCheckId, detail?: string): void;
  result(): { checks: PreflightCheck[]; refusal: PreflightRefusal | null };
};

function recorder(): CheckRecorder {
  const seen = new Map<PreflightCheckId, PreflightCheck>();
  let refusal: PreflightRefusal | null = null;

  const put = (check: PreflightCheck) => {
    if (!seen.has(check.id)) seen.set(check.id, check);
  };

  return {
    pass(id, detail) {
      put({ id, label: PREFLIGHT_CHECK_LABELS[id], status: "PASS", detail });
    },
    fail(id, code, detail) {
      put({ id, label: PREFLIGHT_CHECK_LABELS[id], status: "FAIL", code, detail });
      if (!refusal) {
        refusal = {
          checkId: id,
          code,
          message: detail
            ? `${EXECUTION_ERROR_MESSAGES[code]} ${detail}`
            : EXECUTION_ERROR_MESSAGES[code],
        };
      }
    },
    notRun(id, detail) {
      put({ id, label: PREFLIGHT_CHECK_LABELS[id], status: "NOT_RUN", detail });
    },
    result() {
      // Every id appears, in the documented order, whether it ran or not. A
      // check that silently disappears from a report is a check nobody misses.
      const checks = PREFLIGHT_CHECK_IDS.map(
        (id) =>
          seen.get(id) ?? {
            id,
            label: PREFLIGHT_CHECK_LABELS[id],
            status: "NOT_RUN" as const,
            detail: "Not reached.",
          },
      );
      return { checks, refusal };
    },
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Whether creating a CMS draft for this work would be allowed right now.
 *
 * Read-only and side-effect free, so a screen may call it and so may the
 * transaction that writes. It never runs QA, never repairs anything, and never
 * reaches the network: an out-of-date answer is a refusal, not a trigger to go
 * and make it current.
 *
 * Checks whose inputs are missing report NOT_RUN rather than PASS, so a report
 * with an absent connection does not read as though the connection was fine.
 */
export async function preflightCreateCmsDraft(
  context: TenantContext,
  workItemId: string,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const check = recorder();
  const pageTypeless: EntityTypeSuggestion = suggestEntityType(null);

  const finish = (plan: CmsDraftPlan | null, suggestion = pageTypeless): PreflightResult => {
    const { checks, refusal } = check.result();
    return { ok: refusal === null && plan !== null, checks, plan, refusal, suggestion };
  };

  // --- who is asking -------------------------------------------------------
  if (context.user.authUserId === SYSTEM_AUTH_USER_ID) {
    check.fail("human_actor", "forbidden", "A scheduled job may not act on a CMS.");
    return finish(null);
  }
  check.pass("human_actor");

  if (!hasRole(context.membership.role, REQUIRED.REVIEW)) {
    check.fail("role", "forbidden", "This needs an SEO lead, admin or owner.");
    return finish(null);
  }
  check.pass("role");

  // --- what is being asked about -------------------------------------------
  const workItem = await prisma.contentWorkItem.findFirst({
    where: { id: workItemId, ...websiteScope(context) },
    include: { page: { select: { pageType: true } } },
  });
  if (!workItem) {
    check.fail("work_item", "not_found");
    return finish(null);
  }
  check.pass("work_item");

  const suggestion = suggestEntityType(workItem.page?.pageType ?? null);

  if (workItem.status !== "APPROVED_FOR_CMS") {
    check.fail(
      "work_item_status",
      "policy_denied",
      "Only work that is approved for the CMS can be sent to one.",
    );
  } else {
    check.pass("work_item_status");
  }

  // --- where it would go ---------------------------------------------------
  const connection = await prisma.connection.findFirst({
    where: { provider: "WORDPRESS", websiteId: context.website.id },
  });

  let site: CanonicalSiteUrl | null = null;
  if (!connection) {
    check.fail("connection", "not_configured");
    check.notRun("connection_status");
    check.notRun("site_url");
  } else {
    check.pass("connection");
    if (connection.status !== "CONNECTED") {
      check.fail(
        "connection_status",
        "connection_disabled",
        `The connection reads ${connection.status.toLowerCase().replace(/_/g, " ")}.`,
      );
    } else {
      check.pass("connection_status");
    }

    const parsed = connection.baseUrl ? parseCmsBaseUrl(connection.baseUrl) : null;
    if (!parsed) {
      check.fail("site_url", "invalid_site_url", "No site address is set on the connection.");
    } else if (!parsed.ok) {
      check.fail("site_url", "invalid_site_url");
    } else {
      site = parsed.value;
      check.pass("site_url", site.hostname);
    }
  }

  const policy = connection
    ? await prisma.publishingPolicy.findFirst({
        where: { websiteId: context.website.id, connectionId: connection.id },
      })
    : null;

  if (!connection) {
    check.notRun("policy");
    check.notRun("policy_mode");
  } else if (!policy) {
    check.fail("policy", "not_configured", "No publishing policy is set for this connection.");
    check.notRun("policy_mode");
  } else {
    check.pass("policy");
    if (!MODES_PERMITTING_DRAFT_CREATION.includes(policy.mode)) {
      check.fail(
        "policy_mode",
        "policy_denied",
        `The policy is set to ${policy.mode.toLowerCase().replace(/_/g, " ")}.`,
      );
    } else {
      check.pass("policy_mode");
    }
  }

  // --- what kind of thing would be created ---------------------------------
  const requested = options.targetEntityType ?? null;
  let targetEntityType: CmsEntityType | null = null;
  if (requested === null) {
    check.fail(
      "target_type",
      "target_type_unresolved",
      "A person chooses whether this becomes a WordPress post or page.",
    );
  } else if (!isCmsEntityType(requested)) {
    check.fail("target_type", "target_type_unresolved", "M6 supports a post or a page only.");
  } else {
    targetEntityType = requested;
    check.pass("target_type", requested);
  }

  if (!connection || !targetEntityType) {
    check.notRun("capability");
  } else {
    const capability = await prisma.connectionCapability.findFirst({
      where: {
        connectionId: connection.id,
        websiteId: context.website.id,
        capability: "CREATE_DRAFT",
        entityType: targetEntityType,
      },
    });
    if (!capability) {
      check.fail(
        "capability",
        "capability_missing",
        "The connection has not been checked for permission to create that kind of draft.",
      );
    } else if (!capability.granted) {
      check.fail("capability", "capability_missing", "The connected CMS user may not create it.");
    } else {
      check.pass("capability", `checked ${capability.source}`);
    }
  }

  // --- what authorized it --------------------------------------------------
  const [approvalView, ref] = await Promise.all([
    cmsApprovalFor(context, workItemId),
    approvedRevisionFor(context, workItemId),
  ]);

  if (!approvalView) {
    check.fail("approval", "approval_missing");
    for (const id of [
      "approval_current",
      "qa_run",
      "revision_pinned",
      "revision_hash",
      "draft_approved",
      "not_checked_acknowledged",
      "brief_acknowledged",
      "idempotency",
    ] as const) {
      check.notRun(id);
    }
    return finish(null, suggestion);
  }
  check.pass("approval");

  const approval = approvalView.approval;

  if (!approvalView.executable) {
    check.fail(
      "approval_current",
      "stale_approval",
      `Its QA is stale: ${approvalView.staleReasons.join(", ").toLowerCase().replace(/_/g, " ")}.`,
    );
  } else {
    check.pass("approval_current");
  }

  const run = approvalView.run;
  if (!run) {
    check.fail("qa_run", "qa_blocked", "The QA run behind this approval is no longer readable.");
  } else if (run.status !== "COMPLETED") {
    check.fail("qa_run", "qa_blocked", "The QA run behind this approval did not complete.");
  } else if (run.outcome === "FAIL" || run.blockingCount > 0) {
    check.fail("qa_run", "qa_blocked");
  } else {
    check.pass("qa_run", `${run.blockingCount} blocking`);
  }

  // --- and whether the words are still those words -------------------------
  if (!ref) {
    check.fail(
      "revision_pinned",
      "content_mismatch",
      "The draft no longer has an approved revision.",
    );
    check.notRun("revision_hash");
    check.notRun("draft_approved");
  } else if (ref.revisionId !== approval.contentRevisionId) {
    check.fail("revision_pinned", "content_mismatch", "A different revision is approved now.");
    check.notRun("revision_hash");
    check.pass("draft_approved");
  } else {
    check.pass("revision_pinned", `revision ${ref.revisionNumber}`);
    check.pass("draft_approved");
  }

  const revision =
    ref && ref.revisionId === approval.contentRevisionId
      ? await prisma.contentRevision.findFirst({
          where: { id: approval.contentRevisionId, ...websiteScope(context) },
        })
      : null;

  if (revision) {
    // Recomputed from the words, not read from the row. A stored hash proves
    // only that something wrote it.
    const recomputed = revisionHash({
      title: revision.title,
      slug: revision.slug,
      excerpt: revision.excerpt,
      bodyMarkdown: revision.bodyMarkdown,
      metaTitle: revision.metaTitle,
      metaDescription: revision.metaDescription,
      schemaJson: revision.schemaJson,
    });
    if (recomputed !== approval.revisionHash) {
      check.fail("revision_hash", "content_mismatch");
    } else {
      check.pass("revision_hash");
    }
  }

  const notCheckedTypes =
    run === null
      ? 0
      : await prisma.contentQaResult.count({
          where: { qaRunId: run.id, status: "NOT_CHECKED", ...websiteScope(context) },
        });
  const acknowledgedNotChecked =
    run === null || notCheckedTypes === 0 || approval.notCheckedAcknowledged;
  if (!acknowledgedNotChecked) {
    check.fail(
      "not_checked_acknowledged",
      "approval_missing",
      "Checks that did not run were never acknowledged.",
    );
  } else {
    check.pass("not_checked_acknowledged");
  }

  const briefStale = approvalView.staleReasons.includes("BRIEF_SUPERSEDED");
  if (briefStale && !approval.briefSupersededAcknowledged) {
    check.fail(
      "brief_acknowledged",
      "approval_missing",
      "A newer brief version was not acknowledged.",
    );
  } else {
    check.pass("brief_acknowledged");
  }

  // --- the identity of the operation ---------------------------------------
  let idempotencyKey: string | null = null;
  if (!connection || !site || !targetEntityType) {
    check.notRun("idempotency");
  } else {
    idempotencyKey = executionIdempotencyKey({
      websiteId: context.website.id,
      connectionId: connection.id,
      canonicalSite: site.href,
      contentCmsApprovalId: approval.id,
      revisionHash: approval.revisionHash,
      executionType: CMS_DRAFT,
      targetEntityType,
    });
    check.pass("idempotency");
  }

  // --- and whether anything was already done -------------------------------
  const priorExecutions = await prisma.execution.findMany({
    where: {
      contentWorkItemId: workItemId,
      executionType: CMS_DRAFT,
      ...websiteScope(context),
    },
    orderBy: { createdAt: "asc" },
  });

  const withExternal = priorExecutions.find((row) => row.externalEntityId !== null);
  if (withExternal) {
    check.fail(
      "no_external_draft",
      "already_executed",
      "Updating an existing CMS draft is a later milestone.",
    );
  } else {
    check.pass("no_external_draft");
  }

  const blocking = priorExecutions.find((row) => {
    if (row.idempotencyKey !== null && row.idempotencyKey === idempotencyKey) return false;
    if (row.status === "EXECUTING") return true;
    if (row.status === "FAILED") return !isRetrySafeFailure(row.errorCode);
    return (ACTIVE_EXECUTION_STATUSES as readonly string[]).includes(row.status);
  });

  if (blocking) {
    // An attempt whose outcome we cannot rule out blocks a new one even when a
    // later approval would give it a different identity. Two POSTs because an
    // earlier answer was unclear is the one failure this milestone exists to
    // make impossible.
    const unresolved = blocking.status === "EXECUTING" || blocking.status === "FAILED";
    check.fail(
      "no_open_execution",
      unresolved ? "ambiguous_timeout" : "execution_in_progress",
      unresolved
        ? "An earlier attempt has no settled outcome. It must be reconciled first."
        : "An earlier attempt for this work is still open.",
    );
  } else {
    check.pass("no_open_execution");
  }

  const { refusal } = check.result();
  if (
    refusal ||
    !connection ||
    !site ||
    !targetEntityType ||
    !policy ||
    !revision ||
    !run ||
    !idempotencyKey
  ) {
    return finish(null, suggestion);
  }

  return finish(
    {
      websiteId: context.website.id,
      contentWorkItemId: workItem.id,
      recommendationId: workItem.recommendationId,
      decisionId: workItem.decisionId,
      contentDraftId: approval.contentDraftId,
      contentRevisionId: approval.contentRevisionId,
      revisionNumber: approval.revisionNumber,
      revisionHash: approval.revisionHash,
      contentCmsApprovalId: approval.id,
      qaRunId: approval.qaRunId,
      connectionId: connection.id,
      siteHost: site.hostname,
      canonicalSite: site.href,
      targetEntityType,
      permissionMode: policy.mode,
      executionType: CMS_DRAFT,
      idempotencyKey,
    },
    suggestion,
  );
}

// ---------------------------------------------------------------------------
// Creating, or recognising, the execution
// ---------------------------------------------------------------------------

export type RequestCmsDraftInput = {
  targetEntityType: CmsEntityType;
};

export type RequestCmsDraftResult = {
  execution: Execution;
  /** True when an execution for this same operation already existed. */
  reused: boolean;
  plan: CmsDraftPlan;
};

/** Either the execution this request resolves to, or why it was refused. */
type CreateOutcome =
  | { kind: "done"; result: RequestCmsDraftResult }
  | { kind: "refused"; refusal: PreflightRefusal; failedChecks: PreflightCheckId[] };

/** What to do about an execution that already holds this operation's identity. */
function dispositionOf(
  existing: Execution,
): { reuse: true; retry: boolean } | { code: ExecutionErrorCode } {
  switch (existing.status) {
    case "PROPOSED":
    case "READY":
    case "AWAITING_APPROVAL":
    case "APPROVED":
      return { reuse: true, retry: false };
    case "FAILED":
      // Only a failure that proves nothing was created may be tried again.
      // Everything else, including a failure we could not classify, is treated
      // as though a draft might exist.
      return isRetrySafeFailure(existing.errorCode)
        ? { reuse: true, retry: true }
        : { code: "ambiguous_timeout" };
    case "EXECUTING":
      return { code: "execution_in_progress" };
    case "CANCELLED":
      return { code: "execution_cancelled" };
    default:
      return { code: "already_executed" };
  }
}

/**
 * Records the intent to create a CMS draft, once.
 *
 * Everything that decides whether this may happen runs again inside the
 * transaction, because the screen that led here may be minutes old and the
 * approval behind it may have gone stale in between. The work item row is
 * locked first, so two clicks arriving together are serialised rather than
 * racing, and the unique index on the identity is the backstop for anything
 * that gets past that.
 *
 * The transaction commits with the execution at READY and no external call
 * made. Deliberately: the durable local record has to exist before anything
 * outside SEO OS is touched, so an attempt that later disappears into a
 * timeout still has something here to reconcile against.
 */
export async function requestCmsDraftExecution(
  context: TenantContext,
  workItemId: string,
  input: RequestCmsDraftInput,
): Promise<RequestCmsDraftResult> {
  if (!isCmsEntityType(input.targetEntityType)) {
    throw new ExecutionServiceError("target_type_unresolved");
  }

  try {
    return await createOrReuse(context, workItemId, input.targetEntityType);
  } catch (error) {
    // The index did its job while two transactions overlapped. Asking again
    // now finds the row the other one wrote.
    if (isIdempotencyCollision(error)) {
      return await createOrReuse(context, workItemId, input.targetEntityType);
    }
    throw error;
  }
}

function isIdempotencyCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2002") return false;
  const target = error.meta?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes("idempotency");
}

async function createOrReuse(
  context: TenantContext,
  workItemId: string,
  targetEntityType: CmsEntityType,
): Promise<RequestCmsDraftResult> {
  const startedAt = new Date();

  // The planning pass, outside the transaction on purpose. It reads widely, and
  // a transaction held open across those reads pins a pooled connection while
  // everything else waits for one.
  const preflight = await preflightCreateCmsDraft(context, workItemId, { targetEntityType });

  if (!preflight.ok || !preflight.plan) {
    const refusal = preflight.refusal ?? {
      checkId: "work_item" as PreflightCheckId,
      code: "not_found" as ExecutionErrorCode,
      message: EXECUTION_ERROR_MESSAGES.not_found,
    };
    await recordDecline(
      context,
      workItemId,
      targetEntityType,
      refusal,
      preflight.checks.filter((c) => c.status === "FAIL").map((c) => c.id),
    );
    throw new ExecutionServiceError(refusal.code, refusal.message);
  }

  const plan = preflight.plan;

  const outcome = await prisma.$transaction(async (tx): Promise<CreateOutcome> => {
    // Serialise concurrent requests for the same work before anything is read.
    await tx.$queryRaw`SELECT id FROM content_work_item WHERE id = ${workItemId}::uuid FOR UPDATE`;

    // The authoritative pass. Everything the plan asserts, asked again through
    // this transaction's own connection: the screen that led here may be
    // minutes old, and even the planning pass above is already in the past.
    const refusal = await reverifyPlan(tx, context, plan);
    if (refusal) return { kind: "refused", refusal, failedChecks: [refusal.checkId] };

    const existing = await tx.execution.findFirst({
      where: { websiteId: plan.websiteId, idempotencyKey: plan.idempotencyKey },
    });

    if (existing) {
      const disposition = dispositionOf(existing);
      if ("code" in disposition) throw new ExecutionServiceError(disposition.code);

      const execution = disposition.retry
        ? await tx.execution.update({
            where: { id: existing.id },
            data: { status: "READY", errorCode: null, errorSummary: null },
          })
        : existing;

      await writeStep(
        tx,
        plan,
        execution,
        startedAt,
        preflight.checks,
        disposition.retry ? "retry" : "reuse",
      );
      await recordAudit(tx, context, {
        entityType: "Execution",
        entityId: execution.id,
        action: "UPDATE",
        after: {
          executionType: CMS_DRAFT,
          targetEntityType: plan.targetEntityType,
          reused: true,
          retried: disposition.retry,
          checksPassed: preflight.checks.filter((c) => c.status === "PASS").length,
        },
      });
      return { kind: "done", result: { execution, reused: true, plan } };
    }

    const { approvedByUserId } = await tx.contentCmsApproval.findUniqueOrThrow({
      where: { id: plan.contentCmsApprovalId },
      select: { approvedByUserId: true },
    });

    const execution = await tx.execution.create({
      data: {
        websiteId: plan.websiteId,
        recommendationId: plan.recommendationId,
        decisionId: plan.decisionId,
        contentWorkItemId: plan.contentWorkItemId,
        contentRevisionId: plan.contentRevisionId,
        revisionHash: plan.revisionHash,
        contentCmsApprovalId: plan.contentCmsApprovalId,
        qaRunId: plan.qaRunId,
        targetEntityType: plan.targetEntityType,
        idempotencyKey: plan.idempotencyKey,
        permissionMode: plan.permissionMode,
        executionType: CMS_DRAFT,
        provider: "WORDPRESS",
        connectionId: plan.connectionId,
        // Committed ready to run, never running: no socket has been opened and
        // the record has to be durable before one is.
        status: "READY",
        requestedByUserId: context.user.id,
        // Who authorized it, on the row itself, so the record answers that
        // without a join to an approval that may later be invalidated.
        approvedByUserId,
      },
    });

    await writeStep(tx, plan, execution, startedAt, preflight.checks, "create");
    await recordAudit(tx, context, {
      entityType: "Execution",
      entityId: execution.id,
      action: "CREATE",
      after: {
        executionType: CMS_DRAFT,
        targetEntityType: plan.targetEntityType,
        permissionMode: plan.permissionMode,
        contentCmsApprovalId: plan.contentCmsApprovalId,
        qaRunId: plan.qaRunId,
        contentRevisionId: plan.contentRevisionId,
        revisionNumber: plan.revisionNumber,
        connectionId: plan.connectionId,
        siteHost: plan.siteHost,
        checksPassed: preflight.checks.filter((c) => c.status === "PASS").length,
        reused: false,
      },
    });

    return { kind: "done", result: { execution, reused: false, plan } };
  });

  if (outcome.kind === "refused") {
    await recordDecline(
      context,
      workItemId,
      targetEntityType,
      outcome.refusal,
      outcome.failedChecks,
    );
    throw new ExecutionServiceError(outcome.refusal.code, outcome.refusal.message);
  }

  return outcome.result;
}

/**
 * A refusal is part of the trail.
 *
 * Written outside any transaction, deliberately: a refusal rolls back
 * everything its transaction touched, and the fact that somebody asked and was
 * told no has to survive that. There is no execution row to name, so it is
 * recorded against the work item, with the check that stopped it.
 */
async function recordDecline(
  context: TenantContext,
  workItemId: string,
  targetEntityType: CmsEntityType,
  refusal: PreflightRefusal,
  failedChecks: PreflightCheckId[],
): Promise<void> {
  await recordAudit(prisma, context, {
    entityType: "ContentWorkItem",
    entityId: workItemId,
    action: "DECLINE",
    after: {
      executionType: CMS_DRAFT,
      targetEntityType,
      refusedAt: refusal.checkId,
      code: refusal.code,
      failedChecks,
    },
  });
}

/**
 * Everything the plan asserts, asked again inside the transaction that is about
 * to act on it, reading only through that transaction's own client.
 *
 * It checks against the plan rather than recomputing one, so the question is
 * always the same: is what we decided still true? A recomputed plan could
 * differ and quietly authorize something nobody looked at.
 */
async function reverifyPlan(
  tx: Prisma.TransactionClient,
  context: TenantContext,
  plan: CmsDraftPlan,
): Promise<PreflightRefusal | null> {
  const fail = (
    checkId: PreflightCheckId,
    code: ExecutionErrorCode,
    detail?: string,
  ): PreflightRefusal => ({
    checkId,
    code,
    message: detail
      ? `${EXECUTION_ERROR_MESSAGES[code]} ${detail}`
      : EXECUTION_ERROR_MESSAGES[code],
  });

  const scope = websiteScope(context);

  const workItem = await tx.contentWorkItem.findFirst({
    where: { id: plan.contentWorkItemId, ...scope },
    select: { status: true },
  });
  if (!workItem) return fail("work_item", "not_found");
  if (workItem.status !== "APPROVED_FOR_CMS") return fail("work_item_status", "policy_denied");

  const connection = await tx.connection.findFirst({
    where: { id: plan.connectionId, provider: "WORDPRESS", websiteId: context.website.id },
    select: { id: true, status: true, baseUrl: true },
  });
  if (!connection) return fail("connection", "not_configured");
  if (connection.status !== "CONNECTED") return fail("connection_status", "connection_disabled");

  const site = connection.baseUrl ? parseCmsBaseUrl(connection.baseUrl) : null;
  if (!site || !site.ok) return fail("site_url", "invalid_site_url");
  if (site.value.href !== plan.canonicalSite) {
    return fail("site_url", "invalid_site_url", "The site address changed since this was planned.");
  }

  const policy = await tx.publishingPolicy.findFirst({
    where: { websiteId: context.website.id, connectionId: connection.id },
    select: { mode: true },
  });
  if (!policy) return fail("policy", "not_configured");
  if (!MODES_PERMITTING_DRAFT_CREATION.includes(policy.mode)) {
    return fail("policy_mode", "policy_denied");
  }
  if (policy.mode !== plan.permissionMode) {
    return fail("policy_mode", "policy_denied", "The publishing policy changed.");
  }

  const capability = await tx.connectionCapability.findFirst({
    where: {
      connectionId: connection.id,
      websiteId: context.website.id,
      capability: "CREATE_DRAFT",
      entityType: plan.targetEntityType,
    },
    select: { granted: true },
  });
  if (!capability?.granted) return fail("capability", "capability_missing");

  const approval = await tx.contentCmsApproval.findFirst({
    where: { contentWorkItemId: plan.contentWorkItemId, status: "APPROVED", ...scope },
  });
  if (!approval) return fail("approval", "approval_missing");
  if (
    approval.id !== plan.contentCmsApprovalId ||
    approval.contentRevisionId !== plan.contentRevisionId ||
    approval.revisionHash !== plan.revisionHash ||
    approval.qaRunId !== plan.qaRunId
  ) {
    return fail("approval_current", "stale_approval", "A different approval is current now.");
  }

  const run = await tx.contentQaRun.findFirst({ where: { id: approval.qaRunId, ...scope } });
  if (!run || run.status !== "COMPLETED") return fail("qa_run", "qa_blocked");
  if (run.outcome === "FAIL" || run.blockingCount > 0) return fail("qa_run", "qa_blocked");

  // D8, and the reason this milestone exists to be careful: an approval stays
  // on the record as what it was, and stops authorizing anything the moment the
  // facts, rules or business context it rested on move.
  const fingerprint = await currentInputsFingerprint(context, tx);
  if (run.inputsFingerprint !== fingerprint) {
    return fail(
      "approval_current",
      "stale_approval",
      "The facts, rules or business context changed after this QA run.",
    );
  }

  const later = await tx.contentQaRun.findFirst({
    where: {
      contentRevisionId: approval.contentRevisionId,
      status: "COMPLETED",
      createdAt: { gt: approval.approvedAt },
      ...scope,
    },
    select: { id: true },
  });
  if (later) return fail("approval_current", "stale_approval", "A newer QA run has since run.");

  const draft = await tx.contentDraft.findFirst({
    where: { id: approval.contentDraftId, ...scope },
    select: { status: true, approvedRevisionId: true },
  });
  if (!draft || draft.status !== "APPROVED") return fail("draft_approved", "content_mismatch");
  if (draft.approvedRevisionId !== plan.contentRevisionId) {
    return fail("revision_pinned", "content_mismatch");
  }

  const revision = await tx.contentRevision.findFirst({
    where: { id: plan.contentRevisionId, ...scope },
  });
  if (!revision) return fail("revision_pinned", "content_mismatch");
  const recomputed = revisionHash({
    title: revision.title,
    slug: revision.slug,
    excerpt: revision.excerpt,
    bodyMarkdown: revision.bodyMarkdown,
    metaTitle: revision.metaTitle,
    metaDescription: revision.metaDescription,
    schemaJson: revision.schemaJson,
  });
  if (recomputed !== plan.revisionHash) return fail("revision_hash", "content_mismatch");

  const notCheckedTypes = await tx.contentQaResult.count({
    where: { qaRunId: run.id, status: "NOT_CHECKED", ...scope },
  });
  if (notCheckedTypes > 0 && !approval.notCheckedAcknowledged) {
    return fail("not_checked_acknowledged", "approval_missing");
  }

  const currentBrief = await tx.contentBrief.findFirst({
    where: { contentWorkItemId: plan.contentWorkItemId, status: "APPROVED", ...scope },
    select: { id: true },
  });
  if (
    currentBrief &&
    currentBrief.id !== approval.briefId &&
    !approval.briefSupersededAcknowledged
  ) {
    return fail("brief_acknowledged", "approval_missing");
  }

  const prior = await tx.execution.findMany({
    where: { contentWorkItemId: plan.contentWorkItemId, executionType: CMS_DRAFT, ...scope },
  });
  if (prior.some((row) => row.externalEntityId !== null)) {
    return fail("no_external_draft", "already_executed", "Updating it is a later milestone.");
  }

  const blocking = prior.find((row) => {
    if (row.idempotencyKey !== null && row.idempotencyKey === plan.idempotencyKey) return false;
    if (row.status === "EXECUTING") return true;
    if (row.status === "FAILED") return !isRetrySafeFailure(row.errorCode);
    return (ACTIVE_EXECUTION_STATUSES as readonly string[]).includes(row.status);
  });
  if (blocking) {
    const unresolved = blocking.status === "EXECUTING" || blocking.status === "FAILED";
    return fail(
      "no_open_execution",
      unresolved ? "ambiguous_timeout" : "execution_in_progress",
      unresolved ? "An earlier attempt has no settled outcome." : undefined,
    );
  }

  return null;
}

async function writeStep(
  tx: Prisma.TransactionClient,
  plan: CmsDraftPlan,
  execution: Execution,
  startedAt: Date,
  checks: PreflightCheck[],
  outcome: "create" | "reuse" | "retry",
): Promise<void> {
  await tx.executionStep.create({
    data: {
      websiteId: plan.websiteId,
      executionId: execution.id,
      attempt: execution.attempt,
      stepType: "PREFLIGHT",
      status: "SUCCEEDED",
      // Codes, ids and counts. Never a payload, never a credential, and never
      // a URL that could carry one.
      requestSummaryJson: {
        outcome,
        targetEntityType: plan.targetEntityType,
        permissionMode: plan.permissionMode,
        siteHost: plan.siteHost,
        contentCmsApprovalId: plan.contentCmsApprovalId,
        qaRunId: plan.qaRunId,
        revisionNumber: plan.revisionNumber,
      },
      responseSummaryJson: {
        passed: checks.filter((c) => c.status === "PASS").length,
        notRun: checks.filter((c) => c.status === "NOT_RUN").length,
        checks: checks.filter((c) => c.status === "PASS").map((c) => c.id),
      },
      startedAt,
      finishedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getExecution(
  context: TenantContext,
  executionId: string,
): Promise<Execution | null> {
  return prisma.execution.findFirst({ where: { id: executionId, ...websiteScope(context) } });
}

export async function listExecutions(
  context: TenantContext,
  workItemId: string,
): Promise<Execution[]> {
  return prisma.execution.findMany({
    where: { contentWorkItemId: workItemId, ...websiteScope(context) },
    orderBy: { createdAt: "desc" },
  });
}

export async function listExecutionSteps(
  context: TenantContext,
  executionId: string,
): Promise<ExecutionStep[]> {
  return prisma.executionStep.findMany({
    where: { executionId, ...websiteScope(context) },
    orderBy: { startedAt: "asc" },
  });
}

/** The execution holding the slot for this work and type, if there is one. */
export async function activeExecutionFor(
  context: TenantContext,
  workItemId: string,
  executionType: ExecutionType = CMS_DRAFT,
): Promise<Execution | null> {
  return prisma.execution.findFirst({
    where: {
      contentWorkItemId: workItemId,
      executionType,
      status: { in: [...ACTIVE_EXECUTION_STATUSES] },
      ...websiteScope(context),
    },
  });
}

/**
 * An earlier attempt whose outcome nobody can state. Either it is still running
 * or it failed in a way that does not prove the CMS was left untouched.
 */
export async function unresolvedExecutionFor(
  context: TenantContext,
  workItemId: string,
  executionType: ExecutionType = CMS_DRAFT,
): Promise<Execution | null> {
  const rows = await prisma.execution.findMany({
    where: {
      contentWorkItemId: workItemId,
      executionType,
      status: { in: ["EXECUTING", "FAILED"] },
      ...websiteScope(context),
    },
    orderBy: { createdAt: "asc" },
  });
  return (
    rows.find((row) => row.status === "EXECUTING" || !isRetrySafeFailure(row.errorCode)) ?? null
  );
}

/** The execution that created something in the CMS for this work, if any. */
export async function externalDraftFor(
  context: TenantContext,
  workItemId: string,
  executionType: ExecutionType = CMS_DRAFT,
): Promise<Execution | null> {
  return prisma.execution.findFirst({
    where: {
      contentWorkItemId: workItemId,
      executionType,
      externalEntityId: { not: null },
      ...websiteScope(context),
    },
  });
}
