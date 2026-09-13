import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { shiftMonth } from "@/lib/gsc/retention";
import { planGscRetentionDryRun } from "@/server/services/gsc-retention";
import { recomputeGscRollups } from "@/server/services/gsc-rollups";
import { registerOrganizations } from "../helpers/teardown";

/**
 * The retention dry run against the real database (P1 GSC raw retention).
 *
 * Fixtures hold sixteen months of raw for a website whose latestDataDate is in
 * the sixteenth, so the two oldest months are candidates. The dry run must
 * prove each candidate against its rollups and say SAFE only when every proof
 * holds, block a month whose rollup is missing or wrong, refuse to call a month
 * safe while another website's copy of it is not, and — above all — change
 * nothing.
 */

const organizationIds: string[] = [];

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  await prisma.$disconnect();
}, 60_000);

type Fixture = { context: TenantContext; connectionId: string; host: string };

async function makeFixture(label: string, latestDataDate: string | null): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const organization = await prisma.organization.create({
    data: { name: `Retention ${label}`, slug: `retain-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);
  registerOrganizations([organization.id]);
  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });
  const host = `${label}-${suffix}.example.com`;
  const website = await prisma.website.create({
    data: { workspaceId: workspace.id, domain: host, normalizedDomain: host },
  });
  const connection = await prisma.connection.create({
    data: {
      websiteId: website.id,
      workspaceId: workspace.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      status: "CONNECTED",
      externalPropertyId: `sc-domain:${host}`,
      externalPropertyName: "Test property",
      latestDataDate: latestDataDate ? new Date(latestDataDate) : null,
    },
  });
  // The dry run reads the website; the actor fields are not consulted.
  const context = { website, workspace, organization } as TenantContext;
  return { context, connectionId: connection.id, host };
}

/** Two rows per month (one page, two queries) on the 5th and 20th, for each month given. */
async function seedMonths(fixture: Fixture, months: string[]) {
  const { context, connectionId, host } = fixture;
  const page = await prisma.page.create({
    data: {
      websiteId: context.website.id,
      url: `https://${host}/a`,
      normalizedUrl: `https://${host}/a`,
      path: "/a",
      hostname: host,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });
  const queries = await Promise.all(
    ["alpha", "beta"].map((query) =>
      prisma.query.create({
        data: { websiteId: context.website.id, query, normalizedQuery: query },
      }),
    ),
  );
  const rows = [];
  for (const month of months) {
    for (const day of ["05", "20"]) {
      const date = `${month.slice(0, 7)}-${day}`;
      for (const [index, query] of queries.entries()) {
        rows.push({
          websiteId: context.website.id,
          pageId: page.id,
          queryId: query.id,
          date: new Date(date),
          clicks: 3 + index,
          impressions: 100 + index * 50,
          ctr: (3 + index) / (100 + index * 50),
          position: 4 + index,
          sourceConnectionId: connectionId,
        });
      }
    }
  }
  await prisma.gscMetricDaily.createMany({ data: rows });
  await recomputeGscRollups(context, { startDate: `${months[0]!.slice(0, 7)}-01`, endDate: shiftMonth(months[months.length - 1]!, 1) });
  return { pageId: page.id, queryIds: queries.map((query) => query.id) };
}

const MONTHS = Array.from({ length: 16 }, (_, index) => shiftMonth("2025-06-01", index));
const LATEST = "2026-09-10";

async function snapshot(websiteId: string) {
  const [raw, pageDays, monthly] = await Promise.all([
    prisma.gscMetricDaily.count({ where: { websiteId } }),
    prisma.gscPageDaily.count({ where: { websiteId } }),
    prisma.gscQueryPageMonthly.count({ where: { websiteId } }),
  ]);
  return { raw, pageDays, monthly };
}

describe("the dry run", () => {
  it("names the two oldest months candidates, proves them, and says SAFE — without changing a row", async () => {
    const fixture = await makeFixture("safe", LATEST);
    await seedMonths(fixture, MONTHS);
    const before = await snapshot(fixture.context.website.id);

    const run = await planGscRetentionDryRun({ websiteIds: [fixture.context.website.id] });

    expect(run.verdict).toBe("SAFE");
    expect(run.latestDataDate).toBe(LATEST);
    expect(run.retainedFrom).toBe("2025-08-01");
    const decisions = Object.fromEntries(run.records.map((r) => [r.month, r.decision]));
    expect(decisions["2025-06-01"]).toBe("CANDIDATE_FOR_PURGE");
    expect(decisions["2025-07-01"]).toBe("CANDIDATE_FOR_PURGE");
    expect(decisions["2025-08-01"]).toBe("KEEP_RETENTION_WINDOW");
    expect(decisions["2026-08-01"]).toBe("KEEP_RETENTION_WINDOW");
    expect(decisions["2026-09-01"]).toBe("KEEP_CURRENT_PARTIAL");
    expect(run.records.filter((r) => r.decision === "CANDIDATE_FOR_PURGE").every((r) => r.rollupEquality === "EQUAL")).toBe(true);
    // Four raw rows per month, two candidate months.
    expect(run.purgeableRows).toBe(8);
    expect(run.purgeableBytes).toBe(8 * run.bytesPerRawRow);
    expect(run.months.find((m) => m.month === "2025-06-01")).toMatchObject({ websites: 1, safe: true, rawRows: 4 });
    expect(run.months.find((m) => m.month === "2025-08-01")?.safe).toBe(false);
    expect(run.blocked).toBe(0);

    expect(await snapshot(fixture.context.website.id)).toEqual(before);
    expect(before.raw).toBe(16 * 4);
  }, 120_000);

  it("blocks a candidate whose rollup is missing, and one whose rollup disagrees", async () => {
    const fixture = await makeFixture("blocked", LATEST);
    const ids = await seedMonths(fixture, MONTHS);
    const websiteId = fixture.context.website.id;

    // June's monthly rollup is gone; July's page-day rollup lies about clicks.
    // Fixture rows only — the dry run itself must not repair either.
    await prisma.gscQueryPageMonthly.deleteMany({ where: { websiteId, month: new Date("2025-06-01") } });
    await prisma.gscPageDaily.updateMany({
      where: { websiteId, pageId: ids.pageId, date: new Date("2025-07-05") },
      data: { clicks: 999 },
    });
    const before = await snapshot(websiteId);

    const run = await planGscRetentionDryRun({ websiteIds: [websiteId] });

    expect(run.verdict).toBe("BLOCKED");
    const june = run.records.find((r) => r.month === "2025-06-01")!;
    expect(june).toMatchObject({ decision: "BLOCKED_INCOMPLETE_ROLLUP", rollupEquality: "MISSING" });
    const july = run.records.find((r) => r.month === "2025-07-01")!;
    expect(july).toMatchObject({ decision: "BLOCKED_MISMATCH", rollupEquality: "MISMATCH" });
    expect(run.purgeableRows).toBe(0);
    expect(run.blocked).toBe(2);
    expect(run.months.find((m) => m.month === "2025-06-01")?.safe).toBe(false);

    // Nothing repaired, nothing removed.
    expect(await snapshot(websiteId)).toEqual(before);
    const lie = await prisma.gscPageDaily.findFirst({ where: { websiteId, pageId: ids.pageId, date: new Date("2025-07-05") } });
    expect(lie?.clicks).toBe(999);
  }, 120_000);

  it("blocks a candidate whose rollup was derived before the newest raw write", async () => {
    const fixture = await makeFixture("stale", LATEST);
    const ids = await seedMonths(fixture, MONTHS);
    const websiteId = fixture.context.website.id;

    // Raw for June is re-written after the rollup was derived — the shape of
    // a late provider restatement the rollup has not yet caught up with.
    await prisma.gscMetricDaily.updateMany({
      where: { websiteId, pageId: ids.pageId, date: new Date("2025-06-05") },
      data: { clicks: 4 },
    });

    const run = await planGscRetentionDryRun({ websiteIds: [websiteId] });
    const june = run.records.find((r) => r.month === "2025-06-01")!;
    expect(june.decision).toBe("BLOCKED_INCOMPLETE_ROLLUP");
    expect(june.blockedReason).toBe("rollup older than newest raw write");
    expect(run.records.find((r) => r.month === "2025-07-01")?.decision).toBe("CANDIDATE_FOR_PURGE");
  }, 120_000);

  it("calls a calendar month safe only when every website holding it is safe, and keeps tenants apart", async () => {
    const safe = await makeFixture("tenant-a", LATEST);
    const unsafe = await makeFixture("tenant-b", LATEST);
    await seedMonths(safe, MONTHS);
    await seedMonths(unsafe, MONTHS);
    await prisma.gscQueryPageMonthly.deleteMany({
      where: { websiteId: unsafe.context.website.id, month: new Date("2025-06-01") },
    });

    const run = await planGscRetentionDryRun({
      websiteIds: [safe.context.website.id, unsafe.context.website.id],
    });

    const june = run.months.find((m) => m.month === "2025-06-01")!;
    expect(june.websites).toBe(2);
    expect(june.safe).toBe(false);
    expect(june.states.CANDIDATE_FOR_PURGE).toBe(1);
    expect(june.states.BLOCKED_INCOMPLETE_ROLLUP).toBe(1);
    // July is safe for both, so only July's rows are purgeable: four per website.
    expect(run.months.find((m) => m.month === "2025-07-01")?.safe).toBe(true);
    expect(run.purgeableRows).toBe(8);

    // Each website's records concern that website alone.
    const safeRecords = run.records.filter((r) => r.websiteId === safe.context.website.id);
    expect(safeRecords.every((r) => r.decision !== "BLOCKED_INCOMPLETE_ROLLUP")).toBe(true);
    const alone = await planGscRetentionDryRun({ websiteIds: [safe.context.website.id] });
    expect(alone.verdict).toBe("SAFE");
    expect(alone.records.every((r) => r.websiteId === safe.context.website.id)).toBe(true);
  }, 120_000);

  it("reports NONE with no candidates, and unknown for a website without a data date", async () => {
    const young = await makeFixture("young", LATEST);
    await seedMonths(young, ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"]);
    const undated = await makeFixture("undated", null);
    await seedMonths(undated, ["2025-06-01", "2026-09-01"]);

    const run = await planGscRetentionDryRun({
      websiteIds: [young.context.website.id, undated.context.website.id],
    });

    expect(run.verdict).toBe("NONE");
    expect(run.purgeableRows).toBe(0);
    expect(run.records.filter((r) => r.websiteId === young.context.website.id).map((r) => r.decision)).toEqual([
      "KEEP_RETENTION_WINDOW",
      "KEEP_RETENTION_WINDOW",
      "KEEP_RETENTION_WINDOW",
      "KEEP_CURRENT_PARTIAL",
    ]);
    const undatedRecords = run.records.filter((r) => r.websiteId === undated.context.website.id);
    expect(new Set(undatedRecords.map((r) => r.decision))).toEqual(new Set(["BLOCKED_UNKNOWN"]));
    expect(undatedRecords[0]?.blockedReason).toBe("no latestDataDate for website");
    expect(run.websites.find((w) => w.websiteId === undated.context.website.id)?.simulations).toEqual([]);
  }, 120_000);

  it("simulates the readers before and after: short windows stay raw, straddling ones go to the rollups", async () => {
    const fixture = await makeFixture("simulate", LATEST);
    await seedMonths(fixture, MONTHS);

    const run = await planGscRetentionDryRun({ websiteIds: [fixture.context.website.id] });
    const site = run.websites[0]!;
    const byLabel = Object.fromEntries(site.simulations.map((s) => [s.label, s]));

    expect(byLabel["28d vs previous"]?.today.tier).toBe("RAW");
    expect(byLabel["28d vs previous"]?.afterPurge.tier).toBe("RAW");
    expect(byLabel["90d vs previous"]?.afterPurge.tier).toBe("RAW");
    expect(byLabel["straddles post-purge floor"]?.afterPurge).toEqual({ tier: "ROLLUP", reason: "previous_before_raw" });
    expect(byLabel["whole months before post-purge floor"]?.afterPurge).toEqual({ tier: "ROLLUP", reason: "current_before_raw" });
    // Never mixed: each simulation is one decision for both periods.
    for (const simulation of site.simulations) {
      expect(["RAW", "ROLLUP", "NONE"]).toContain(simulation.afterPurge.tier);
    }
  }, 120_000);
});
