import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { revisionHash } from "@/lib/execution/hash";
import { renderMarkdown } from "@/lib/content/markdown";
import { compareContent, compareText } from "@/lib/cms/content";
import {
  EXECUTION_ERROR_MESSAGES,
  isRetrySafeFailure,
  type ExecutionErrorCode,
} from "@/lib/execution/errors";
import { EXECUTION_TRANSITIONS, canTransition } from "@/lib/execution/statuses";
import { buildProviderContext, loadWordPressConnection } from "@/server/services/cms-connection";
import {
  CmsProviderError,
  type CmsEntity,
  type CmsProvider,
  type CmsTransport,
  type CreateDraftInput,
  type ProviderContext,
} from "@/server/connectors/wordpress/types";
import { Prisma } from "@/generated/prisma/client";
import type {
  Execution,
  ExecutionStatus,
  ExecutionVerificationStatus,
  VerificationType,
} from "@/generated/prisma/client";

/**
 * Carrying out a CREATE_CMS_DRAFT execution that M6.1 already authorized.
 *
 * M6.1 decided whether this may happen and wrote the record. This does it, and
 * its whole design is about the gap between "we asked" and "we know what
 * happened", because that gap is where a duplicate draft comes from.
 *
 * Three transactions with the provider calls between them, never inside:
 *
 *   1. re-check eligibility, move READY to EXECUTING, commit
 *   2. create the draft
 *   3. persist what was created, commit
 *   4. read it back
 *   5. write the verification rows and the final status, commit
 *
 * A crash anywhere after (1) leaves an execution sitting in EXECUTING, which
 * M6.1 already treats as unresolved and refuses to create a second draft for.
 * That is the intended resting place for an interrupted attempt: visible,
 * blocking, and waiting for a person.
 *
 * The create call is never retried. Not here, not in the transport, not by any
 * wrapper. Where the outcome is unknown the execution says so and stops.
 */

/**
 * The code behind a refusal, whichever layer refused.
 *
 * The connection layer answers with a CmsProviderError and this one with a
 * CmsExecutionError; both carry a code from the same table, and it is the code
 * a person reads. Anything else is genuinely unexpected and is recorded as an
 * answer we could not make sense of.
 */
function refusalCode(error: unknown): ExecutionErrorCode {
  if (error instanceof CmsExecutionError) return error.code;
  if (error instanceof CmsProviderError) return error.code;
  return "cms_invalid_response";
}

export class CmsExecutionError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    message: string = EXECUTION_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "CmsExecutionError";
  }
}

export type ExecuteResult = {
  execution: Execution;
  /** VERIFIED when every required check passed. */
  verified: boolean;
  verifications: { type: VerificationType; status: ExecutionVerificationStatus }[];
};

export type ExecuteOptions = {
  /** Injected in tests. Production builds one from the validated base URL. */
  transport?: CmsTransport;
  resolve?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
};

/** What is sent, derived only from the revision the approval pinned. */
async function buildPayload(
  context: TenantContext,
  execution: Execution,
): Promise<CreateDraftInput> {
  const revision = await prisma.contentRevision.findFirst({
    where: { id: execution.contentRevisionId, ...websiteScope(context) },
  });
  if (!revision) throw new CmsExecutionError("content_mismatch");

  // Recomputed, not trusted. The hash on the execution is what a person
  // approved; if the words no longer produce it, nothing is sent.
  const recomputed = revisionHash({
    title: revision.title,
    slug: revision.slug,
    excerpt: revision.excerpt,
    bodyMarkdown: revision.bodyMarkdown,
    metaTitle: revision.metaTitle,
    metaDescription: revision.metaDescription,
    schemaJson: revision.schemaJson,
  });
  if (recomputed !== execution.revisionHash) throw new CmsExecutionError("content_mismatch");

  if (execution.targetEntityType === null) throw new CmsExecutionError("target_invalid");

  return {
    entityType: execution.targetEntityType,
    title: revision.title,
    slug: revision.slug,
    // The one deterministic conversion, already used for previews. No model is
    // asked anything: the CMS receives the approved words, rendered.
    contentHtml: renderMarkdown(revision.bodyMarkdown),
    excerpt: revision.excerpt,
  };
}

/**
 * What a provider call needs to be true before it is made.
 *
 * "create" is the full gate: a policy that permits drafts, and the exact
 * CREATE_DRAFT capability for the exact kind of thing about to be created.
 * "read" is what reconciliation and re-verification need — READ_CONTENT, and
 * no policy gate, because reading a draft back is not writing to a CMS. A site
 * switched to read-only can still be asked what it holds.
 */
type ProviderNeed = "create" | "read";

/** The connection, checked again, and the provider it selects. */
async function resolveProvider(
  context: TenantContext,
  execution: Execution,
  options: ExecuteOptions,
  need: ProviderNeed = "create",
): Promise<{ provider: CmsProvider; providerContext: ProviderContext; simulated: boolean }> {
  // Provider, status, base URL and credential shape are the connection's own
  // business and are checked there. What is left here is what this execution
  // needs to be true: the policy it will run under, and the exact capability
  // for the exact kind of thing it is about to create.
  const { connection, site } = await loadWordPressConnection(context, execution.connectionId);

  if (execution.targetEntityType === null) throw new CmsExecutionError("target_invalid");

  if (need === "create") {
    const policy = await prisma.publishingPolicy.findFirst({
      where: { websiteId: context.website.id, connectionId: connection.id },
    });
    if (!policy) throw new CmsExecutionError("not_configured");
    if (policy.mode === "READ_ONLY" || policy.mode === "FULL_PUBLISH") {
      throw new CmsExecutionError("policy_denied");
    }
  }

  // Asked of the connection as it is now, never inferred from the fact that an
  // earlier attempt succeeded.
  const capability = await prisma.connectionCapability.findFirst({
    where: {
      connectionId: connection.id,
      websiteId: context.website.id,
      capability: need === "create" ? "CREATE_DRAFT" : "READ_CONTENT",
      entityType: need === "create" ? execution.targetEntityType : null,
    },
  });
  if (!capability?.granted) throw new CmsExecutionError("capability_missing");

  return buildProviderContext(context, connection, site, options);
}

/**
 * Moves an execution, refusing a move the state machine does not have.
 *
 * The table in lib/execution/statuses is the machine; this is the only place
 * in M6.2 that writes an execution's status, so a transition nobody wrote
 * down cannot be introduced by a later edit here. Verification therefore goes
 * SUCCEEDED to VERIFYING to VERIFIED rather than jumping, which is also the
 * honest sequence: the checks ran, and then they passed.
 */
async function moveExecution(
  tx: Prisma.TransactionClient,
  execution: Execution,
  to: ExecutionStatus,
  data: Prisma.ExecutionUpdateInput = {},
): Promise<Execution> {
  if (execution.status !== to && !canTransition(EXECUTION_TRANSITIONS, execution.status, to)) {
    throw new CmsExecutionError("already_executed");
  }
  return tx.execution.update({ where: { id: execution.id }, data: { ...data, status: to } });
}

async function appendStep(
  execution: Execution,
  stepType: "CREATE_DRAFT" | "VERIFY_STATE" | "RECONCILE",
  status: "SUCCEEDED" | "FAILED" | "SKIPPED",
  startedAt: Date,
  summary: Prisma.InputJsonObject,
  errorCode?: ExecutionErrorCode,
): Promise<void> {
  await prisma.executionStep.create({
    data: {
      websiteId: execution.websiteId,
      executionId: execution.id,
      attempt: execution.attempt,
      stepType,
      status,
      // Codes, ids, statuses and counts. Never a body, a credential, a header
      // or a provider payload.
      requestSummaryJson: summary,
      startedAt,
      finishedAt: new Date(),
      errorCode: errorCode ?? null,
      errorSummary: errorCode ? EXECUTION_ERROR_MESSAGES[errorCode] : null,
    },
  });
}

/**
 * Runs one authorized execution.
 *
 * The execution must already be READY and must already carry everything M6.1
 * pinned. Nothing here re-runs QA, mints an approval, or creates a second
 * execution: those decisions were made, and this either carries them out or
 * records why it could not.
 */
export async function executeCmsDraft(
  context: TenantContext,
  executionId: string,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const now = options.now ?? (() => new Date());

  // --- 1. Claim it, in a transaction that ends before any provider call -----
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM execution WHERE id = ${executionId}::uuid FOR UPDATE`;

    const execution = await tx.execution.findFirst({
      where: { id: executionId, ...websiteScope(context) },
    });
    if (!execution) throw new CmsExecutionError("not_found");
    if (execution.executionType !== "CREATE_CMS_DRAFT")
      throw new CmsExecutionError("target_invalid");
    if (execution.externalEntityId !== null) throw new CmsExecutionError("already_executed");
    if (execution.status !== "READY") {
      throw new CmsExecutionError(
        execution.status === "EXECUTING" ? "execution_in_progress" : "already_executed",
      );
    }

    return tx.execution.update({
      where: { id: execution.id },
      data: {
        status: "EXECUTING",
        startedAt: now(),
        attempt: { increment: 1 },
        // The person this ran for. Recorded here so every path that executes
        // answers "who" without the caller having to remember to say.
        executedByUserId: context.user.id,
      },
    });
  });

  const startedAt = now();

  // --- everything below runs with no transaction open -----------------------
  let payload: CreateDraftInput;
  let provider: CmsProvider;
  let providerContext: ProviderContext;
  let simulated: boolean;

  try {
    payload = await buildPayload(context, claimed);
    ({ provider, providerContext, simulated } = await resolveProvider(context, claimed, options));
  } catch (error) {
    // Nothing was sent: these all fail before a provider exists. Both error
    // classes speak the same vocabulary, and the code is the point.
    return failBeforeSend(claimed, refusalCode(error), startedAt);
  }

  // --- 2. Create. One attempt, never repeated. ------------------------------
  let created: CmsEntity;
  try {
    created = await provider.createDraft(providerContext, payload);
  } catch (error) {
    const providerError =
      error instanceof CmsProviderError
        ? error
        : new CmsProviderError("cms_invalid_response", true);

    await appendStep(
      claimed,
      "CREATE_DRAFT",
      "FAILED",
      startedAt,
      {
        provider: provider.name,
        simulated,
        targetEntityType: payload.entityType,
        httpStatus: providerError.httpStatus,
        ambiguous: providerError.ambiguous,
      },
      providerError.code,
    );

    // Ambiguous means WordPress may hold a draft nobody can see. The execution
    // stays FAILED with a code M6.1 refuses to call retry-safe, so no second
    // create can be requested until a person or a reconciliation settles it.
    const code = providerError.ambiguous ? "create_ambiguous" : providerError.code;
    return finishFailed(context, claimed, code);
  }

  // --- 3. Persist what exists now, before anything else can go wrong --------
  let recorded: Execution;
  try {
    recorded = await prisma.$transaction(async (tx) => {
      const updated = await tx.execution.update({
        where: { id: claimed.id },
        data: {
          externalEntityId: created.externalId,
          externalStatus: created.status,
          externalUrl: created.url,
          status: "SUCCEEDED",
          completedAt: now(),
        },
      });
      await recordAudit(tx, context, {
        entityType: "Execution",
        entityId: claimed.id,
        action: "COMPLETE",
        after: {
          provider: provider.name,
          simulated,
          targetEntityType: payload.entityType,
          externalEntityId: created.externalId,
          externalStatus: created.status,
          seoMetadata: "not_written",
        },
      });
      return updated;
    });
  } catch {
    // The draft exists and we could not write that down. Retrying the create
    // would make a second one, so this is reconciliation's problem now.
    await appendStep(
      claimed,
      "CREATE_DRAFT",
      "FAILED",
      startedAt,
      {
        provider: provider.name,
        simulated,
        persisted: false,
      },
      "create_ambiguous",
    );
    return finishFailed(context, claimed, "create_ambiguous");
  }

  await appendStep(recorded, "CREATE_DRAFT", "SUCCEEDED", startedAt, {
    provider: provider.name,
    simulated,
    targetEntityType: payload.entityType,
    externalEntityId: created.externalId,
    externalStatus: created.status,
    // Said plainly on the record: WordPress core has no field for these, and
    // nothing was written to a plugin's.
    seoMetadata: "not_written",
  });

  // --- 4. Read it back, independently of what the create call claimed -------
  const verifyStarted = now();
  let observed: CmsEntity;
  try {
    observed = await provider.getEntity(providerContext, payload.entityType, created.externalId);
  } catch (error) {
    const code = error instanceof CmsProviderError ? error.code : "cms_invalid_response";
    await appendStep(
      recorded,
      "VERIFY_STATE",
      "FAILED",
      verifyStarted,
      {
        provider: provider.name,
        externalEntityId: created.externalId,
      },
      code,
    );
    // The id is kept. The draft exists; we simply cannot say what it holds.
    return finishUnverified(context, recorded, code);
  }

  // --- 5. Verify, and record every check ------------------------------------
  return finishVerification(context, recorded, payload, observed, verifyStarted, provider.name);
}

/** A failure with no provider call made at all. */
async function failBeforeSend(
  execution: Execution,
  code: ExecutionErrorCode,
  startedAt: Date,
): Promise<ExecuteResult> {
  await appendStep(execution, "CREATE_DRAFT", "SKIPPED", startedAt, { sent: false }, code);
  const updated = await prisma.$transaction((tx) =>
    moveExecution(tx, execution, "FAILED", {
      errorCode: code,
      errorSummary: EXECUTION_ERROR_MESSAGES[code],
    }),
  );
  return { execution: updated, verified: false, verifications: [] };
}

async function finishFailed(
  context: TenantContext,
  execution: Execution,
  code: ExecutionErrorCode,
): Promise<ExecuteResult> {
  const updated = await prisma.$transaction(async (tx) => {
    const row = await moveExecution(tx, execution, "FAILED", {
      errorCode: code,
      errorSummary: EXECUTION_ERROR_MESSAGES[code],
    });
    await recordAudit(tx, context, {
      entityType: "Execution",
      entityId: execution.id,
      action: "UPDATE",
      after: { outcome: "FAILED", code, retrySafe: isRetrySafeFailure(code) },
    });
    return row;
  });
  return { execution: updated, verified: false, verifications: [] };
}

/** Created, but nothing could be checked. The id stays; the status does not become VERIFIED. */
async function finishUnverified(
  context: TenantContext,
  execution: Execution,
  code: ExecutionErrorCode,
): Promise<ExecuteResult> {
  const updated = await prisma.$transaction(async (tx) => {
    const row = await moveExecution(tx, execution, "VERIFYING", {
      errorCode: code,
      errorSummary: EXECUTION_ERROR_MESSAGES[code],
    });
    await recordAudit(tx, context, {
      entityType: "Execution",
      entityId: execution.id,
      action: "VERIFY",
      after: { outcome: "UNVERIFIED", code },
    });
    return row;
  });
  return { execution: updated, verified: false, verifications: [] };
}

/** Required checks decide VERIFIED. The slug is recorded and never decides it. */
async function finishVerification(
  context: TenantContext,
  execution: Execution,
  payload: CreateDraftInput,
  observed: CmsEntity,
  startedAt: Date,
  providerName: string,
): Promise<ExecuteResult> {
  const content = compareContent(payload.contentHtml, observed.content);
  const excerptSent = payload.excerpt !== null && payload.excerpt.length > 0;

  const checks: {
    type: VerificationType;
    required: boolean;
    passed: boolean;
    expected: unknown;
    observedValue: unknown;
  }[] = [
    {
      type: "CMS_STATUS_DRAFT",
      required: true,
      passed: observed.status === "draft",
      expected: "draft",
      observedValue: observed.status,
    },
    {
      type: "TITLE_MATCH",
      required: true,
      passed: compareText(payload.title, observed.title),
      expected: { normalized: true },
      observedValue: { matched: compareText(payload.title, observed.title) },
    },
    {
      type: "CONTENT_PRESENT",
      required: true,
      passed: content.matches,
      // Fingerprints and a difference kind, never the content itself.
      expected: { fingerprint: content.expectedFingerprint },
      observedValue: {
        fingerprint: content.observedFingerprint,
        difference: content.difference,
      },
    },
    {
      type: "SLUG_MATCH",
      // WordPress legitimately rewrites a slug for uniqueness, so a difference
      // is worth recording and is not a reason to refuse the draft.
      required: false,
      passed: payload.slug === null || payload.slug === observed.slug,
      expected: payload.slug,
      observedValue: observed.slug,
    },
  ];

  if (excerptSent) {
    checks.push({
      type: "EXCERPT_MATCH",
      required: true,
      passed: compareText(payload.excerpt, observed.excerpt),
      expected: { sent: true },
      observedValue: { matched: compareText(payload.excerpt, observed.excerpt) },
    });
  }

  const verified = checks.every((check) => !check.required || check.passed);

  const updated = await prisma.$transaction(async (tx) => {
    for (const check of checks) {
      await tx.executionVerification.create({
        data: {
          websiteId: execution.websiteId,
          executionId: execution.id,
          attempt: execution.attempt,
          verificationType: check.type,
          status: check.passed ? "PASS" : "FAIL",
          expectedValueJson: check.expected as never,
          observedValueJson: check.observedValue as never,
          verifiedAt: new Date(),
          errorSummary: check.passed
            ? null
            : check.required
              ? "The CMS draft does not match the approved revision."
              : "WordPress used a different slug from the one requested.",
        },
      });
    }

    // The checks ran, so the execution is VERIFYING whatever they found.
    const verifying = await moveExecution(tx, execution, "VERIFYING", {
      errorCode: verified ? null : "verification_failed",
      errorSummary: verified ? null : EXECUTION_ERROR_MESSAGES.verification_failed,
    });

    // And only then, if every required check passed, VERIFIED. A failure stays
    // at VERIFYING with the reason on the record: the draft exists, its id is
    // kept, and nothing creates another.
    const row = verified
      ? await moveExecution(tx, verifying, "VERIFIED", { verifiedAt: new Date() })
      : verifying;

    await recordAudit(tx, context, {
      entityType: "Execution",
      entityId: execution.id,
      action: "VERIFY",
      after: {
        provider: providerName,
        outcome: verified ? "VERIFIED" : "MISMATCH",
        checks: checks.map((check) => ({
          type: check.type,
          required: check.required,
          passed: check.passed,
        })),
      },
    });

    return row;
  });

  await appendStep(
    execution,
    "VERIFY_STATE",
    verified ? "SUCCEEDED" : "FAILED",
    startedAt,
    {
      provider: providerName,
      externalEntityId: observed.externalId,
      passed: checks.filter((check) => check.passed).length,
      failed: checks.filter((check) => !check.passed).map((check) => check.type),
    },
    verified ? undefined : "verification_failed",
  );

  return {
    execution: updated,
    verified,
    verifications: checks.map((check) => ({
      type: check.type,
      status: (check.passed ? "PASS" : "FAIL") as ExecutionVerificationStatus,
    })),
  };
}

/**
 * How long an EXECUTING execution may sit before it is treated as abandoned.
 *
 * A create is one HTTP call with a 30-second ceiling, so a row still EXECUTING
 * long after that belongs to a process that is gone. Being abandoned is not
 * evidence that nothing was created — it is the reason to go and look.
 */
export const STALE_EXECUTION_MINUTES = 15;

/**
 * Whether an attempt's outcome is genuinely unknown, and so worth searching for.
 *
 * Two shapes qualify. A failure that does not prove the CMS was left untouched,
 * which is what M6.2 records for an ambiguous create. And an EXECUTING row old
 * enough that the process holding it has died: it is never reset to READY and
 * never retried blindly, because a draft may exist that nobody can see.
 */
export function isUnresolved(
  execution: Pick<Execution, "status" | "errorCode" | "startedAt" | "createdAt">,
  now: Date = new Date(),
): boolean {
  if (execution.status === "FAILED") return !isRetrySafeFailure(execution.errorCode);
  if (execution.status !== "EXECUTING") return false;

  const startedAt = execution.startedAt ?? execution.createdAt;
  return now.getTime() - startedAt.getTime() >= STALE_EXECUTION_MINUTES * 60_000;
}

/**
 * Looks at a draft SEO OS already created, and says whether it still matches.
 *
 * Read only, and deliberately so. It sends a GET, compares what comes back
 * against the approved revision, and writes verification rows. It never
 * creates, never updates and never publishes: if somebody has edited the draft
 * in WordPress, the answer is a recorded mismatch, not a correction. The
 * approved revision stays the evidence of what was authorized.
 *
 * Useful when an earlier read-back could not be made, when it found a
 * difference somebody has since dealt with, or simply to ask again.
 */
export async function reverifyCmsDraft(
  context: TenantContext,
  executionId: string,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const execution = await prisma.execution.findFirst({
    where: { id: executionId, ...websiteScope(context) },
  });
  if (!execution) throw new CmsExecutionError("not_found");
  if (execution.executionType !== "CREATE_CMS_DRAFT") {
    throw new CmsExecutionError("target_invalid");
  }
  // Nothing to look at. This is for drafts that exist.
  if (execution.externalEntityId === null || execution.targetEntityType === null) {
    throw new CmsExecutionError("not_found");
  }

  // The approved revision, recomputed and re-checked, is what the CMS is
  // compared against — not whatever it happens to hold now.
  const payload = await buildPayload(context, execution);
  const { provider, providerContext } = await resolveProvider(context, execution, options, "read");

  const startedAt = options.now?.() ?? new Date();
  let observed: CmsEntity;

  try {
    observed = await provider.getEntity(
      providerContext,
      execution.targetEntityType,
      execution.externalEntityId,
    );
  } catch (error) {
    const code = refusalCode(error);
    await appendStep(
      execution,
      "VERIFY_STATE",
      "FAILED",
      startedAt,
      { provider: provider.name, externalEntityId: execution.externalEntityId, reverify: true },
      code,
    );
    // The draft is still there as far as we know; we simply could not read it.
    return finishUnverified(context, execution, code);
  }

  return finishVerification(context, execution, payload, observed, startedAt, provider.name);
}

export type ReconcileResult =
  | { outcome: "ATTACHED"; execution: Execution }
  | { outcome: "AMBIGUOUS"; candidates: number }
  /** The search could not be completed, so it proves nothing either way. */
  | { outcome: "SEARCH_FAILED"; code: ExecutionErrorCode }
  | { outcome: "ABSENT" };

/**
 * Looks for a draft an ambiguous attempt may have created.
 *
 * The foundation only: it searches, it compares, and it attaches when exactly
 * one candidate matches the approved content completely. Everything else stays
 * ambiguous, because a best guess here attaches this website's execution to
 * whatever draft happened to look closest.
 *
 * A search that finds nothing may only be called absent when the search itself
 * succeeded; a failed query proves nothing and leaves the execution as it was.
 */
export async function reconcileCmsDraft(
  context: TenantContext,
  executionId: string,
  options: ExecuteOptions = {},
): Promise<ReconcileResult> {
  const execution = await prisma.execution.findFirst({
    where: { id: executionId, ...websiteScope(context) },
  });
  if (!execution) throw new CmsExecutionError("not_found");
  if (execution.externalEntityId !== null) throw new CmsExecutionError("already_executed");
  // Only an attempt whose outcome could not be observed is reconciled. A READY
  // execution has not been tried, and searching a CMS for a draft nobody sent
  // could attach one somebody else made.
  if (!isUnresolved(execution, options.now?.() ?? new Date())) {
    throw new CmsExecutionError("already_executed");
  }

  const payload = await buildPayload(context, execution);
  const { provider, providerContext } = await resolveProvider(context, execution, options);

  const startedAt = execution.startedAt ?? execution.createdAt;
  const startedSearch = new Date();

  // A search that fails proves nothing. It is not absence, and it is not a
  // match: the attempt stays exactly as unresolved as it was, and nothing
  // becomes retry-safe on the strength of a question we could not ask.
  let candidates;
  try {
    candidates = await provider.reconcileCreate(providerContext, payload, {
      after: new Date(startedAt.getTime() - 60_000),
      before: new Date(startedAt.getTime() + 15 * 60_000),
    });
  } catch (error) {
    const code = refusalCode(error);
    await appendStep(
      execution,
      "RECONCILE",
      "FAILED",
      startedSearch,
      {
        provider: provider.name,
        searched: false,
      },
      code,
    );
    return { outcome: "SEARCH_FAILED", code };
  }

  const strong = candidates.filter(
    (candidate) =>
      candidate.entity.status === "draft" &&
      compareText(payload.title, candidate.entity.title) &&
      compareContent(payload.contentHtml, candidate.entity.content).matches &&
      (payload.excerpt === null || compareText(payload.excerpt, candidate.entity.excerpt)),
  );

  // Exactly one candidate matching the whole approved revision, or nothing is
  // attached. Closest is not a match.
  const resolved = strong.length === 1;

  await appendStep(execution, "RECONCILE", resolved ? "SUCCEEDED" : "FAILED", startedSearch, {
    provider: provider.name,
    candidates: candidates.length,
    strongMatches: strong.length,
  });

  if (resolved) {
    const entity = strong[0]!.entity;
    const updated = await prisma.$transaction(async (tx) => {
      const row = await moveExecution(tx, execution, "SUCCEEDED", {
        externalEntityId: entity.externalId,
        externalStatus: entity.status,
        externalUrl: entity.url,
        errorCode: null,
        errorSummary: null,
      });
      await recordAudit(tx, context, {
        entityType: "Execution",
        entityId: execution.id,
        action: "UPDATE",
        after: {
          provider: provider.name,
          outcome: "RECONCILED",
          externalEntityId: entity.externalId,
          externalStatus: entity.status,
        },
      });
      return row;
    });
    return { outcome: "ATTACHED", execution: updated };
  }

  if (strong.length > 1) return { outcome: "AMBIGUOUS", candidates: strong.length };

  if (candidates.length === 0) {
    // The search ran, completely, and found nothing. Only that proves absence,
    // and only then is another attempt safe. An abandoned EXECUTING row moves
    // to FAILED to say so; one that was already FAILED only gains the code.
    // Nothing is re-sent here: a person has to ask again.
    await prisma.$transaction((tx) =>
      moveExecution(tx, execution, "FAILED", {
        errorCode: "reconciled_absent",
        errorSummary: EXECUTION_ERROR_MESSAGES.reconciled_absent,
      }),
    );
    return { outcome: "ABSENT" };
  }

  return { outcome: "AMBIGUOUS", candidates: candidates.length };
}
