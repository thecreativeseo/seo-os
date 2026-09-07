import crypto from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { systemContextFor } from "@/server/jobs/system-context";
import { approveDraft, reopenDraft, startDraftFromBrief } from "@/server/services/content-draft";
import { approveBrief, saveBrief } from "@/server/services/content-brief";
import type { KeywordIntent } from "@/generated/prisma/client";
import {
  approveForCms,
  cmsApprovalFor,
  listCmsApprovals,
  runQa,
} from "@/server/services/content-qa";
import type { TenantContext } from "@/server/auth/guards";
import { QaFixtures, type QaFixture } from "../helpers/qa-fixture";
import { installQaStub } from "../helpers/qa-stub";

/**
 * P4 M5.3: the human gate between a passing QA run and execution.
 *
 * A person with review rights approves exactly one revision, on the strength
 * of exactly one completed run, and only after everything M4.5 and M5.1 pin
 * still holds. Warnings, unchecked types and a superseded brief may be
 * accepted, explicitly and on the record; a blocking finding may not. The
 * approval is a decision, not a state: when the content moves it is
 * invalidated with a reason and stays readable as what it was.
 */

const fixtures = new QaFixtures();

afterEach(() => resetProvider());
afterAll(async () => {
  vi.unstubAllEnvs();
  await fixtures.teardown();
  await prisma.$disconnect();
});

/**
 * A work item whose approved revision has passed QA, awaiting final approval.
 * With a judge, every type is checked; without one, the judged types are
 * NOT_CHECKED, which is what a person has to acknowledge.
 */
async function awaitingApproval(label: string, options: { judge?: boolean } = {}) {
  const tenant = await fixtures.tenant(label);
  const lead = await fixtures.colleague(tenant, "SEO_LEAD");
  const { item, draft, revision, brief } = await fixtures.readyForQa(tenant, lead);
  if (options.judge === false) {
    vi.stubEnv("AI_PROVIDER", "null");
    resetProvider();
  } else {
    installQaStub();
  }
  const outcome = await runQa(tenant, item.id);
  vi.unstubAllEnvs();
  resetProvider();
  if (!outcome.ok) throw new Error(`${label}: the run failed`);
  expect(outcome.workItem.status).toBe("AWAITING_EDITOR_REVIEW");
  return { tenant, lead, item, draft, revision, brief, run: outcome.run };
}

const briefEdit = (brief: {
  title: string;
  contentType: string;
  searchIntent: KeywordIntent | null;
  primaryConversion: string | null;
  audience: string | null;
  customerProblem: string | null;
  desiredOutcome: string | null;
  brandVoiceNotes: string | null;
}) => ({
  title: brief.title,
  contentType: brief.contentType,
  searchIntent: brief.searchIntent,
  primaryConversion: brief.primaryConversion,
  audience: brief.audience,
  customerProblem: brief.customerProblem,
  desiredOutcome: brief.desiredOutcome,
  recommendedAngle: "Compliance first, then the price comparison buyers ask for.",
  keyQuestions: ["Which payroll tools produce BIR-compliant payslips?"],
  requiredSections: [{ heading: "What BIR compliance requires", purpose: "The core." }],
  optionalSections: [],
  externalEvidenceRequirements: [],
  brandVoiceNotes: brief.brandVoiceNotes,
});

/**
 * The same, but a newer brief version was approved while the piece was still
 * being written, so the revision that reaches the gate is pinned to the older
 * one. The only way a brief can be superseded here: once a draft is approved,
 * its work item is no longer briefable.
 */
async function awaitingApprovalOnOldBrief(label: string) {
  const tenant = await fixtures.tenant(label);
  const lead = await fixtures.colleague(tenant, "SEO_LEAD");
  const { item, draft, revision, brief } = await fixtures.readyForQa(tenant, lead, undefined, {
    approveDraft: false,
  });
  const edited = await saveBrief(tenant, brief.id, briefEdit(brief));
  const newer = await approveBrief(lead, edited.brief.id);
  await approveDraft(lead, draft.id, { note: "On v1 on purpose.", acknowledgeBriefMismatch: true });
  installQaStub();
  const outcome = await runQa(tenant, item.id);
  resetProvider();
  if (!outcome.ok) throw new Error(`${label}: the run failed`);
  return { tenant, lead, item, draft, revision, brief, newer, run: outcome.run };
}

async function statusOf(itemId: string) {
  return (await prisma.contentWorkItem.findUniqueOrThrow({ where: { id: itemId } })).status;
}

describe("approving content for CMS", () => {
  it("pins the revision, the hash and the run, records what was accepted, and moves the work item", async () => {
    const { tenant, lead, item, draft, revision, run } = await awaitingApproval("approve");
    const notChecked = await prisma.contentQaResult.count({
      where: { qaRunId: run.id, status: "NOT_CHECKED" },
    });

    const result = await approveForCms(lead, item.id, {
      note: "Warnings read, nothing blocking. Ready for the CMS.",
      acknowledgeNotChecked: true,
    });

    expect(result.approval).toMatchObject({
      contentWorkItemId: item.id,
      contentDraftId: draft.id,
      contentRevisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      revisionHash: revision.contentHash,
      qaRunId: run.id,
      briefVersion: 1,
      status: "APPROVED",
      approvedByUserId: lead.user.id,
      briefSupersededAcknowledged: false,
      notCheckedAcknowledged: notChecked > 0,
      selfDecided: true, // the lead editorially approved this revision in M4.5
      invalidatedAt: null,
      invalidatedReason: null,
      note: "Warnings read, nothing blocking. Ready for the CMS.",
    });
    expect(result.workItem.status).toBe("APPROVED_FOR_CMS");
    expect(result.run.id).toBe(run.id);

    // What the person accepted: codes and reasons, never content.
    const acknowledged = result.approval.acknowledgedJson as {
      version: number;
      notChecked: { qaType: string; reason: string | null }[];
      needsHumanConfirmation: unknown[];
      warningCount: number;
      briefSuperseded: boolean;
    };
    expect(acknowledged.version).toBe(1);
    expect(acknowledged.notChecked).toHaveLength(notChecked);
    expect(acknowledged.warningCount).toBe(run.warningCount);
    expect(acknowledged.briefSuperseded).toBe(false);
    expect(JSON.stringify(acknowledged)).not.toContain("Payslips follow BIR formats");

    // The reader says it may still authorize execution.
    const view = await cmsApprovalFor(tenant, item.id);
    expect(view).toMatchObject({ executable: true, staleReasons: [] });
    expect(view?.approval.id).toBe(result.approval.id);
    expect(view?.run?.id).toBe(run.id);
    expect(view?.approval.approvedBy.email).toBe(lead.user.email);
    expect((await listCmsApprovals(tenant, item.id)).map((row) => row.status)).toEqual([
      "APPROVED",
    ]);

    // The trail, with no content in it.
    const events = await prisma.auditEvent.findMany({
      where: {
        OR: [
          { entityType: "ContentCmsApproval", entityId: result.approval.id },
          { entityType: "ContentWorkItem", entityId: item.id, action: "APPROVE" },
        ],
      },
    });
    expect(events.map((event) => event.action).sort()).toEqual(["APPROVE", "APPROVE"]);
    const trail = JSON.stringify(events);
    expect(trail).toContain(run.id);
    expect(trail).not.toContain("Every employer files the same forms");
  });

  it("is a person's act at review level, and nothing else", async () => {
    const { tenant, item } = await awaitingApproval("roles");
    const viewer = await fixtures.colleague(tenant, "VIEWER");
    const member = await fixtures.colleague(tenant, "MEMBER");
    const admin = await fixtures.colleague(tenant, "ADMIN");
    const system = await systemContextFor(tenant.website.id);

    for (const actor of [viewer, member, system]) {
      await expect(
        approveForCms(actor, item.id, { acknowledgeNotChecked: true }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await statusOf(item.id)).toBe("AWAITING_EDITOR_REVIEW");
    expect(await prisma.contentCmsApproval.count({ where: { contentWorkItemId: item.id } })).toBe(
      0,
    );

    // An admin may, and is not the author, so it is not self-decided.
    const approved = await approveForCms(admin, item.id, { acknowledgeNotChecked: true });
    expect(approved.approval.selfDecided).toBe(false);
    expect(approved.workItem.status).toBe("APPROVED_FOR_CMS");
    // And nobody may approve it twice.
    await expect(
      approveForCms(admin, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("refuses unchecked types unless they are acknowledged, and records which", async () => {
    const { lead, item, run } = await awaitingApproval("acknowledge", { judge: false });
    const notChecked = await prisma.contentQaResult.findMany({
      where: { qaRunId: run.id, status: "NOT_CHECKED" },
      select: { qaType: true, notCheckedReason: true },
    });
    expect(notChecked.length).toBeGreaterThan(0);

    await expect(approveForCms(lead, item.id)).rejects.toMatchObject({
      code: "not_checked_unacknowledged",
    });
    const approved = await approveForCms(lead, item.id, { acknowledgeNotChecked: true });
    expect(approved.approval.notCheckedAcknowledged).toBe(true);
    const acknowledged = approved.approval.acknowledgedJson as {
      notChecked: { qaType: string; reason: string | null }[];
    };
    expect(acknowledged.notChecked.map((row) => row.qaType).sort()).toEqual(
      notChecked.map((row) => String(row.qaType)).sort(),
    );
    expect(acknowledged.notChecked.every((row) => row.reason !== null)).toBe(true);
  });

  it("refuses a superseded brief unless it is acknowledged, and keeps the older version pinned", async () => {
    const { lead, item, newer } = await awaitingApprovalOnOldBrief("old-brief");
    expect(newer.version).toBe(2);

    await expect(
      approveForCms(lead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "brief_superseded" });
    const approved = await approveForCms(lead, item.id, {
      acknowledgeNotChecked: true,
      acknowledgeBriefMismatch: true,
    });
    expect(approved.approval).toMatchObject({
      briefSupersededAcknowledged: true,
      briefVersion: 1,
    });
    expect(
      (approved.approval.acknowledgedJson as { briefSuperseded: boolean }).briefSuperseded,
    ).toBe(true);
  });

  it("refuses when the facts or rules changed after the run", async () => {
    const { tenant, lead, item } = await awaitingApproval("stale-inputs");
    await prisma.brandFact.create({
      data: {
        websiteId: tenant.website.id,
        category: "Product",
        factKey: "support",
        value: "Support answers within one business day",
        approvalStatus: "APPROVED",
      },
    });
    await expect(
      approveForCms(lead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "qa_stale" });
    expect(await statusOf(item.id)).toBe("AWAITING_EDITOR_REVIEW");
    expect(await prisma.contentCmsApproval.count({ where: { contentWorkItemId: item.id } })).toBe(
      0,
    );
  });

  it("refuses when no completed run stands behind the approved revision", async () => {
    const { tenant, lead, item } = await awaitingApproval("no-run");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
      await tx.contentQaResult.deleteMany({ where: { websiteId: tenant.website.id } });
      await tx.contentQaRun.deleteMany({ where: { websiteId: tenant.website.id } });
    });
    await expect(
      approveForCms(lead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "qa_required" });
    expect(await prisma.contentCmsApproval.count({ where: { contentWorkItemId: item.id } })).toBe(
      0,
    );
  });

  it("refuses a failing run, and refuses it again when the work item is forced to the gate", async () => {
    const { tenant, lead, item } = await awaitingApproval("failing");
    await prisma.brandFact.update({
      where: { id: tenant.factApproved },
      data: { approvalStatus: "REJECTED" },
    });
    installQaStub();
    const failed = await runQa(tenant, item.id);
    resetProvider();
    expect(failed.ok && failed.run.outcome).toBe("FAIL");
    expect(await statusOf(item.id)).toBe("QA");

    // At QA, the gate refuses on the state alone.
    await expect(
      approveForCms(lead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    // Forced to the gate anyway, it refuses on the run: a blocking finding is
    // not something a person may accept.
    await prisma.contentWorkItem.update({
      where: { id: item.id },
      data: { status: "AWAITING_EDITOR_REVIEW" },
    });
    await expect(
      approveForCms(lead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "qa_failed" });
    expect(await prisma.contentCmsApproval.count({ where: { contentWorkItemId: item.id } })).toBe(
      0,
    );
  });

  it("refuses a work item that is not at the gate, and one whose approval was reopened", async () => {
    const tenant = await fixtures.tenant("state");
    const lead = await fixtures.colleague(tenant, "SEO_LEAD");
    const { item, draft } = await fixtures.readyForQa(tenant, lead);
    // Ready for QA, but QA has not run.
    await expect(
      approveForCms(lead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    // Back in drafting.
    await reopenDraft(tenant, draft.id, "Another pass.");
    await expect(
      approveForCms(lead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      approveForCms(lead, crypto.randomUUID(), { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("what happens to an approval afterwards", () => {
  it("stays approved but stops authorizing execution when the ground moves", async () => {
    const { tenant, lead, item } = await awaitingApproval("stale");
    const approved = await approveForCms(lead, item.id, { acknowledgeNotChecked: true });
    expect((await cmsApprovalFor(tenant, item.id))?.executable).toBe(true);

    // A rule changes: the QA that backed the approval no longer describes the
    // rules in force. The approval is untouched; it just cannot authorize.
    await prisma.seoRule.update({
      where: { id: tenant.ruleId },
      data: { rule: "Meta titles stay under 55 characters." },
    });
    const view = await cmsApprovalFor(tenant, item.id);
    expect(view?.approval).toMatchObject({
      id: approved.approval.id,
      status: "APPROVED",
      invalidatedAt: null,
    });
    expect(view?.executable).toBe(false);
    expect(view?.staleReasons).toEqual(["QA_INPUTS_CHANGED"]);
    expect(await statusOf(item.id)).toBe("APPROVED_FOR_CMS");
  });

  it("is invalidated with a reason when the draft is reopened, and a fresh one can follow", async () => {
    const { tenant, lead, item, draft, revision } = await awaitingApproval("reopen");
    const approved = await approveForCms(lead, item.id, { acknowledgeNotChecked: true });

    const reopened = await reopenDraft(tenant, draft.id, "The pricing section needs rewriting.");
    expect(reopened.draft.status).toBe("DRAFTING");
    expect(reopened.workItem.status).toBe("DRAFTING");

    const invalidated = await prisma.contentCmsApproval.findUniqueOrThrow({
      where: { id: approved.approval.id },
    });
    expect(invalidated).toMatchObject({
      status: "INVALIDATED",
      invalidatedReason: "The pricing section needs rewriting.",
      contentRevisionId: revision.id,
      revisionHash: revision.contentHash,
      approvedByUserId: lead.user.id,
    });
    expect(invalidated.invalidatedAt).not.toBeNull();
    expect(await cmsApprovalFor(tenant, item.id)).toBeNull();
    expect((await listCmsApprovals(tenant, item.id)).map((row) => row.status)).toEqual([
      "INVALIDATED",
    ]);
    expect(
      await prisma.auditEvent.count({
        where: {
          entityType: "ContentCmsApproval",
          entityId: approved.approval.id,
          action: "RETIRE",
        },
      }),
    ).toBe(1);
    // The work item walked back through QA, and every move is on the record.
    const moves = await prisma.auditEvent.findMany({
      where: { entityType: "ContentWorkItem", entityId: item.id, action: "UPDATE" },
      orderBy: { createdAt: "asc" },
    });
    const statuses = moves.map((move) => (move.afterSnapshotJson as { status?: string })?.status);
    expect(statuses.slice(-2)).toEqual(["QA", "DRAFTING"]);
  });

  it("is invalidated when a newer brief supersedes the draft it approved", async () => {
    const { tenant, lead, item, draft, newer } = await awaitingApprovalOnOldBrief("supersede");
    const approved = await approveForCms(lead, item.id, {
      acknowledgeNotChecked: true,
      acknowledgeBriefMismatch: true,
    });

    const restarted = await startDraftFromBrief(tenant, item.id, newer.id);
    expect(restarted.created).toBe(true);
    expect(restarted.supersededDraftIds).toEqual([draft.id]);

    const invalidated = await prisma.contentCmsApproval.findUniqueOrThrow({
      where: { id: approved.approval.id },
    });
    expect(invalidated).toMatchObject({
      status: "INVALIDATED",
      invalidatedReason: "draft_superseded",
    });
    expect(await statusOf(item.id)).toBe("DRAFTING");
    expect(await cmsApprovalFor(tenant, item.id)).toBeNull();
  });
});

describe("tenant isolation at the gate", () => {
  it("gives another tenant nothing: no approval, no read, no act", async () => {
    const { tenant, lead, item } = await awaitingApproval("iso-a");
    const approved = await approveForCms(lead, item.id, { acknowledgeNotChecked: true });
    const other = await fixtures.tenant("iso-b");
    const otherLead: TenantContext = await fixtures.colleague(other as QaFixture, "SEO_LEAD");

    await expect(
      approveForCms(otherLead, item.id, { acknowledgeNotChecked: true }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await cmsApprovalFor(other, item.id)).toBeNull();
    expect(await listCmsApprovals(other, item.id)).toEqual([]);
    expect(await cmsApprovalFor(tenant, item.id)).not.toBeNull();
    expect(await prisma.contentCmsApproval.count({ where: { websiteId: other.website.id } })).toBe(
      0,
    );
    expect(approved.approval.websiteId).toBe(tenant.website.id);
  });
});
