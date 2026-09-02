import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  getRankingCoverage,
  getRankingHistory,
  getRankingPages,
  listRankingChanges,
  remapUnresolvedRankings,
} from "@/server/services/ranking";

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `rank-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Ranking ${label}`, slug: `rank-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

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

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: `${label}-${suffix}.example.com`,
      normalizedDomain: `${label}-${suffix}.example.com`,
      primaryLanguage: "en",
      primaryMarket: "PH",
    },
  });

  return { user, membership, organization, workspace, website };
}

async function makeKeyword(context: TenantContext, text: string) {
  return prisma.keyword.create({
    data: {
      websiteId: context.website.id,
      keyword: text,
      normalizedKeyword: text.toLowerCase(),
      locale: "en-PH",
      language: "en",
      market: "PH",
    },
  });
}

/** Days back from today, so window filters behave as they would in use. */
function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

async function snapshot(
  context: TenantContext,
  keywordId: string,
  input: {
    daysAgo: number;
    position: number | null;
    url?: string | null;
    pageId?: string | null;
    provider?: "SEMRUSH" | "AHREFS";
  },
) {
  return prisma.rankingSnapshot.create({
    data: {
      websiteId: context.website.id,
      keywordId,
      capturedAt: daysAgo(input.daysAgo),
      position: input.position,
      rankingUrl: input.url ?? null,
      pageId: input.pageId ?? null,
      sourceProvider: input.provider ?? "SEMRUSH",
    },
  });
}

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("history", () => {
  it("returns the sequence oldest first", async () => {
    const context = await makeContext("history");
    const keyword = await makeKeyword(context, "payroll software");

    await snapshot(context, keyword.id, { daysAgo: 21, position: 18 });
    await snapshot(context, keyword.id, { daysAgo: 14, position: 12 });
    await snapshot(context, keyword.id, { daysAgo: 7, position: 9 });

    const history = await getRankingHistory(context, keyword.id);

    expect(history.map((point) => point.position)).toEqual([18, 12, 9]);
  });

  it("keeps each provider's series separable", async () => {
    const context = await makeContext("providers");
    const keyword = await makeKeyword(context, "payroll software");

    await snapshot(context, keyword.id, { daysAgo: 7, position: 9, provider: "SEMRUSH" });
    await snapshot(context, keyword.id, { daysAgo: 7, position: 11, provider: "AHREFS" });

    const all = await getRankingHistory(context, keyword.id);
    const ahrefs = await getRankingHistory(context, keyword.id, { provider: "AHREFS" });

    expect(all).toHaveLength(2);
    expect(ahrefs).toHaveLength(1);
    expect(ahrefs[0]?.position).toBe(11);
  });

  it("does not return another tenant's history", async () => {
    const a = await makeContext("h-iso-a");
    const b = await makeContext("h-iso-b");
    const keyword = await makeKeyword(b, "theirs");

    await snapshot(b, keyword.id, { daysAgo: 7, position: 3 });

    expect(await getRankingHistory(a, keyword.id)).toHaveLength(0);
  });
});

describe("what moved", () => {
  it("compares our own consecutive captures", async () => {
    const context = await makeContext("moved");
    const keyword = await makeKeyword(context, "payroll software");

    await snapshot(context, keyword.id, { daysAgo: 14, position: 18 });
    await snapshot(context, keyword.id, { daysAgo: 7, position: 9 });

    const [change] = await listRankingChanges(context);

    expect(change?.current).toBe(9);
    expect(change?.previous).toBe(18);
    expect(change?.movement.state).toBe("improved");
    expect(change?.movement.placesGained).toBe(9);
    expect(change?.band).toBe("PAGE_ONE");
  });

  it("notices the ranking page changing, not only the position", async () => {
    const context = await makeContext("urlswitch");
    const host = context.website.normalizedDomain;
    const keyword = await makeKeyword(context, "payroll software");

    await snapshot(context, keyword.id, {
      daysAgo: 14,
      position: 8,
      url: `https://${host}/payroll-software/`,
    });
    await snapshot(context, keyword.id, {
      daysAgo: 7,
      position: 9,
      url: `https://${host}/blog/payroll-guide/`,
    });

    const [change] = await listRankingChanges(context);

    // One place of movement is noise; the page Google chose changing is not.
    expect(change?.movement.state).toBe("declined");
    expect(change?.urlChanged).toBe(true);
    expect(change?.previousUrl).toContain("/payroll-software/");
    expect(change?.currentUrl).toContain("/payroll-guide/");
  });

  it("filters out the wobble but keeps a url switch", async () => {
    const context = await makeContext("material");
    const host = context.website.normalizedDomain;

    const noisy = await makeKeyword(context, "noisy keyword");
    await snapshot(context, noisy.id, { daysAgo: 14, position: 8 });
    await snapshot(context, noisy.id, { daysAgo: 7, position: 9 });

    const switched = await makeKeyword(context, "switched keyword");
    await snapshot(context, switched.id, { daysAgo: 14, position: 8, url: `https://${host}/a/` });
    await snapshot(context, switched.id, { daysAgo: 7, position: 9, url: `https://${host}/b/` });

    const material = await listRankingChanges(context, { materialOnly: true });

    expect(material).toHaveLength(1);
    expect(material[0]?.keyword).toBe("switched keyword");
  });

  it("reports a first appearance", async () => {
    const context = await makeContext("appeared");
    const keyword = await makeKeyword(context, "new keyword");

    await snapshot(context, keyword.id, { daysAgo: 7, position: 14 });

    const [change] = await listRankingChanges(context);

    expect(change?.movement.state).toBe("new");
    expect(change?.previous).toBeNull();
  });

  it("does not mix two providers into one movement", async () => {
    // A Semrush 9 following an Ahrefs 18 is not a nine-place improvement; it is
    // two vendors looking at the same SERP differently.
    const context = await makeContext("nomix");
    const keyword = await makeKeyword(context, "payroll software");

    await snapshot(context, keyword.id, { daysAgo: 14, position: 18, provider: "AHREFS" });
    await snapshot(context, keyword.id, { daysAgo: 7, position: 9, provider: "SEMRUSH" });

    const changes = await listRankingChanges(context);

    expect(changes).toHaveLength(2);
    for (const change of changes) {
      expect(change.movement.state).toBe("new");
      expect(change.previous).toBeNull();
    }
  });
});

describe("pages that rank", () => {
  it("lists every page seen ranking, most frequent first", async () => {
    const context = await makeContext("pages");
    const host = context.website.normalizedDomain;
    const keyword = await makeKeyword(context, "payroll software");

    await snapshot(context, keyword.id, { daysAgo: 21, position: 12, url: `https://${host}/a/` });
    await snapshot(context, keyword.id, { daysAgo: 14, position: 9, url: `https://${host}/a/` });
    await snapshot(context, keyword.id, { daysAgo: 7, position: 11, url: `https://${host}/b/` });

    const observations = await getRankingPages(context, keyword.id);

    expect(observations).toHaveLength(2);
    expect(observations[0]?.captures).toBe(2);
    // Lower is better, so the best position is the minimum.
    expect(observations[0]?.bestPosition).toBe(9);
  });

  it("ignores snapshots that name no page", async () => {
    const context = await makeContext("nourl");
    const keyword = await makeKeyword(context, "payroll software");

    // A snapshot with no URL says the keyword ranked, not which page did.
    await snapshot(context, keyword.id, { daysAgo: 7, position: 5, url: null });

    expect(await getRankingPages(context, keyword.id)).toHaveLength(0);
  });
});

describe("coverage", () => {
  it("counts what Google ranks that we cannot account for", async () => {
    const context = await makeContext("coverage");
    const host = context.website.normalizedDomain;
    const keyword = await makeKeyword(context, "payroll software");

    const page = await prisma.page.create({
      data: {
        websiteId: context.website.id,
        url: `https://${host}/known/`,
        normalizedUrl: `https://${host}/known`,
        path: "/known",
        hostname: host,
        protocol: "https",
        sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
      },
    });

    await snapshot(context, keyword.id, {
      daysAgo: 14,
      position: 4,
      url: `https://${host}/known`,
      pageId: page.id,
    });
    await snapshot(context, keyword.id, {
      daysAgo: 7,
      position: 6,
      url: `https://${host}/unknown-page`,
    });

    const coverage = await getRankingCoverage(context);

    expect(coverage.total).toBe(2);
    expect(coverage.mapped).toBe(1);
    expect(coverage.unmapped).toBe(1);
    // Surfaced rather than hidden: Google is ranking a page nothing else reported.
    expect(coverage.unmappedUrls).toEqual([`https://${host}/unknown-page`]);
  });
});

describe("attaching pages discovered later", () => {
  it("links a snapshot once the page becomes known", async () => {
    // Ordering is the reason this exists: a Semrush export can arrive before the
    // Search Console sync that first reports the page it names.
    const context = await makeContext("remap");
    const host = context.website.normalizedDomain;
    const keyword = await makeKeyword(context, "payroll software");

    const stored = await snapshot(context, keyword.id, {
      daysAgo: 7,
      position: 6,
      url: `https://${host}/arrives-later/`,
    });

    expect((await remapUnresolvedRankings(context)).attached).toBe(0);

    await prisma.page.create({
      data: {
        websiteId: context.website.id,
        url: `https://${host}/arrives-later/`,
        normalizedUrl: `https://${host}/arrives-later`,
        path: "/arrives-later",
        hostname: host,
        protocol: "https",
        sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
      },
    });

    const result = await remapUnresolvedRankings(context);

    expect(result.attached).toBe(1);

    const updated = await prisma.rankingSnapshot.findUniqueOrThrow({ where: { id: stored.id } });
    expect(updated.pageId).not.toBeNull();
    // The measurement is untouched; only the link that was always meant to exist.
    expect(Number(updated.position)).toBe(6);
    expect(updated.rankingUrl).toBe(`https://${host}/arrives-later/`);
  });

  it("leaves a URL that belongs to nobody alone", async () => {
    const context = await makeContext("foreign");
    const keyword = await makeKeyword(context, "payroll software");

    await snapshot(context, keyword.id, {
      daysAgo: 7,
      position: 3,
      url: "https://someone-else.example.net/page/",
    });

    const result = await remapUnresolvedRankings(context);

    expect(result.examined).toBe(1);
    expect(result.attached).toBe(0);
  });

  it("never attaches another tenant's page", async () => {
    const a = await makeContext("r-iso-a");
    const b = await makeContext("r-iso-b");
    const keyword = await makeKeyword(a, "shared path");

    // B owns a page at the same path. A's remap must not reach it.
    await prisma.page.create({
      data: {
        websiteId: b.website.id,
        url: `https://${a.website.normalizedDomain}/shared/`,
        normalizedUrl: `https://${a.website.normalizedDomain}/shared`,
        path: "/shared",
        hostname: a.website.normalizedDomain,
        protocol: "https",
        sourceFirstSeen: "MANUAL",
      },
    });

    await snapshot(a, keyword.id, {
      daysAgo: 7,
      position: 5,
      url: `https://${a.website.normalizedDomain}/shared/`,
    });

    const result = await remapUnresolvedRankings(a);

    expect(result.attached).toBe(0);
  });
});
