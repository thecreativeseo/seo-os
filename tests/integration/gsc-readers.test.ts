import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { resolveCustomWindows, resolveWindows } from "@/lib/metrics/compare";
import {
  getGscRawAvailability,
  pageRollupComparison,
  pageRollupSeries,
  pageRollupTotals,
  queryPageHistory,
  queryRollupComparison,
  readGscPageComparison,
  readGscQueryComparison,
} from "@/server/services/gsc-readers";
import { recomputeGscRollups } from "@/server/services/gsc-rollups";
import { getPageMetrics, getQueryMetrics, gscTotalsFor } from "@/server/services/metrics";
import { registerOrganizations } from "../helpers/teardown";

/**
 * Reading Search Console from the right tier (P1 GSC reader tiering).
 *
 * The rollup readers must say what the raw readers say, at the grain the
 * rollup has: a page over any days, a query over whole months. The entry
 * points must choose one tier for both periods from what the data holds.
 * And the readers the product uses today must be untouched by all of it.
 *
 * Fixtures are shaped like production: one page with several queries, one
 * query landing on two pages, a page-day with a query that has no position,
 * ties that need the fixed rule, and a raw floor that sits inside the range.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
}, 60_000);

type Fixture = { context: TenantContext; connectionId: string; host: string };

async function makeFixture(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `tier-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);
  const organization = await prisma.organization.create({
    data: { name: `Tier ${label}`, slug: `tier-${label}-${suffix}` },
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
  const connection = await prisma.connection.create({
    data: {
      websiteId: website.id,
      workspaceId: workspace.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      status: "CONNECTED",
      externalPropertyId: `sc-domain:${host}`,
      externalPropertyName: "Test property",
    },
  });
  return { context: { user, membership, organization, workspace, website }, connectionId: connection.id, host };
}

type RawRow = {
  date: string;
  path: string;
  query: string;
  clicks: number;
  impressions: number;
  position?: number | null;
};

async function seedRaw(fixture: Fixture, rows: RawRow[]) {
  const { context, connectionId, host } = fixture;
  const pages = new Map<string, string>();
  const queries = new Map<string, string>();
  for (const row of rows) {
    if (!pages.has(row.path)) {
      const page = await prisma.page.upsert({
        where: { websiteId_normalizedUrl: { websiteId: context.website.id, normalizedUrl: `https://${host}${row.path}` } },
        update: {},
        create: {
          websiteId: context.website.id,
          url: `https://${host}${row.path}`,
          normalizedUrl: `https://${host}${row.path}`,
          path: row.path,
          hostname: host,
          protocol: "https",
          sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
        },
      });
      pages.set(row.path, page.id);
    }
    if (!queries.has(row.query)) {
      const query = await prisma.query.upsert({
        where: { websiteId_normalizedQuery: { websiteId: context.website.id, normalizedQuery: row.query } },
        update: {},
        create: { websiteId: context.website.id, query: row.query, normalizedQuery: row.query },
      });
      queries.set(row.query, query.id);
    }
  }
  await prisma.gscMetricDaily.createMany({
    data: rows.map((row) => ({
      websiteId: context.website.id,
      pageId: pages.get(row.path)!,
      queryId: queries.get(row.query)!,
      date: new Date(row.date),
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.impressions === 0 ? null : row.clicks / row.impressions,
      position: row.position === undefined ? 5 : row.position,
      sourceConnectionId: connectionId,
    })),
  });
  return { pages, queries };
}

/** A production-shaped July and August: three pages, four queries, a shared query, a tie. */
function twoMonths(): RawRow[] {
  const rows: RawRow[] = [];
  for (const month of ["07", "08"]) {
    const days = month === "07" ? 31 : 31;
    for (let day = 1; day <= days; day += 1) {
      const date = `2026-${month}-${String(day).padStart(2, "0")}`;
      // /a earns two queries every day; "shared" also lands on /b on even days.
      rows.push({ date, path: "/a", query: "alpha", clicks: day % 5, impressions: 40 + day, position: 2 + (day % 3) });
      rows.push({ date, path: "/a", query: "shared", clicks: 1, impressions: 20, position: 4 });
      if (day % 2 === 0) {
        rows.push({ date, path: "/b", query: "shared", clicks: 1, impressions: 60, position: 8 });
      }
      // /c: a query with impressions and few clicks. Every row here has a
      // position, as every Search Console row does: the raw readers weight
      // position over all impressions, the rollups only over rows that have
      // one, and the two agree exactly when no position is missing. The
      // missing-position case is pinned in the rollup tests, on its own.
      rows.push({ date, path: "/c", query: "gamma", clicks: 0, impressions: 5, position: 12 });
    }
  }
  // A tie in August: "tied" lands on /a and /b with equal clicks and impressions.
  rows.push({ date: "2026-08-10", path: "/a", query: "tied", clicks: 3, impressions: 30, position: 5 });
  rows.push({ date: "2026-08-11", path: "/b", query: "tied", clicks: 3, impressions: 30, position: 6 });
  return rows;
}

const close = (a: number | null, b: number | null, tolerance = 0.002) => {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= tolerance;
};

describe("the page rollup reader against raw", () => {
  it("gives the same website totals, page rows, CTR and position as raw over the same days", async () => {
    const fixture = await makeFixture("pages");
    await seedRaw(fixture, twoMonths());
    await recomputeGscRollups(fixture.context, { startDate: "2026-07-01", endDate: "2026-08-31" });
    const windows = resolveWindows("2026-08-31", "28d");
    const websiteId = fixture.context.website.id;

    for (const range of [windows.current, windows.previous]) {
      const raw = await gscTotalsFor(websiteId, range);
      const rolled = await pageRollupTotals(websiteId, range);
      expect(rolled.clicks).toBe(raw.clicks);
      expect(rolled.impressions).toBe(raw.impressions);
      expect(rolled.ctr).toBe(raw.ctr);
      expect(close(rolled.position, raw.position)).toBe(true);
    }

    const rawPages = await getPageMetrics(fixture.context, windows, { limit: 500 });
    const rolledPages = await pageRollupComparison(fixture.context, windows, { limit: 500 });
    expect(rolledPages.map((row) => row.pageId)).toEqual(rawPages.map((row) => row.pageId));
    for (const [index, rolled] of rolledPages.entries()) {
      const raw = rawPages[index]!;
      expect(rolled).toMatchObject({
        clicks: raw.clicks,
        impressions: raw.impressions,
        ctr: raw.ctr,
        previousClicks: raw.previousClicks,
        previousImpressions: raw.previousImpressions,
        previousCtr: raw.previousCtr,
      });
      expect(close(rolled.position, raw.position)).toBe(true);
    }
  });

  it("recomputes CTR from the totals and weights position by impressions, never averaging the stored ones", async () => {
    const fixture = await makeFixture("weights");
    const ids = await seedRaw(fixture, [
      { date: "2026-08-01", path: "/a", query: "q", clicks: 1, impressions: 100, position: 10 },
      { date: "2026-08-02", path: "/a", query: "q", clicks: 9, impressions: 100, position: 2 },
      { date: "2026-08-03", path: "/a", query: "q", clicks: 5, impressions: 50, position: 4 },
    ]);
    await recomputeGscRollups(fixture.context, { startDate: "2026-08-01", endDate: "2026-08-31" });
    const range = { start: "2026-08-01", end: "2026-08-03" };

    const totals = await pageRollupTotals(fixture.context.website.id, range);
    // 15 / 250, not the mean of 0.01, 0.09 and 0.1; (10×100 + 2×100 + 4×50) / 250 = 5.6, not 5.33.
    expect(totals).toMatchObject({ clicks: 15, impressions: 250, ctr: 0.06 });
    expect(close(totals.position, 5.6)).toBe(true);

    const series = await pageRollupSeries(fixture.context, ids.pages.get("/a")!, range);
    expect(series.map((point) => point.date)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(series[1]).toMatchObject({ clicks: 9, impressions: 100, ctr: 0.09, position: 2 });
  });
});

describe("the query rollup reader against raw", () => {
  it("sums a query across its pages, keeps every page, and picks the top page by the fixed rule", async () => {
    const fixture = await makeFixture("queries");
    const ids = await seedRaw(fixture, twoMonths());
    await recomputeGscRollups(fixture.context, { startDate: "2026-07-01", endDate: "2026-08-31" });
    const months = { current: ["2026-08-01"], previous: ["2026-07-01"] };

    const rolled = await queryRollupComparison(fixture.context, months, { limit: 500 });
    const raw = await getQueryMetrics(
      fixture.context,
      { current: { start: "2026-08-01", end: "2026-08-31" }, previous: { start: "2026-07-01", end: "2026-07-31" }, days: 31, preset: "custom" },
      { limit: 500 },
    );
    expect(rolled.map((row) => row.queryId)).toEqual(raw.map((row) => row.queryId));
    for (const [index, row] of rolled.entries()) {
      const rawRow = raw[index]!;
      expect(row).toMatchObject({
        clicks: rawRow.clicks,
        impressions: rawRow.impressions,
        ctr: rawRow.ctr,
        previousClicks: rawRow.previousClicks,
      });
      expect(close(row.position, rawRow.position)).toBe(true);
    }

    const shared = rolled.find((row) => row.queryId === ids.queries.get("shared"))!;
    expect(shared.pages.map((page) => page.pageId).sort()).toEqual(
      [ids.pages.get("/a"), ids.pages.get("/b")].sort(),
    );
    // /a: 31 clicks over 31 days; /b: 15 clicks over the even days.
    expect(shared.topPageId).toBe(ids.pages.get("/a"));
    expect(shared.clicks).toBe(31 + 15);
    expect(shared.impressions).toBe(31 * 20 + 15 * 60);

    const tied = rolled.find((row) => row.queryId === ids.queries.get("tied"))!;
    const tiedPages = [ids.pages.get("/a")!, ids.pages.get("/b")!].sort();
    expect(tied.topPageId).toBe(tiedPages[0]);
    expect(tied.pages).toHaveLength(2);
  });

  it("keeps a query's page history month by month, and never invents a day", async () => {
    const fixture = await makeFixture("history");
    const ids = await seedRaw(fixture, twoMonths());
    await recomputeGscRollups(fixture.context, { startDate: "2026-07-01", endDate: "2026-08-31" });

    const history = await queryPageHistory(fixture.context, ids.queries.get("shared")!, ["2026-07-01", "2026-08-01"]);
    expect(history.map((point) => `${point.month}:${point.path}`)).toEqual([
      "2026-07-01:/a",
      "2026-07-01:/b",
      "2026-08-01:/a",
      "2026-08-01:/b",
    ]);
    expect(history[1]).toMatchObject({ clicks: 15, impressions: 900, daysWithData: 15 });
    // The rollup carries months and day counts, not days: there is no field
    // from which a "14th of July" could be read or made up.
    expect(Object.keys(history[0]!).sort()).toEqual(
      ["clicks", "ctr", "daysWithData", "impressions", "month", "pageId", "path", "position"].sort(),
    );
  });
});

describe("choosing the tier for a comparison", () => {
  it("reads raw for both when raw holds both, exactly as the product reads today", async () => {
    const fixture = await makeFixture("rawtier");
    await seedRaw(fixture, twoMonths());
    await recomputeGscRollups(fixture.context, { startDate: "2026-07-01", endDate: "2026-08-31" });
    const windows = resolveWindows("2026-08-31", "28d");

    expect(await getGscRawAvailability(fixture.context)).toEqual({
      rawFloor: "2026-07-01",
      latestDataDate: "2026-08-31",
    });

    const result = await readGscPageComparison(fixture.context, windows, { limit: 500 });
    expect(result.decision).toEqual({ tier: "RAW", reason: "both_in_raw" });
    expect(result.totals.current).toEqual(await gscTotalsFor(fixture.context.website.id, windows.current));
    const rawPages = await getPageMetrics(fixture.context, windows, { limit: 500 });
    expect(result.pages.map((row) => row.pageId)).toEqual(rawPages.map((row) => row.pageId));

    const queries = await readGscQueryComparison(fixture.context, windows, { limit: 500 });
    expect(queries.ok && queries.tier).toBe("RAW");
    if (queries.ok && queries.tier === "RAW") {
      expect(queries.queries).toEqual(await getQueryMetrics(fixture.context, windows, { limit: 500 }));
    }
  });

  it("reads the rollups for both when the previous period reaches before raw", async () => {
    const fixture = await makeFixture("rolltier");
    await seedRaw(fixture, twoMonths());
    await recomputeGscRollups(fixture.context, { startDate: "2026-07-01", endDate: "2026-08-31" });
    // Raw before the 20th of July is gone — the shape of a retention purge.
    // The rollups already hold those days.
    await prisma.gscMetricDaily.deleteMany({
      where: { websiteId: fixture.context.website.id, date: { lt: new Date("2026-07-20") } },
    });
    const windows = resolveWindows("2026-08-31", "28d");
    expect(windows.previous.start).toBe("2026-07-07");

    const result = await readGscPageComparison(fixture.context, windows, { limit: 500 });
    expect(result.decision).toEqual({ tier: "ROLLUP", reason: "previous_before_raw" });
    expect(result.availability.rawFloor).toBe("2026-07-20");
    // The previous period is still answered in full, from page-days.
    const rolledPrevious = await pageRollupTotals(fixture.context.website.id, windows.previous);
    expect(result.totals.previous).toEqual(rolledPrevious);
    expect(rolledPrevious.clicks).toBeGreaterThan(0);
    // And the current period is answered from the same tier — not raw — even
    // though raw could have answered it alone.
    expect(result.totals.current).toEqual(await pageRollupTotals(fixture.context.website.id, windows.current));

    // A day-based range cannot be answered by the monthly rollup: refused, not rounded.
    const queries = await readGscQueryComparison(fixture.context, windows, { limit: 500 });
    expect(queries).toMatchObject({ ok: false, tier: "ROLLUP", reason: "start_not_month_start" });

    // Whole months are answered, with the previous period as the months before.
    const august = resolveCustomWindows({ start: "2026-08-01", end: "2026-08-31" });
    const monthly = await readGscQueryComparison(fixture.context, august, { limit: 500 });
    expect(monthly.ok && monthly.tier).toBe("ROLLUP");
    if (monthly.ok && monthly.tier === "ROLLUP") {
      expect(monthly.months).toEqual({ current: ["2026-08-01"], previous: ["2026-07-01"] });
      expect(monthly.queries.length).toBeGreaterThan(0);
    }
  });

  it("reads the rollups for both when the current period reaches before raw, and nothing when nothing can", async () => {
    const fixture = await makeFixture("edges");
    await seedRaw(fixture, twoMonths());
    await recomputeGscRollups(fixture.context, { startDate: "2026-07-01", endDate: "2026-08-31" });
    await prisma.gscMetricDaily.deleteMany({
      where: { websiteId: fixture.context.website.id, date: { lt: new Date("2026-08-15") } },
    });

    const wide = resolveCustomWindows({ start: "2026-08-01", end: "2026-08-31" });
    const result = await readGscPageComparison(fixture.context, wide, { limit: 500 });
    expect(result.decision).toEqual({ tier: "ROLLUP", reason: "current_before_raw" });
    expect(result.totals.current.clicks).toBeGreaterThan(0);

    const beyond = resolveWindows("2026-09-15", "28d");
    const none = await readGscPageComparison(fixture.context, beyond, { limit: 500 });
    expect(none.decision).toEqual({ tier: "NONE", reason: "extends_past_latest" });
    expect(none.pages).toEqual([]);
    expect(none.totals.current).toEqual({ clicks: 0, impressions: 0, ctr: null, position: null });
  });

  it("is scoped to one website", async () => {
    const mine = await makeFixture("mine");
    const theirs = await makeFixture("theirs");
    await seedRaw(mine, twoMonths());
    await recomputeGscRollups(mine.context, { startDate: "2026-07-01", endDate: "2026-08-31" });
    const windows = resolveWindows("2026-08-31", "28d");

    expect(await getGscRawAvailability(theirs.context)).toEqual({ rawFloor: null, latestDataDate: null });
    const result = await readGscPageComparison(theirs.context, windows);
    expect(result.decision).toEqual({ tier: "NONE", reason: "no_data" });
    expect(await pageRollupTotals(theirs.context.website.id, windows.current)).toEqual({
      clicks: 0,
      impressions: 0,
      ctr: null,
      position: null,
    });
    expect(await queryRollupComparison(theirs.context, { current: ["2026-08-01"], previous: ["2026-07-01"] })).toEqual([]);
  });
});
