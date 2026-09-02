import { prisma } from "@/server/db/prisma";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { freshnessInDays } from "@/lib/metrics/compare";
import {
  SCORING_MODEL_VERSION,
  detectSignals,
  type DetectedSignal,
} from "@/lib/signals/rules";
import { renderSignal } from "@/lib/signals/templates";
import {
  getPageMetrics,
  getQueryMetrics,
  resolveWebsiteWindows,
  type MetricsWindow,
} from "@/server/services/metrics";
import type { Prisma, Signal, SignalEvidence } from "@/generated/prisma/client";

/**
 * Runs detection and persists the results.
 *
 * Detection itself is pure (lib/signals/rules.ts); this file only reads metrics,
 * hands them over, and writes what comes back. Keeping the rules out of here is
 * what lets thresholds be argued about with a test rather than a database.
 *
 * Re-running for the same period updates rather than duplicates: Signal is unique
 * on (websiteId, type, pageId, queryId, currentPeriodStart). A signal that is no
 * longer detected is resolved rather than deleted — an observation that was true
 * last week remains part of the record.
 */

export class SignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalError";
  }
}

export type SignalWithEvidence = Signal & {
  evidence: SignalEvidence[];
  page: { id: string; path: string } | null;
  queryRef: { id: string; query: string } | null;
};

export async function detectAndStoreSignals(
  context: TenantContext,
  options: { now?: Date } = {},
): Promise<{
  detected: number;
  resolved: number;
  windows: MetricsWindow;
  totalsByType: Partial<Record<string, number>>;
}> {
  const now = options.now ?? new Date();
  const { windows, latestDataDate } = await resolveWebsiteWindows(context, "28d");

  const [pages, queries, lastRun] = await Promise.all([
    getPageMetrics(context, windows, { limit: 500 }),
    getQueryMetrics(context, windows, { limit: 500 }),
    prisma.syncRun.findFirst({
      where: { websiteId: context.website.id },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    }),
  ]);

  const detection = detectSignals({
    pages: pages.map((page) => ({
      pageId: page.pageId,
      path: page.path,
      clicks: page.clicks,
      impressions: page.impressions,
      ctr: page.ctr,
      position: page.position,
      previousClicks: page.previousClicks,
      previousImpressions: page.previousImpressions,
      previousCtr: page.previousCtr,
    })),
    queries: queries.map((query) => ({
      queryId: query.queryId,
      query: query.query,
      topPagePath: query.topPagePath,
      clicks: query.clicks,
      impressions: query.impressions,
      ctr: query.ctr,
      position: query.position,
      previousClicks: query.previousClicks,
    })),
    freshnessDays: freshnessInDays(latestDataDate, now),
    lastSyncFailed: lastRun?.status === "FAILED" || lastRun?.status === "PARTIAL",
  });

  const detected = detection.signals;

  const keptIds: string[] = [];

  for (const signal of detected) {
    const stored = await upsertSignal(context, signal, windows);
    keptIds.push(stored.id);
  }

  // Anything previously detected for this period that no longer holds is resolved,
  // not removed. The record of what was observed stays intact.
  const resolved = await prisma.signal.updateMany({
    where: {
      ...websiteScope(context),
      currentPeriodStart: new Date(windows.current.start),
      status: "DETECTED",
      id: { notIn: keptIds.length > 0 ? keptIds : ["00000000-0000-0000-0000-000000000000"] },
    },
    data: { status: "RESOLVED", resolvedAt: now },
  });

  return {
    detected: detected.length,
    resolved: resolved.count,
    windows,
    totalsByType: detection.totalsByType,
  };
}

async function upsertSignal(
  context: TenantContext,
  signal: DetectedSignal,
  windows: MetricsWindow,
): Promise<Signal> {
  const copy = renderSignal(signal, windows);

  // Identity lives in a raw index with NULLS NOT DISTINCT, which Prisma cannot
  // express, so this is findFirst-then-write rather than upsert. The database still
  // enforces uniqueness; this just cannot use the generated compound-key helper.
  const identity = {
    websiteId: context.website.id,
    type: signal.type,
    pageId: signal.pageId ?? null,
    queryId: signal.queryId ?? null,
    currentPeriodStart: new Date(windows.current.start),
  };

  const data = {
    severity: signal.severity,
    score: signal.score,
    scoringModelVersion: SCORING_MODEL_VERSION,
    headline: copy.headline,
    summary: copy.summary,
    currentPeriodEnd: new Date(windows.current.end),
    comparisonPeriodStart: new Date(windows.previous.start),
    comparisonPeriodEnd: new Date(windows.previous.end),
    evidenceJson: signal.evidence as unknown as Prisma.InputJsonValue,
  };

  const existing = await prisma.signal.findFirst({ where: identity });

  // A signal a person already reviewed or dismissed keeps that state: re-running
  // detection must not quietly undo someone's decision.
  const stored = existing
    ? await prisma.signal.update({ where: { id: existing.id }, data })
    : await prisma.signal.create({
        data: { ...data, ...identity, status: "DETECTED" },
      });

  // Evidence is rewritten wholesale: it belongs to this detection run, and a stale
  // row would make the signal unexplainable from its own numbers.
  await prisma.signalEvidence.deleteMany({ where: { signalId: stored.id } });
  await prisma.signalEvidence.createMany({
    data: signal.evidence.map((entry) => ({
      signalId: stored.id,
      evidenceType: "METRIC_COMPARISON" as const,
      sourceEntityType: signal.pageId ? "Page" : signal.queryId ? "Query" : "Website",
      sourceEntityId: signal.pageId ?? signal.queryId ?? context.website.id,
      metricKey: entry.metricKey,
      currentValue: entry.currentValue,
      previousValue: entry.previousValue,
      periodStart: new Date(windows.current.start),
      periodEnd: new Date(windows.current.end),
    })),
  });

  return stored;
}

export async function listSignals(
  context: TenantContext,
  options: { status?: "DETECTED" | "REVIEWED" | "DISMISSED" | "RESOLVED"; limit?: number } = {},
): Promise<SignalWithEvidence[]> {
  return prisma.signal.findMany({
    where: {
      ...websiteScope(context),
      ...(options.status ? { status: options.status } : {}),
    },
    include: {
      evidence: true,
      page: { select: { id: true, path: true } },
      queryRef: { select: { id: true, query: true } },
    },
    orderBy: [{ severity: "desc" }, { score: "desc" }, { detectedAt: "desc" }],
    take: options.limit ?? 100,
  });
}

export async function getSignal(
  context: TenantContext,
  signalId: string,
): Promise<SignalWithEvidence | null> {
  return prisma.signal.findFirst({
    where: { id: signalId, ...websiteScope(context) },
    include: {
      evidence: true,
      page: { select: { id: true, path: true } },
      queryRef: { select: { id: true, query: true } },
    },
  });
}

/** A person's judgement on a signal. Only these two transitions exist in P1. */
export async function setSignalStatus(
  context: TenantContext,
  signalId: string,
  status: "REVIEWED" | "DISMISSED",
): Promise<Signal> {
  const existing = await prisma.signal.findFirst({
    where: { id: signalId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new SignalError("That signal is not available.");
  }

  return prisma.signal.update({ where: { id: existing.id }, data: { status } });
}

/** Counts for the Command Center's Attention section. */
export async function getSignalCounts(
  context: TenantContext,
): Promise<Record<string, number>> {
  const rows = await prisma.signal.groupBy({
    by: ["type"],
    where: { ...websiteScope(context), status: "DETECTED" },
    _count: { _all: true },
  });

  return Object.fromEntries(rows.map((row) => [row.type, row._count._all]));
}
