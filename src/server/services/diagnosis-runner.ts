import type { TenantContext } from "@/server/auth/guards";
import { getJobQueue } from "@/server/jobs/client";
import { JOB_NAMES, type Queue } from "@/server/jobs/queue";
import {
  createDiagnosisRequest,
  failDiagnosisRequest,
  requestPageDiagnosis,
  type DiagnosisOutcome,
  type RequestPageDiagnosisInput,
} from "@/server/services/diagnosis";
import type { DiagnosisRequest } from "@/generated/prisma/client";

/**
 * Where a diagnosis runs (docs/P1_SPEC.md section 23, docs/P3_SPEC.md section 14).
 *
 *   inline   in the web request that asked for it. The default: it needs no
 *            second process, and a laptop running `npm run dev` has none.
 *   queue    handed to the worker. The request row is created here, the
 *            worker does the rest, and the screen follows the row's status.
 *
 * An explicit setting rather than a guess. Detecting "is a worker alive" from
 * the web side is unreliable, and a diagnosis that silently ran in the wrong
 * place is harder to explain than one that failed with a sentence.
 */

export type DiagnosisRunner = "inline" | "queue";

export function resolveDiagnosisRunner(
  value: string | undefined = process.env.DIAGNOSIS_RUNNER,
): DiagnosisRunner {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized === "inline") return "inline";
  if (normalized === "queue") return "queue";

  throw new Error(`DIAGNOSIS_RUNNER must be "inline" or "queue" (got "${value}").`);
}

export type SubmitOutcome = {
  runner: DiagnosisRunner;
  request: DiagnosisRequest;
  /** Present when the diagnosis ran here; absent while a worker has it. */
  outcome?: DiagnosisOutcome;
};

/**
 * Asks for a diagnosis, wherever it is going to run.
 *
 * On the queue path, a queue that cannot take the job closes the request as
 * FAILED with a plain reason. The alternative - quietly running inline after
 * all - would hide a worker that is down behind a result that took a minute.
 */
export async function submitPageDiagnosis(
  context: TenantContext,
  input: RequestPageDiagnosisInput,
  options: { runner?: DiagnosisRunner; queue?: Pick<Queue, "enqueue"> } = {},
): Promise<SubmitOutcome> {
  const runner = options.runner ?? resolveDiagnosisRunner();

  if (runner === "inline") {
    const outcome = await requestPageDiagnosis(context, input);
    return { runner, request: outcome.request, outcome };
  }

  const request = await createDiagnosisRequest(context, input);
  const queue = options.queue ?? getJobQueue();

  try {
    await queue.enqueue(
      JOB_NAMES.DIAGNOSIS_RUN,
      { websiteId: context.website.id, requestId: request.id },
      { singletonKey: request.id },
    );
  } catch (error) {
    // Logged with what an operator needs and nothing the queue's own error
    // might carry: the message is ours, the ids are not secrets.
    console.error(
      JSON.stringify({
        at: "diagnosis.submit",
        event: "enqueue-failed",
        requestId: request.id,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );

    const failed = await failDiagnosisRequest(
      context,
      request.id,
      "queue_unavailable",
      "The diagnosis could not be queued. The worker service may not be running.",
    );

    return {
      runner,
      request: failed,
      outcome: {
        ok: false,
        request: failed,
        error: { code: "queue_unavailable", message: failed.errorSummary ?? "" },
      },
    };
  }

  return { runner, request };
}
