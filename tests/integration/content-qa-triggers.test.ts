import crypto from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { runQa } from "@/server/services/content-qa";
import { QaFixtures } from "../helpers/qa-fixture";
import { installQaStub } from "../helpers/qa-stub";

/**
 * The QA history triggers (P4, migration 20260907020000).
 *
 * A completed run and every result are history. The one change they may take
 * is a reference the database itself nulls when the row it points at is
 * deleted - an evidence package, an AI run, a business context version - so
 * that the documented history teardown of a website works. Everything else
 * about them is fixed: the binding, the hash, the outcome, the counts, the
 * findings. A reference gaining a value, or swapping one row for another, is
 * a mutation like any other and is refused.
 */

const fixtures = new QaFixtures();

afterEach(() => resetProvider());
afterAll(async () => {
  await fixtures.teardown();
  await prisma.$disconnect();
});

/** A tenant whose work item has one completed QA run, judged, with everything attached. */
async function judgedRun(label: string) {
  const tenant = await fixtures.tenant(label);
  const lead = await fixtures.colleague(tenant, "SEO_LEAD");
  const { item } = await fixtures.readyForQa(tenant, lead);
  installQaStub();
  const outcome = await runQa(tenant, item.id);
  if (!outcome.ok) throw new Error(`${label}: the run failed`);
  resetProvider();
  const run = await prisma.contentQaRun.findUniqueOrThrow({ where: { id: outcome.run.id } });
  expect(run.status).toBe("COMPLETED");
  expect(run.evidencePackageId).not.toBeNull();
  expect(run.aiRunId).not.toBeNull();
  expect(run.contextVersionId).not.toBeNull();
  return { tenant, lead, item, run };
}

describe("referential cleanup on QA history", () => {
  it("lets the database null a reference whose row is gone, and changes nothing else", async () => {
    const { tenant, run } = await judgedRun("cleanup");
    const judgedResults = await prisma.contentQaResult.findMany({
      where: { qaRunId: run.id, aiRunId: { not: null } },
      select: { id: true },
    });
    expect(judgedResults.length).toBeGreaterThan(0);

    // The AI run goes: both the run and its results lose the reference, and
    // keep everything else exactly as it was.
    await prisma.aiRun.delete({ where: { id: run.aiRunId! } });
    const withoutAi = await prisma.contentQaRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(withoutAi.aiRunId).toBeNull();
    expect({ ...withoutAi, aiRunId: null }).toEqual({ ...run, aiRunId: null });
    for (const row of judgedResults) {
      const result = await prisma.contentQaResult.findUniqueOrThrow({ where: { id: row.id } });
      expect(result.aiRunId).toBeNull();
      expect(result.status).not.toBeNull();
    }

    // The evidence package goes: same again.
    await prisma.evidencePackage.delete({ where: { id: run.evidencePackageId! } });
    const withoutPackage = await prisma.contentQaRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(withoutPackage.evidencePackageId).toBeNull();
    expect({ ...withoutPackage, evidencePackageId: null, aiRunId: null }).toEqual({
      ...run,
      evidencePackageId: null,
      aiRunId: null,
    });
    expect(withoutPackage.revisionHash).toBe(run.revisionHash);
    expect(withoutPackage.outcome).toBe(run.outcome);
    expect(withoutPackage.inputsFingerprint).toBe(run.inputsFingerprint);

    // The results are still bound to their run, and still say what they said.
    const results = await prisma.contentQaResult.findMany({ where: { qaRunId: run.id } });
    expect(results).toHaveLength(10);
    expect(results.every((result) => result.revisionHash === run.revisionHash)).toBe(true);
    expect(tenant.website.id).toBe(withoutPackage.websiteId);
  });

  it("tears a website's history down the documented way, with no QA rows left behind", async () => {
    const { tenant, run } = await judgedRun("teardown");
    const websiteId = tenant.website.id;
    const organizationId = tenant.organization.id;
    expect(await prisma.contentQaResult.count({ where: { qaRunId: run.id } })).toBe(10);

    // Exactly what docs/DEPLOYMENT.md documents: the switch, then the delete.
    // No pre-deletion of anything, and the cascades do the rest.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
      await tx.organization.deleteMany({ where: { id: organizationId } });
    });

    for (const [label, count] of [
      ["qa runs", await prisma.contentQaRun.count({ where: { websiteId } })],
      ["qa results", await prisma.contentQaResult.count({ where: { websiteId } })],
      ["cms approvals", await prisma.contentCmsApproval.count({ where: { websiteId } })],
      ["ai runs", await prisma.aiRun.count({ where: { websiteId } })],
      ["packages", await prisma.evidencePackage.count({ where: { websiteId } })],
      ["revisions", await prisma.contentRevision.count({ where: { websiteId } })],
      ["work items", await prisma.contentWorkItem.count({ where: { websiteId } })],
      ["websites", await prisma.website.count({ where: { id: websiteId } })],
    ] as const) {
      expect(count, label).toBe(0);
    }
    expect(await prisma.contentQaRun.findUnique({ where: { id: run.id } })).toBeNull();
  });

  it("still refuses a delete without the switch", async () => {
    const { run } = await judgedRun("delete-guard");
    await expect(prisma.contentQaRun.delete({ where: { id: run.id } })).rejects.toThrow(/history/);
    const result = await prisma.contentQaResult.findFirstOrThrow({ where: { qaRunId: run.id } });
    await expect(prisma.contentQaResult.delete({ where: { id: result.id } })).rejects.toThrow(
      /history/,
    );
  });
});

describe("what a completed run still refuses", () => {
  it("refuses every business field, and every reference that gains or swaps a value", async () => {
    const { tenant, run } = await judgedRun("immutable");
    const otherRun = await prisma.aiRun.findFirstOrThrow({
      where: { websiteId: tenant.website.id, agentType: "CONTENT_BRIEF" },
      select: { id: true, evidencePackageId: true },
    });
    const mutations: [string, Record<string, unknown>][] = [
      ["revisionHash", { revisionHash: "sha256:something-else" }],
      ["contentRevisionId", { contentRevisionId: crypto.randomUUID() }],
      ["revisionNumber", { revisionNumber: run.revisionNumber + 1 }],
      ["briefVersion up", { briefVersion: run.briefVersion + 1 }],
      ["contentWorkItemId", { contentWorkItemId: crypto.randomUUID() }],
      ["contentDraftId", { contentDraftId: crypto.randomUUID() }],
      ["briefId", { briefId: crypto.randomUUID() }],
      ["briefVersion", { briefVersion: 99 }],
      ["websiteId", { websiteId: crypto.randomUUID() }],
      ["inputsFingerprint", { inputsFingerprint: "sha256:tampered" }],
      ["outcome", { outcome: "PASS" }],
      ["status", { status: "RUNNING" }],
      ["blockingCount", { blockingCount: run.blockingCount + 1 }],
      ["warningCount", { warningCount: run.warningCount + 1 }],
      ["notCheckedCount", { notCheckedCount: run.notCheckedCount + 1 }],
      ["checkerVersion", { checkerVersion: "qa-deterministic/0" }],
      ["requestedByUserId", { requestedByUserId: crypto.randomUUID() }],
      ["startedAt", { startedAt: new Date(0) }],
      ["completedAt", { completedAt: new Date(0) }],
      ["errorCode", { errorCode: "invented" }],
      ["errorSummary", { errorSummary: "invented" }],
      ["contextVersionId swap", { contextVersionId: crypto.randomUUID() }],
      ["aiRunId swap", { aiRunId: otherRun.id }],
      ["evidencePackageId swap", { evidencePackageId: otherRun.evidencePackageId }],
    ];
    const allowed: string[] = [];
    for (const [label, data] of mutations) {
      try {
        await prisma.contentQaRun.update({ where: { id: run.id }, data });
        allowed.push(label);
      } catch (error) {
        expect(String(error), label).toMatch(/immutable|foreign key|violates/i);
      }
    }
    expect(allowed).toEqual([]);

    // Writing a column its own value changes nothing, and is not refused.
    await prisma.contentQaRun.update({
      where: { id: run.id },
      data: { outcome: run.outcome, blockingCount: run.blockingCount },
    });

    // Nothing moved.
    const after = await prisma.contentQaRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toEqual(run);

    // A reference may only lose its value. Once null, it may not gain one.
    await prisma.aiRun.delete({ where: { id: run.aiRunId! } });
    const nulled = await prisma.contentQaRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(nulled.aiRunId).toBeNull();
    await expect(
      prisma.contentQaRun.update({ where: { id: run.id }, data: { aiRunId: otherRun.id } }),
    ).rejects.toThrow(/immutable/);
    await prisma.evidencePackage.delete({ where: { id: run.evidencePackageId! } });
    await expect(
      prisma.contentQaRun.update({
        where: { id: run.id },
        data: { evidencePackageId: otherRun.evidencePackageId },
      }),
    ).rejects.toThrow(/immutable/);
  });
});

describe("what a result still refuses", () => {
  it("cannot move to another run, change what it judged, or be added after the run closed", async () => {
    const { tenant, item, run } = await judgedRun("result");
    installQaStub();
    const second = await runQa(tenant, item.id);
    resetProvider();
    if (!second.ok) throw new Error("the second run failed");
    const result = await prisma.contentQaResult.findFirstOrThrow({
      where: { qaRunId: run.id, qaType: "STRUCTURE" },
    });

    const mutations: [string, Record<string, unknown>][] = [
      ["another run", { qaRunId: second.run.id }],
      ["revisionHash", { revisionHash: "sha256:tampered" }],
      ["contentRevisionId", { contentRevisionId: crypto.randomUUID() }],
      ["qaType", { qaType: "READABILITY" }],
      ["status", { status: "PASS" }],
      ["source", { source: "AI_JUDGED" }],
      ["findings", { issuesJson: { version: 1, findings: [], coverage: [], considered: {} } }],
      ["blocking issues", { blockingIssuesJson: [{ code: "PLANTED", severity: "BLOCKING" }] }],
      ["checkerVersion", { checkerVersion: "qa-deterministic/0" }],
      ["notCheckedReason", { notCheckedReason: "NO_PROVIDER" }],
      ["websiteId", { websiteId: crypto.randomUUID() }],
    ];
    const allowedOnResult: string[] = [];
    for (const [label, data] of mutations) {
      try {
        await prisma.contentQaResult.update({ where: { id: result.id }, data });
        allowedOnResult.push(label);
      } catch (error) {
        expect(String(error), label).toMatch(/immutable|foreign key|violates|unique/i);
      }
    }
    expect(allowedOnResult).toEqual([]);
    expect(await prisma.contentQaResult.findUniqueOrThrow({ where: { id: result.id } })).toEqual(
      result,
    );

    // And nothing may be added to a run that has closed.
    await expect(
      prisma.contentQaResult.create({
        data: {
          websiteId: tenant.website.id,
          contentRevisionId: run.contentRevisionId,
          qaRunId: run.id,
          revisionHash: run.revisionHash,
          qaType: "DUPLICATION_RISK",
          status: "PASS",
          checkerVersion: "qa-deterministic/1",
        },
      }),
    ).rejects.toThrow(/COMPLETED|unique/i);
  });
});
