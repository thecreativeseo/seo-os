import crypto from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { systemContextFor } from "@/server/jobs/system-context";
import { reopenDraft } from "@/server/services/content-draft";
import {
  approveForCms,
  cmsApprovalFor,
  getQaRun,
  listCmsApprovals,
  listQaRuns,
  qaProvenanceFor,
  qaRunsForRevision,
  qaSummaryFor,
  runQa,
} from "@/server/services/content-qa";
import { QaFixtures, type QaFixture } from "../helpers/qa-fixture";
import { installQaStub } from "../helpers/qa-stub";

/**
 * P4 M5.5, the final hardening pass over the QA gate.
 *
 * The whole chain and the trail it leaves; the three things that can make an
 * approval stale, none of which rewrites it; the roles at the gate; what
 * stays impossible; and every M5 record read or acted on by the wrong tenant.
 */

const fixtures = new QaFixtures();

afterEach(() => resetProvider());
afterAll(async () => {
  await fixtures.teardown();
  await prisma.$disconnect();
});

/** A work item whose approved revision has passed QA and awaits the gate. */
async function atTheGate(label: string) {
  const tenant = await fixtures.tenant(label);
  const lead = await fixtures.colleague(tenant, "SEO_LEAD");
  const { item, draft, revision } = await fixtures.readyForQa(tenant, lead);
  installQaStub();
  const run = await runQa(tenant, item.id);
  resetProvider();
  if (!run.ok) throw new Error(`${label}: the run failed`);
  return { tenant, lead, item, draft, revision, run: run.run };
}

const statusOf = async (id: string) =>
  (await prisma.contentWorkItem.findUniqueOrThrow({ where: { id } })).status;

describe("the whole chain, and the trail it leaves", () => {
  it("runs QA, passes the gate, and records every act on the right record", async () => {
    const { tenant, lead, item, draft, revision, run } = await atTheGate("chain");
    expect(await statusOf(item.id)).toBe("AWAITING_EDITOR_REVIEW");

    const approved = await approveForCms(lead, item.id, {
      note: "Read and accepted.",
      acknowledgeNotChecked: true,
    });
    expect(await statusOf(item.id)).toBe("APPROVED_FOR_CMS");

    // Sent back: the approval is invalidated, the history stays, and the work
    // returns through QA to drafting.
    const reopened = await reopenDraft(tenant, draft.id, "The pricing section needs rewriting.");
    expect(reopened.workItem.status).toBe("DRAFTING");
    expect(await cmsApprovalFor(tenant, item.id)).toBeNull();
    expect((await listCmsApprovals(tenant, item.id)).map((row) => row.status)).toEqual([
      "INVALIDATED",
    ]);
    // The QA history is untouched by any of it.
    expect((await listQaRuns(tenant, item.id)).map((row) => row.id)).toEqual([run.id]);
    expect((await qaRunsForRevision(tenant, revision.id)).map((row) => row.id)).toEqual([run.id]);
    const view = await getQaRun(tenant, run.id);
    expect(view?.results).toHaveLength(10);
    expect(view?.currency.revisionApproved).toBe(false);

    const events = await prisma.auditEvent.findMany({
      where: { websiteId: tenant.website.id },
      select: { entityType: true, entityId: true, action: true, afterSnapshotJson: true },
    });
    const has = (entityType: string, action: string, entityId?: string) =>
      events.some(
        (row) =>
          row.entityType === entityType &&
          row.action === action &&
          (!entityId || row.entityId === entityId),
      );
    expect(has("ContentQaRun", "EXECUTE", run.id)).toBe(true);
    expect(has("ContentQaRun", "COMPLETE", run.id)).toBe(true);
    expect(has("ContentCmsApproval", "APPROVE", approved.approval.id)).toBe(true);
    expect(has("ContentCmsApproval", "RETIRE", approved.approval.id)).toBe(true);
    expect(has("ContentWorkItem", "APPROVE", item.id)).toBe(true);
    expect(has("ContentWorkItem", "UPDATE", item.id)).toBe(true);
    expect(has("ContentDraft", "UPDATE", draft.id)).toBe(true);

    // The trail carries ids, codes and counts - never the content, the
    // evidence or anything a provider said.
    const trail = JSON.stringify(events);
    expect(trail).toContain(run.id);
    expect(trail).not.toContain("Every employer files the same forms");
    expect(trail).not.toContain("Payslips follow BIR formats. Every");
    expect(trail).not.toMatch(/sk-ant|api[_-]?key/i);
  });
});

describe("what makes an approval stale", () => {
  it("a fact, a rule, or the business context - and none of them rewrites it", async () => {
    for (const [label, change] of [
      [
        "a fact",
        async (tenant: QaFixture) => {
          await prisma.brandFact.update({
            where: { id: tenant.factApproved },
            data: { value: "Payslips follow the bureau's current formats" },
          });
        },
      ],
      [
        "a rule",
        async (tenant: QaFixture) => {
          await prisma.seoRule.update({
            where: { id: tenant.ruleId },
            data: { rule: "Meta titles stay under 55 characters." },
          });
        },
      ],
      [
        "the business context",
        async (tenant: QaFixture) => {
          // A person edits the approved context: that is a new version, and
          // approving it is what moves the ground under the old QA.
          const version = await prisma.businessContextVersion.findFirstOrThrow({
            where: { businessContext: { websiteId: tenant.website.id }, status: "APPROVED" },
          });
          await prisma.businessContextVersion.create({
            data: {
              businessContextId: version.businessContextId,
              versionNumber: version.versionNumber + 1,
              status: "APPROVED",
              createdByUserId: tenant.user.id,
              approvedByUserId: tenant.user.id,
              approvedAt: new Date(),
              companySummary: version.companySummary,
              brandVoice: "Plain, specific, and warmer than before.",
              prohibitedClaims: version.prohibitedClaims,
              avoidTopics: version.avoidTopics,
            },
          });
        },
      ],
    ] as const) {
      const { tenant, lead, item } = await atTheGate(`stale-${label.replace(/\s+/g, "-")}`);
      const approved = await approveForCms(lead, item.id, { acknowledgeNotChecked: true });
      expect((await cmsApprovalFor(tenant, item.id))?.executable, label).toBe(true);

      await change(tenant);

      const view = await cmsApprovalFor(tenant, item.id);
      expect(view?.executable, label).toBe(false);
      expect(view?.staleReasons, label).toContain("QA_INPUTS_CHANGED");
      // The approval itself is exactly as it was recorded.
      const row = await prisma.contentCmsApproval.findUniqueOrThrow({
        where: { id: approved.approval.id },
      });
      expect(row, label).toMatchObject({
        status: "APPROVED",
        invalidatedAt: null,
        invalidatedReason: null,
        revisionHash: approved.approval.revisionHash,
        qaRunId: approved.approval.qaRunId,
      });
      expect(await statusOf(item.id), label).toBe("APPROVED_FOR_CMS");
      // And the summary the screens read says the same.
      const summary = await qaSummaryFor(tenant, item.id);
      expect(summary?.latest?.current, label).toBe(false);
      expect(summary?.approval?.executable, label).toBe(false);
    }
  }, 240_000);
});

describe("the roles at the gate", () => {
  it("lets each role do exactly what its rank allows, and the system actor nothing", async () => {
    const { tenant, lead, item, draft } = await atTheGate("roles");
    const viewer = await fixtures.colleague(tenant, "VIEWER");
    const member = await fixtures.colleague(tenant, "MEMBER");
    const system = await systemContextFor(tenant.website.id);

    // Running QA: write and above, never a viewer or a job.
    installQaStub();
    await expect(runQa(viewer, item.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(runQa(system, item.id)).rejects.toMatchObject({ code: "forbidden" });
    const memberRun = await runQa(member, item.id);
    expect(memberRun.ok).toBe(true);
    resetProvider();

    // Approving for the CMS: review and above, never a member, viewer or job.
    for (const actor of [viewer, member, system]) {
      await expect(
        approveForCms(actor, item.id, { acknowledgeNotChecked: true }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await prisma.contentCmsApproval.count({ where: { contentWorkItemId: item.id } })).toBe(
      0,
    );

    // Returning for revision: write and above.
    await expect(reopenDraft(viewer, draft.id, "no")).rejects.toMatchObject({ code: "forbidden" });
    await expect(reopenDraft(system, draft.id, "no")).rejects.toMatchObject({ code: "forbidden" });

    // A lead may approve, and self-approval is recorded rather than refused.
    const approved = await approveForCms(lead, item.id, { acknowledgeNotChecked: true });
    expect(approved.approval.selfDecided).toBe(true);
    expect(await statusOf(item.id)).toBe("APPROVED_FOR_CMS");
    // A member may still send it back.
    const reopened = await reopenDraft(member, draft.id, "One more pass on the pricing.");
    expect(reopened.workItem.status).toBe("DRAFTING");
  }, 180_000);
});

describe("what stays impossible", () => {
  it("no approval without a passing current run, and no second one", async () => {
    const { tenant, lead, item, draft } = await atTheGate("impossible");

    // Approved once, never twice.
    await approveForCms(lead, item.id, { acknowledgeNotChecked: true });
    await expect(
      approveForCms(lead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    // QA still runs on approved work, and approving again needs the gate.
    installQaStub();
    const rerun = await runQa(tenant, item.id);
    resetProvider();
    expect(rerun.ok).toBe(true);
    expect(await statusOf(item.id)).toBe("APPROVED_FOR_CMS");

    // Back to drafting: nothing may be approved from there.
    await reopenDraft(tenant, draft.id, "Rewrite the opening.");
    await expect(runQa(tenant, item.id)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      approveForCms(lead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(
      await prisma.contentCmsApproval.count({
        where: { contentWorkItemId: item.id, status: "APPROVED" },
      }),
    ).toBe(0);
  }, 180_000);
});

describe("another tenant, against every M5 record", () => {
  it("reads nothing and acts on nothing, whatever id it holds", async () => {
    const { tenant, lead, item, draft, revision, run } = await atTheGate("iso");
    const approved = await approveForCms(lead, item.id, { acknowledgeNotChecked: true });
    const other = await fixtures.tenant("iso-other");
    const otherLead = await fixtures.colleague(other, "SEO_LEAD");

    // Readers: nothing comes back.
    expect(await getQaRun(other, run.id)).toBeNull();
    expect(await qaProvenanceFor(other, run.id)).toBeNull();
    expect(await listQaRuns(other, item.id)).toEqual([]);
    expect(await qaRunsForRevision(other, revision.id)).toEqual([]);
    expect(await qaSummaryFor(other, item.id)).toBeNull();
    expect(await cmsApprovalFor(other, item.id)).toBeNull();
    expect(await listCmsApprovals(other, item.id)).toEqual([]);

    // Acts: refused, as not-found where the record should be invisible.
    installQaStub();
    await expect(runQa(otherLead, item.id)).rejects.toMatchObject({ code: "not_found" });
    resetProvider();
    await expect(
      approveForCms(otherLead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(reopenDraft(otherLead, draft.id, "not yours")).rejects.toMatchObject({
      code: "not_found",
    });

    // Ids that are well-formed but name nothing of its own.
    const nothing = crypto.randomUUID();
    expect(await getQaRun(other, nothing)).toBeNull();
    expect(await cmsApprovalFor(other, nothing)).toBeNull();
    expect(await qaSummaryFor(other, nothing)).toBeNull();

    // Nothing of A's moved, and nothing of A's exists under B.
    expect(await statusOf(item.id)).toBe("APPROVED_FOR_CMS");
    expect(
      await prisma.contentCmsApproval.findUniqueOrThrow({ where: { id: approved.approval.id } }),
    ).toMatchObject({ status: "APPROVED", websiteId: tenant.website.id });
    expect(await prisma.contentQaRun.count({ where: { websiteId: other.website.id } })).toBe(0);
    expect(await prisma.contentCmsApproval.count({ where: { websiteId: other.website.id } })).toBe(
      0,
    );
  }, 180_000);
});
