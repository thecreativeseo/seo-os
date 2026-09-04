import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * M2 database verification. Requires a live connection (DIRECT_URL).
 *
 * Covers the two release-blocking P0 invariants that can only be proven against a
 * real Postgres: the approved-context immutability trigger, and that the seed
 * creates tenant structure without inventing business facts.
 *
 * Every row this suite creates is removed in afterAll.
 */

const connectionString = process.env.DIRECT_URL;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: connectionString ?? "" }),
});

const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdOrganizationIds.length > 0) {
    // Approved context versions block DELETE by design, cascades included. Teardown
    // opts in explicitly for this transaction only; no application code does this.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
      await tx.organization.deleteMany({
        where: { id: { in: createdOrganizationIds } },
      });
    });
  }
  // Users are not owned by an Organization, so nothing cascades them away.
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

async function createFixture() {
  const suffix = Math.random().toString(36).slice(2, 10);

  const organization = await prisma.organization.create({
    data: { name: `Trigger Test ${suffix}`, slug: `trigger-test-${suffix}` },
  });
  createdOrganizationIds.push(organization.id);

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Test", slug: `test-${suffix}` },
  });

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: `${suffix}.example.com`,
      normalizedDomain: `${suffix}.example.com`,
    },
  });

  const user = await prisma.user.create({
    data: {
      authUserId: crypto.randomUUID(),
      email: `trigger-test-${suffix}@example.com`,
    },
  });

  createdUserIds.push(user.id);

  const context = await prisma.businessContext.create({
    data: { websiteId: website.id },
  });

  return { organization, workspace, website, user, context };
}

describe("seeded tenant structure", () => {
  // These describe the seed, not the database: on an instance where an operator
  // has removed the seeded organization, there is nothing to check and nothing
  // wrong. They skip, visibly, rather than fail or re-seed what was removed.
  let seeded = false;

  beforeAll(async () => {
    seeded = (await prisma.organization.count({ where: { slug: "the-creative-seo" } })) > 0;
  });

  it("creates Organization -> Workspace -> Website", async ({ skip }) => {
    if (!seeded) skip("the seeded organization is not present in this database");
    const organization = await prisma.organization.findUnique({
      where: { slug: "the-creative-seo" },
      include: { workspaces: { include: { websites: true } } },
    });

    expect(organization?.name).toBe("The Creative SEO");
    expect(organization?.workspaces).toHaveLength(1);
    expect(organization?.workspaces[0]?.name).toBe("SEO Team");
    expect(organization?.workspaces[0]?.websites[0]?.normalizedDomain).toBe("thecreativeseo.com");
  });

  it("seeds no business facts", async ({ skip }) => {
    if (!seeded) skip("the seeded organization is not present in this database");
    const organization = await prisma.organization.findUnique({
      where: { slug: "the-creative-seo" },
      include: { workspaces: { include: { websites: true } } },
    });
    const websiteId = organization?.workspaces[0]?.websites[0]?.id;
    expect(websiteId).toBeDefined();

    const where = { websiteId: websiteId! };
    const [goals, competitors, facts, rules, contexts] = await Promise.all([
      prisma.businessGoal.count({ where }),
      prisma.competitor.count({ where }),
      prisma.brandFact.count({ where }),
      prisma.seoRule.count({ where }),
      prisma.businessContext.count({ where }),
    ]);

    expect({ goals, competitors, facts, rules, contexts }).toEqual({
      goals: 0,
      competitors: 0,
      facts: 0,
      rules: 0,
      contexts: 0,
    });
  });

  it("grants no memberships, so the seeded tenant is unreachable until provisioned", async ({
    skip,
  }) => {
    if (!seeded) skip("the seeded organization is not present in this database");
    const organization = await prisma.organization.findUnique({
      where: { slug: "the-creative-seo" },
      include: { memberships: true },
    });
    expect(organization?.memberships).toHaveLength(0);
  });
});

describe("approved business context immutability", () => {
  it("permits the DRAFT -> APPROVED transition", async () => {
    const { user, context } = await createFixture();

    const version = await prisma.businessContextVersion.create({
      data: {
        businessContextId: context.id,
        versionNumber: 1,
        createdByUserId: user.id,
        companySummary: "Draft summary",
      },
    });

    const approved = await prisma.businessContextVersion.update({
      where: { id: version.id },
      data: {
        status: "APPROVED",
        approvedByUserId: user.id,
        approvedAt: new Date(),
      },
    });

    expect(approved.status).toBe("APPROVED");
  });

  it("rejects UPDATE of an approved version", async () => {
    const { user, context } = await createFixture();

    const version = await prisma.businessContextVersion.create({
      data: {
        businessContextId: context.id,
        versionNumber: 1,
        createdByUserId: user.id,
        status: "APPROVED",
        approvedByUserId: user.id,
        approvedAt: new Date(),
      },
    });

    await expect(
      prisma.businessContextVersion.update({
        where: { id: version.id },
        data: { companySummary: "tampered" },
      }),
    ).rejects.toThrow(/immutable/i);

    const unchanged = await prisma.businessContextVersion.findUnique({
      where: { id: version.id },
    });
    expect(unchanged?.companySummary).toBeNull();
  });

  it("rejects DELETE of an approved version", async () => {
    const { user, context } = await createFixture();

    const version = await prisma.businessContextVersion.create({
      data: {
        businessContextId: context.id,
        versionNumber: 1,
        createdByUserId: user.id,
        status: "APPROVED",
        approvedByUserId: user.id,
        approvedAt: new Date(),
      },
    });

    await expect(
      prisma.businessContextVersion.delete({ where: { id: version.id } }),
    ).rejects.toThrow(/immutable/i);

    expect(await prisma.businessContextVersion.count({ where: { id: version.id } })).toBe(1);
  });

  it("still allows draft versions to be edited", async () => {
    const { user, context } = await createFixture();

    const version = await prisma.businessContextVersion.create({
      data: {
        businessContextId: context.id,
        versionNumber: 1,
        createdByUserId: user.id,
        companySummary: "first",
      },
    });

    const edited = await prisma.businessContextVersion.update({
      where: { id: version.id },
      data: { companySummary: "second" },
    });

    expect(edited.companySummary).toBe("second");
  });
});

describe("website domain uniqueness", () => {
  it("rejects a duplicate normalized domain in the same workspace", async () => {
    const { workspace, website } = await createFixture();

    await expect(
      prisma.website.create({
        data: {
          workspaceId: workspace.id,
          domain: `https://www.${website.normalizedDomain}/`,
          normalizedDomain: website.normalizedDomain,
        },
      }),
    ).rejects.toThrow();
  });

  it("allows the same domain in a different workspace", async () => {
    const first = await createFixture();
    const second = await createFixture();

    const created = await prisma.website.create({
      data: {
        workspaceId: second.workspace.id,
        domain: first.website.domain,
        normalizedDomain: first.website.normalizedDomain,
      },
    });

    expect(created.normalizedDomain).toBe(first.website.normalizedDomain);
  });
});
