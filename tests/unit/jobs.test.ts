import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAILY_CRON,
  connectionSyncPayload,
  dailySyncPayload,
  isRetryableSyncFailure,
  resolveDailyCron,
  websiteSyncPayload,
} from "@/server/jobs/definitions";
import {
  DEFAULT_QUEUE_SCHEMA,
  isManualSyncProvider,
  manualSyncKey,
  resolveQueueSchema,
} from "@/server/jobs/names";
import { JOB_NAMES } from "@/server/jobs/queue";

describe("the daily cron setting", () => {
  it("defaults to 03:00 UTC when nothing is set", () => {
    expect(resolveDailyCron(undefined)).toBe(DEFAULT_DAILY_CRON);
    expect(resolveDailyCron("")).toBe(DEFAULT_DAILY_CRON);
    expect(resolveDailyCron("   ")).toBe(DEFAULT_DAILY_CRON);
    expect(DEFAULT_DAILY_CRON).toBe("0 3 * * *");
  });

  it("accepts a five-field expression and trims it", () => {
    expect(resolveDailyCron(" 30 4 * * 1-5 ")).toBe("30 4 * * 1-5");
  });

  it("refuses anything that is not five fields, so a typo fails at start-up", () => {
    expect(() => resolveDailyCron("every day")).toThrow(/five-field/);
    expect(() => resolveDailyCron("0 3 * *")).toThrow(/five-field/);
    expect(() => resolveDailyCron("0 3 * * * *")).toThrow(/five-field/);
  });
});

describe("job payloads", () => {
  it("only accepts a website id that is a uuid", () => {
    expect(websiteSyncPayload.safeParse({ websiteId: "not-a-uuid" }).success).toBe(false);
    expect(websiteSyncPayload.safeParse({}).success).toBe(false);

    const parsed = websiteSyncPayload.safeParse({
      websiteId: "0b1f3f4e-8f7a-4f0e-9d3b-2c2f9a1e5b77",
      requestedAt: "2026-09-04T03:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("lets a cron-fired daily job carry no data at all", () => {
    expect(dailySyncPayload.safeParse(null).success).toBe(true);
    expect(dailySyncPayload.safeParse(undefined).success).toBe(true);
    expect(dailySyncPayload.safeParse({}).success).toBe(true);
    expect(dailySyncPayload.safeParse({ reason: "SYNC_ON_START" }).success).toBe(true);
  });

  it("names queues the way the spec does", () => {
    expect(JOB_NAMES.SYNC_DAILY).toBe("sync.daily");
    expect(JOB_NAMES.WEBSITE_SYNC).toBe("website.sync");
    expect(JOB_NAMES.CONNECTION_SYNC).toBe("connection.sync");
  });

  it("only accepts a manual sync for a provider a person can sync by hand", () => {
    const websiteId = "0b1f3f4e-8f7a-4f0e-9d3b-2c2f9a1e5b77";

    expect(
      connectionSyncPayload.safeParse({ websiteId, provider: "GOOGLE_SEARCH_CONSOLE" }).success,
    ).toBe(true);
    expect(
      connectionSyncPayload.safeParse({
        websiteId,
        provider: "GOOGLE_ANALYTICS",
        requestedByUserId: websiteId,
        requestedAt: "2026-09-08T01:00:00.000Z",
      }).success,
    ).toBe(true);
    // Semrush is billed per row and pulled by the daily job on purpose.
    expect(connectionSyncPayload.safeParse({ websiteId, provider: "SEMRUSH" }).success).toBe(false);
    expect(
      connectionSyncPayload.safeParse({ websiteId: "nope", provider: "GOOGLE_ANALYTICS" }).success,
    ).toBe(false);
  });
});

describe("what a manual sync retries", () => {
  it("retries a busy or unreachable provider and an unclassified failure", () => {
    for (const code of [
      "rate_limited",
      "upstream_error",
      "request_failed",
      "unknown",
      "already_running",
    ]) {
      expect(isRetryableSyncFailure(code)).toBe(true);
    }
  });

  it("never loops on a credential, property, permission or quota problem", () => {
    for (const code of [
      "reauth_required",
      "no_credential",
      "permission_denied",
      "property_not_found",
      "no_property",
      "not_connected",
      "invalid_response",
      "invalid_key",
      "quota_exhausted",
      "stale_run_recovered",
      "forbidden",
    ]) {
      expect(isRetryableSyncFailure(code)).toBe(false);
    }
    expect(isRetryableSyncFailure(null)).toBe(false);
    expect(isRetryableSyncFailure(undefined)).toBe(false);
  });
});

describe("naming the queue and its schema", () => {
  it("keys a manual sync by website and provider, so one connection is one logical sync", () => {
    expect(manualSyncKey("w", "GOOGLE_ANALYTICS")).toBe("w:GOOGLE_ANALYTICS");
    expect(isManualSyncProvider("GOOGLE_SEARCH_CONSOLE")).toBe(true);
    expect(isManualSyncProvider("SEMRUSH")).toBe(false);
  });

  it("defaults the schema and refuses one that is not a plain identifier", () => {
    expect(resolveQueueSchema(undefined)).toBe(DEFAULT_QUEUE_SCHEMA);
    expect(resolveQueueSchema("")).toBe("pgboss");
    expect(resolveQueueSchema(" pgboss_local ")).toBe("pgboss_local");
    // The value is interpolated into SQL by the job-table readers.
    expect(() => resolveQueueSchema("pgboss; drop schema public")).toThrow(/identifier/);
    expect(() => resolveQueueSchema("PgBoss")).toThrow(/identifier/);
  });
});
