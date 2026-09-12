import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import type { SearchAnalyticsResult } from "@/server/connectors/google/search-console";
import {
  monthComplete,
  monthsTouched,
  nextMonth,
  recomputeGscRollups,
  topPagesForMonth,
} from "@/server/services/gsc-rollups";
import { runGscSync } from "@/server/services/sync";
import { registerOrganizations } from "../helpers/teardown";

/**
 * Search Console rollups (P1 GSC storage).
 *
 * gsc_metric_daily is canonical and grows without bound; the two rollup tiers
 * are derived from it, a calendar month at a time, and must be a pure
 * function of it: the same raw gives the same page-day and query-page-month
 * rows whatever the provider windows were, however many times it is run, and
 * whatever an overlapping pull re-wrote. These tests seed raw rows directly,
 * derive, and compare against the aggregates raw itself yields; and they run
 * the real sync with an injected connector to show the rollups follow it.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const NOW = new Date("2026-09-02T09:00:00Z");
const TOKEN = async () => "test-access-token";

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
    data: { authUserId: crypto.randomUUID(), email: `rollup-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Rollup ${label}`, slug: `rollup-${label}-${suffix}` },
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

  return {
    context: { user, membership, organization, workspace, website },
    connectionId: connection.id,
    host,
  };
}

type RawRow = {
  date: string;
  path: string;
  query: string;
  clicks: number;
  impressions: number;
  position?: number | null;
};

/** Writes raw rows straight into gsc_metric_daily, creating pages and queries as needed. */
async function seedRaw(fixture: Fixture, rows: RawRow[]) {
  const { context, connectionId, host } = fixture;
  const ids = { pages: new Map<string, string>(), queries: new Map<string, string>() };

  for (const row of rows) {
    if (!ids.pages.has(row.path)) {
      const page = await prisma.page.upsert({
        where: {
          websiteId_normalizedUrl: {
            websiteId: context.website.id,
            normalizedUrl: `https://${host}${row.path}`,
          },
        },
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
      ids.pages.set(row.path, page.id);
    }
    if (!ids.queries.has(row.query)) {
      const query = await prisma.query.upsert({
        where: {
          websiteId_normalizedQuery: { websiteId: context.website.id, normalizedQuery: row.query },
        },
        update: {},
        create: { websiteId: context.website.id, query: row.query, normalizedQuery: row.query },
      });
      ids.queries.set(row.query, query.id);
    }
  }

  await prisma.gscMetricDaily.createMany({
    data: rows.map((row) => ({
      websiteId: context.website.id,
      pageId: ids.pages.get(row.path)!,
      queryId: ids.queries.get(row.query)!,
      date: new Date(row.date),
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.impressions === 0 ? null : row.clicks / row.impressions,
      position: row.position === undefined ? 5 : row.position,
      sourceConnectionId: connectionId,
    })),
  });

  return ids;
}

const num = (value: unknown) => (value === null ? null : Number(value));

async function pageDays(websiteId: string) {
  const rows = await prisma.gscPageDaily.findMany({
    where: { websiteId },
    orderBy: [{ date: "asc" }, { pageId: "asc" }],
  });
  return rows.map((row) => ({
    pageId: row.pageId,
    date: row.date.toISOString().slice(0, 10),
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: num(row.ctr),
    position: num(row.position),
  }));
}

async function queryPageMonths(websiteId: string) {
  const rows = await prisma.gscQueryPageMonthly.findMany({
    where: { websiteId },
    orderBy: [{ month: "asc" }, { queryId: "asc" }, { pageId: "asc" }],
  });
  return rows.map((row) => ({
    queryId: row.queryId,
    pageId: row.pageId,
    month: row.month.toISOString().slice(0, 10),
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: num(row.ctr),
    position: num(row.position),
    daysWithData: row.daysWithData,
  }));
}

/** What raw itself says a page-day and a query-page-month should be. */
async function rawAggregates(websiteId: string) {
  const days = await prisma.$queryRaw<
    { page_id: string; date: Date; clicks: bigint; impressions: bigint }[]
  >`
    SELECT page_id, date, SUM(clicks) AS clicks, SUM(impressions) AS impressions
    FROM gsc_metric_daily WHERE website_id = ${websiteId}::uuid
    GROUP BY page_id, date ORDER BY date, page_id
  `;
  const months = await prisma.$queryRaw<
    {
      query_id: string;
      page_id: string;
      month: Date;
      clicks: bigint;
      impressions: bigint;
      days: bigint;
    }[]
  >`
    SELECT query_id, page_id, date_trunc('month', date)::date AS month,
           SUM(clicks) AS clicks, SUM(impressions) AS impressions, COUNT(DISTINCT date) AS days
    FROM gsc_metric_daily WHERE website_id = ${websiteId}::uuid
    GROUP BY query_id, page_id, date_trunc('month', date) ORDER BY month, query_id, page_id
  `;
  return {
    days: days.map((row) => ({
      pageId: row.page_id,
      date: row.date.toISOString().slice(0, 10),
      clicks: Number(row.clicks),
      impressions: Number(row.impressions),
    })),
    months: months.map((row) => ({
      queryId: row.query_id,
      pageId: row.page_id,
      month: row.month.toISOString().slice(0, 10),
      clicks: Number(row.clicks),
      impressions: Number(row.impressions),
      daysWithData: Number(row.days),
    })),
  };
}

const AUGUST = { startDate: "2026-08-01", endDate: "2026-08-31" };

describe("what a rollup is", () => {
  it("a page-day is the sum of its queries, with CTR and position derived from the sums", async () => {
    const fixture = await makeFixture("pageday");
    const ids = await seedRaw(fixture, [
      { date: "2026-08-10", path: "/a", query: "one", clicks: 3, impressions: 10, position: 2 },
      { date: "2026-08-10", path: "/a", query: "two", clicks: 5, impressions: 30, position: 4 },
      { date: "2026-08-10", path: "/b", query: "one", clicks: 0, impressions: 8, position: 9 },
    ]);

    const result = await recomputeGscRollups(fixture.context, AUGUST);
    expect(result).toMatchObject({ months: ["2026-08-01"], pageDays: 2, queryPageMonths: 3 });

    const days = await pageDays(fixture.context.website.id);
    const a = days.find((row) => row.pageId === ids.pages.get("/a"))!;
    // 8 of 40; position (2×10 + 4×30) / 40 = 3.5. An average of the two CTRs
    // (0.3 and 0.167) or of the two positions (3) would both be wrong.
    expect(a).toMatchObject({ date: "2026-08-10", clicks: 8, impressions: 40, ctr: 0.2, position: 3.5 });
    const b = days.find((row) => row.pageId === ids.pages.get("/b"))!;
    expect(b).toMatchObject({ clicks: 0, impressions: 8, ctr: 0, position: 9 });

    const raw = await rawAggregates(fixture.context.website.id);
    expect(days.map(({ pageId, date, clicks, impressions }) => ({ pageId, date, clicks, impressions }))).toEqual(raw.days);
  });

  it("a query-page-month is the sum of its days, and counts the days it saw", async () => {
    const fixture = await makeFixture("month");
    const ids = await seedRaw(fixture, [
      { date: "2026-08-01", path: "/a", query: "q", clicks: 1, impressions: 100, position: 10 },
      { date: "2026-08-02", path: "/a", query: "q", clicks: 9, impressions: 100, position: 2 },
      { date: "2026-08-31", path: "/a", query: "q", clicks: 0, impressions: 0, position: null },
      // September belongs to another month's row.
      { date: "2026-09-01", path: "/a", query: "q", clicks: 4, impressions: 40, position: 3 },
    ]);

    await recomputeGscRollups(fixture.context, { startDate: "2026-08-01", endDate: "2026-09-30" });

    const months = await queryPageMonths(fixture.context.website.id);
    expect(months).toHaveLength(2);
    const august = months.find((row) => row.month === "2026-08-01")!;
    // CTR 10/200 = 0.05, not the mean of 0.01 and 0.09 and null. Position over
    // the two days that had impressions: (10×100 + 2×100) / 200 = 6.
    expect(august).toMatchObject({
      queryId: ids.queries.get("q"),
      pageId: ids.pages.get("/a"),
      clicks: 10,
      impressions: 200,
      ctr: 0.05,
      position: 6,
      daysWithData: 3,
    });
    expect(months.find((row) => row.month === "2026-09-01")).toMatchObject({
      clicks: 4,
      impressions: 40,
      daysWithData: 1,
    });

    const raw = await rawAggregates(fixture.context.website.id);
    expect(
      months.map(({ queryId, pageId, month, clicks, impressions, daysWithData }) => ({
        queryId,
        pageId,
        month,
        clicks,
        impressions,
        daysWithData,
      })),
    ).toEqual(raw.months);
  });

  it("keeps unknown unknown: no impressions means no CTR, no measurable position means no position", async () => {
    const fixture = await makeFixture("nulls");
    await seedRaw(fixture, [
      { date: "2026-08-03", path: "/a", query: "q", clicks: 0, impressions: 0, position: null },
      { date: "2026-08-04", path: "/b", query: "q", clicks: 2, impressions: 10, position: null },
      // Position known on one row only: weighted over that row's impressions alone.
      { date: "2026-08-05", path: "/c", query: "q", clicks: 1, impressions: 10, position: null },
      { date: "2026-08-05", path: "/c", query: "r", clicks: 1, impressions: 30, position: 7 },
    ]);

    await recomputeGscRollups(fixture.context, AUGUST);

    const days = await pageDays(fixture.context.website.id);
    expect(days.find((row) => row.date === "2026-08-03")).toMatchObject({ ctr: null, position: null });
    expect(days.find((row) => row.date === "2026-08-04")).toMatchObject({ ctr: 0.2, position: null });
    expect(days.find((row) => row.date === "2026-08-05")).toMatchObject({
      clicks: 2,
      impressions: 40,
      ctr: 0.05,
      position: 7,
    });
  });

  it("keeps every page a query landed on, and every query a page earned", async () => {
    const fixture = await makeFixture("shape");
    const ids = await seedRaw(fixture, [
      { date: "2026-08-10", path: "/a", query: "shared", clicks: 5, impressions: 100 },
      { date: "2026-08-11", path: "/b", query: "shared", clicks: 5, impressions: 200 },
      { date: "2026-08-12", path: "/a", query: "other", clicks: 1, impressions: 10 },
    ]);

    await recomputeGscRollups(fixture.context, AUGUST);

    const months = await queryPageMonths(fixture.context.website.id);
    const shared = months.filter((row) => row.queryId === ids.queries.get("shared"));
    expect(shared.map((row) => row.pageId).sort()).toEqual(
      [ids.pages.get("/a"), ids.pages.get("/b")].sort(),
    );
    const pageA = months.filter((row) => row.pageId === ids.pages.get("/a"));
    expect(pageA.map((row) => row.queryId).sort()).toEqual(
      [ids.queries.get("shared"), ids.queries.get("other")].sort(),
    );
  });

  it("derives a query's top page by clicks, then impressions, then the lowest page id", async () => {
    const fixture = await makeFixture("top");
    const ids = await seedRaw(fixture, [
      { date: "2026-08-10", path: "/a", query: "shared", clicks: 5, impressions: 100 },
      { date: "2026-08-11", path: "/b", query: "shared", clicks: 5, impressions: 200 },
      { date: "2026-08-12", path: "/c", query: "tied", clicks: 2, impressions: 20 },
      { date: "2026-08-13", path: "/d", query: "tied", clicks: 2, impressions: 20 },
    ]);

    await recomputeGscRollups(fixture.context, AUGUST);

    const top = await topPagesForMonth(fixture.context, "2026-08-15");
    const byQuery = Object.fromEntries(top.map((row) => [row.queryId, row]));
    expect(byQuery[ids.queries.get("shared")!]?.pageId).toBe(ids.pages.get("/b"));
    const tiedPages = [ids.pages.get("/c")!, ids.pages.get("/d")!].sort();
    expect(byQuery[ids.queries.get("tied")!]?.pageId).toBe(tiedPages[0]);
  });
});

describe("a pure function of raw", () => {
  it("derives the same metrics twice, whichever months are asked in whichever order", async () => {
    const fixture = await makeFixture("replay");
    await seedRaw(fixture, [
      { date: "2026-07-30", path: "/a", query: "q", clicks: 2, impressions: 20, position: 3 },
      { date: "2026-08-01", path: "/a", query: "q", clicks: 3, impressions: 30, position: 4 },
      { date: "2026-08-15", path: "/b", query: "q", clicks: 4, impressions: 40, position: 5 },
    ]);

    await recomputeGscRollups(fixture.context, { startDate: "2026-07-01", endDate: "2026-08-31" });
    const firstDays = await pageDays(fixture.context.website.id);
    const firstMonths = await queryPageMonths(fixture.context.website.id);
    const firstStamp = await prisma.gscQueryPageMonthly.findFirst({
      where: { websiteId: fixture.context.website.id },
      orderBy: { computedAt: "asc" },
    });

    // Again, later, and in pieces, newest first.
    await recomputeGscRollups(fixture.context, AUGUST, { now: new Date(NOW.getTime() + 60_000) });
    await recomputeGscRollups(fixture.context, { startDate: "2026-07-01", endDate: "2026-07-31" });
    await recomputeGscRollups(fixture.context, { startDate: "2026-08-15", endDate: "2026-08-15" });

    expect(await pageDays(fixture.context.website.id)).toEqual(firstDays);
    expect(await queryPageMonths(fixture.context.website.id)).toEqual(firstMonths);

    const laterStamp = await prisma.gscQueryPageMonthly.findFirst({
      where: { websiteId: fixture.context.website.id },
      orderBy: { computedAt: "asc" },
    });
    expect(laterStamp!.computedAt.getTime()).toBeGreaterThanOrEqual(firstStamp!.computedAt.getTime());
  });

  it("forgets a key that canonical raw no longer implies", async () => {
    const fixture = await makeFixture("stale");
    const ids = await seedRaw(fixture, [
      { date: "2026-08-10", path: "/a", query: "q", clicks: 5, impressions: 100 },
      { date: "2026-08-10", path: "/gone", query: "q", clicks: 1, impressions: 10 },
    ]);
    await recomputeGscRollups(fixture.context, AUGUST);
    expect(await pageDays(fixture.context.website.id)).toHaveLength(2);
    expect(await queryPageMonths(fixture.context.website.id)).toHaveLength(2);

    // The fixture's own raw row goes away — the shape of a page merge, or of
    // a later retention purge. The rollup must follow raw, not remember it.
    await prisma.gscMetricDaily.deleteMany({
      where: { websiteId: fixture.context.website.id, pageId: ids.pages.get("/gone") },
    });
    await recomputeGscRollups(fixture.context, AUGUST);

    expect((await pageDays(fixture.context.website.id)).map((row) => row.pageId)).toEqual([
      ids.pages.get("/a"),
    ]);
    expect((await queryPageMonths(fixture.context.website.id)).map((row) => row.pageId)).toEqual([
      ids.pages.get("/a"),
    ]);
  });

  it("is scoped to one website", async () => {
    const mine = await makeFixture("mine");
    const theirs = await makeFixture("theirs");
    await seedRaw(mine, [{ date: "2026-08-10", path: "/a", query: "q", clicks: 5, impressions: 100 }]);
    await seedRaw(theirs, [{ date: "2026-08-10", path: "/a", query: "q", clicks: 7, impressions: 700 }]);

    await recomputeGscRollups(mine.context, AUGUST);
    expect(await pageDays(theirs.context.website.id)).toHaveLength(0);
    expect(await queryPageMonths(theirs.context.website.id)).toHaveLength(0);

    await recomputeGscRollups(theirs.context, AUGUST);
    expect((await pageDays(mine.context.website.id))[0]).toMatchObject({ clicks: 5, impressions: 100 });
    expect((await pageDays(theirs.context.website.id))[0]).toMatchObject({ clicks: 7, impressions: 700 });
  });

  it("says whether a month is complete from freshness alone, and never writes it down", () => {
    expect(monthComplete("2026-08-01", new Date("2026-08-31T00:00:00Z"))).toBe(true);
    expect(monthComplete("2026-08-01", new Date("2026-09-08T00:00:00Z"))).toBe(true);
    expect(monthComplete("2026-08-01", new Date("2026-08-30T00:00:00Z"))).toBe(false);
    expect(monthComplete("2026-09-01", new Date("2026-09-08T00:00:00Z"))).toBe(false);
    expect(monthComplete("2026-08-01", null)).toBe(false);
    // A leap-year February ends on the 29th.
    expect(monthComplete("2028-02-01", new Date("2028-02-29T00:00:00Z"))).toBe(true);
    expect(monthComplete("2028-02-01", new Date("2028-02-28T00:00:00Z"))).toBe(false);
  });

  it("names the months a range touches, whole months at a time", () => {
    expect(monthsTouched({ startDate: "2026-08-30", endDate: "2026-09-02" })).toEqual([
      "2026-08-01",
      "2026-09-01",
    ]);
    expect(monthsTouched({ startDate: "2026-11-15", endDate: "2027-01-03" })).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
    ]);
    expect(monthsTouched({ startDate: "2026-09-02", endDate: "2026-09-01" })).toEqual([]);
    expect(nextMonth("2026-12-01")).toBe("2027-01-01");
  });
});

describe("following the sync", () => {
  function payload(host: string, rows: RawRow[]): SearchAnalyticsResult {
    return {
      rows: rows.map((row) => ({
        date: row.date,
        page: `https://${host}${row.path}`,
        query: row.query,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.impressions === 0 ? 0 : row.clicks / row.impressions,
        position: row.position ?? 4.5,
      })),
      truncated: false,
    };
  }

  /** Twenty days of rows for one page and two queries, one of them shared with a second page. */
  function twentyDays(): RawRow[] {
    const rows: RawRow[] = [];
    for (let day = 1; day <= 20; day += 1) {
      const date = `2026-08-${String(day).padStart(2, "0")}`;
      rows.push({ date, path: "/a", query: "alpha", clicks: day, impressions: day * 10, position: 3 });
      rows.push({ date, path: "/a", query: "beta", clicks: 1, impressions: 5, position: 8 });
      if (day % 2 === 0) {
        rows.push({ date, path: "/b", query: "alpha", clicks: 2, impressions: 50, position: 6 });
      }
    }
    return rows;
  }

  const inRange = (rows: RawRow[], startDate: string, endDate: string) =>
    rows.filter((row) => row.date >= startDate && row.date <= endDate);

  it("derives the rollups after the pull, and the same ones whatever the window size", async () => {
    const rows = twentyDays();
    const now = new Date("2026-08-23T09:00:00Z");

    const results = [];
    for (const windowDays of [7, 30]) {
      const fixture = await makeFixture(`windows${windowDays}`);
      const outcome = await runGscSync(fixture.context, {
        now,
        days: 20,
        windowDays,
        accessTokenFor: TOKEN,
        source: async ({ startDate, endDate }) =>
          payload(fixture.host, inRange(rows, startDate, endDate)),
      });
      expect(outcome.status).toBe("SUCCEEDED");

      const days = await pageDays(fixture.context.website.id);
      const months = await queryPageMonths(fixture.context.website.id);
      const raw = await rawAggregates(fixture.context.website.id);
      expect(days.map(({ date, clicks, impressions }) => ({ date, clicks, impressions }))).toEqual(
        raw.days.map(({ date, clicks, impressions }) => ({ date, clicks, impressions })),
      );
      expect(months).toHaveLength(raw.months.length);
      // Compared by shape rather than id: each fixture has its own pages and queries.
      results.push({
        days: days
          .map(({ date, clicks, impressions, ctr, position }) => ({ date, clicks, impressions, ctr, position }))
          .sort((a, b) => a.date.localeCompare(b.date) || a.clicks - b.clicks || a.impressions - b.impressions),
        months: months
          .map(({ clicks, impressions, ctr, position, daysWithData }) => ({ clicks, impressions, ctr, position, daysWithData }))
          .sort((a, b) => a.clicks - b.clicks || a.impressions - b.impressions),
      });
    }

    expect(results[1]).toEqual(results[0]);
  });

  it("an overlapping pull replaces rather than adds", async () => {
    const rows = twentyDays();
    const fixture = await makeFixture("overlap");
    const source = async ({ startDate, endDate }: { startDate: string; endDate: string }) =>
      payload(fixture.host, inRange(rows, startDate, endDate));

    const first = await runGscSync(fixture.context, {
      now: new Date("2026-08-13T09:00:00Z"),
      days: 10,
      accessTokenFor: TOKEN,
      source,
    });
    expect(first.status).toBe("SUCCEEDED");
    const before = await queryPageMonths(fixture.context.website.id);

    // Ten days later. The next window starts three days before the last
    // data date, so days 8 to 10 are read and written a second time.
    const second = await runGscSync(fixture.context, {
      now: new Date("2026-08-23T09:00:00Z"),
      accessTokenFor: TOKEN,
      source,
    });
    expect(second.status).toBe("SUCCEEDED");
    expect(second.window.startDate).toBe("2026-08-07");

    const raw = await rawAggregates(fixture.context.website.id);
    const months = await queryPageMonths(fixture.context.website.id);
    expect(
      months.map(({ queryId, pageId, month, clicks, impressions, daysWithData }) => ({
        queryId,
        pageId,
        month,
        clicks,
        impressions,
        daysWithData,
      })),
    ).toEqual(raw.months);
    // The month grew by exactly the ten new days of the shared query on /a.
    const alphaBefore = before.find((row) => row.clicks === (1 + 10) * 5)!;
    expect(alphaBefore.daysWithData).toBe(10);
    const alphaAfter = months.find((row) => row.pageId === alphaBefore.pageId && row.queryId === alphaBefore.queryId)!;
    expect(alphaAfter).toMatchObject({ clicks: (1 + 20) * 10, daysWithData: 20 });
  });

  it("keeps a current month's rollups without calling the month complete", async () => {
    const rows = twentyDays();
    const fixture = await makeFixture("current");
    const outcome = await runGscSync(fixture.context, {
      now: new Date("2026-08-23T09:00:00Z"),
      days: 20,
      accessTokenFor: TOKEN,
      source: async ({ startDate, endDate }) =>
        payload(fixture.host, inRange(rows, startDate, endDate)),
    });
    expect(outcome.status).toBe("SUCCEEDED");

    expect(await queryPageMonths(fixture.context.website.id)).not.toHaveLength(0);
    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: fixture.connectionId } });
    expect(connection.latestDataDate?.toISOString().slice(0, 10)).toBe("2026-08-20");
    expect(monthComplete("2026-08-01", connection.latestDataDate)).toBe(false);
  });
});
