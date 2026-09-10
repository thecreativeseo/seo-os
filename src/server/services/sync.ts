import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import type { Connection, SyncRun, SyncStatus, SyncType } from "@/generated/prisma/client";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import {
  fingerprintError,
  newStageTracker,
  type StageTracker,
  type SyncFailureFingerprint,
} from "@/lib/sync/failure";
import { GSC_FIXED_DIMENSIONS, collapseGscRows, hasUniqueGscGrains } from "@/lib/sync/grain";
import { Ga4WindowAccumulator, hasUniqueGa4Grains } from "@/lib/sync/ga4-grain";
import type { NormalizedUrl } from "@/lib/url/normalize-url";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { hasLiveSyncJob } from "@/server/jobs/status";
import { getAccessToken } from "@/server/services/connection-auth";
import { normalizeUrl } from "@/lib/url/normalize-url";
import { normalizeQuery } from "@/lib/query/normalize-query";
import { EXPECTED_LAG_DAYS } from "@/lib/metrics/compare";
import {
  digestHex,
  foldDigest,
  ingestByDateWindows,
  newDigest,
  type AdaptiveResult,
  type DateWindow,
} from "@/lib/sync/windows";
import {
  SearchConsoleError,
  streamSearchAnalytics,
  type SearchAnalyticsResult,
  type SearchConsoleRow,
} from "@/server/connectors/google/search-console";
import {
  AnalyticsError,
  streamLandingPageMetrics,
  type Ga4MetricName,
  type Ga4Result,
} from "@/server/connectors/google/analytics";
import {
  DEFAULT_MAX_ROWS,
  SemrushError,
  databaseForMarket,
  SEMRUSH_SYNC_CODES,
  fetchOrganicPositions,
} from "@/server/connectors/semrush/client";
import {
  AhrefsError,
  DEFAULT_LIMIT as AHREFS_DEFAULT_LIMIT,
  countryForMarket,
  fetchOrganicKeywords,
} from "@/server/connectors/ahrefs/client";
import { getApiKey } from "@/server/services/connection-auth";
import { persistMarketRows } from "@/server/services/market-data";

/**
 * Sync orchestration (docs/P1_SPEC.md §11, §23).
 *
 * A sync is the only thing in SEO OS that turns an outside claim into a stored
 * number, so the acceptance criteria hold it to four properties and this module is
 * organised around them:
 *
 *   - **Idempotent.** The same period asked for twice writes the same rows. Metric
 *     rows are upserted on the documented grain, so a retry updates in place; the
 *     idempotency key on SyncRun then means a completed period is not refetched at
 *     all.
 *   - **Retry-safe.** A run that failed halfway leaves valid rows behind and can be
 *     run again. Nothing is deleted first, and no row depends on the run that wrote
 *     it.
 *   - **Honest about freshness.** `connection.lastSyncedAt` and `latestDataDate`
 *     advance only on a run that actually succeeded. A failed sync leaves the
 *     product saying the data is old, which it is.
 *   - **Redacted.** Errors carry a code from our own vocabulary and a short summary.
 *     The provider's message, which can echo the request and the token audience,
 *     never reaches the database.
 */

export type SyncErrorCode =
  | "not_connected"
  | "no_property"
  | "already_running"
  | "no_credential"
  | "reauth_required"
  | "upstream_error"
  | "permission_denied"
  | "property_not_found"
  | "rate_limited"
  | "request_failed"
  | "invalid_response"
  | "unknown"
  // P2 LIVE API MODE. A metered third-party API fails in ways an OAuth provider
  // does not — the key can be valid while the account has nothing left to spend —
  // and "upstream_error" would tell an operator nothing they could act on.
  | "invalid_key"
  | "quota_exhausted"
  | "unknown_database"
  | "not_subscribed"
  | "no_market"
  // A run left at RUNNING by a process that died between committing rows and
  // finalising — Railway recycling the container, an OOM, a dropped request.
  // It is a recovered orphan, not a fresh failure, and says so.
  | "stale_run_recovered"
  // A person whose role does not permit starting a sync asked for one.
  | "forbidden";

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: SyncErrorCode,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

/** A first sync reaches back far enough for the 28-versus-28 comparison to work. */
export const INITIAL_WINDOW_DAYS = 90;

/**
 * How far back an incremental sync re-reads. Search Console revises recent days
 * upward for about three days after the fact, so re-reading them is how the stored
 * figure catches up with the final one. Upserting makes it free.
 */
export const OVERLAP_DAYS = 3;

/** A RUNNING row older than this was left behind by a crashed process. */
export const STALE_RUN_MINUTES = 15;

/** Rows per INSERT. Keeps the parameter count well inside Postgres's limit. */
const BATCH_SIZE = 500;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return isoDate(base);
}

export type SyncWindow = { startDate: string; endDate: string };

/**
 * The period a sync should read.
 *
 * The end date is today minus the reporting lag, not today: asking Search Console
 * for yesterday returns a partial day that would later revise upward, and a metric
 * that revises upward after being shown is a metric nobody trusts again.
 */
export function resolveSyncWindow(
  connection: Pick<Connection, "latestDataDate">,
  options: { now?: Date; days?: number } = {},
): SyncWindow {
  const now = options.now ?? new Date();
  const endDate = shiftDays(isoDate(now), -EXPECTED_LAG_DAYS);

  if (options.days !== undefined) {
    return { startDate: shiftDays(endDate, -(options.days - 1)), endDate };
  }

  if (!connection.latestDataDate) {
    return { startDate: shiftDays(endDate, -(INITIAL_WINDOW_DAYS - 1)), endDate };
  }

  const resumeFrom = shiftDays(isoDate(connection.latestDataDate), -OVERLAP_DAYS);
  const initialFloor = shiftDays(endDate, -(INITIAL_WINDOW_DAYS - 1));

  return {
    // Never reaches further back than the initial window, so a long-dormant
    // connection does not silently request a year of data on its next run.
    startDate: resumeFrom > initialFloor ? resumeFrom : initialFloor,
    endDate,
  };
}

/**
 * The same period always produces the same key, which is what makes a repeated
 * request cheap rather than merely harmless.
 */
export function idempotencyKeyFor(syncType: SyncType, window: SyncWindow): string {
  return `${syncType}:${window.startDate}:${window.endDate}`;
}

function errorCodeFor(error: unknown): SyncErrorCode {
  if (error instanceof SyncError) return error.code;

  // Semrush names the account states its API distinguishes - units, report
  // limit, total limit, database access - and this log does not, so the
  // collapse is written down in the connector rather than cast away here.
  if (error instanceof SemrushError) return SEMRUSH_SYNC_CODES[error.code];

  if (
    error instanceof SearchConsoleError ||
    error instanceof AnalyticsError ||
    error instanceof AhrefsError
  ) {
    // These connectors' codes are a subset of ours by construction.
    return error.code as SyncErrorCode;
  }

  // ConnectionAuthError and anything else: a code, never the message.
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const code = error.code;
    if (code === "no_credential" || code === "reauth_required") return code;
  }

  return "unknown";
}

/**
 * A short, safe summary for the run row.
 *
 * Deliberately not the provider's text: a Google error body can contain the request
 * URL, the property, and the token audience. What is stored is our own sentence.
 */
const ERROR_SUMMARIES: Record<SyncErrorCode, string> = {
  not_connected: "This provider is not connected.",
  no_property: "No property has been selected for this connection.",
  already_running: "A sync for this period is already in progress.",
  no_credential: "This connection has no stored credential.",
  reauth_required: "The authorisation was rejected and needs to be granted again.",
  upstream_error: "The provider could not be reached.",
  permission_denied: "The authorisation does not permit reading this property.",
  property_not_found: "The selected property could not be found.",
  rate_limited: "The provider is rate limiting requests.",
  request_failed: "The provider rejected the request.",
  invalid_response: "The provider returned data that could not be read.",
  unknown: "The sync did not complete.",
  invalid_key: "The stored API key was rejected. Reconnect with a valid key.",
  quota_exhausted: "This provider account has no API quota left.",
  unknown_database: "The provider has no regional database for this website's market.",
  not_subscribed: "This provider plan does not include API access to that report.",
  no_market: "Set the website's primary market before syncing this provider.",
  stale_run_recovered:
    "A previous run was interrupted before it finished and has been marked failed. The figures above are unchanged.",
  forbidden: "This role cannot start a sync.",
};

export type SyncOutcome = {
  run: SyncRun;
  status: SyncStatus;
  window: SyncWindow;
  received: number;
  written: number;
  skipped: number;
  /** True when the run was satisfied from an earlier successful sync. */
  reused: boolean;
  /**
   * The safe shape of the error, when the run failed. In memory only, for the
   * job that decides whether to retry and logs why; the run row keeps its
   * code and its sentence exactly as before.
   */
  failure?: SyncFailureFingerprint;
};

export async function connectionFor(
  context: TenantContext,
  provider: "GOOGLE_SEARCH_CONSOLE" | "GOOGLE_ANALYTICS",
): Promise<{ connection: Connection; propertyId: string }> {
  const connection = await prisma.connection.findFirst({
    where: { provider, ...websiteScope(context) },
  });

  if (!connection || connection.status === "NOT_CONNECTED") {
    throw new SyncError("This provider is not connected.", "not_connected");
  }

  if (!connection.externalPropertyId) {
    throw new SyncError("Choose a property before syncing.", "no_property");
  }

  return { connection, propertyId: connection.externalPropertyId };
}

/**
 * Claims the run row for this attempt.
 *
 * Returns the existing run when the period has already succeeded — the caller then
 * does no work at all, which is the point of the key. A previously failed run is
 * reused rather than replaced so the history stays one row per period.
 */
/**
 * Recovers runs a dead process left behind.
 *
 * A sync commits its metric rows as it goes and only afterwards, in a separate
 * transaction, marks the run SUCCEEDED and advances the connection's freshness.
 * An ordinary exception is caught and the run is marked FAILED. But a process
 * that is killed outright — a container recycle, an OOM, a dropped request —
 * cannot run a catch block, so its run stays RUNNING forever and the period it
 * was working on can never be synced again.
 *
 * Before a new run for a connection, any RUNNING run for that same connection
 * older than the staleness threshold is marked FAILED — unless a live job still
 * owns it. The worker heartbeats its job while a handler runs, so a run whose
 * job is still being stamped is executing however long it has been going,
 * and a run whose job has gone quiet is not. Without a queue to ask, age
 * alone decides, as it did before. A recovered run's idempotency key is
 * archived so the orphan is preserved as history rather than overwritten by
 * the fresh attempt. A run still inside the threshold is left alone either
 * way: it might genuinely be in flight.
 */
async function recoverStaleRuns(connectionId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MINUTES * 60_000);

  const running = await prisma.syncRun.findMany({
    where: { connectionId, status: "RUNNING" },
  });

  let recovered = 0;
  for (const run of running) {
    const startedAt = run.startedAt ?? run.createdAt;
    if (startedAt >= cutoff) continue;

    // Old, but owned by a job that is still heartbeating: a long sync, not an
    // orphan.
    if (await hasLiveSyncJob(run.websiteId, run.provider, startedAt)) continue;

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: now,
        errorCode: "stale_run_recovered",
        errorSummary: ERROR_SUMMARIES.stale_run_recovered,
        // Free the canonical key so the retry is a distinct row and this one
        // survives as the record of an interrupted attempt.
        idempotencyKey: `${run.idempotencyKey}:stale:${run.id.slice(0, 8)}`,
      },
    });
    recovered += 1;
  }

  return recovered;
}

async function claimRun(
  context: TenantContext,
  connection: Connection,
  syncType: SyncType,
  window: SyncWindow,
  now: Date,
): Promise<{ run: SyncRun; alreadyDone: boolean }> {
  const idempotencyKey = idempotencyKeyFor(syncType, window);

  // Clear out anything a dead process abandoned for this connection first. A
  // RUNNING run for this period that survives this call is therefore recent
  // enough to still be executing, and is protected below.
  await recoverStaleRuns(connection.id, now);

  const existing = await prisma.syncRun.findUnique({
    where: { connectionId_idempotencyKey: { connectionId: connection.id, idempotencyKey } },
  });

  if (existing?.status === "SUCCEEDED") {
    return { run: existing, alreadyDone: true };
  }

  if (existing?.status === "RUNNING") {
    // Recovery already retired the stale ones, so this is a genuinely active run.
    throw new SyncError("A sync for this period is already running.", "already_running");
  }

  const data = {
    status: "RUNNING" as const,
    startedAt: now,
    finishedAt: null,
    errorCode: null,
    errorSummary: null,
    recordsReceived: 0,
    recordsWritten: 0,
    recordsSkipped: 0,
  };

  const run = existing
    ? await prisma.syncRun.update({ where: { id: existing.id }, data })
    : await prisma.syncRun.create({
        data: {
          websiteId: context.website.id,
          connectionId: connection.id,
          provider: connection.provider,
          syncType,
          periodStart: new Date(`${window.startDate}T00:00:00.000Z`),
          periodEnd: new Date(`${window.endDate}T00:00:00.000Z`),
          idempotencyKey,
          ...data,
        },
      });

  return { run, alreadyDone: false };
}

async function failRun(
  run: SyncRun,
  error: unknown,
  diagnostics: { context?: TenantContext; failure?: SyncFailureFingerprint } = {},
): Promise<SyncRun> {
  const code = errorCodeFor(error);

  const failed = await prisma.syncRun.update({
    where: { id: run.id },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorCode: code,
      errorSummary: ERROR_SUMMARIES[code],
    },
  });
  // Note what is NOT here: the connection is left untouched, so lastSyncedAt and
  // latestDataDate still describe the last run that genuinely worked.

  // The safe fingerprint goes to the audit trail, which already exists, is
  // tenant-scoped, and is never shown on Data Health. It is written after the
  // run row and on its own: a diagnostic that could not be recorded must not
  // take the FAILED status down with it, and the error being diagnosed may
  // well be the database refusing writes.
  if (diagnostics.context && diagnostics.failure) {
    const { context, failure } = diagnostics;
    try {
      await prisma.$transaction((tx) =>
        recordAudit(tx, context, {
          entityType: "SyncRun",
          entityId: run.id,
          action: "UPDATE",
          after: {
            status: "FAILED",
            provider: run.provider,
            errorCode: code,
            failure,
          },
        }),
      );
    } catch {
      // Deliberately silent. The run is already marked, and the retry log
      // carries the same fingerprint.
    }
  }

  return failed;
}

/**
 * How many provider rows are normalised, resolved and written at a time.
 *
 * Every structure in an ingest step is bounded by this rather than by the size
 * of the property. It also keeps identity lookups well inside Postgres's limit
 * on bind parameters: a site with seventy-five thousand distinct queries would
 * otherwise be asked for in a single IN list, which is both enormous and, past
 * 65535 values, impossible.
 */
const INGEST_CHUNK = 5_000;

/**
 * What a sync knows so far.
 *
 * Counters and a running hash — never the rows. This is the whole of what
 * survives from one page to the next, which is what makes a sync's memory a
 * function of the chunk size instead of the property's size.
 */
type Tally = {
  received: number;
  written: number;
  skipped: number;
  /** Rows that were placed. Distinguishes a complete read from a partial one. */
  seen: number;
  latestDate: string | null;
  /** Order-independent, so the same rows hash alike however they were asked for. */
  digest: Uint8Array;
};

function newTally(): Tally {
  return {
    received: 0,
    written: 0,
    skipped: 0,
    seen: 0,
    latestDate: null,
    digest: newDigest(),
  };
}

/** One row's contribution to the checksum. */
function rowDigest(canonical: string): Uint8Array {
  return createHash("sha256").update(canonical).digest();
}

/** What the counters were before a window, so a discarded probe can be undone. */
type TallyMark = Pick<Tally, "received" | "written" | "skipped" | "seen" | "latestDate">;

function markTally(tally: Tally): TallyMark {
  return {
    received: tally.received,
    written: tally.written,
    skipped: tally.skipped,
    seen: tally.seen,
    latestDate: tally.latestDate,
  };
}

/**
 * Rolls the counters back to a mark.
 *
 * Used when a window came back truncated and is being replaced by its halves.
 * The rows it wrote stay in the database — they are real rows for real dates,
 * and the halves rewrite the same grain — but they are not counted twice, and
 * the probe contributes nothing to the checksum because its digest is simply
 * never folded in.
 */
function restoreTally(tally: Tally, mark: TallyMark): void {
  tally.received = mark.received;
  tally.written = mark.written;
  tally.skipped = mark.skipped;
  tally.seen = mark.seen;
  tally.latestDate = mark.latestDate;
}

/** What a window read, kept aside until the driver rules on the window. */
type WindowContribution = { mark: TallyMark; digest: Uint8Array } | null;

/**
 * Keeps what a window read.
 *
 * Its counters already stand, so only the checksum needs settling: the window's
 * rows are folded into the run's digest, which is why a discarded probe leaves
 * no trace without anything having to be undone.
 */
function acceptWindow(tally: Tally, contribution: WindowContribution): void {
  if (contribution) foldDigest(tally.digest, contribution.digest);
}

/** Undoes what a window read, because its halves are about to read it again. */
function discardWindow(tally: Tally, contribution: WindowContribution): void {
  if (contribution) restoreTally(tally, contribution.mark);
}

function noteDate(tally: Tally, date: string): void {
  if (tally.latestDate === null || date > tally.latestDate) tally.latestDate = date;
}

/** Splits a provider page into pieces small enough to hold. */
function chunks<T>(rows: T[], size: number = INGEST_CHUNK): T[][] {
  if (size <= 0) size = INGEST_CHUNK;
  if (rows.length <= size) return [rows];
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    out.push(rows.slice(index, index + size));
  }
  return out;
}

/**
 * A snapshot for a provider whose whole report arrives at once.
 *
 * Semrush and Ahrefs return a bounded, already-paid-for number of rows, so
 * there is nothing to stream and the checksum can be taken in one pass.
 */
async function recordSnapshot(
  context: TenantContext,
  connection: Connection,
  window: SyncWindow,
  payload: { rowsReceived: number; checksumSource: string; extra?: Record<string, unknown> },
): Promise<string> {
  const snapshot = await prisma.sourceSnapshot.create({
    data: {
      websiteId: context.website.id,
      connectionId: connection.id,
      provider: connection.provider,
      periodStart: new Date(`${window.startDate}T00:00:00.000Z`),
      periodEnd: new Date(`${window.endDate}T00:00:00.000Z`),
      checksum: createHash("sha256").update(payload.checksumSource).digest("hex"),
      // Counts and periods only. A snapshot never holds tokens, and the
      // response body itself is not retained in this phase.
      metadataJson: { rowsReceived: payload.rowsReceived, complete: true, ...payload.extra },
    },
  });

  return snapshot.id;
}

/**
 * Opens the snapshot before any row is written.
 *
 * It has to exist first because every metric row references it. What it says
 * about the read is filled in at the end, when the read is over and the counts
 * are known.
 */
async function beginSnapshot(
  context: TenantContext,
  connection: Connection,
  window: SyncWindow,
): Promise<string> {
  const snapshot = await prisma.sourceSnapshot.create({
    data: {
      websiteId: context.website.id,
      connectionId: connection.id,
      provider: connection.provider,
      periodStart: new Date(`${window.startDate}T00:00:00.000Z`),
      periodEnd: new Date(`${window.endDate}T00:00:00.000Z`),
      metadataJson: { rowsReceived: 0, complete: false },
    },
  });

  return snapshot.id;
}

/** At most this many incomplete windows are named, so metadata stays bounded. */
const MAX_REPORTED_WINDOWS = 20;

/**
 * Closes the snapshot with what the read turned out to be.
 *
 * The checksum is folded in row by row as the pages arrive, so the evidence of
 * what was read never requires the rows to be joined into one enormous string —
 * which, at four hundred thousand rows, was tens of megabytes allocated at the
 * worst possible moment.
 *
 * It also records how the period was divided and which parts of it, if any,
 * could not be finished — so a partial sync says which dates are missing rather
 * than only that something was.
 *
 * Counts, dates and codes only. A snapshot never holds tokens, and the response
 * body is not retained in this phase.
 */
async function finishSnapshot(
  snapshotId: string,
  tally: Tally,
  range: DateWindow,
  outcome: AdaptiveResult,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await prisma.sourceSnapshot.update({
    where: { id: snapshotId },
    data: {
      checksum: digestHex(tally.digest),
      // Counts, dates and codes. Bounded by the length of the period rather
      // than by the number of rows, and never a row itself.
      metadataJson: {
        requestedStart: range.startDate,
        requestedEnd: range.endDate,
        rowsReceived: tally.received,
        rowsWritten: tally.written,
        windows: outcome.windows.length,
        windowsCompleted: outcome.windows.length - outcome.incomplete.length,
        providerRequests: outcome.requests,
        truncated: !outcome.complete,
        complete: outcome.complete,
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(outcome.incomplete.length > 0
          ? {
              incompleteWindows: outcome.incomplete.slice(0, MAX_REPORTED_WINDOWS).map((entry) => ({
                start: entry.startDate,
                end: entry.endDate,
                code: entry.code ?? null,
              })),
            }
          : {}),
        ...extra,
      },
    },
  });
}

/** Ensures Pages exist for every URL in the batch and returns normalizedUrl → id. */
async function resolvePages(
  websiteId: string,
  urls: { normalized: string; hostname: string; protocol: string; path: string }[],
  source: "GOOGLE_SEARCH_CONSOLE" | "GOOGLE_ANALYTICS",
): Promise<Map<string, string>> {
  if (urls.length > 0) {
    await prisma.page.createMany({
      data: urls.map((url) => ({
        websiteId,
        url: url.normalized,
        normalizedUrl: url.normalized,
        path: url.path,
        hostname: url.hostname,
        protocol: url.protocol,
        sourceFirstSeen: source,
      })),
      // A page already known from another source keeps its original
      // sourceFirstSeen: the first sighting is a fact about history, and a later
      // sync must not rewrite it.
      skipDuplicates: true,
    });
  }

  const pages = await prisma.page.findMany({
    where: { websiteId, normalizedUrl: { in: urls.map((url) => url.normalized) } },
    select: { id: true, normalizedUrl: true },
  });

  return new Map(pages.map((page) => [page.normalizedUrl, page.id]));
}

/** Ensures Queries exist and returns normalizedQuery → id. */
async function resolveQueries(
  websiteId: string,
  queries: { raw: string; normalized: string }[],
): Promise<Map<string, string>> {
  if (queries.length > 0) {
    await prisma.query.createMany({
      data: queries.map((query) => ({
        websiteId,
        query: query.raw,
        normalizedQuery: query.normalized,
      })),
      skipDuplicates: true,
    });
  }

  const stored = await prisma.query.findMany({
    where: { websiteId, normalizedQuery: { in: queries.map((query) => query.normalized) } },
    select: { id: true, normalizedQuery: true },
  });

  return new Map(stored.map((query) => [query.normalizedQuery, query.id]));
}

type GscInsertRow = {
  websiteId: string;
  pageId: string;
  queryId: string;
  date: string;
  // The three dimensions this writer fixes. Carried on the row so the grain
  // it is collapsed on is the schema's grain, column for column.
  country: string;
  device: string;
  searchType: string;
  clicks: number;
  impressions: number;
  /** Null only for an aggregate with no impressions to compute it from. */
  ctr: number | null;
  position: number | null;
  connectionId: string;
  snapshotId: string;
};

/**
 * Upserts metric rows on the documented grain.
 *
 * ON CONFLICT DO UPDATE rather than skipDuplicates: re-reading a recent period is
 * how a revised figure replaces a provisional one, and skipping the conflict would
 * freeze the first, incomplete number in place forever.
 */
async function upsertGscRows(rows: GscInsertRow[]): Promise<number> {
  // Postgres refuses a statement whose VALUES list names the same conflict
  // key twice, so the writer collapses collisions before it gets here. This
  // is the check that it did, said without naming any row.
  if (!hasUniqueGscGrains(rows)) {
    throw new Error("gsc upsert batch contains the same grain more than once");
  }

  let written = 0;

  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);

    const values = batch.map(
      (row) => Prisma.sql`(
        gen_random_uuid(),
        ${row.websiteId}::uuid,
        ${row.pageId}::uuid,
        ${row.queryId}::uuid,
        ${row.date}::date,
        ${row.country},
        ${row.device},
        ${row.searchType}::"SearchType",
        ${row.clicks}::int,
        ${row.impressions}::int,
        ${row.ctr}::numeric(9,6),
        ${row.position}::numeric(7,3),
        ${row.connectionId}::uuid,
        ${row.snapshotId}::uuid,
        now(),
        now()
      )`,
    );

    written += await prisma.$executeRaw`
      INSERT INTO gsc_metric_daily (
        id, website_id, page_id, query_id, date, country, device, search_type,
        clicks, impressions, ctr, position,
        source_connection_id, source_snapshot_id, created_at, updated_at
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT (website_id, date, page_id, query_id, country, device, search_type)
      DO UPDATE SET
        clicks = EXCLUDED.clicks,
        impressions = EXCLUDED.impressions,
        ctr = EXCLUDED.ctr,
        position = EXCLUDED.position,
        source_connection_id = EXCLUDED.source_connection_id,
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        updated_at = now()
    `;
  }

  return written;
}

export type GscSyncOptions = {
  days?: number;
  now?: Date;
  /**
   * Injected in tests so the whole lifecycle runs without a network. Delivered
   * to the ingest path as a single page.
   */
  source?: (params: {
    accessToken: string;
    propertyId: string;
    startDate: string;
    endDate: string;
  }) => Promise<SearchAnalyticsResult>;
  /**
   * Injected where a test needs several pages — to show that they are written
   * and released one at a time rather than gathered up first.
   */
  pages?: typeof streamSearchAnalytics;
  /**
   * How many rows are held at once. Production uses INGEST_CHUNK; a test
   * lowers it so that a page splitting into pieces can be shown with a handful
   * of rows instead of tens of thousands.
   */
  ingestChunk?: number;
  /** Days in the first cut of the period. Defaults to DEFAULT_WINDOW_DAYS. */
  windowDays?: number;
  /** The ceiling on provider requests for one sync. */
  maxRequests?: number;
  accessTokenFor?: (connectionId: string) => Promise<string>;
};

/**
 * Chooses where a Search Console sync's rows come from.
 *
 * Production streams from the connector. A test may hand over pages directly,
 * to prove that pages are written and released one at a time, or a whole
 * result, which is delivered as a single page.
 */
function gscStream(options: GscSyncOptions): typeof streamSearchAnalytics {
  if (options.pages) return options.pages;

  const source = options.source;
  if (!source) return streamSearchAnalytics;

  return async (params, onPage) => {
    const result = await source(params);
    if (result.rows.length > 0) await onPage(result.rows);
    return { truncated: result.truncated };
  };
}

/**
 * Normalises, places and writes one bounded piece of a page.
 *
 * Everything it allocates — the url and query maps, the staged rows, the
 * identity lookups, the insert rows — belongs to this chunk and is gone when
 * it returns. Only the counters in the tally outlive it.
 */
async function writeGscChunk(
  context: TenantContext,
  connection: Connection,
  snapshotId: string,
  rows: SearchConsoleRow[],
  tally: Tally,
  progress: StageTracker,
): Promise<void> {
  progress.stage = "normalize";

  // Normalize first, so a row that cannot be placed is counted as skipped
  // rather than stored against a guessed identity.
  const urls = new Map<
    string,
    { normalized: string; hostname: string; protocol: string; path: string }
  >();
  const queries = new Map<string, { raw: string; normalized: string }>();
  const staged: {
    date: string;
    url: string;
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[] = [];

  for (const row of rows) {
    const url = normalizeUrl(row.page, context.website.normalizedDomain);
    const query = normalizeQuery(row.query);

    if (!url.ok || !query.ok) {
      tally.skipped += 1;
      continue;
    }

    urls.set(url.value.normalized, url.value);
    if (!queries.has(query.normalized)) {
      queries.set(query.normalized, { raw: row.query, normalized: query.normalized });
    }

    staged.push({
      date: row.date,
      url: url.value.normalized,
      query: query.normalized,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }

  if (staged.length === 0) return;

  progress.stage = "identity_lookup";
  const pageIds = await resolvePages(
    context.website.id,
    [...urls.values()],
    "GOOGLE_SEARCH_CONSOLE",
  );
  const queryIds = await resolveQueries(context.website.id, [...queries.values()]);

  const insertRows: GscInsertRow[] = [];

  for (const row of staged) {
    const pageId = pageIds.get(row.url);
    const queryId = queryIds.get(row.query);

    if (!pageId || !queryId) {
      tally.skipped += 1;
      continue;
    }

    tally.seen += 1;
    noteDate(tally, row.date);

    insertRows.push({
      websiteId: context.website.id,
      pageId,
      queryId,
      date: row.date,
      ...GSC_FIXED_DIMENSIONS,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      connectionId: connection.id,
      snapshotId,
    });
  }

  // Only now, with identities resolved, is the persisted grain known. Rows
  // that turned out to be the same page and query on the same day — the
  // provider's spellings of one thing — become one measurement here, summed
  // as measurements rather than dropped as duplicates.
  const stored = collapseGscRows(insertRows);

  progress.stage = "database_write";
  tally.written += await upsertGscRows(stored);
}

/** Search Console → Page, Query, GscMetricDaily. */
export async function runGscSync(
  context: TenantContext,
  options: GscSyncOptions = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const { connection, propertyId } = await connectionFor(context, "GOOGLE_SEARCH_CONSOLE");
  const window = resolveSyncWindow(connection, { now, days: options.days });

  const { run, alreadyDone } = await claimRun(context, connection, "GSC_METRICS", window, now);

  if (alreadyDone) {
    return {
      run,
      status: run.status,
      window,
      received: run.recordsReceived,
      written: run.recordsWritten,
      skipped: run.recordsSkipped,
      reused: true,
    };
  }

  // Where the run is, for the failure record. Advanced at each boundary and
  // read only in the catch; nothing branches on it.
  const progress = newStageTracker();

  try {
    progress.stage = "provider_fetch";
    const accessToken = await (options.accessTokenFor ?? getAccessToken)(connection.id);
    const stream = gscStream(options);

    // The snapshot exists before any row is written, because every row points
    // at it. What it says about the read is filled in when the read is done.
    progress.stage = "snapshot_open";
    const snapshotId = await beginSnapshot(context, connection, window);
    const tally = newTally();

    // What the window just read contributed, held until the driver says whether
    // the window is kept or replaced by its halves. Only the driver knows which,
    // so the decision is made in one place rather than guessed at from
    // `truncated`: a truncated single day is kept, and its rows count.
    let contribution: WindowContribution = null;

    // The period is read a window at a time, strictly one after another. A
    // window that comes back truncated is abandoned and asked again in halves,
    // so a busy property is read completely instead of being cut off at the
    // provider's ceiling.
    const outcome = await ingestByDateWindows(
      { startDate: window.startDate, endDate: window.endDate },
      async (slice) => {
        const mark = markTally(tally);
        const digest = newDigest();
        let rows = 0;
        let pages = 0;

        progress.stage = "provider_fetch";
        const { truncated } = await stream(
          {
            accessToken,
            propertyId,
            startDate: slice.startDate,
            endDate: slice.endDate,
          },
          async (batch) => {
            pages += 1;
            rows += batch.length;
            tally.received += batch.length;

            for (const row of batch) {
              foldDigest(
                digest,
                rowDigest(`${row.date}|${row.page}|${row.query}|${row.clicks}|${row.impressions}`),
              );
            }

            // Written in pieces, and each piece released before the next.
            // Nothing from an earlier page is still referenced here.
            for (const chunk of chunks(batch, options.ingestChunk)) {
              await writeGscChunk(context, connection, snapshotId, chunk, tally, progress);
            }
            // The next thing that happens is the provider being asked for
            // another page.
            progress.stage = "provider_fetch";
          },
        );

        contribution = { mark, digest };
        return { rows, pages, truncated };
      },
      {
        initialDays: options.windowDays,
        maxRequests: options.maxRequests,
        onAccept: () => acceptWindow(tally, contribution),
        onDiscard: () => discardWindow(tally, contribution),
      },
    );

    progress.stage = "snapshot_finalize";
    await finishSnapshot(snapshotId, tally, window, outcome);

    progress.stage = "sync_run_finalize";
    return await completeRun(context, connection, run, {
      window,
      received: tally.received,
      written: tally.written,
      skipped: tally.skipped,
      latestDate: tally.latestDate,
      partial: !outcome.complete,
      complete: outcome.complete,
      seen: tally.seen,
    });
  } catch (error) {
    const failure = fingerprintError(error, progress.stage);
    const failed = await failRun(run, error, { context, failure });

    return {
      run: failed,
      status: "FAILED",
      window,
      received: 0,
      written: 0,
      skipped: 0,
      reused: false,
      failure,
    };
  }
}

type Ga4InsertRow = {
  websiteId: string;
  pageId: string;
  date: string;
  sessions: number | null;
  engagedSessions: number | null;
  users: number | null;
  newUsers: number | null;
  keyEvents: number | null;
  revenue: number | null;
  connectionId: string;
  snapshotId: string;
};

async function upsertGa4Rows(rows: Ga4InsertRow[]): Promise<number> {
  // Postgres refuses a statement that names the same conflict key twice; the
  // window accumulator collapses collisions before this point, and this says
  // so without naming a row.
  if (!hasUniqueGa4Grains(rows)) {
    throw new Error("ga4 upsert batch contains the same grain more than once");
  }

  let written = 0;

  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);

    const values = batch.map(
      (row) => Prisma.sql`(
        gen_random_uuid(),
        ${row.websiteId}::uuid,
        ${row.pageId}::uuid,
        ${row.date}::date,
        ${row.sessions}::int,
        ${row.engagedSessions}::int,
        ${row.users}::int,
        ${row.newUsers}::int,
        ${row.keyEvents}::int,
        ${row.revenue}::numeric(18,4),
        ${row.connectionId}::uuid,
        ${row.snapshotId}::uuid,
        now(),
        now()
      )`,
    );

    written += await prisma.$executeRaw`
      INSERT INTO ga4_landing_page_metric_daily (
        id, website_id, page_id, date,
        sessions, engaged_sessions, users, new_users, key_events, revenue,
        source_connection_id, source_snapshot_id, created_at, updated_at
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT (website_id, date, page_id)
      DO UPDATE SET
        sessions = EXCLUDED.sessions,
        engaged_sessions = EXCLUDED.engaged_sessions,
        users = EXCLUDED.users,
        new_users = EXCLUDED.new_users,
        key_events = EXCLUDED.key_events,
        revenue = EXCLUDED.revenue,
        source_connection_id = EXCLUDED.source_connection_id,
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        updated_at = now()
    `;
  }

  return written;
}

/**
 * GA4 reports a landing page as a path, not a URL, and sometimes as a placeholder.
 *
 * "(not set)" and "(other)" are GA4 telling us it could not attribute the session.
 * Storing them against a Page would attach real sessions to a page that does not
 * exist, so they are skipped and counted.
 */
export function landingPageToUrl(landingPage: string, hostname: string): string | null {
  const value = landingPage.trim();

  if (value.length === 0 || value.startsWith("(")) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (!value.startsWith("/")) return null;

  return `https://${hostname}${value}`;
}

export type Ga4SyncOptions = {
  /** Several pages, for the tests that prove memory stays bounded. */
  pages?: typeof streamLandingPageMetrics;
  /** How many rows are held at once. See GscSyncOptions.ingestChunk. */
  ingestChunk?: number;
  /** Days in the first cut of the period. See GscSyncOptions.windowDays. */
  windowDays?: number;
  /** The ceiling on provider requests for one sync. */
  maxRequests?: number;
  days?: number;
  now?: Date;
  source?: (params: {
    accessToken: string;
    propertyId: string;
    startDate: string;
    endDate: string;
  }) => Promise<Ga4Result>;
  accessTokenFor?: (connectionId: string) => Promise<string>;
};

/** GA4 → Ga4LandingPageMetricDaily, mapped onto existing Pages where possible. */
/** Chooses where a GA4 sync's rows come from. Same reasoning as gscStream. */
function ga4Stream(options: Ga4SyncOptions): typeof streamLandingPageMetrics {
  if (options.pages) return options.pages;

  const source = options.source;
  if (!source) return streamLandingPageMetrics;

  return async (params, onPage) => {
    const result = await source(params);
    if (result.rows.length > 0) await onPage(result.rows, result.availableMetrics);
    return { availableMetrics: result.availableMetrics, truncated: result.truncated };
  };
}

/**
 * Normalises one bounded piece of a GA4 page into the window's accumulator.
 *
 * Nothing is written here. GA4 reports the same page under several spellings
 * — with and without a query string, a trailing slash, an index file — that
 * the normalizer folds into one, and those spellings can arrive in different
 * provider pages and different chunks. A row written per chunk would let a
 * later chunk replace an earlier one for the same page and day, and for the
 * unique-user counts that is not even wrong in a recoverable way. So a
 * window's rows are gathered by grain and written once, when the window is
 * kept. What the accumulator holds is a few numbers per distinct page and
 * day, never the rows.
 */
function stageGa4Chunk(
  context: TenantContext,
  rows: Ga4Result["rows"],
  window: Ga4WindowState,
  tally: Tally,
  progress: StageTracker,
): void {
  progress.stage = "normalize";

  for (const row of rows) {
    const candidate = landingPageToUrl(row.landingPage, context.website.normalizedDomain);

    if (!candidate) {
      tally.skipped += 1;
      continue;
    }

    const url = normalizeUrl(candidate, context.website.normalizedDomain);

    if (!url.ok) {
      tally.skipped += 1;
      continue;
    }

    window.urls.set(url.value.normalized, url.value);
    window.accumulator.add(row.date, url.value.normalized, row.metrics);
  }
}

/** Everything a window gathers before it is kept or thrown away. */
type Ga4WindowState = {
  accumulator: Ga4WindowAccumulator;
  /** The pages seen, by normalized URL, for one bounded identity lookup each. */
  urls: Map<string, NormalizedUrl>;
};

/**
 * Writes a kept window: one row per page per day.
 *
 * Identities are resolved in bounded batches, so a window with many distinct
 * pages costs several small lookups rather than one enormous IN list. The
 * rows are then upserted in batches on the documented grain, exactly as a
 * replay of the same window would upsert them again.
 */
async function flushGa4Window(
  context: TenantContext,
  connection: Connection,
  snapshotId: string,
  window: Ga4WindowState,
  tally: Tally,
  progress: StageTracker,
): Promise<void> {
  const measurements = window.accumulator.drain();
  if (measurements.length === 0) return;

  progress.stage = "identity_lookup";
  const pageIds = new Map<string, string>();
  const urls = [...window.urls.values()];
  for (const batch of chunks(urls, INGEST_CHUNK)) {
    const resolved = await resolvePages(context.website.id, batch, "GOOGLE_ANALYTICS");
    for (const [url, id] of resolved) pageIds.set(url, id);
  }
  window.urls.clear();

  const insertRows: Ga4InsertRow[] = [];

  for (const measurement of measurements) {
    const pageId = pageIds.get(measurement.url);

    if (!pageId) {
      tally.skipped += measurement.rawRows;
      continue;
    }

    tally.seen += measurement.rawRows;
    noteDate(tally, measurement.date);

    insertRows.push({
      websiteId: context.website.id,
      pageId,
      date: measurement.date,
      sessions: measurement.sessions,
      engagedSessions: measurement.engagedSessions,
      users: measurement.users,
      newUsers: measurement.newUsers,
      keyEvents: measurement.keyEvents,
      revenue: measurement.revenue,
      connectionId: connection.id,
      snapshotId,
    });
  }

  progress.stage = "database_write";
  tally.written += await upsertGa4Rows(insertRows);
}
export async function runGa4Sync(
  context: TenantContext,
  options: Ga4SyncOptions = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const { connection, propertyId } = await connectionFor(context, "GOOGLE_ANALYTICS");
  const window = resolveSyncWindow(connection, { now, days: options.days });

  const { run, alreadyDone } = await claimRun(context, connection, "GA4_METRICS", window, now);

  if (alreadyDone) {
    return {
      run,
      status: run.status,
      window,
      received: run.recordsReceived,
      written: run.recordsWritten,
      skipped: run.recordsSkipped,
      reused: true,
    };
  }

  const progress = newStageTracker();

  try {
    progress.stage = "provider_fetch";
    const accessToken = await (options.accessTokenFor ?? getAccessToken)(connection.id);
    const stream = ga4Stream(options);

    progress.stage = "snapshot_open";
    const snapshotId = await beginSnapshot(context, connection, window);
    const tally = newTally();

    // Which metrics the property could report. Settled by the first window
    // and the same for every one after it.
    let availableMetrics: Ga4MetricName[] = [];

    // Held until the driver says whether this window is kept. For GA4 the
    // window's rows are held too — gathered by grain, not stored as rows —
    // and written only on acceptance, so a probe that is split never writes
    // and the same page's spellings across chunks become one measurement.
    let contribution: WindowContribution = null;
    let pending: Ga4WindowState | null = null;

    const outcome = await ingestByDateWindows(
      { startDate: window.startDate, endDate: window.endDate },
      async (slice) => {
        const mark = markTally(tally);
        const digest = newDigest();
        let rows = 0;
        let pages = 0;

        progress.stage = "provider_fetch";
        const result = await stream(
          {
            accessToken,
            propertyId,
            startDate: slice.startDate,
            endDate: slice.endDate,
          },
          // The metrics arrive with the page, because rows are written before
          // the read is over and each one has to know what this property
          // reports.
          async (batch, metrics) => {
            pages += 1;
            rows += batch.length;
            tally.received += batch.length;

            for (const row of batch) {
              foldDigest(
                digest,
                rowDigest(`${row.date}|${row.landingPage}|${row.metrics.sessions ?? ""}`),
              );
            }

            pending ??= { accumulator: new Ga4WindowAccumulator(metrics), urls: new Map() };
            for (const chunk of chunks(batch, options.ingestChunk)) {
              stageGa4Chunk(context, chunk, pending, tally, progress);
            }
            progress.stage = "provider_fetch";
          },
        );

        availableMetrics = result.availableMetrics;
        contribution = { mark, digest };

        return { rows, pages, truncated: result.truncated };
      },
      {
        initialDays: options.windowDays,
        maxRequests: options.maxRequests,
        onAccept: async () => {
          acceptWindow(tally, contribution);
          const kept = pending;
          pending = null;
          if (kept) await flushGa4Window(context, connection, snapshotId, kept, tally, progress);
        },
        onDiscard: () => {
          // Nothing was written for a probe, so there is nothing to undo in
          // the database; only the counters and the gathered rows go.
          discardWindow(tally, contribution);
          pending = null;
        },
      },
    );

    progress.stage = "snapshot_finalize";
    await finishSnapshot(snapshotId, tally, window, outcome, { availableMetrics });

    progress.stage = "sync_run_finalize";
    return await completeRun(context, connection, run, {
      window,
      received: tally.received,
      written: tally.written,
      skipped: tally.skipped,
      latestDate: tally.latestDate,
      partial: !outcome.complete,
      complete: outcome.complete,
      seen: tally.seen,
    });
  } catch (error) {
    const failure = fingerprintError(error, progress.stage);
    const failed = await failRun(run, error, { context, failure });

    return {
      run: failed,
      status: "FAILED",
      window,
      received: 0,
      written: 0,
      skipped: 0,
      reused: false,
      failure,
    };
  }
}

/**
 * Closes a run and, only then, advances the connection's freshness.
 *
 * PARTIAL rather than SUCCEEDED when the provider had more rows than the ceiling
 * allowed, or when some rows could not be placed: the period was read, but not
 * completely, and a later retry should be able to tell.
 */
async function completeRun(
  context: TenantContext,
  connection: Connection,
  run: SyncRun,
  result: {
    window: SyncWindow;
    received: number;
    written: number;
    skipped: number;
    latestDate: string | null;
    partial: boolean;
    /**
     * Whether the whole requested period was read.
     *
     * Distinct from `skipped`, which counts rows the provider gave us that
     * cannot be attributed to a page of this website — an app-store listing,
     * say. Those make a run PARTIAL but the period was still read completely,
     * so the data really is as fresh as it claims. A period that could not be
     * read completely is a different thing, and it is the one that must not
     * move the freshness dates.
     */
    complete: boolean;
    seen: number;
  },
): Promise<SyncOutcome> {
  const status: SyncStatus = result.partial || result.skipped > 0 ? "PARTIAL" : "SUCCEEDED";
  const finishedAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const stored = await tx.syncRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt,
        recordsReceived: result.received,
        recordsWritten: result.written,
        recordsSkipped: result.skipped,
        errorCode: null,
        errorSummary: null,
      },
    });

    await tx.connection.update({
      where: { id: connection.id },
      data: {
        // The provider answered, so whatever it was last complaining about is
        // over. This is about the connection working, not about the data being
        // complete, and the two are cleared on different conditions.
        lastError: null,

        // Freshness moves only when the whole requested period was read. A run
        // that could not finish has really written rows, and they are really
        // correct, but they are not the complete picture these dates claim — so
        // an incomplete period leaves them where they were, and the connection
        // goes on reporting the last date it can actually stand behind.
        ...(result.complete
          ? {
              lastSyncedAt: finishedAt,
              // Only moves forward, and only when rows actually arrived. A quiet
              // period with no data must not make the connection look newer.
              ...(result.latestDate &&
              (!connection.latestDataDate ||
                result.latestDate > connection.latestDataDate.toISOString().slice(0, 10))
                ? { latestDataDate: new Date(`${result.latestDate}T00:00:00.000Z`) }
                : {}),
            }
          : {}),
      },
    });

    await recordAudit(tx, context, {
      entityType: "SyncRun",
      entityId: stored.id,
      action: "CREATE",
      after: {
        provider: connection.provider,
        period: `${result.window.startDate}..${result.window.endDate}`,
        status,
        recordsReceived: result.received,
        recordsWritten: result.written,
        recordsSkipped: result.skipped,
      },
    });

    return stored;
  });

  return {
    run: updated,
    status,
    window: result.window,
    received: result.received,
    written: result.written,
    skipped: result.skipped,
    reused: false,
  };
}

export type SemrushSyncOptions = {
  now?: Date;
  /** Cost ceiling for one run. Rows are billed, so this is money, not throughput. */
  maxRows?: number;
  /** Injected in tests so parsing and error mapping run without a network. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
};

/**
 * Pulls this website's organic positions from Semrush (P2_SPEC §7 LIVE API MODE).
 *
 * Two things differ from the Google syncs, and both come from what the report
 * actually is.
 *
 * It has no date range. `domain_organic` answers "where does this domain rank
 * now", so the period is a single day — today — and the idempotency key follows.
 * Asking twice in one day is therefore free rather than merely safe, which
 * matters more here than for Search Console because every row costs API units.
 *
 * And it is not first-party. Search Console reports what Google recorded about
 * traffic that really happened; Semrush reports its own crawl of the SERP, on its
 * own cadence. So rows land in the P2 snapshot tables with `sourceProvider` set
 * and go through the same `persistMarketRows` path as an uploaded export — never
 * into the GSC tables, and never presented as a measurement of this site.
 */
export async function runSemrushSync(
  context: TenantContext,
  options: SemrushSyncOptions = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const today = isoDate(now);

  // A point-in-time report, so the window is one day rather than a range.
  const window: SyncWindow = { startDate: today, endDate: today };

  const connection = await prisma.connection.findFirst({
    where: { provider: "SEMRUSH", ...websiteScope(context) },
  });

  if (!connection || connection.status === "NOT_CONNECTED") {
    throw new SyncError("Semrush is not connected.", "not_connected");
  }

  const { run, alreadyDone } = await claimRun(context, connection, "SEMRUSH_ORGANIC", window, now);

  if (alreadyDone) {
    return {
      run,
      status: run.status,
      window,
      received: run.recordsReceived,
      written: run.recordsWritten,
      skipped: run.recordsSkipped,
      reused: true,
    };
  }

  try {
    const database = databaseForMarket(context.website.primaryMarket);

    if (!database) {
      // Guessing a database would attribute another country's search volumes to
      // this site, which is worse than refusing to run.
      throw new SyncError("This website has no primary market set.", "no_market");
    }

    const apiKey = await getApiKey(connection.id);

    const result = await fetchOrganicPositions({
      apiKey,
      domain: context.website.normalizedDomain,
      database,
      maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
    });

    const snapshotId = await recordSnapshot(context, connection, window, {
      rowsReceived: result.rows.length,
      // Hashed over the identities returned, not the response body: the body is
      // large and the point is only to tell one pull from another.
      checksumSource: result.rows
        .map((row) => `${row.normalizedKeyword}:${row.position}`)
        .join("\n"),
      extra: {
        database,
        truncated: result.truncated,
        malformedRows: result.malformed,
        // Named so a silently dropped provider column is visible in the record
        // rather than showing up as every row having no difficulty score.
        missingColumns: result.missingColumns,
      },
    });

    const written = await persistMarketRows(context, result.rows, {
      provider: "SEMRUSH",
      attribution: { kind: "connection", connectionId: connection.id, snapshotId },
      // Semrush stamps each row; this covers a row whose timestamp was unreadable.
      fallbackCapturedAt: today,
      mode: "keywords",
    });

    return completeRun(context, connection, run, {
      window,
      received: result.rows.length,
      written: written.rankingsWritten + written.metricsWritten,
      skipped: result.malformed,
      latestDate: result.rows.length > 0 ? today : null,
      // Hitting our own row ceiling is a partial answer, and saying so is the
      // difference between "this is the whole picture" and "this is what we paid
      // for".
      partial: result.truncated,
      // The period asked for is a single day and it was read. "Truncated"
      // here means our own row ceiling, which is a cost decision rather than
      // a gap in the period, so freshness still advances as it always has.
      complete: true,
      seen: result.rows.length,
    });
  } catch (error) {
    const failed = await failRun(run, error);

    return {
      run: failed,
      status: "FAILED",
      window,
      received: 0,
      written: 0,
      skipped: 0,
      reused: false,
    };
  }
}

export type AhrefsSyncOptions = {
  now?: Date;
  /** Row ceiling for one run. Rows consume API units, so this is money. */
  limit?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Pulls this website's organic keywords from Ahrefs (P2_SPEC §7, second provider).
 *
 * Structurally the twin of the Semrush sync — point-in-time report, one-day
 * window, same idempotency key shape, same shared write path — and deliberately
 * so: the two vendors disagree about volumes and difficulty, and the product's
 * answer to that is to store both readings side by side under their own provider
 * and let `provider-precedence` decide what to show. That only works if both
 * arrive through identical machinery.
 *
 * What it does not do is reconcile them. Neither snapshot overwrites the other,
 * because their disagreement is a fact rather than a conflict to resolve.
 */
export async function runAhrefsSync(
  context: TenantContext,
  options: AhrefsSyncOptions = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const today = isoDate(now);

  const window: SyncWindow = { startDate: today, endDate: today };

  const connection = await prisma.connection.findFirst({
    where: { provider: "AHREFS", ...websiteScope(context) },
  });

  if (!connection || connection.status === "NOT_CONNECTED") {
    throw new SyncError("Ahrefs is not connected.", "not_connected");
  }

  const { run, alreadyDone } = await claimRun(context, connection, "AHREFS_ORGANIC", window, now);

  if (alreadyDone) {
    return {
      run,
      status: run.status,
      window,
      received: run.recordsReceived,
      written: run.recordsWritten,
      skipped: run.recordsSkipped,
      reused: true,
    };
  }

  try {
    const country = countryForMarket(context.website.primaryMarket);

    if (!country) {
      throw new SyncError("This website has no primary market set.", "no_market");
    }

    const apiKey = await getApiKey(connection.id);

    const result = await fetchOrganicKeywords({
      apiKey,
      target: context.website.normalizedDomain,
      country,
      // The API requires a date and reports as of it.
      date: today,
      limit: options.limit ?? AHREFS_DEFAULT_LIMIT,
      fetchImpl: options.fetchImpl,
    });

    const snapshotId = await recordSnapshot(context, connection, window, {
      rowsReceived: result.rows.length,
      checksumSource: result.rows
        .map((row) => `${row.normalizedKeyword}:${row.position}`)
        .join("\n"),
      extra: {
        country,
        truncated: result.truncated,
        malformedRows: result.malformed,
        // A field the vendor stopped returning shows here, rather than as a
        // column that is empty for reasons nobody can explain.
        missingFields: result.missingFields,
      },
    });

    const written = await persistMarketRows(context, result.rows, {
      provider: "AHREFS",
      attribution: { kind: "connection", connectionId: connection.id, snapshotId },
      // This endpoint dates the report rather than each row, so every row in the
      // batch is as of the date we asked for.
      fallbackCapturedAt: today,
      mode: "keywords",
    });

    return completeRun(context, connection, run, {
      window,
      received: result.rows.length,
      written: written.rankingsWritten + written.metricsWritten,
      skipped: result.malformed,
      latestDate: result.rows.length > 0 ? today : null,
      partial: result.truncated,
      // The period asked for is a single day and it was read. "Truncated"
      // here means our own row ceiling, which is a cost decision rather than
      // a gap in the period, so freshness still advances as it always has.
      complete: true,
      seen: result.rows.length,
    });
  } catch (error) {
    const failed = await failRun(run, error);

    return {
      run: failed,
      status: "FAILED",
      window,
      received: 0,
      written: 0,
      skipped: 0,
      reused: false,
    };
  }
}

/** Recent runs for a website, newest first. */
export async function listSyncRuns(context: TenantContext, limit = 20): Promise<SyncRun[]> {
  return prisma.syncRun.findMany({
    where: websiteScope(context),
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
