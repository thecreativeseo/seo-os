import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  TopicError,
  archiveTopic,
  createTopic,
  getTopic,
  getTopicMapping,
  listTopics,
  mapKeyword,
  mapPage,
  recomputeCoverage,
  slugify,
  unmapPage,
  updateTopic,
} from "@/server/services/topic";

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `top-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Topic ${label}`, slug: `top-${label}-${suffix}` },
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

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("authoring a topic", () => {
  it("records the two things nothing can derive", async () => {
    const context = await makeContext("author");

    const topic = await createTopic(context, {
      name: "Payroll Management",
      customerLanguage: "paying staff on time without spreadsheets",
      businessOutcome: "demo requests from finance leads",
      priority: 3,
    });

    // What makes a topic more than a keyword bucket.
    expect(topic.customerLanguage).toContain("spreadsheets");
    expect(topic.businessOutcome).toContain("demo requests");
    expect(topic.slug).toBe("payroll-management");
  });

  it("refuses a duplicate name", async () => {
    const context = await makeContext("dupe");
    await createTopic(context, { name: "Payroll" });

    await expect(createTopic(context, { name: "  payroll  " })).rejects.toBeInstanceOf(
      TopicError,
    );
  });

  it("refuses a name that cannot become a slug", async () => {
    const context = await makeContext("slug");

    await expect(createTopic(context, { name: "!!!" })).rejects.toBeInstanceOf(TopicError);
    expect(slugify("Payroll & HR — Software!")).toBe("payroll-hr-software");
  });

  it("keeps the pillar and the commercial destination separate", async () => {
    // The page that explains a topic is rarely the page that sells it.
    const context = await makeContext("pillar");
    const pillar = await makePage(context, "/payroll");
    const commercial = await makePage(context, "/payroll-software");

    const topic = await createTopic(context, {
      name: "Payroll",
      pillarPageId: pillar.id,
      commercialDestinationPageId: commercial.id,
    });

    const summary = await getTopic(context, topic.id);

    expect(summary?.pillarPath).toBe("/payroll");
    expect(summary?.commercialPath).toBe("/payroll-software");
  });

  it("refuses another tenant's page as a pillar", async () => {
    const a = await makeContext("p-iso-a");
    const b = await makeContext("p-iso-b");
    const theirPage = await makePage(b, "/theirs");

    await expect(
      createTopic(a, { name: "Payroll", pillarPageId: theirPage.id }),
    ).rejects.toBeInstanceOf(TopicError);
  });
});

describe("hierarchy", () => {
  it("nests a topic under a parent", async () => {
    const context = await makeContext("nest");
    const parent = await createTopic(context, { name: "Payroll" });
    await createTopic(context, { name: "Payroll Compliance", parentTopicId: parent.id });

    const summary = await getTopic(context, parent.id);

    expect(summary?.childCount).toBe(1);
  });

  it("refuses to make a topic its own parent", async () => {
    const context = await makeContext("self");
    const topic = await createTopic(context, { name: "Payroll" });

    await expect(
      updateTopic(context, topic.id, { parentTopicId: topic.id }),
    ).rejects.toBeInstanceOf(TopicError);
  });

  it("refuses a cycle further up the chain", async () => {
    // Cheap to check on write, impossible to recover from on read: a cycle makes
    // the hierarchy infinite and every traversal a hang.
    const context = await makeContext("cycle");
    const grandparent = await createTopic(context, { name: "A" });
    const parent = await createTopic(context, {
      name: "B",
      parentTopicId: grandparent.id,
    });
    const child = await createTopic(context, { name: "C", parentTopicId: parent.id });

    await expect(
      updateTopic(context, grandparent.id, { parentTopicId: child.id }),
    ).rejects.toBeInstanceOf(TopicError);
  });
});

describe("mapping and coverage", () => {
  it("recomputes coverage as the mapping changes", async () => {
    const context = await makeContext("recompute");
    const topic = await createTopic(context, { name: "Payroll" });

    expect((await getTopic(context, topic.id))?.coverage.status).toBe("UNMAPPED");

    const page = await makePage(context, "/payroll");
    await mapPage(context, topic.id, page.id, "PILLAR");

    // Pages but no keywords: nothing to assess against.
    expect((await getTopic(context, topic.id))?.coverage.status).toBe("UNKNOWN");

    for (let index = 0; index < 3; index += 1) {
      const keyword = await makeKeyword(context, `payroll keyword ${index}`);
      await mapKeyword(context, topic.id, keyword.id);
    }

    expect((await getTopic(context, topic.id))?.coverage.status).toBe("COVERED");

    for (let index = 3; index < 9; index += 1) {
      const keyword = await makeKeyword(context, `payroll keyword ${index}`);
      await mapKeyword(context, topic.id, keyword.id);
    }

    const partial = await getTopic(context, topic.id);
    expect(partial?.coverage.status).toBe("PARTIAL");
    expect(partial?.keywordCount).toBe(9);
    expect(partial?.pageCount).toBe(1);
  });

  it("lets a person overrule the computed status, and says so", async () => {
    const context = await makeContext("override");
    const topic = await createTopic(context, { name: "Payroll" });

    await updateTopic(context, topic.id, { coverageStatus: "PLANNED" });

    const summary = await getTopic(context, topic.id);

    expect(summary?.coverage.status).toBe("PLANNED");
    expect(summary?.coverageSource).toBe("USER_PROVIDED");
    // The screen has to be able to say which of the two a reader is looking at.
    expect(summary?.coverage.reason).toBe("Set by your team.");
  });

  it("does not overwrite a person's judgement when the mapping changes", async () => {
    const context = await makeContext("respect");
    const topic = await createTopic(context, { name: "Payroll" });
    await updateTopic(context, topic.id, { coverageStatus: "PLANNED" });

    const page = await makePage(context, "/payroll");
    await mapPage(context, topic.id, page.id, "PILLAR");
    const keyword = await makeKeyword(context, "payroll software");
    await mapKeyword(context, topic.id, keyword.id);

    expect((await getTopic(context, topic.id))?.coverage.status).toBe("PLANNED");
  });

  it("returns to a computed status when explicitly recomputed", async () => {
    const context = await makeContext("reclaim");
    const topic = await createTopic(context, { name: "Payroll" });
    await updateTopic(context, topic.id, { coverageStatus: "COVERED" });

    const coverage = await recomputeCoverage(context, topic.id);

    expect(coverage.status).toBe("UNMAPPED");
    expect((await getTopic(context, topic.id))?.coverageSource).toBe("SYSTEM_DERIVED");
  });

  it("flags two pages holding the same singular role", async () => {
    const context = await makeContext("overlap");
    const topic = await createTopic(context, { name: "Payroll" });
    const first = await makePage(context, "/payroll");
    const second = await makePage(context, "/payroll-hub");

    await mapPage(context, topic.id, first.id, "PILLAR");
    await mapPage(context, topic.id, second.id, "PILLAR");

    expect((await getTopic(context, topic.id))?.coverage.status).toBe("OVERLAPPING");
  });

  it("changes a page's role without duplicating the mapping", async () => {
    const context = await makeContext("role");
    const topic = await createTopic(context, { name: "Payroll" });
    const page = await makePage(context, "/payroll");

    await mapPage(context, topic.id, page.id, "SUPPORTING");
    await mapPage(context, topic.id, page.id, "PILLAR");

    const mapping = await getTopicMapping(context, topic.id);

    expect(mapping.pages).toHaveLength(1);
    expect(mapping.pages[0]?.role).toBe("PILLAR");
  });

  it("unmaps a page and updates coverage", async () => {
    const context = await makeContext("unmap");
    const topic = await createTopic(context, { name: "Payroll" });
    const page = await makePage(context, "/payroll");
    const keyword = await makeKeyword(context, "payroll software");

    await mapPage(context, topic.id, page.id, "PILLAR");
    await mapKeyword(context, topic.id, keyword.id);
    expect((await getTopic(context, topic.id))?.coverage.status).toBe("COVERED");

    await unmapPage(context, topic.id, page.id);
    expect((await getTopic(context, topic.id))?.coverage.status).toBe("UNMAPPED");
  });

  it("lets one keyword serve two topics", async () => {
    // Many-to-many on purpose: a keyword can legitimately belong to two subjects.
    const context = await makeContext("shared");
    const payroll = await createTopic(context, { name: "Payroll" });
    const compliance = await createTopic(context, { name: "Compliance" });
    const keyword = await makeKeyword(context, "payroll compliance philippines");

    await mapKeyword(context, payroll.id, keyword.id);
    await mapKeyword(context, compliance.id, keyword.id);

    expect((await getTopicMapping(context, payroll.id)).keywords).toHaveLength(1);
    expect((await getTopicMapping(context, compliance.id)).keywords).toHaveLength(1);
  });

  it("refuses to map another tenant's keyword", async () => {
    const a = await makeContext("m-iso-a");
    const b = await makeContext("m-iso-b");
    const topic = await createTopic(a, { name: "Payroll" });
    const theirKeyword = await makeKeyword(b, "theirs");

    await expect(mapKeyword(a, topic.id, theirKeyword.id)).rejects.toBeInstanceOf(
      TopicError,
    );
  });
});

describe("listing", () => {
  it("hides archived topics", async () => {
    const context = await makeContext("archive");
    const kept = await createTopic(context, { name: "Kept" });
    const gone = await createTopic(context, { name: "Gone" });

    await archiveTopic(context, gone.id);

    const topics = await listTopics(context);

    expect(topics.map((topic) => topic.id)).toEqual([kept.id]);
  });

  it("does not list another tenant's topics", async () => {
    const a = await makeContext("l-iso-a");
    const b = await makeContext("l-iso-b");

    await createTopic(b, { name: "Their Topic" });

    expect(await listTopics(a)).toHaveLength(0);
  });
});
