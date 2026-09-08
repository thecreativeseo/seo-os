import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { SYSTEM_AUTH_USER_ID } from "@/server/jobs/system-context";
import {
  EXECUTION_ERROR_MESSAGES,
  isRetrySafeFailure,
  type ExecutionErrorCode,
} from "@/lib/execution/errors";
import {
  ExecutionServiceError,
  externalDraftFor,
  requestCmsDraftExecution,
  unresolvedExecutionFor,
} from "@/server/services/execution";
import {
  CmsExecutionError,
  executeCmsDraft,
  isUnresolved,
  reconcileCmsDraft,
  reverifyCmsDraft,
  type ExecuteOptions,
  type ExecuteResult,
} from "@/server/services/cms-execution";
import type { CmsEntityType, Execution } from "@/generated/prisma/client";

/**
 * The three things a person may do about a WordPress draft (M6.3).
 *
 * M6.1 decides whether a draft may be created and writes the record; M6.2
 * carries it out and checks the result. Neither knows who asked. This is where
 * a human being enters: it is the only door into those services from a screen,
 * and it is the layer that refuses when the person, the moment, or the
 * intention is wrong.
 *
 * Three acts, and no fourth. Create asks WordPress to make a draft. Reconcile
 * goes looking for one an interrupted attempt may have made. Re-verify reads a
 * draft we know exists and says whether it still matches. None of them
 * publishes, updates or deletes anything: there is no method on the provider
 * that would let them, and no argument here that could reach one.
 *
 * What a caller may say is deliberately small — which work item, which kind of
 * entity, and that they meant it. Everything else, including which revision,
 * which approval, which connection and which draft, is resolved from the
 * database at the moment of the request. A browser cannot name a revision hash,
 * an execution, an external id or a capability, so it cannot forge one.
 */

/**
 * The word a caller must send to create a draft.
 *
 * Not a boolean, and not any truthy value: an exact constant the server checks,
 * so a stray form field, a replayed request or a default-true flag cannot
 * amount to somebody deciding to write into a CMS. M6.4 will put a control
 * behind it; until then it is what makes the intent explicit.
 */
export const CREATE_WORDPRESS_DRAFT = "CREATE_WORDPRESS_DRAFT";

/**
 * What happened, in terms a screen can render and a person can act on.
 *
 * Deliberately coarse. The execution row carries the detail; this says which of
 * a handful of situations a person is now in, and therefore what they may do
 * next.
 */
export type CmsDraftOutcome =
  /** The draft exists and reads back as the approved revision. */
  | "VERIFIED"
  /** The draft exists; what came back did not match. Its id is kept. */
  | "CREATED_VERIFICATION_FAILED"
  /** Something may or may not have been created. A person must reconcile. */
  | "AMBIGUOUS_RECONCILIATION_REQUIRED"
  /** A draft already exists for this work. Nothing was sent. */
  | "ALREADY_CREATED"
  /** An attempt is running now. Nothing was sent. */
  | "ALREADY_IN_PROGRESS"
  /** It failed, and we know nothing was created. Asking again is safe. */
  | "RETRY_SAFE_FAILURE"
  /** A condition was not met. Nothing was sent. */
  | "REFUSED";

export type CmsDraftActionResult = {
  outcome: CmsDraftOutcome;
  /** Present once an execution exists and belongs to this tenant. */
  executionId: string | null;
  /** Our own code from the execution vocabulary. Never a provider's. */
  code: ExecutionErrorCode | null;
  /** Our own sentence. Never a provider body, a stack, or a database error. */
  message: string | null;
  /** Which checks the read-back made, and how each came out. */
  verifications: ExecuteResult["verifications"];
};

export type CreateWordPressDraftInput = {
  contentWorkItemId: string;
  targetEntityType: CmsEntityType;
  /** Must be exactly CREATE_WORDPRESS_DRAFT. */
  confirmation: string;
};

export type RecoverWordPressDraftInput = {
  contentWorkItemId: string;
};

/** Options exist so tests can inject a transport. Production passes nothing. */
export type CmsDraftActionOptions = ExecuteOptions;

function result(
  outcome: CmsDraftOutcome,
  execution: Execution | null,
  code: ExecutionErrorCode | null = null,
  message: string | null = null,
  verifications: ExecuteResult["verifications"] = [],
): CmsDraftActionResult {
  return {
    outcome,
    executionId: execution?.id ?? null,
    code,
    message: message ?? (code ? EXECUTION_ERROR_MESSAGES[code] : null),
    verifications,
  };
}

const refuse = (code: ExecutionErrorCode, execution: Execution | null = null) =>
  result("REFUSED", execution, code);

/**
 * Who may do any of this, asked at the moment of the request.
 *
 * Three separate questions. Is this a person at all — a scheduled job must
 * never write into somebody's CMS, and the system actor is recognisable by an
 * authUserId no sign-in can produce. Is their membership still active — read
 * again from the database rather than taken from the context, because the page
 * this came from may be minutes old and access can be revoked in between. And
 * does that membership still carry REVIEW, which is the permission the product
 * already uses for the editor gate.
 *
 * No role is named here. REVIEW is the primitive; who satisfies it is the role
 * table's business.
 */
async function authorizeHuman(context: TenantContext): Promise<ExecutionErrorCode | null> {
  if (context.user.authUserId === SYSTEM_AUTH_USER_ID) return "forbidden";

  const membership = await prisma.organizationMembership.findFirst({
    where: {
      userId: context.user.id,
      organizationId: context.organization.id,
      status: "ACTIVE",
    },
    select: { role: true },
  });

  if (!membership) return "forbidden";
  if (!hasRole(membership.role, REQUIRED.REVIEW)) return "forbidden";

  return null;
}

/** The work item, if it is this tenant's. Absent rather than forbidden. */
async function workItemFor(context: TenantContext, workItemId: string) {
  return prisma.contentWorkItem.findFirst({
    where: { id: workItemId, ...websiteScope(context) },
    select: { id: true },
  });
}

/** Turns an execution's own state into the outcome a person sees. */
function outcomeOfExisting(execution: Execution): CmsDraftActionResult {
  if (execution.status === "VERIFIED") {
    return result("VERIFIED", execution);
  }
  return result(
    "ALREADY_CREATED",
    execution,
    execution.errorCode && isExecutionCode(execution.errorCode) ? execution.errorCode : null,
  );
}

function isExecutionCode(value: string): value is ExecutionErrorCode {
  return value in EXECUTION_ERROR_MESSAGES;
}

/** Maps what M6.2 did into what a person is now in a position to do. */
function outcomeOfExecute(executed: ExecuteResult): CmsDraftActionResult {
  const execution = executed.execution;
  const code =
    execution.errorCode && isExecutionCode(execution.errorCode) ? execution.errorCode : null;

  if (executed.verified) return result("VERIFIED", execution, null, null, executed.verifications);

  if (execution.externalEntityId !== null) {
    // A draft exists. Whatever else is true, nothing may create a second one.
    return result("CREATED_VERIFICATION_FAILED", execution, code, null, executed.verifications);
  }

  if (code && isRetrySafeFailure(code)) {
    return result("RETRY_SAFE_FAILURE", execution, code);
  }

  return result("AMBIGUOUS_RECONCILIATION_REQUIRED", execution, code);
}

/**
 * Create the WordPress draft a person has approved.
 *
 * The order matters. Authorization, then the explicit confirmation, then the
 * situations in which no create may happen at all — a draft that already
 * exists, an attempt still running, an earlier attempt nobody has settled.
 * Only after those does it ask M6.1 to plan and claim an execution, which runs
 * the full preflight again inside its own transaction and refuses on anything
 * that has changed since the screen was drawn. M6.2 then does the one POST.
 *
 * Nothing here approves anything. A CMS approval is a separate act by a person,
 * made earlier; this requires one to exist and be current, and never creates,
 * refreshes or repairs one.
 */
export async function requestCreateWordPressDraft(
  context: TenantContext,
  input: CreateWordPressDraftInput,
  options: CmsDraftActionOptions = {},
): Promise<CmsDraftActionResult> {
  const denied = await authorizeHuman(context);
  if (denied) return refuse(denied);

  // Checked before anything is read about the work, let alone sent.
  if (input.confirmation !== CREATE_WORDPRESS_DRAFT) {
    return refuse("policy_denied");
  }

  const workItem = await workItemFor(context, input.contentWorkItemId);
  if (!workItem) return refuse("not_found");

  // A draft already exists for this work: never a second one, whatever else.
  const existing = await externalDraftFor(context, workItem.id);
  if (existing) return outcomeOfExisting(existing);

  // An attempt whose outcome nobody can state blocks a new one. The next valid
  // move is to reconcile, not to ask again.
  const unresolvedBefore = await unresolvedExecutionFor(context, workItem.id);
  if (unresolvedBefore) {
    const code =
      unresolvedBefore.status === "EXECUTING" && !isUnresolved(unresolvedBefore, options.now?.())
        ? "execution_in_progress"
        : "ambiguous_timeout";
    return result(
      code === "execution_in_progress"
        ? "ALREADY_IN_PROGRESS"
        : "AMBIGUOUS_RECONCILIATION_REQUIRED",
      unresolvedBefore,
      code,
    );
  }

  // M6.1 plans, re-checks everything through its own transaction, and either
  // creates the execution or recognises the one this operation already has.
  let ready: Execution;
  try {
    const requested = await requestCmsDraftExecution(context, workItem.id, {
      targetEntityType: input.targetEntityType,
    });
    ready = requested.execution;
  } catch (error) {
    if (error instanceof ExecutionServiceError) {
      if (error.code === "execution_in_progress")
        return result("ALREADY_IN_PROGRESS", null, error.code);
      if (error.code === "ambiguous_timeout") {
        return result("AMBIGUOUS_RECONCILIATION_REQUIRED", null, error.code);
      }
      if (error.code === "already_executed") return result("ALREADY_CREATED", null, error.code);
      return refuse(error.code);
    }
    throw error;
  }

  // Reused an execution that has already been carried out: nothing to send.
  if (ready.externalEntityId !== null) return outcomeOfExisting(ready);

  try {
    return outcomeOfExecute(await executeCmsDraft(context, ready.id, options));
  } catch (error) {
    if (error instanceof CmsExecutionError) {
      if (error.code === "execution_in_progress")
        return result("ALREADY_IN_PROGRESS", ready, error.code);
      if (error.code === "already_executed") return result("ALREADY_CREATED", ready, error.code);
      return refuse(error.code, ready);
    }
    throw error;
  }
}

/**
 * Go and look for a draft an interrupted attempt may have created.
 *
 * This is the only way out of an unresolved attempt, and it is a person's
 * decision. It reads: it searches the CMS within the window around the attempt
 * and compares candidates against the whole approved revision. Exactly one
 * complete match is attached and then read back independently before anything
 * is called verified; anything else stays unresolved, because attaching the
 * closest match would bind this work to whatever draft happened to look most
 * like it.
 *
 * A search that completes and finds nothing is the one result that makes
 * another attempt safe. Even then nothing is re-sent: a person has to ask.
 */
export async function requestReconcileWordPressDraft(
  context: TenantContext,
  input: RecoverWordPressDraftInput,
  options: CmsDraftActionOptions = {},
): Promise<CmsDraftActionResult> {
  const denied = await authorizeHuman(context);
  if (denied) return refuse(denied);

  const workItem = await workItemFor(context, input.contentWorkItemId);
  if (!workItem) return refuse("not_found");

  const unresolved = await unresolvedExecutionFor(context, workItem.id);
  if (!unresolved) return refuse("not_found");

  // An attempt that is genuinely still running is left alone: its own process
  // is about to record what happened.
  if (!isUnresolved(unresolved, options.now?.())) {
    return result("ALREADY_IN_PROGRESS", unresolved, "execution_in_progress");
  }

  let reconciled;
  try {
    reconciled = await reconcileCmsDraft(context, unresolved.id, options);
  } catch (error) {
    if (error instanceof CmsExecutionError) return refuse(error.code, unresolved);
    if (error instanceof ExecutionServiceError) return refuse(error.code, unresolved);
    throw error;
  }

  if (reconciled.outcome === "AMBIGUOUS") {
    // More than one plausible draft. Attaching the closest would bind this
    // work to whichever one happened to look most like it.
    return result("AMBIGUOUS_RECONCILIATION_REQUIRED", unresolved, "ambiguous_timeout");
  }

  if (reconciled.outcome === "SEARCH_FAILED") {
    // We could not ask. The attempt is exactly as unresolved as before, and
    // nothing has become safe to retry.
    return result("AMBIGUOUS_RECONCILIATION_REQUIRED", unresolved, reconciled.code);
  }

  if (reconciled.outcome === "ABSENT") {
    const settled = await prisma.execution.findFirst({
      where: { id: unresolved.id, ...websiteScope(context) },
    });
    return result("RETRY_SAFE_FAILURE", settled ?? unresolved, "reconciled_absent");
  }

  await recordReconciliation(context, reconciled.execution);

  // Attached, which says the draft exists — not that it is right. The read-back
  // is what decides that, and it is a separate call to the CMS.
  try {
    return outcomeOfExecute(await reverifyCmsDraft(context, reconciled.execution.id, options));
  } catch (error) {
    if (error instanceof CmsExecutionError) {
      return result("CREATED_VERIFICATION_FAILED", reconciled.execution, error.code);
    }
    throw error;
  }
}

/**
 * Ask WordPress what the draft says now.
 *
 * A GET and a comparison. If somebody has edited the draft in WordPress the
 * answer is a recorded mismatch: SEO OS does not overwrite the CMS, does not
 * rewrite its own approved revision, and does not quietly accept the new words
 * as though they had been approved. The approved revision remains the evidence
 * of what was authorized, and the mismatch is the fact.
 */
export async function requestReverifyWordPressDraft(
  context: TenantContext,
  input: RecoverWordPressDraftInput,
  options: CmsDraftActionOptions = {},
): Promise<CmsDraftActionResult> {
  const denied = await authorizeHuman(context);
  if (denied) return refuse(denied);

  const workItem = await workItemFor(context, input.contentWorkItemId);
  if (!workItem) return refuse("not_found");

  const created = await externalDraftFor(context, workItem.id);
  if (!created) return refuse("not_found");

  try {
    return outcomeOfExecute(await reverifyCmsDraft(context, created.id, options));
  } catch (error) {
    if (error instanceof CmsExecutionError) return refuse(error.code, created);
    throw error;
  }
}

/** The reconciliation itself, on the trail, with ids and no content. */
async function recordReconciliation(context: TenantContext, execution: Execution): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, context, {
      entityType: "Execution",
      entityId: execution.id,
      action: "EXECUTE",
      after: {
        operation: "reconcile",
        externalEntityId: execution.externalEntityId,
        externalStatus: execution.externalStatus,
        targetEntityType: execution.targetEntityType,
      },
    });
  });
}
