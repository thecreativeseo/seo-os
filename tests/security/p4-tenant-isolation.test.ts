import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { decide } from "@/server/services/decision";
import {
  contentWorkForRecommendation,
  getContentWorkItem,
  listApprovedNotStarted,
  listContentWorkItems,
  startFromRecommendation,
} from "@/server/services/content-work";

/**
 * P4 tenant isolation (P4_ACCEPTANCE_CRITERIA, "Security attack tests").
 *
 * Tenant A holds a valid context of its own and supplies tenant B's ids.
 * Every read must come back empty and every write must be refused as "not
 * found" - never as a different error that would confirm the row exists.
 * Grows with each milestone as more of the twelve entities get a service.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Tenant = TenantContext & { recommendationId: string; itemId: string };

async function makeTenant(label: string): Promise<Tenant> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `p4iso-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `P4 iso ${label}`, slug: `p4iso-${label}-${suffix}` },
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

  const host = `${label}-${suffix}.example.com`;
  const website = await prisma.website.create({
    data: { workspaceId: workspace.id, domain: host, normalizedDomain: host, primaryMarket: "PH" },
  });

  const context: TenantContext = { user, membership, organization, workspace, website };

  const recommendation = await prisma.recommendation.create({
    data: {
      websiteId: website.id,
      type: "CONTENT_REFRESH",
      title: `${label} refresh`,
      summary: "Summary",
      rationale: "Rationale",
    },
  });
  await decide(context, recommendation.id, { decision: "APPROVED" });

  // A second, started one, so there is an item to reach for.
  const started = await prisma.recommendation.create({
    data: {
      websiteId: website.id,
      type: "CONTENT_CREATE",
      title: `${label} new page`,
      summary: "Summary",
      rationale: "Rationale",
    },
  });
  await decide(context, started.id, { decision: "APPROVED" });
  const item = await startFromRecommendation(context, started.id);

  return { ...context, recommendationId: recommendation.id, itemId: item.id };
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  [a, b] = await Promise.all([makeTenant("a"), makeTenant("b")]);
});

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
      await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
    });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("content work across tenants", () => {
  it("cannot be started from another tenant's approved recommendation", async () => {
    await expect(startFromRecommendation(a, b.recommendationId)).rejects.toMatchObject({
      name: "ContentWorkError",
      code: "not_found",
    });

    // Nothing was created for B either.
    expect(await contentWorkForRecommendation(b, b.recommendationId)).toBeNull();
  });

  it("cannot be read by id across tenants", async () => {
    expect(await getContentWorkItem(a, b.itemId)).toBeNull();
    expect(await getContentWorkItem(b, a.itemId)).toBeNull();
    expect(await getContentWorkItem(a, a.itemId)).not.toBeNull();
  });

  it("never lists another tenant's work or approved recommendations", async () => {
    const aItems = await listContentWorkItems(a, { status: "all" });
    expect(aItems.map((row) => row.id)).toEqual([a.itemId]);

    const aWaiting = await listApprovedNotStarted(a);
    expect(aWaiting.map((row) => row.recommendation.id)).toEqual([a.recommendationId]);

    expect(await contentWorkForRecommendation(a, b.recommendationId)).toBeNull();
  });

  it("cannot hand ownership to a user from another organization", async () => {
    await expect(
      startFromRecommendation(a, a.recommendationId, { ownerUserId: b.user.id }),
    ).rejects.toMatchObject({ code: "forbidden" });

    expect(await contentWorkForRecommendation(a, a.recommendationId)).toBeNull();
  });
});
