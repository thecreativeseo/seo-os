import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import type { Connection, SyncRun, SyncStatus, SyncType } from "@/generated/prisma/client";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { getAccessToken } from "@/server/services/connection-auth";
import { normalizeUrl } from "@/lib/url/normalize-url";
import { normalizeQuery } from "@/lib/query/normalize-query";
import { EXPECTED_LAG_DAYS } from "@/lib/metrics/compare";
import {
  fetchSearchAnalytics,
  SearchConsoleError,
  type SearchAnalyticsResult,
} from "@/server/connectors/google/search-console";
import {
  AnalyticsError,
  fetchLandingPageMetrics,
  type Ga4MetricName,
  type Ga4Result,
} from "@/server/connectors/google/analytics";
import {
  DEFAULT_MAX_ROWS,
  SemrushError,
  databaseForMarket,
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
  | "no_market";

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

  if (
    error instanceof SearchConsoleError ||
    error instanceof AnalyticsError ||
    error instanceof SemrushError ||
    error instanceof AhrefsError
  ) {
    // Each connector's codes are a subset of ours by construction, so the union
    // above stays exhaustive rather than needing a mapping table per vendor.
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
};

async function connectionFor(
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
async function claimRun(
  context: TenantContext,
  connection: Connection,
  syncType: SyncType,
  window: SyncWindow,
  now: Date,
): Promise<{ run: SyncRun; alreadyDone: boolean }> {
  const idempotencyKey = idempotencyKeyFor(syncType, window);

  const existing = await prisma.syncRun.findUnique({
    where: { connectionId_idempotencyKey: { connectionId: connection.id, idempotencyKey } },
  });

  if (existing?.status === "SUCCEEDED") {
    return { run: existing, alreadyDone: true };
  }

  if (existing?.status === "RUNNING") {
    const startedAt = existing.startedAt ?? existing.createdAt;
    const ageMinutes = (now.getTime() - startedAt.getTime()) / 60_000;

    // A process that died mid-run would otherwise lock the period forever.
    if (ageMinutes < STALE_RUN_MINUTES) {
      throw new SyncError("A sync for this period is already running.", "already_running");
    }
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

async function failRun(run: SyncRun, error: unknown): Promise<SyncRun> {
  const code = errorCodeFor(error);

  return prisma.syncRun.update({
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
}

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
      // Counts and periods only. The spec is explicit that a snapshot never holds
      // tokens, and the response body itself is not retained in this phase.
      metadataJson: { rowsReceived: payload.rowsReceived, ...payload.extra },
    },
  });

  return snapshot.id;
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
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
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
        'ALL',
        'ALL',
        'WEB'::"SearchType",
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
  /** Injected in tests so the whole lifecycle runs without a network. */
  source?: (params: {
    accessToken: string;
    propertyId: string;
    startDate: string;
    endDate: string;
  }) => Promise<SearchAnalyticsResult>;
  accessTokenFor?: (connectionId: string) => Promise<string>;
};

/** Search Console → Page, Query, GscMetricDaily. */
export async function runGscSync(
  context: TenantContext,
  options: GscSyncOptions = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const { connection, propertyId } = await connectionFor(context, "GOOGLE_SEARCH_CONSOLE");
  const window = resolveSyncWindow(connection, { now, days: options.days });

  const { run, alreadyDone } = await claimRun(
    context,
    connection,
    "GSC_METRICS",
    window,
    now,
  );

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
    const accessToken = await (options.accessTokenFor ?? getAccessToken)(connection.id);
    const fetchRows = options.source ?? fetchSearchAnalytics;

    const result = await fetchRows({
      accessToken,
      propertyId,
      startDate: window.startDate,
      endDate: window.endDate,
    });

    const snapshotId = await recordSnapshot(context, connection, window, {
      rowsReceived: result.rows.length,
      checksumSource: result.rows
        .map((row) => `${row.date}|${row.page}|${row.query}|${row.clicks}|${row.impressions}`)
        .join("\n"),
      extra: { truncated: result.truncated },
    });

    // Normalize first, so a row that cannot be placed is counted as skipped rather
    // than stored against a guessed identity.
    const urls = new Map<string, { normalized: string; hostname: string; protocol: string; path: string }>();
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
    let skipped = 0;

    for (const row of result.rows) {
      const url = normalizeUrl(row.page, context.website.normalizedDomain);
      const query = normalizeQuery(row.query);

      if (!url.ok || !query.ok) {
        skipped += 1;
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
        skipped += 1;
        continue;
      }

      insertRows.push({
        websiteId: context.website.id,
        pageId,
        queryId,
        date: row.date,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        connectionId: connection.id,
        snapshotId,
      });
    }

    const written = await upsertGscRows(insertRows);
    const latestDate = staged.reduce<string | null>(
      (latest, row) => (latest === null || row.date > latest ? row.date : latest),
      null,
    );

    return await completeRun(context, connection, run, {
      window,
      received: result.rows.length,
      written,
      skipped,
      latestDate,
      partial: result.truncated,
      seen: staged.length,
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
export async function runGa4Sync(
  context: TenantContext,
  options: Ga4SyncOptions = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const { connection, propertyId } = await connectionFor(context, "GOOGLE_ANALYTICS");
  const window = resolveSyncWindow(connection, { now, days: options.days });

  const { run, alreadyDone } = await claimRun(
    context,
    connection,
    "GA4_METRICS",
    window,
    now,
  );

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
    const accessToken = await (options.accessTokenFor ?? getAccessToken)(connection.id);
    const fetchRows = options.source ?? fetchLandingPageMetrics;

    const result = await fetchRows({
      accessToken,
      propertyId,
      startDate: window.startDate,
      endDate: window.endDate,
    });

    const snapshotId = await recordSnapshot(context, connection, window, {
      rowsReceived: result.rows.length,
      checksumSource: result.rows
        .map((row) => `${row.date}|${row.landingPage}|${row.metrics.sessions ?? ""}`)
        .join("\n"),
      extra: {
        availableMetrics: result.availableMetrics,
        truncated: result.truncated,
      },
    });

    const urls = new Map<string, { normalized: string; hostname: string; protocol: string; path: string }>();
    const staged: { date: string; url: string; metrics: Ga4Result["rows"][number]["metrics"] }[] = [];
    let skipped = 0;

    for (const row of result.rows) {
      const candidate = landingPageToUrl(row.landingPage, context.website.normalizedDomain);

      if (!candidate) {
        skipped += 1;
        continue;
      }

      const url = normalizeUrl(candidate, context.website.normalizedDomain);

      if (!url.ok) {
        skipped += 1;
        continue;
      }

      urls.set(url.value.normalized, url.value);
      staged.push({ date: row.date, url: url.value.normalized, metrics: row.metrics });
    }

    const pageIds = await resolvePages(
      context.website.id,
      [...urls.values()],
      "GOOGLE_ANALYTICS",
    );

    // A metric this property cannot report stays null for every row. Reading it off
    // the row alone would store null for a page that simply had none that day,
    // which is a different fact.
    const measured = new Set(result.availableMetrics);
    const valueOf = (
      metrics: Ga4Result["rows"][number]["metrics"],
      name: Ga4MetricName,
    ): number | null => (measured.has(name) ? (metrics[name] ?? 0) : null);

    const insertRows: Ga4InsertRow[] = [];

    for (const row of staged) {
      const pageId = pageIds.get(row.url);

      if (!pageId) {
        skipped += 1;
        continue;
      }

      insertRows.push({
        websiteId: context.website.id,
        pageId,
        date: row.date,
        sessions: valueOf(row.metrics, "sessions"),
        engagedSessions: valueOf(row.metrics, "engagedSessions"),
        users: valueOf(row.metrics, "totalUsers"),
        newUsers: valueOf(row.metrics, "newUsers"),
        keyEvents: valueOf(row.metrics, "keyEvents"),
        revenue: valueOf(row.metrics, "totalRevenue"),
        connectionId: connection.id,
        snapshotId,
      });
    }

    const written = await upsertGa4Rows(insertRows);
    const latestDate = staged.reduce<string | null>(
      (latest, row) => (latest === null || row.date > latest ? row.date : latest),
      null,
    );

    return await completeRun(context, connection, run, {
      window,
      received: result.rows.length,
      written,
      skipped,
      latestDate,
      partial: result.truncated,
      seen: staged.length,
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
        lastSyncedAt: finishedAt,
        // Only moves forward, and only when rows actually arrived. A quiet period
        // with no data must not make the connection look newer than it is.
        ...(result.latestDate &&
        (!connection.latestDataDate ||
          result.latestDate > connection.latestDataDate.toISOString().slice(0, 10))
          ? { latestDataDate: new Date(`${result.latestDate}T00:00:00.000Z`) }
          : {}),
        lastError: null,
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

  const { run, alreadyDone } = await claimRun(
    context,
    connection,
    "SEMRUSH_ORGANIC",
    window,
    now,
  );

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
      checksumSource: result.rows.map((row) => `${row.normalizedKeyword}:${row.position}`).join("\n"),
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
export async function listSyncRuns(
  context: TenantContext,
  limit = 20,
): Promise<SyncRun[]> {
  return prisma.syncRun.findMany({
    where: websiteScope(context),
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
