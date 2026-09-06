import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { DemoSeedError } from "@/server/demo/p3";
import { seedP4Demo } from "@/server/demo/p4";

/**
 * The P4 M3 demo seed (docs/P4_SPEC.md §34, §35): runs the real services
 * under the stub provider into a demo tenant, refuses a real one, and can be
 * run again.
 */

const SEED_TIMEOUT = 120_000;
const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeTenant(label: string, isDemo: boolean): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `p4demo-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `P4 demo ${label}`, slug: `p4demo-${label}-${suffix}` },
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
    data: { organizationId: organization.id, name: "Investor Demo", slug: `demo-${suffix}` },
  });

  const host = isDemo ? `${label}-${suffix}.demo.example` : `${label}-${suffix}.example.com`;
  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: host,
      normalizedDomain: host,
      primaryLanguage: "en",
      primaryMarket: "PH",
      isDemo,
    },
  });

  await prisma.page.create({
    data: {
      websiteId: website.id,
      url: `https://${host}/blog/cohort-analysis-guide`,
      normalizedUrl: `https://${host}/blog/cohort-analysis-guide`,
      path: "/blog/cohort-analysis-guide",
      hostname: host,
      protocol: "https",
      sourceFirstSeen: "SITEMAP",
    },
  });

  await prisma.brandFact.create({
    data: {
      websiteId: website.id,
      category: "Product",
      factKey: "reports",
      value: "Cohort reports refresh hourly",
      approvalStatus: "APPROVED",
    },
  });
  await prisma.seoRule.create({
    data: {
      websiteId: website.id,
      category: "Claims",
      rule: "Never quote customer counts.",
      severity: "BLOCKING",
      // A machine check, so the deliberately bad draft pass is blocked by a rule.
      checkJson: { kind: "forbidden_phrase", phrase: "Trusted by" },
    },
  });

  return { user, membership, organization, workspace, website };
}

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

describe("the P4 demo seed", () => {
  it(
    "produces the M3 stories through the real services, and runs again cleanly",
    async () => {
      const tenant = await makeTenant("stories", true);

      const first = await seedP4Demo(tenant);
      const statuses = first.briefs.map((row) => row.status).sort();
      expect(statuses).toEqual([
        "APPROVED",
        "APPROVED",
        "AWAITING_REVIEW",
        "SUPERSEDED",
        "SUPERSEDED",
      ]);

      const items = await prisma.contentWorkItem.findMany({
        where: { websiteId: tenant.website.id },
        orderBy: { createdAt: "asc" },
      });
      expect(items.map((row) => row.type).sort()).toEqual([
        "CONTENT_REFRESH",
        "NEW_CONTENT",
        "NEW_CONTENT",
      ]);

      const refresh = items.find((row) => row.id === first.refreshItemId)!;
      const created = items.find((row) => row.id === first.newContentItemId)!;
      const compare = items.find((row) => row.id === first.compareItemId)!;
      expect(refresh.status).toBe("QA");
      expect(created.status).toBe("BRIEFING");
      expect(compare.status).toBe("DRAFTING");

      const refreshBriefs = await prisma.contentBrief.findMany({
        where: { contentWorkItemId: refresh.id },
        orderBy: { version: "asc" },
      });
      expect(refreshBriefs.map((row) => [row.version, row.status])).toEqual([
        [1, "SUPERSEDED"],
        [2, "APPROVED"],
      ]);
      expect(refreshBriefs[0]!.createdByAiRunId).not.toBeNull();
      expect(refreshBriefs[1]!.createdByUserId).toBe(tenant.user.id);

      // M4.2 / M4.3: the refresh draft - AI v1 flagged and blocking, human v2
      // clean, review requested.
      expect(first.revisions).toEqual([
        { revisionNumber: 1, blocking: true, author: "AI" },
        { revisionNumber: 2, blocking: false, author: "HUMAN" },
      ]);
      const draft = await prisma.contentDraft.findUniqueOrThrow({
        where: { id: first.reviewDraftId },
        include: { revisions: { orderBy: { revisionNumber: "asc" } } },
      });
      expect(draft.contentWorkItemId).toBe(refresh.id);
      expect(draft.briefId).toBe(refreshBriefs[1]!.id);
      // Story B ends approved for QA on exactly revision 2 (M4.5).
      expect(draft.status).toBe("APPROVED");
      expect(draft.approvedRevisionId).toBe(draft.revisions[1]!.id);
      expect(draft.approvedRevisionHash).toBe(draft.revisions[1]!.contentHash);
      expect(draft.approvedByUserId).toBe(tenant.user.id);
      expect(draft.approvedReviewId).not.toBeNull();
      expect(refresh.status).toBe("QA");
      const refreshReviews = await prisma.contentDraftReview.findMany({
        where: { contentDraftId: draft.id },
      });
      expect(refreshReviews.map((row) => [row.status, row.revisionNumber])).toEqual([
        ["APPROVED", 2],
      ]);
      // Story A: the generated brief v1 went through review before approval.
      expect(
        await prisma.auditEvent.count({
          where: { entityType: "ContentBrief", entityId: refreshBriefs[0]!.id, action: "UPDATE" },
        }),
      ).toBeGreaterThanOrEqual(1);
      expect(draft.revisions[0]!.bodyMarkdown).not.toContain("https://research.example");
      expect(draft.revisions[1]!.createdByUserId).toBe(tenant.user.id);
      expect(draft.revisions[1]!.basedOnRevisionNumber).toBe(1);
      expect(draft.currentRevisionId).toBe(draft.revisions[1]!.id);
      expect(await prisma.contentDraft.count({ where: { contentWorkItemId: created.id } })).toBe(0);

      // The supersession story: the old draft kept and superseded, the new one on v2.
      const old = await prisma.contentDraft.findUniqueOrThrow({
        where: { id: first.supersession.oldDraftId },
        include: { brief: true, _count: { select: { revisions: true } } },
      });
      const fresh = await prisma.contentDraft.findUniqueOrThrow({
        where: { id: first.supersession.newDraftId },
        include: { brief: true, revisions: true },
      });
      expect(old.contentWorkItemId).toBe(compare.id);
      expect([old.status, old.brief.version, old.brief.status, old._count.revisions]).toEqual([
        "SUPERSEDED",
        1,
        "SUPERSEDED",
        1,
      ]);
      expect([fresh.status, fresh.brief.version, fresh.brief.status]).toEqual([
        "DRAFTING",
        2,
        "APPROVED",
      ]);
      // Story C: approved, reopened with a reason, revised by hand. The
      // approval is history, not current.
      expect(first.reopenedDraftId).toBe(fresh.id);
      expect(fresh.revisions).toHaveLength(2);
      expect(
        fresh.revisions.find((row) => row.revisionNumber === 1)?.evidencePackageId,
      ).not.toBeNull();
      expect(fresh.revisions.find((row) => row.revisionNumber === 2)?.createdByUserId).toBe(
        tenant.user.id,
      );
      expect(fresh.approvedRevisionId).toBeNull();
      expect(fresh.approvedReviewId).toBeNull();
      const freshReviews = await prisma.contentDraftReview.findMany({
        where: { contentDraftId: fresh.id },
      });
      expect(freshReviews.map((row) => [row.status, row.revisionNumber])).toEqual([
        ["APPROVED", 1],
      ]);
      expect(
        await prisma.auditEvent.count({
          where: {
            entityType: "ContentDraftReview",
            entityId: freshReviews[0]!.id,
            action: "RETIRE",
          },
        }),
      ).toBe(1);
      const reviewRowsFirst = await prisma.contentDraftReview.count({
        where: { websiteId: tenant.website.id },
      });
      expect(reviewRowsFirst).toBe(2);

      // Run again: the stories are rebuilt, not duplicated.
      const second = await seedP4Demo(tenant);
      expect(second.briefs.map((row) => row.status).sort()).toEqual(statuses);
      expect(await prisma.contentWorkItem.count({ where: { websiteId: tenant.website.id } })).toBe(
        3,
      );
      expect(await prisma.contentDraft.count({ where: { websiteId: tenant.website.id } })).toBe(3);
      expect(
        await prisma.contentDraftReview.count({ where: { websiteId: tenant.website.id } }),
      ).toBe(2);
      expect(await prisma.contentBrief.count({ where: { websiteId: tenant.website.id } })).toBe(5);
      expect(second.reviewDraftId).not.toBe(first.reviewDraftId);
    },
    SEED_TIMEOUT,
  );

  it("refuses a website that is not a demo", async () => {
    const real = await makeTenant("real", false);

    await expect(seedP4Demo(real)).rejects.toBeInstanceOf(DemoSeedError);
    expect(await prisma.contentWorkItem.count({ where: { websiteId: real.website.id } })).toBe(0);
  });
});
