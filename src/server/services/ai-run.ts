import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { resolveProvider } from "@/server/ai/registry";
import { activeTemplate } from "@/server/services/prompt-template";
import type { AiError, AiUsage, GenerateStructuredRequest } from "@/lib/ai/provider";
import { Prisma } from "@/generated/prisma/client";
import type { AgentType, AiRun, AiTaskType } from "@/generated/prisma/client";
import type { z } from "zod";

/**
 * AiRunService (docs/P3_SPEC.md §7, §38).
 *
 * Every call to a model is recorded, and the recording is not the caller's
 * responsibility. `runAgent` below is the only sanctioned way to reach a
 * provider from domain code: it opens the run, calls the model, and closes the
 * run on every path including the ones that throw. A caller cannot forget,
 * because there is no version of this that does not write the row.
 *
 * That matters more here than in most audit trails. A diagnosis is an opinion the
 * product will put in front of someone who then does work because of it. "Which
 * model said this, under which prompt version, over which evidence, and what did
 * it cost" is the difference between an explicable claim and an anonymous one.
 *
 * What a run never holds: the prompt inputs, the evidence text, the model's prose,
 * or anything from a provider's error body. The run points at the prompt template
 * and the evidence package, both of which are stored and re-readable. Copying the
 * inputs in would duplicate the evidence into a table with different retention,
 * and provider error text echoes the request.
 */

/**
 * Token cost, when we have been told the prices.
 *
 * Deliberately not hardcoded. Model pricing is an external fact that changes
 * without notice, and a stale constant here would produce a confident wrong
 * number on a screen that looks like accounting. Unset means null, which the UI
 * renders as "not calculated" rather than as zero.
 */
function estimateCost(usage: AiUsage): Prisma.Decimal | null {
  // Parsed rather than coerced: Number("") is 0, not NaN, so a plain Number()
  // would turn an unset price into a cost of exactly zero — the confident wrong
  // number this function exists to avoid.
  const inputPerMillion = price(process.env.AI_COST_PER_MTOK_INPUT);
  const outputPerMillion = price(process.env.AI_COST_PER_MTOK_OUTPUT);

  if (inputPerMillion === null || outputPerMillion === null) return null;

  if (usage.inputTokens === null && usage.outputTokens === null) return null;

  const total =
    ((usage.inputTokens ?? 0) * inputPerMillion + (usage.outputTokens ?? 0) * outputPerMillion) /
    1_000_000;

  return new Prisma.Decimal(total.toFixed(6));
}

/** A configured price per million tokens, or null when none is set. */
function price(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export type RunAgentInput<T> = {
  agentType: AgentType;
  taskType: AiTaskType;
  /** The evidence package this run reasons over, if it has one. */
  evidencePackageId?: string;
  /** Everything but `system`, which comes from the active prompt template. */
  request: Omit<GenerateStructuredRequest<T>, "system" | "outputSchemaVersion">;
};

export type RunAgentResult<T> =
  { ok: true; run: AiRun; value: T } | { ok: false; run: AiRun; error: AiError };

/**
 * Runs an agent and records what happened.
 *
 * The system instructions come from the active PromptTemplate rather than from
 * the caller. A caller that could pass its own system prompt would be a caller
 * that could bypass the versioning the whole registry exists for.
 */
export async function runAgent<T>(
  context: TenantContext,
  input: RunAgentInput<T>,
): Promise<RunAgentResult<T>> {
  const template = await activeTemplate(input.agentType, input.taskType);
  const provider = resolveProvider();

  // AI_RUN_STARTED (section 35). Written with the row, in one transaction, so a
  // run that exists is a run the audit trail knows began - a process that dies
  // mid-call leaves a RUNNING row and a start event, never one without the other.
  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.aiRun.create({
      data: {
        organizationId: context.organization.id,
        workspaceId: context.workspace.id,
        websiteId: context.website.id,
        agentType: input.agentType,
        taskType: input.taskType,
        provider: provider.name,
        model: provider.model,
        promptTemplateId: template.id,
        promptTemplateVersion: template.version,
        outputSchemaVersion: template.outputSchemaVersion,
        evidencePackageId: input.evidencePackageId,
        status: "RUNNING",
        startedAt: new Date(),
        createdByUserId: context.user.id,
      },
    });

    await recordAudit(tx, context, {
      entityType: "AiRun",
      entityId: created.id,
      action: "CREATE",
      after: {
        status: "RUNNING",
        agentType: created.agentType,
        taskType: created.taskType,
        provider: created.provider,
        model: created.model,
        promptTemplateVersion: created.promptTemplateVersion,
        evidencePackageId: created.evidencePackageId,
      },
    });

    return created;
  });

  const schema = input.request.schema as z.ZodType<T>;

  let result: Awaited<ReturnType<typeof provider.generateStructured<T>>>;

  try {
    result = await provider.generateStructured<T>({
      ...input.request,
      schema,
      system: template.systemInstructions,
      outputSchemaVersion: template.outputSchemaVersion,
    });
  } catch {
    // A provider is supposed to return errors rather than throw them. If one
    // throws anyway, the run still closes: an AiRun stuck at RUNNING forever is
    // indistinguishable from one that is still going.
    const failed = await closeRun(context, run.id, {
      status: "FAILED",
      usage: { inputTokens: null, outputTokens: null },
      errorCode: "provider_error",
      errorSummary: "The AI provider failed unexpectedly.",
    });

    return {
      ok: false,
      run: failed,
      error: {
        code: "provider_error",
        message: "The AI provider failed unexpectedly.",
        retryable: true,
      },
    };
  }

  if (!result.ok) {
    const failed = await closeRun(context, run.id, {
      status: "FAILED",
      usage: result.usage,
      errorCode: result.error.code,
      // Our message, from the fixed table. Never the provider's.
      errorSummary: result.error.message,
    });

    return { ok: false, run: failed, error: result.error };
  }

  const succeeded = await closeRun(context, run.id, {
    status: "SUCCEEDED",
    usage: result.usage,
  });

  return { ok: true, run: succeeded, value: result.value };
}

async function closeRun(
  context: TenantContext,
  runId: string,
  input: {
    status: "SUCCEEDED" | "FAILED" | "CANCELLED";
    usage: AiUsage;
    errorCode?: string;
    errorSummary?: string;
  },
): Promise<AiRun> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.aiRun.update({
      where: { id: runId },
      data: {
        status: input.status,
        finishedAt: new Date(),
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        estimatedCost: estimateCost(input.usage),
        errorCode: input.errorCode,
        errorSummary: input.errorSummary,
      },
    });

    await recordAudit(tx, context, {
      entityType: "AiRun",
      entityId: run.id,
      action: "COMPLETE",
      after: {
        status: run.status,
        provider: run.provider,
        model: run.model,
        promptTemplateVersion: run.promptTemplateVersion,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        errorCode: run.errorCode,
      },
    });

    return run;
  });
}

/** Marks a run cancelled. Used when a request is abandoned before it finishes. */
export async function cancelRun(context: TenantContext, runId: string): Promise<AiRun | null> {
  const existing = await prisma.aiRun.findFirst({
    where: { id: runId, ...websiteScope(context), status: { in: ["QUEUED", "RUNNING"] } },
  });

  if (!existing) return null;

  return closeRun(context, existing.id, {
    status: "CANCELLED",
    usage: { inputTokens: existing.inputTokens, outputTokens: existing.outputTokens },
  });
}

export async function listRuns(context: TenantContext, limit = 50): Promise<AiRun[]> {
  return prisma.aiRun.findMany({
    where: websiteScope(context),
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getRun(context: TenantContext, runId: string): Promise<AiRun | null> {
  return prisma.aiRun.findFirst({ where: { id: runId, ...websiteScope(context) } });
}

export type RunTotals = {
  runs: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when no pricing is configured, never zero. */
  estimatedCost: string | null;
};

/** Usage for this website. Shown on the Command Center so cost is not invisible. */
export async function runTotals(context: TenantContext): Promise<RunTotals> {
  const runs = await prisma.aiRun.findMany({
    where: websiteScope(context),
    select: {
      status: true,
      inputTokens: true,
      outputTokens: true,
      estimatedCost: true,
    },
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let cost: Prisma.Decimal | null = null;

  for (const run of runs) {
    inputTokens += run.inputTokens ?? 0;
    outputTokens += run.outputTokens ?? 0;

    if (run.estimatedCost !== null) {
      cost = (cost ?? new Prisma.Decimal(0)).add(run.estimatedCost);
    }
  }

  return {
    runs: runs.length,
    succeeded: runs.filter((run) => run.status === "SUCCEEDED").length,
    failed: runs.filter((run) => run.status === "FAILED").length,
    inputTokens,
    outputTokens,
    estimatedCost: cost === null ? null : cost.toFixed(4),
  };
}
