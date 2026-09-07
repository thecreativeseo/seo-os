import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { systemContextFor } from "@/server/jobs/system-context";
import {
  PREFLIGHT_CHECK_IDS,
  preflightCreateCmsDraft,
  type PreflightCheckId,
} from "@/server/services/execution";
import { CmsFixtures, SITE_URL, type CmsFixture } from "../helpers/cms-fixture";

/**
 * P4 M6.1: the gate before anything outside SEO OS is touched.
 *
 * Preflight is the whole safety argument of the milestone, so each of these
 * says one thing: with this one fact changed, no CMS call may happen. It reads
 * and it refuses; it never repairs, never re-runs QA, and never reaches a
 * network.
 */

const fixtures = new CmsFixtures();
let base: CmsFixture;

beforeAll(async () => {
  base = await fixtures.approvedForCms("pf");
}, 60_000);

afterAll(async () => {
  resetProvider();
  vi.unstubAllEnvs();
  await fixtures.teardown();
  await prisma.$disconnect();
});

const statusOf = (
  checks: { id: PreflightCheckId; status: string }[],
  id: PreflightCheckId,
): string => checks.find((check) => check.id === id)?.status ?? "MISSING";

async function run(context = base.lead, entity: "POST" | "PAGE" | null = "POST") {
  return preflightCreateCmsDraft(context, base.item.id, { targetEntityType: entity });
}

describe("a preflight with nothing wrong", () => {
  it("passes every check and produces a complete plan", async () => {
    const result = await run();

    expect(result.refusal).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([...PREFLIGHT_CHECK_IDS]);
    expect(result.checks.filter((check) => check.status !== "PASS")).toEqual([]);

    const plan = result.plan!;
    expect(plan.contentCmsApprovalId).toBe(base.approval.id);
    expect(plan.qaRunId).toBe(base.approval.qaRunId);
    expect(plan.contentRevisionId).toBe(base.approval.contentRevisionId);
    expect(plan.revisionHash).toBe(base.approval.revisionHash);
    expect(plan.connectionId).toBe(base.connection.id);
    expect(plan.canonicalSite).toBe(SITE_URL);
    expect(plan.siteHost).toBe("cms.example.com");
    expect(plan.targetEntityType).toBe("POST");
    expect(plan.permissionMode).toBe("DRAFT_ONLY");
    expect(plan.executionType).toBe("CREATE_CMS_DRAFT");
    expect(plan.idempotencyKey).toMatch(/^cms-exec\/1:[0-9a-f]{64}$/);
  });

  it("names every check it ran, so a report cannot quietly lose one", async () => {
    const result = await run();
    expect(result.checks).toHaveLength(PREFLIGHT_CHECK_IDS.length);
    for (const check of result.checks) expect(check.label.length).toBeGreaterThan(5);
  });
});

describe("who is asking", () => {
  it("refuses a scheduled job, whatever the website's data says", async () => {
    const system = await systemContextFor(base.tenant.website.id);
    const result = await run(system);
    expect(result.ok).toBe(false);
    expect(result.refusal?.code).toBe("forbidden");
    expect(result.refusal?.checkId).toBe("human_actor");
    // Nothing further is even evaluated for a job.
    expect(statusOf(result.checks, "approval")).toBe("NOT_RUN");
  });

  it("refuses a member, who may write content but not authorize CMS work", async () => {
    const member = await fixtures.qa.colleague(base.tenant, "MEMBER");
    const result = await run(member);
    expect(result.ok).toBe(false);
    expect(result.refusal?.checkId).toBe("role");
    expect(result.refusal?.code).toBe("forbidden");
  });

  it("refuses another tenant's work item as though it did not exist", async () => {
    const other = await fixtures.qa.tenant("pf-other");
    const result = await preflightCreateCmsDraft(other, base.item.id, {
      targetEntityType: "POST",
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.checkId).toBe("work_item");
    expect(result.refusal?.code).toBe("not_found");
  });
});

describe("the connection it would use", () => {
  afterAll(async () => {
    await fixtures.connect(base.tenant);
  });

  it("refuses when no WordPress connection is configured", async () => {
    await prisma.connectionCapability.deleteMany({ where: { connectionId: base.connection.id } });
    await prisma.publishingPolicy.deleteMany({ where: { connectionId: base.connection.id } });
    await prisma.connection.delete({ where: { id: base.connection.id } });

    const result = await run();
    expect(result.refusal?.checkId).toBe("connection");
    expect(result.refusal?.code).toBe("not_configured");
    // A missing connection leaves these unanswered rather than passed.
    expect(statusOf(result.checks, "connection_status")).toBe("NOT_RUN");
    expect(statusOf(result.checks, "capability")).toBe("NOT_RUN");
    expect(statusOf(result.checks, "policy")).toBe("NOT_RUN");

    base.connection = await fixtures.connect(base.tenant);
  });

  it("refuses a connection that is not connected", async () => {
    await fixtures.connect(base.tenant, { status: "REAUTH_REQUIRED" });
    const result = await run();
    expect(result.refusal?.checkId).toBe("connection_status");
    expect(result.refusal?.code).toBe("connection_disabled");
    await fixtures.connect(base.tenant, { status: "CONNECTED" });
  });

  it("refuses a connection whose site address is missing or would not be dialled", async () => {
    await fixtures.connect(base.tenant, { baseUrl: null });
    expect((await run()).refusal?.code).toBe("invalid_site_url");

    for (const bad of ["http://cms.example.com", "https://localhost", "https://10.0.0.4"]) {
      await fixtures.connect(base.tenant, { baseUrl: bad });
      const result = await run();
      expect(result.refusal?.checkId).toBe("site_url");
      expect(result.refusal?.code).toBe("invalid_site_url");
    }

    await fixtures.connect(base.tenant, { baseUrl: SITE_URL });
  });

  it("refuses when no publishing policy has been set", async () => {
    await prisma.publishingPolicy.deleteMany({ where: { connectionId: base.connection.id } });
    const result = await run();
    expect(result.refusal?.checkId).toBe("policy");
    expect(result.refusal?.code).toBe("not_configured");
    expect(statusOf(result.checks, "policy_mode")).toBe("NOT_RUN");
    await fixtures.connect(base.tenant, { mode: "DRAFT_ONLY" });
  });

  it("refuses a read-only policy, and the enum-only publish-everything mode", async () => {
    for (const mode of ["READ_ONLY", "FULL_PUBLISH"] as const) {
      await fixtures.connect(base.tenant, { mode });
      const result = await run();
      expect(result.refusal?.checkId).toBe("policy_mode");
      expect(result.refusal?.code).toBe("policy_denied");
    }
    await fixtures.connect(base.tenant, { mode: "DRAFT_ONLY" });
  });
});

describe("what it may create there", () => {
  afterAll(async () => {
    await fixtures.connect(base.tenant);
  });

  it("refuses until a person has said post or page", async () => {
    const result = await run(base.lead, null);
    expect(result.refusal?.checkId).toBe("target_type");
    expect(result.refusal?.code).toBe("target_type_unresolved");
    expect(statusOf(result.checks, "capability")).toBe("NOT_RUN");
  });

  it("suggests a target without deciding it", async () => {
    const result = await run(base.lead, null);
    expect(result.suggestion.reason.length).toBeGreaterThan(10);
    expect(result.plan).toBeNull();
  });

  it("refuses a kind the connection was never asked about", async () => {
    await fixtures.connect(base.tenant, { skipCapabilities: true });
    const result = await run(base.lead, "POST");
    expect(result.refusal?.checkId).toBe("capability");
    expect(result.refusal?.code).toBe("capability_missing");
    await fixtures.connect(base.tenant);
  });

  it("refuses a kind the CMS user may not create, and allows the kind they may", async () => {
    await fixtures.connect(base.tenant, { createDraftFor: ["POST"] });

    const page = await run(base.lead, "PAGE");
    expect(page.refusal?.checkId).toBe("capability");
    expect(page.refusal?.code).toBe("capability_missing");

    const post = await run(base.lead, "POST");
    expect(post.ok).toBe(true);

    await fixtures.connect(base.tenant);
  });
});

describe("the authorization behind it", () => {
  it("refuses work that is not approved for the CMS", async () => {
    await prisma.contentWorkItem.update({
      where: { id: base.item.id },
      data: { status: "AWAITING_EDITOR_REVIEW" },
    });
    const result = await run();
    expect(result.refusal?.checkId).toBe("work_item_status");
    expect(result.refusal?.code).toBe("policy_denied");
    await prisma.contentWorkItem.update({
      where: { id: base.item.id },
      data: { status: "APPROVED_FOR_CMS" },
    });
  });

  it("still passes once the status is put back, so the check reads the present", async () => {
    expect((await run()).ok).toBe(true);
  });
});
