import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { websiteScope } from "@/server/auth/guards";
import {
  activeExecutionFor,
  externalDraftFor,
  getExecution,
  listExecutions,
  listExecutionSteps,
  preflightCreateCmsDraft,
  requestCmsDraftExecution,
  unresolvedExecutionFor,
} from "@/server/services/execution";
import type { Execution } from "@/generated/prisma/client";
import { CmsFixtures, type CmsFixture } from "../helpers/cms-fixture";
import type { QaFixture } from "../helpers/qa-fixture";

/**
 * P4 M6.1: tenant isolation across the execution domain.
 *
 * The consequence here is worse than a leak. A cross-tenant execution would
 * mean SEO OS writing one customer's words into another customer's WordPress,
 * with that customer's credentials. Every id below is real and belongs to
 * someone else; none of them may do anything.
 *
 * Note what the service takes: a work item id, and a post-or-page choice. There
 * is no parameter naming a connection, an approval, a QA run or an execution,
 * so there is nothing else an attacker could put in the request. That is the
 * design, and these tests are what hold it in place.
 */

const fixtures = new CmsFixtures();
let owner: CmsFixture;
let attacker: QaFixture;
let execution: Execution;

beforeAll(async () => {
  owner = await fixtures.approvedForCms("iso");
  attacker = await fixtures.qa.tenant("iso-b");

  const created = await requestCmsDraftExecution(owner.lead, owner.item.id, {
    targetEntityType: "POST",
  });
  execution = await prisma.execution.update({
    where: { id: created.execution.id },
    data: { status: "SUCCEEDED", externalEntityId: "9001", externalStatus: "draft" },
  });
}, 90_000);

afterAll(async () => {
  resetProvider();
  vi.unstubAllEnvs();
  await fixtures.teardown();
  await prisma.$disconnect();
});

describe("another tenant's work", () => {
  it("cannot be preflighted, and reads as absent rather than forbidden", async () => {
    const result = await preflightCreateCmsDraft(attacker, owner.item.id, {
      targetEntityType: "POST",
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.checkId).toBe("work_item");
    expect(result.refusal?.code).toBe("not_found");
    expect(result.plan).toBeNull();
  });

  it("cannot be executed", async () => {
    await expect(
      requestCmsDraftExecution(attacker, owner.item.id, { targetEntityType: "POST" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("gains nothing from a second attempt or the other target type", async () => {
    for (const entity of ["POST", "PAGE"] as const) {
      await expect(
        requestCmsDraftExecution(attacker, owner.item.id, { targetEntityType: entity }),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    expect(await prisma.execution.count({ where: { websiteId: attacker.website.id } })).toBe(0);
  });
});

describe("another tenant's execution records", () => {
  it("cannot be read by id", async () => {
    expect(await getExecution(attacker, execution.id)).toBeNull();
    expect(await listExecutionSteps(attacker, execution.id)).toEqual([]);
  });

  it("never appears in a listing", async () => {
    expect(await listExecutions(attacker, owner.item.id)).toEqual([]);
    expect(await activeExecutionFor(attacker, owner.item.id)).toBeNull();
    expect(await unresolvedExecutionFor(attacker, owner.item.id)).toBeNull();
    expect(await externalDraftFor(attacker, owner.item.id)).toBeNull();
  });

  it("is still perfectly readable by the tenant that owns it", async () => {
    expect((await getExecution(owner.lead, execution.id))?.id).toBe(execution.id);
    expect(await listExecutions(owner.lead, owner.item.id)).toHaveLength(1);
    expect((await externalDraftFor(owner.lead, owner.item.id))?.externalEntityId).toBe("9001");
  });
});

describe("another tenant's connection and what it may do", () => {
  it("is invisible under the attacker's scope", async () => {
    expect(
      await prisma.connection.findFirst({
        where: { id: owner.connection.id, ...websiteScope(attacker) },
      }),
    ).toBeNull();
    expect(
      await prisma.connectionCapability.findFirst({
        where: { connectionId: owner.connection.id, ...websiteScope(attacker) },
      }),
    ).toBeNull();
    expect(
      await prisma.publishingPolicy.findFirst({
        where: { connectionId: owner.connection.id, ...websiteScope(attacker) },
      }),
    ).toBeNull();
    expect(
      await prisma.contentCmsApproval.findFirst({
        where: { id: owner.approval.id, ...websiteScope(attacker) },
      }),
    ).toBeNull();
  });

  it("cannot be reached even when the attacker's own website has none", async () => {
    // The attacker has a work item of their own and no WordPress at all. The
    // connection is resolved from the tenant context, so the neighbouring
    // tenant's connection is not a candidate: the answer is "none configured".
    const { workItemId } = await attackerWorkItem();
    const result = await preflightCreateCmsDraft(attacker, workItemId, {
      targetEntityType: "POST",
    });
    expect(result.refusal?.code).toBe("not_configured");
    expect(result.refusal?.checkId).toBe("connection");
  });
});

describe("another tenant's external CMS entity", () => {
  it("cannot be claimed by an execution of the attacker's own", async () => {
    const { workItemId, recommendationId, decisionId } = await attackerWorkItem();
    await expect(
      prisma.execution.create({
        data: {
          websiteId: attacker.website.id,
          recommendationId,
          decisionId,
          contentWorkItemId: workItemId,
          contentRevisionId: execution.contentRevisionId,
          revisionHash: execution.revisionHash,
          executionType: "APPLY_INTERNAL_LINK_UPDATE",
          provider: "WORDPRESS",
          connectionId: owner.connection.id,
          externalEntityId: "9001",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("roles inside the owning tenant", () => {
  it("refuse a viewer and a member, and admit an SEO lead", async () => {
    const viewer = await fixtures.qa.colleague(owner.tenant, "VIEWER");
    const member = await fixtures.qa.colleague(owner.tenant, "MEMBER");

    for (const context of [viewer, member]) {
      const result = await preflightCreateCmsDraft(context, owner.item.id, {
        targetEntityType: "POST",
      });
      expect(result.refusal?.checkId).toBe("role");
      expect(result.refusal?.code).toBe("forbidden");
    }

    const lead = await preflightCreateCmsDraft(owner.lead, owner.item.id, {
      targetEntityType: "POST",
    });
    expect(lead.refusal?.checkId).not.toBe("role");
  });
});

/** A bare piece of work in the attacker's tenant, with its own recommendation. */
async function attackerWorkItem() {
  const recommendation = await prisma.recommendation.create({
    data: {
      websiteId: attacker.website.id,
      type: "CONTENT_REFRESH",
      status: "APPROVED",
      title: "Their own work",
      summary: "Something of their own.",
      rationale: "Their own reasons.",
    },
  });
  const decision = await prisma.decision.create({
    data: {
      websiteId: attacker.website.id,
      recommendationId: recommendation.id,
      decision: "APPROVED",
      decidedByUserId: attacker.user.id,
    },
  });
  const item = await prisma.contentWorkItem.create({
    data: {
      websiteId: attacker.website.id,
      recommendationId: recommendation.id,
      decisionId: decision.id,
      type: "CONTENT_REFRESH",
      title: "Their own work",
      objective: "Their own objective.",
      status: "APPROVED_FOR_CMS",
    },
  });
  return { workItemId: item.id, recommendationId: recommendation.id, decisionId: decision.id };
}
