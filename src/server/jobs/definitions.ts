import { z } from "zod";

import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { SitemapError } from "@/server/connectors/sitemap/fetch";
import { detectAndStoreOpportunities } from "@/server/services/opportunity";
import { detectAndStoreSignals } from "@/server/services/signals";
import { listSitemaps, syncSitemap } from "@/server/services/sitemap";
import {
  runAhrefsSync,
  runGa4Sync,
  runGscSync,
  runSemrushSync,
  SyncError,
  type SyncOutcome,
} from "@/server/services/sync";
import type { ConnectionProvider } from "@/generated/prisma/client";

import { JOB_NAMES, type Queue } from "./queue";
import { listSyncableWebsiteIds, SystemContextError, systemContextFor } from "./system-context";

/**
 * What the worker does (docs/P1_SPEC.md section 23).
 *
 * Two jobs. `sync.daily` runs on a cron and enqueues one `website.sync` per
 * active website; `website.sync` pulls everything that website has connected,
 * then re-runs detection so the signals describe the data that was just
 * written. The fan-out exists so that one slow or failing website is one
 * failed job, retried on its own, and not a reason the others were not synced.
 *
 * The handlers call the same services as the "Sync now" buttons. Nothing here
 * reads a provider directly, and nothing here writes a metric: the job runner
 * decides when, the services decide what. Provider failures are recorded in
 * the job's summary and the job carries on to the next step, because "Semrush
 * was down" is not a reason to skip the sitemap. Anything that is not a known
 * provider or domain error is rethrown so pg-boss retries the job and, if it
 * keeps failing, leaves it failed where an operator can see it.
 */

export const websiteSyncPayload = z.object({
  websiteId: z.uuid(),
  /** When the fan-out asked. Informational; the window is computed at run time. */
  requestedAt: z.iso.datetime().optional(),
});

export type WebsiteSyncPayload = z.infer<typeof websiteSyncPayload>;

/** A cron job carries no data; a manual trigger may say who asked. */
export const dailySyncPayload = z
  .object({ reason: z.string().max(200).optional() })
  .nullable()
  .optional();

export type StepStatus = "done" | "reused" | "skipped" | "failed";

export type StepResult = {
  step: string;
  status: StepStatus;
  /** Our own words only: an error code, a run summary, a count. Never provider output. */
  detail?: string;
  written?: number;
};

export type WebsiteSyncSummary = {
  websiteId: string;
  startedAt: string;
  finishedAt: string;
  steps: StepResult[];
  /** True when at least one provider wrote new rows. */
  wroteMetrics: boolean;
};

export type DailySyncSummary = {
  startedAt: string;
  finishedAt: string;
  websites: number;
  enqueued: number;
};

/** 03:00 UTC: after the day has rolled over everywhere the reporting lag matters. */
export const DEFAULT_DAILY_CRON = "0 3 * * *";

const CRON_SHAPE = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/;

/**
 * The daily cron from the environment, or the default. Only the shape is
 * checked here - five fields - and a bad shape fails the worker at start-up,
 * which is where a misconfiguration should fail.
 */
export function resolveDailyCron(value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    return DEFAULT_DAILY_CRON;
  }

  if (!CRON_SHAPE.test(trimmed)) {
    throw new Error(
      `SYNC_DAILY_CRON must be a five-field cron expression (got "${trimmed}"). Example: "0 3 * * *".`,
    );
  }

  return trimmed;
}

/** Errors a step may record and move on from. Anything else is a bug or an outage. */
function isExpected(error: unknown): boolean {
  return (
    error instanceof SyncError ||
    error instanceof SitemapError ||
    error instanceof SystemContextError
  );
}

function describeError(error: unknown): string {
  if (error instanceof SyncError) return `sync:${error.code}`;
  if (error instanceof SitemapError) return `sitemap:${error.code}`;
  if (error instanceof SystemContextError) return `context:${error.code}`;
  return error instanceof Error ? error.name : "unknown";
}

function fromOutcome(step: string, outcome: SyncOutcome): StepResult {
  if (outcome.reused) {
    return { step, status: "reused", detail: `through ${outcome.window.endDate}` };
  }

  if (outcome.status === "FAILED") {
    return { step, status: "failed", detail: outcome.run.errorSummary ?? "sync did not complete" };
  }

  return {
    step,
    status: "done",
    detail: `${outcome.window.startDate} to ${outcome.window.endDate}`,
    written: outcome.written,
  };
}

type ProviderStep = {
  step: string;
  provider: ConnectionProvider;
  run: (context: TenantContext, now: Date) => Promise<SyncOutcome>;
};

const PROVIDER_STEPS: ProviderStep[] = [
  {
    step: "gsc",
    provider: "GOOGLE_SEARCH_CONSOLE",
    run: (context, now) => runGscSync(context, { now }),
  },
  {
    step: "ga4",
    provider: "GOOGLE_ANALYTICS",
    run: (context, now) => runGa4Sync(context, { now }),
  },
  { step: "semrush", provider: "SEMRUSH", run: (context, now) => runSemrushSync(context, { now }) },
  { step: "ahrefs", provider: "AHREFS", run: (context, now) => runAhrefsSync(context, { now }) },
];

async function connectedProviders(context: TenantContext): Promise<Set<ConnectionProvider>> {
  const rows = await prisma.connection.findMany({
    where: { status: "CONNECTED", ...websiteScope(context) },
    select: { provider: true },
  });

  return new Set(rows.map((row) => row.provider));
}

async function hasAnyMetrics(context: TenantContext): Promise<boolean> {
  const [gsc, ga4] = await Promise.all([
    prisma.gscMetricDaily.count({ where: { websiteId: context.website.id }, take: 1 }),
    prisma.ga4LandingPageMetricDaily.count({ where: { websiteId: context.website.id }, take: 1 }),
  ]);

  return gsc > 0 || ga4 > 0;
}

/**
 * Runs one step, recording an expected failure and rethrowing anything else.
 * The summary so far is logged before rethrowing, so a retry does not erase
 * what the first attempt learned.
 */
async function attempt(
  steps: StepResult[],
  step: string,
  work: () => Promise<StepResult>,
): Promise<void> {
  try {
    steps.push(await work());
  } catch (error) {
    if (isExpected(error)) {
      steps.push({ step, status: "failed", detail: describeError(error) });
      return;
    }

    steps.push({ step, status: "failed", detail: describeError(error) });
    throw error;
  }
}

/**
 * One website, start to finish. Exported on its own so a test can run it
 * without a queue, and so a "Sync everything now" action could call it later.
 */
export async function runWebsiteSync(
  websiteId: string,
  options: { now?: Date; signal?: AbortSignal } = {},
): Promise<WebsiteSyncSummary> {
  const now = options.now ?? new Date();
  const startedAt = new Date().toISOString();
  const steps: StepResult[] = [];

  const finish = (): WebsiteSyncSummary => ({
    websiteId,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
    wroteMetrics: steps.some((row) => row.status === "done" && (row.written ?? 0) > 0),
  });

  const aborted = () => options.signal?.aborted === true;

  let context: TenantContext;
  try {
    context = await systemContextFor(websiteId);
  } catch (error) {
    if (error instanceof SystemContextError) {
      // An archived website is not an error the queue should retry; it is a
      // website that gets no more syncs. The job completes with the reason.
      steps.push({ step: "context", status: "skipped", detail: describeError(error) });
      return finish();
    }
    throw error;
  }

  try {
    const connected = await connectedProviders(context);

    for (const provider of PROVIDER_STEPS) {
      if (aborted()) break;

      if (!connected.has(provider.provider)) {
        steps.push({ step: provider.step, status: "skipped", detail: "not connected" });
        continue;
      }

      await attempt(steps, provider.step, async () =>
        fromOutcome(provider.step, await provider.run(context, now)),
      );
    }

    if (!aborted()) {
      const sitemaps = await listSitemaps(context);

      if (sitemaps.length === 0) {
        steps.push({ step: "sitemaps", status: "skipped", detail: "none registered" });
      }

      for (const sitemap of sitemaps) {
        if (aborted()) break;

        await attempt(steps, `sitemap:${sitemap.id}`, async () => {
          const result = await syncSitemap(context, sitemap.id);
          return {
            step: `sitemap:${sitemap.id}`,
            status: "done",
            detail: `${result.discovered} discovered`,
            written: result.created,
          };
        });
      }
    }

    // Detection runs whether or not a provider wrote today: keywords, ownership
    // and sitemap pages change by hand during the day, and detection is a
    // deterministic upsert over what is stored, so a re-run with nothing new
    // changes nothing. Signals are the exception - they need metrics to read,
    // and a website that has none yet gets "not yet" rather than an error.
    if (!aborted()) {
      if (await hasAnyMetrics(context)) {
        await attempt(steps, "signals", async () => {
          const result = await detectAndStoreSignals(context, { now });
          return {
            step: "signals",
            status: "done",
            detail: `${result.detected} detected, ${result.resolved} resolved`,
          };
        });
      } else {
        steps.push({ step: "signals", status: "skipped", detail: "no metrics yet" });
      }
    }

    if (!aborted()) {
      await attempt(steps, "opportunities", async () => {
        const result = await detectAndStoreOpportunities(context, { now });
        const detected = (result as { detected?: unknown }).detected;
        return {
          step: "opportunities",
          status: "done",
          detail: typeof detected === "number" ? `${detected} detected` : undefined,
        };
      });
    }

    if (aborted()) {
      steps.push({ step: "job", status: "failed", detail: "aborted" });
      throw new Error("website.sync was aborted before it finished");
    }

    return finish();
  } catch (error) {
    console.error(JSON.stringify({ at: "website.sync", event: "failed", ...finish() }));
    throw error;
  }
}

/**
 * The fan-out. One job per website, staggered a few seconds apart so a hundred
 * websites do not all open a connection to Google in the same second. The
 * singleton key means a website that is still waiting from a previous fan-out
 * - or from a manual trigger - is not queued twice.
 */
export async function runDailySync(
  queue: Pick<Queue, "enqueue">,
  options: { staggerSeconds?: number } = {},
): Promise<DailySyncSummary> {
  const startedAt = new Date().toISOString();
  const stagger = options.staggerSeconds ?? 5;
  const websites = await listSyncableWebsiteIds();

  let enqueued = 0;

  for (const [index, websiteId] of websites.entries()) {
    const id = await queue.enqueue(
      JOB_NAMES.WEBSITE_SYNC,
      { websiteId, requestedAt: startedAt } satisfies WebsiteSyncPayload,
      { singletonKey: websiteId, startAfterSeconds: index * stagger },
    );

    if (id) enqueued += 1;
  }

  return { startedAt, finishedAt: new Date().toISOString(), websites: websites.length, enqueued };
}

function log(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

/** Wires the handlers to their queues. Called once, by the worker. */
export async function registerJobs(queue: Queue): Promise<void> {
  await queue.work<z.infer<typeof dailySyncPayload>>(JOB_NAMES.SYNC_DAILY, async (job) => {
    dailySyncPayload.parse(job.data);
    const summary = await runDailySync(queue);
    log({ at: JOB_NAMES.SYNC_DAILY, event: "completed", jobId: job.id, ...summary });
    return summary;
  });

  await queue.work<WebsiteSyncPayload>(JOB_NAMES.WEBSITE_SYNC, async (job) => {
    const payload = websiteSyncPayload.parse(job.data);
    const summary = await runWebsiteSync(payload.websiteId, { signal: job.signal });
    log({ at: JOB_NAMES.WEBSITE_SYNC, event: "completed", jobId: job.id, ...summary });
    return summary;
  });
}
