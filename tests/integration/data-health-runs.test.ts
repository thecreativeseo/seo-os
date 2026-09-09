import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  RUNS_PER_PAGE,
  listSyncRunPage,
  normalizeRunsPage,
  runFailureNote,
  runsPageWindow,
} from "@/server/services/data-health";
import { registerOrganizations } from "../helpers/teardown";

/**
 * Data Health, Recent runs (P1 observability).
 *
 * The table grows for as long as the website exists and every attempt is kept,
 * so the page shows three at a time. Two things then have to hold that did not
 * have to hold before: the paging must happen in the database rather than in
 * React, and a page number arriving from a URL — which is to say, from anyone —
 * must never be able to produce a crash or an empty table.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

let tenant: TenantContext;
let other: TenantContext;

/** Runs are seeded oldest first, so the newest is the last one created. */
const SEEDED = 8;

beforeAll(async () => {
  tenant = await makeTenant("runs");
  other = await makeTenant("nosey");

  const connection = await connect(tenant);
  for (let index = 0; index < SEEDED; index += 1) {
    await seedRun(tenant, connection.id, {
      startedAt: new Date(Date.UTC(2026, 8, 1, index, 0, 0)),
      status: index % 3 === 0 ? "FAILED" : "SUCCEEDED",
      errorCode: index % 3 === 0 ? "stale_run_recovered" : null,
    });
  }
}, 120_000);

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
}, 60_000);

async function makeTenant(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `dh-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Data health ${label}`, slug: `dh-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);
  registerOrganizations([organization.id]);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: "OWNER",
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });

  const host = `${label}-${suffix}.example.com`;
  const website = await prisma.website.create({
    data: { workspaceId: workspace.id, domain: host, normalizedDomain: host },
  });

  return { user, membership, organization, workspace, website };
}

async function connect(context: TenantContext) {
  return prisma.connection.create({
    data: {
      websiteId: context.website.id,
      workspaceId: context.workspace.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      status: "CONNECTED",
      externalPropertyId: `sc-domain:${context.website.normalizedDomain}`,
      externalPropertyName: "Test property",
    },
  });
}

async function seedRun(
  context: TenantContext,
  connectionId: string,
  run: {
    startedAt: Date | null;
    status: "SUCCEEDED" | "FAILED" | "RUNNING" | "QUEUED";
    errorCode?: string | null;
  },
) {
  return prisma.syncRun.create({
    data: {
      websiteId: context.website.id,
      connectionId,
      provider: "GOOGLE_SEARCH_CONSOLE",
      syncType: "GSC_METRICS",
      status: run.status,
      startedAt: run.startedAt,
      idempotencyKey: crypto.randomUUID(),
      ...(run.errorCode
        ? { errorCode: run.errorCode, errorSummary: "A previous run was interrupted." }
        : {}),
    },
  });
}

describe("paging through the run history", () => {
  it("shows three at a time, newest first", async () => {
    const page = await listSyncRunPage(tenant, "1");

    expect(page.perPage).toBe(RUNS_PER_PAGE);
    expect(page.runs).toHaveLength(3);
    expect(page.total).toBe(SEEDED);
    expect(page.page).toBe(1);
    expect(page.pageCount).toBe(3);

    const started = page.runs.map((run) => run.startedAt!.toISOString());
    expect(started).toEqual([...started].sort().reverse());
    // The newest seeded run is hour 7.
    expect(page.runs[0]!.startedAt!.getUTCHours()).toBe(SEEDED - 1);
  });

  it("gives the next three on page two, with no row seen twice", async () => {
    const first = await listSyncRunPage(tenant, "1");
    const second = await listSyncRunPage(tenant, "2");

    expect(second.runs).toHaveLength(3);
    expect(second.page).toBe(2);

    const overlap = second.runs.filter((run) => first.runs.some((seen) => seen.id === run.id));
    expect(overlap).toEqual([]);

    // Page two continues where page one stopped rather than restarting.
    expect(second.runs[0]!.startedAt!.getTime()).toBeLessThan(first.runs[2]!.startedAt!.getTime());
  });

  it("gives the remainder on the last page", async () => {
    const last = await listSyncRunPage(tenant, "3");

    // Eight runs in threes: three, three, two.
    expect(last.runs).toHaveLength(2);
    expect(last.page).toBe(3);
    expect(last.pageCount).toBe(3);
  });

  it("counts every run, not just the ones on this page", async () => {
    const page = await listSyncRunPage(tenant, "2");

    expect(page.total).toBe(SEEDED);
    expect(page.runs.length).toBeLessThan(page.total);
  });

  it("reads only one page from the database", async () => {
    // The guarantee is take/skip, not filtering in memory: a page can never
    // contain more rows than it is allowed to show, however long the history.
    for (const requested of ["1", "2", "3"]) {
      const page = await listSyncRunPage(tenant, requested);
      expect(page.runs.length).toBeLessThanOrEqual(RUNS_PER_PAGE);
    }
  });

  it("puts a run that is happening now on the first page", async () => {
    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: tenant.website.id },
    });
    const live = await seedRun(tenant, connection.id, { startedAt: null, status: "QUEUED" });

    try {
      const page = await listSyncRunPage(tenant, "1");
      // A run with no start time has not started; it is what the pipeline is
      // doing right now, and burying it under yesterday would be a strange
      // answer to "what is happening".
      expect(page.runs[0]!.id).toBe(live.id);
      expect(page.total).toBe(SEEDED + 1);
    } finally {
      await prisma.syncRun.delete({ where: { id: live.id } });
    }
  });
});

describe("a page number arriving from a URL", () => {
  const cases: [string, string | string[] | undefined, number][] = [
    ["nothing at all", undefined, 1],
    ["an empty string", "", 1],
    ["zero", "0", 1],
    ["a negative number", "-4", 1],
    ["a fraction", "1.5", 1],
    ["words", "abc", 1],
    ["scientific notation", "1e3", 1],
    ["an injection attempt", "1; DROP TABLE sync_run", 1],
    ["a repeated parameter", ["2", "3"], 2],
    ["a number past the end", "9999", 3],
    ["an absurd number", "999999999999999999999", 3],
  ];

  for (const [label, raw, expected] of cases) {
    it(`normalizes ${label} to a page that exists`, () => {
      expect(normalizeRunsPage(raw, 3)).toBe(expected);
    });
  }

  it("returns the last page rather than an empty table when asked past the end", async () => {
    const page = await listSyncRunPage(tenant, "500");

    expect(page.page).toBe(page.pageCount);
    expect(page.runs.length).toBeGreaterThan(0);
  });

  it("is safe on a website with no runs at all", async () => {
    const page = await listSyncRunPage(other, "7");

    expect(page.runs).toEqual([]);
    expect(page.total).toBe(0);
    // One empty page, not zero pages: "Showing 0 of 0" still needs a page to be on.
    expect(page.pageCount).toBe(1);
    expect(page.page).toBe(1);
  });
});

describe("what a failed row says", () => {
  it("is one short phrase for a recovered orphan", () => {
    const note = runFailureNote({
      errorCode: "stale_run_recovered",
      errorSummary:
        "A previous run was interrupted before it finished and has been marked failed. The figures above are unchanged.",
    });

    expect(note).toBe("Interrupted before completion");
    // The long version is said once above the table instead of on every row.
    expect(note).not.toContain("figures above are unchanged");
  });

  it("keeps a genuinely different failure's own words", () => {
    expect(
      runFailureNote({
        errorCode: "rate_limited",
        errorSummary: "The provider is rate limiting us.",
      }),
    ).toBe("The provider is rate limiting us.");

    expect(
      runFailureNote({ errorCode: "reauth_required", errorSummary: "Reconnect this provider." }),
    ).toBe("Reconnect this provider.");
  });

  it("says nothing when a run did not fail", () => {
    expect(runFailureNote({ errorCode: null, errorSummary: null })).toBeNull();
  });

  it("leaves the stored history exactly as it was", async () => {
    // The compaction happens when the row is drawn. Rewriting what was recorded
    // would destroy the record of what actually happened.
    const stored = await prisma.syncRun.findFirstOrThrow({
      where: { websiteId: tenant.website.id, errorCode: "stale_run_recovered" },
    });

    expect(stored.errorSummary).toBe("A previous run was interrupted.");
    expect(stored.errorCode).toBe("stale_run_recovered");
  });
});

describe("tenant isolation", () => {
  it("never pages into another website's runs", async () => {
    const mine = await listSyncRunPage(tenant, "1");
    const theirs = await listSyncRunPage(other, "1");

    expect(theirs.runs).toEqual([]);
    expect(theirs.total).toBe(0);

    const ids = new Set(mine.runs.map((run) => run.id));
    for (const run of theirs.runs) expect(ids.has(run.id)).toBe(false);
  });

  it("counts only this website's history", async () => {
    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: tenant.website.id },
    });
    await seedRun(tenant, connection.id, { startedAt: new Date(), status: "SUCCEEDED" });

    const theirs = await listSyncRunPage(other, "1");
    expect(theirs.total).toBe(0);
  });

  it("preserves every run it was given", async () => {
    const total = await prisma.syncRun.count({ where: { websiteId: tenant.website.id } });
    const page = await listSyncRunPage(tenant, "1");

    expect(page.total).toBe(total);
  });
});

describe("which page numbers to offer", () => {
  it("offers every page while there are few of them", () => {
    expect(runsPageWindow(1, 1)).toEqual([1]);
    expect(runsPageWindow(2, 3)).toEqual([1, 2, 3]);
    expect(runsPageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("collapses the distance to the ends once there are many", () => {
    // A website syncing hourly passes a thousand pages within six weeks, and a
    // row of a thousand links is neither usable nor small.
    expect(runsPageWindow(50, 400)).toEqual([1, "gap", 48, 49, 50, 51, 52, "gap", 400]);
    expect(runsPageWindow(1, 400)).toEqual([1, 2, 3, "gap", 400]);
    expect(runsPageWindow(400, 400)).toEqual([1, "gap", 398, 399, 400]);
  });

  it("never hides a single page behind a gap", () => {
    // A gap standing for one page is wider than the number it replaces.
    const steps = runsPageWindow(5, 9);
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(steps).not.toContain("gap");
  });

  it("always keeps the first page, the last page and the current one", () => {
    for (const [page, count] of [
      [1, 1],
      [1, 2],
      [7, 13],
      [2, 999],
      [998, 999],
      [500, 1000],
    ] as const) {
      const steps = runsPageWindow(page, count);
      expect(steps).toContain(1);
      expect(steps).toContain(count);
      expect(steps).toContain(page);

      // Ascending, with no page offered twice.
      const numbers = steps.filter((step): step is number => step !== "gap");
      expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b));
      // Short enough to read at any history length.
      expect(steps.length).toBeLessThanOrEqual(9);
    }
  });
});
