import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  OwnershipError,
  assignOwnership,
  detectOwnershipIssues,
  getOwnershipCounts,
  getPrimaryOwner,
  isDuplicatePrimary,
  listOwnerships,
  retireOwnership,
} from "@/server/services/ownership";

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `own-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Ownership ${label}`, slug: `own-${label}-${suffix}` },
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

async function makeKeyword(context: TenantContext, text: string, market = "PH") {
  return prisma.keyword.create({
    data: {
      websiteId: context.website.id,
      keyword: text,
      normalizedKeyword: text.toLowerCase(),
      locale: `en-${market}`,
      language: "en",
      market,
    },
  });
}

async function makePage(context: TenantContext, path: string) {
  const host = context.website.normalizedDomain;

  return prisma.page.create({
    data: {
      websiteId: context.website.id,
      url: `https://${host}${path}`,
      normalizedUrl: `https://${host}${path}`,
      path,
      hostname: host,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

async function rank(
  context: TenantContext,
  keywordId: string,
  input: { daysAgo: number; pageId?: string | null; url?: string | null; position: number },
) {
  return prisma.rankingSnapshot.create({
    data: {
      websiteId: context.website.id,
      keywordId,
      capturedAt: daysAgo(input.daysAgo),
      position: input.position,
      pageId: input.pageId ?? null,
      rankingUrl: input.url ?? null,
      sourceProvider: "SEMRUSH",
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

describe("assigning an owner", () => {
  it("nominates a page and records who decided", async () => {
    const context = await makeContext("assign");
    const keyword = await makeKeyword(context, "payroll software");
    const page = await makePage(context, "/payroll-software");

    const ownership = await assignOwnership(context, {
      keywordId: keyword.id,
      pageId: page.id,
      notes: "Commercial destination for this term",
    });

    expect(ownership.ownershipType).toBe("PRIMARY");
    expect(ownership.status).toBe("ACTIVE");
    expect(ownership.assignedByUserId).toBe(context.user.id);
    expect(ownership.market).toBe("PH");
    expect(ownership.page.path).toBe("/payroll-software");
  });

  it("retires the previous owner rather than editing it", async () => {
    const context = await makeContext("reassign");
    const keyword = await makeKeyword(context, "payroll software");
    const first = await makePage(context, "/old-page");
    const second = await makePage(context, "/new-page");

    const original = await assignOwnership(context, {
      keywordId: keyword.id,
      pageId: first.id,
    });
    await assignOwnership(context, { keywordId: keyword.id, pageId: second.id });

    const all = await listOwnerships(context, keyword.id);

    // Two rows: "who decided this, and when" is a question people ask months
    // later, and an updated row cannot answer it.
    expect(all).toHaveLength(2);

    const retired = all.find((row) => row.id === original.id);
    expect(retired?.status).toBe("RETIRED");

    const current = await getPrimaryOwner(context, keyword.id);
    expect(current?.page.path).toBe("/new-page");
  });

  it("does not churn history when the same page is assigned twice", async () => {
    const context = await makeContext("idempotent");
    const keyword = await makeKeyword(context, "payroll software");
    const page = await makePage(context, "/payroll-software");

    const first = await assignOwnership(context, { keywordId: keyword.id, pageId: page.id });
    const second = await assignOwnership(context, { keywordId: keyword.id, pageId: page.id });

    expect(second.id).toBe(first.id);
    expect(await listOwnerships(context, keyword.id)).toHaveLength(1);
  });

  it("allows several secondary owners alongside one primary", async () => {
    // A team may legitimately have supporting pages for one keyword.
    const context = await makeContext("secondary");
    const keyword = await makeKeyword(context, "payroll software");
    const primary = await makePage(context, "/payroll-software");
    const supportA = await makePage(context, "/guides/payroll");
    const supportB = await makePage(context, "/blog/payroll-basics");

    await assignOwnership(context, { keywordId: keyword.id, pageId: primary.id });
    await assignOwnership(context, {
      keywordId: keyword.id,
      pageId: supportA.id,
      ownershipType: "SECONDARY",
    });
    await assignOwnership(context, {
      keywordId: keyword.id,
      pageId: supportB.id,
      ownershipType: "SECONDARY",
    });

    const active = (await listOwnerships(context, keyword.id)).filter(
      (row) => row.status === "ACTIVE",
    );

    expect(active).toHaveLength(3);
    expect(active.filter((row) => row.ownershipType === "PRIMARY")).toHaveLength(1);
  });

  it("keeps the same keyword's owner separate per market", async () => {
    const context = await makeContext("markets");
    const ph = await makeKeyword(context, "payroll software", "PH");
    const us = await makeKeyword(context, "payroll software", "US");
    const phPage = await makePage(context, "/ph/payroll");
    const usPage = await makePage(context, "/us/payroll");

    await assignOwnership(context, { keywordId: ph.id, pageId: phPage.id });
    await assignOwnership(context, { keywordId: us.id, pageId: usPage.id });

    expect((await getPrimaryOwner(context, ph.id))?.page.path).toBe("/ph/payroll");
    expect((await getPrimaryOwner(context, us.id))?.page.path).toBe("/us/payroll");
  });

  it("refuses to assign another tenant's page", async () => {
    const a = await makeContext("x-a");
    const b = await makeContext("x-b");
    const keyword = await makeKeyword(a, "payroll software");
    const theirPage = await makePage(b, "/their-page");

    await expect(
      assignOwnership(a, { keywordId: keyword.id, pageId: theirPage.id }),
    ).rejects.toBeInstanceOf(OwnershipError);
  });

  it("refuses to assign to another tenant's keyword", async () => {
    const a = await makeContext("y-a");
    const b = await makeContext("y-b");
    const theirKeyword = await makeKeyword(b, "their keyword");
    const page = await makePage(a, "/mine");

    await expect(
      assignOwnership(a, { keywordId: theirKeyword.id, pageId: page.id }),
    ).rejects.toBeInstanceOf(OwnershipError);
  });
});

/**
 * The rule lives in the database, not in the service. This asserts that directly:
 * if a future code path forgets to retire the previous owner, Postgres refuses
 * rather than quietly allowing two owners and making every divergence check
 * ambiguous.
 */
describe("the database enforces one primary owner", () => {
  it("refuses a second active primary for the same keyword and market", async () => {
    const context = await makeContext("dbrule");
    const keyword = await makeKeyword(context, "payroll software");
    const first = await makePage(context, "/first");
    const second = await makePage(context, "/second");

    await assignOwnership(context, { keywordId: keyword.id, pageId: first.id });

    // Bypassing the service entirely.
    const attempt = prisma.keywordPageOwnership.create({
      data: {
        websiteId: context.website.id,
        keywordId: keyword.id,
        pageId: second.id,
        ownershipType: "PRIMARY",
        status: "ACTIVE",
        market: "PH",
        language: "en",
        locale: "en-PH",
      },
    });

    await expect(attempt).rejects.toSatisfy(isDuplicatePrimary);
  });

  it("permits a retired primary alongside the active one", async () => {
    // Otherwise reassignment could not keep its own history.
    const context = await makeContext("retired");
    const keyword = await makeKeyword(context, "payroll software");
    const first = await makePage(context, "/first");
    const second = await makePage(context, "/second");

    const original = await assignOwnership(context, {
      keywordId: keyword.id,
      pageId: first.id,
    });
    await retireOwnership(context, original.id);

    await expect(
      assignOwnership(context, { keywordId: keyword.id, pageId: second.id }),
    ).resolves.toBeDefined();
  });
});

describe("observations", () => {
  it("finds a keyword with demand and no owner", async () => {
    const context = await makeContext("noowner");
    const keyword = await makeKeyword(context, "payroll software");

    await prisma.keywordMetricsSnapshot.create({
      data: {
        websiteId: context.website.id,
        keywordId: keyword.id,
        capturedAt: daysAgo(3),
        searchVolume: 2400,
        sourceProvider: "SEMRUSH",
      },
    });

    const candidates = await detectOwnershipIssues(context);

    expect(candidates.map((c) => c.type)).toContain("NO_OWNING_PAGE");
  });

  it("finds the intended owner differing from the ranking page", async () => {
    // The demo's headline moment, and the reason ownership exists at all.
    const context = await makeContext("divergence");
    const keyword = await makeKeyword(context, "payroll software philippines");
    const owner = await makePage(context, "/payroll-software");
    const blog = await makePage(context, "/blog/payroll-guide");

    await assignOwnership(context, { keywordId: keyword.id, pageId: owner.id });
    await rank(context, keyword.id, { daysAgo: 3, pageId: blog.id, position: 11 });

    const candidates = await detectOwnershipIssues(context);
    const divergence = candidates.find((c) => c.type === "RANKING_URL_DIVERGENCE");

    expect(divergence).toBeDefined();
    expect(divergence?.copy.detail).toContain("/payroll-software");
    expect(divergence?.copy.detail).toContain("/blog/payroll-guide");
    // Observed, not diagnosed.
    expect(divergence?.copy.detail).not.toMatch(/cannibali/i);
  });

  it("finds the ranking page changing between captures", async () => {
    const context = await makeContext("switch");
    const keyword = await makeKeyword(context, "payroll software");
    const pageA = await makePage(context, "/a");
    const pageB = await makePage(context, "/b");

    await rank(context, keyword.id, { daysAgo: 20, pageId: pageA.id, position: 8 });
    await rank(context, keyword.id, { daysAgo: 3, pageId: pageB.id, position: 9 });

    const candidates = await detectOwnershipIssues(context);

    expect(candidates.map((c) => c.type)).toContain("RANKING_URL_SWITCH");
    expect(candidates.map((c) => c.type)).toContain("MULTIPLE_RANKING_PAGES");
  });

  it("counts by type for the command centre", async () => {
    const context = await makeContext("counts");
    const keyword = await makeKeyword(context, "payroll software");
    const owner = await makePage(context, "/owner");
    const other = await makePage(context, "/other");

    await assignOwnership(context, { keywordId: keyword.id, pageId: owner.id });
    await rank(context, keyword.id, { daysAgo: 20, pageId: other.id, position: 12 });
    await rank(context, keyword.id, { daysAgo: 3, pageId: other.id, position: 11 });

    const counts = await getOwnershipCounts(context);

    expect(counts.RANKING_URL_DIVERGENCE).toBe(1);
    expect(counts.NO_OWNING_PAGE).toBeUndefined();
  });

  it("does not observe another tenant's keywords", async () => {
    const a = await makeContext("o-iso-a");
    const b = await makeContext("o-iso-b");
    const keyword = await makeKeyword(b, "their keyword");

    await prisma.keywordMetricsSnapshot.create({
      data: {
        websiteId: b.website.id,
        keywordId: keyword.id,
        capturedAt: daysAgo(3),
        searchVolume: 5000,
        sourceProvider: "SEMRUSH",
      },
    });

    expect(await detectOwnershipIssues(a)).toHaveLength(0);
  });
});
