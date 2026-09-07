import crypto from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import {
  approveForCms,
  listQaQueue,
  qaProvenanceFor,
  qaSummaryFor,
  runQa,
  type QaQueueRow,
} from "@/server/services/content-qa";
import { DEFAULT_QA_FILTERS, applyQaFilters, qaQueueRank } from "@/lib/content/qa-ux";
import type { TenantContext } from "@/server/auth/guards";
import { QaFixtures, type QaFixture } from "../helpers/qa-fixture";
import { installQaStub } from "../helpers/qa-stub";

/**
 * What the QA screens read (M5.4 §2, §16, §17, §25). One website with a work
 * item at each point of the gate: the queue says which revision was judged,
 * what QA found, whether that still holds, and who approved it. Another
 * tenant sees none of it.
 */

const fixtures = new QaFixtures();
let tenant: QaFixture;
let lead: TenantContext;
let ready: { id: string };
let awaiting: { id: string };
let approvedItem: { id: string };
let awaitingRunId: string;

beforeAll(async () => {
  tenant = await fixtures.tenant("queue");
  lead = await fixtures.colleague(tenant, "SEO_LEAD");

  const first = await fixtures.readyForQa(tenant, lead);
  ready = first.item;

  const second = await fixtures.readyForQa(tenant, lead);
  installQaStub();
  const secondRun = await runQa(tenant, second.item.id);
  resetProvider();
  if (!secondRun.ok) throw new Error("the awaiting run failed");
  awaiting = second.item;
  awaitingRunId = secondRun.run.id;

  const third = await fixtures.readyForQa(tenant, lead);
  installQaStub();
  const thirdRun = await runQa(tenant, third.item.id);
  resetProvider();
  if (!thirdRun.ok) throw new Error("the approved run failed");
  await approveForCms(lead, third.item.id, { acknowledgeNotChecked: true });
  approvedItem = third.item;
}, 240_000);

afterEach(() => resetProvider());
afterAll(async () => {
  await fixtures.teardown();
  await prisma.$disconnect();
});

const find = (rows: QaQueueRow[], id: string) =>
  rows.find((row) => row.workItemId === id) as QaQueueRow;

describe("the QA queue", () => {
  it("shows one row per work item at the gate, with the exact revision and what QA found", async () => {
    const rows = await listQaQueue(tenant);
    expect(rows).toHaveLength(3);

    const readyRow = find(rows, ready.id);
    expect(readyRow).toMatchObject({
      itemStatus: "QA",
      runId: null,
      runStatus: null,
      outcome: null,
      blockingCount: 0,
      notCheckedCount: 0,
      runCurrent: false,
      approved: false,
      briefVersion: 1,
      revisionNumber: 1,
    });
    expect(readyRow.revisionHash).toMatch(/^sha256:/);
    expect(readyRow.contentType).toBe("CONTENT_REFRESH");

    const awaitingRow = find(rows, awaiting.id);
    expect(awaitingRow).toMatchObject({
      itemStatus: "AWAITING_EDITOR_REVIEW",
      runId: awaitingRunId,
      runStatus: "COMPLETED",
      outcome: "PASS_WITH_WARNINGS",
      blockingCount: 0,
      runCurrent: true,
      approved: false,
      aiProvider: "stub",
    });
    expect(awaitingRow.runAt).not.toBeNull();

    const approvedRow = find(rows, approvedItem.id);
    expect(approvedRow).toMatchObject({
      itemStatus: "APPROVED_FOR_CMS",
      approved: true,
      approvalStale: false,
      approvalStaleReasons: [],
      approvedBy: lead.user.email,
      runCurrent: true,
    });
    expect(approvedRow.approvedAt).not.toBeNull();
    // The lead editorially approved the revision too, so it is recorded.
    expect(approvedRow.selfDecided).toBe(true);
  });

  it("puts what needs doing first, and filters by state", async () => {
    const rows = await listQaQueue(tenant);
    const ordered = [...rows].sort(
      (a, b) => qaQueueRank(a) - qaQueueRank(b) || b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    expect(ordered[0]!.workItemId).toBe(awaiting.id);
    expect(ordered.map((row) => row.itemStatus)).toEqual([
      "AWAITING_EDITOR_REVIEW",
      "QA",
      "APPROVED_FOR_CMS",
    ]);

    const of = (filters: Partial<typeof DEFAULT_QA_FILTERS>) =>
      applyQaFilters(rows, { ...DEFAULT_QA_FILTERS, ...filters }).map((row) => row.workItemId);
    expect(of({ state: "awaiting" })).toEqual([awaiting.id]);
    expect(of({ state: "approved" })).toEqual([approvedItem.id]);
    expect(of({ state: "ready" })).toEqual([ready.id]);
    expect(of({ state: "blocked" })).toEqual([]);
    expect(of({ contentType: "CONTENT_REFRESH" })).toHaveLength(3);
    expect(of({ contentType: "NEW_CONTENT" })).toEqual([]);
  });

  it("marks the run and the approval stale when the facts behind them change", async () => {
    await prisma.brandFact.create({
      data: {
        websiteId: tenant.website.id,
        category: "Product",
        factKey: "support",
        value: "Support answers within one business day",
        approvalStatus: "APPROVED",
      },
    });

    const rows = await listQaQueue(tenant);
    expect(find(rows, awaiting.id)).toMatchObject({ runStatus: "COMPLETED", runCurrent: false });
    const approvedRow = find(rows, approvedItem.id);
    expect(approvedRow).toMatchObject({
      approved: true,
      approvalStale: true,
      approvalStaleReasons: ["QA_INPUTS_CHANGED"],
    });
    // The approval itself is untouched: it is history, not a state.
    const approval = await prisma.contentCmsApproval.findFirstOrThrow({
      where: { contentWorkItemId: approvedItem.id },
    });
    expect(approval).toMatchObject({ status: "APPROVED", invalidatedAt: null });

    const stale = applyQaFilters(rows, { ...DEFAULT_QA_FILTERS, stale: true }).map(
      (row) => row.workItemId,
    );
    expect(stale.sort()).toEqual([approvedItem.id, awaiting.id].sort());
  });
});

describe("what one work item's screens read", () => {
  it("summarises the latest run, its freshness, and the approval", async () => {
    const summary = await qaSummaryFor(tenant, approvedItem.id);
    expect(summary).not.toBeNull();
    expect(summary!.itemStatus).toBe("APPROVED_FOR_CMS");
    expect(summary!.approvedRevision).not.toBeNull();
    expect(summary!.latest).toMatchObject({
      status: "COMPLETED",
      outcome: "PASS_WITH_WARNINGS",
      aiProvider: "stub",
      current: false, // a fact changed in the test above
    });
    expect(summary!.latest!.currency.revisionApproved).toBe(true);
    expect(summary!.latest!.currency.inputsCurrent).toBe(false);
    expect(summary!.approval).not.toBeNull();
    expect(summary!.approval!.executable).toBe(false);
    expect(summary!.briefSuperseded).toBe(false);

    const withoutRun = await qaSummaryFor(tenant, ready.id);
    expect(withoutRun!.latest).toBeNull();
    expect(withoutRun!.approval).toBeNull();
    expect(withoutRun!.approvedRevision).not.toBeNull();
  });

  it("reads provenance from the run rather than from anywhere else", async () => {
    const provenance = await qaProvenanceFor(tenant, awaitingRunId);
    expect(provenance).toMatchObject({
      runId: awaitingRunId,
      checkerVersion: "qa-deterministic/1",
      requestedBy: tenant.user.email,
    });
    expect(provenance!.inputsFingerprint).toMatch(/^sha256:/);
    expect(provenance!.evidencePackage?.sealedAt).not.toBeNull();
    expect(provenance!.evidencePackage?.retrievalPolicy?.name).toBe("content-qa");
    expect(provenance!.aiRun).toMatchObject({
      provider: "stub",
      promptTemplateVersion: 1,
      outputSchemaVersion: "1",
      status: "SUCCEEDED",
    });
    expect(provenance!.contextVersionId).not.toBeNull();
  });
});

describe("another tenant", () => {
  it("sees no rows, no summary and no provenance of this website's QA", async () => {
    const other = await fixtures.tenant("queue-other");
    expect(await listQaQueue(other)).toEqual([]);
    expect(await qaSummaryFor(other, awaiting.id)).toBeNull();
    expect(await qaProvenanceFor(other, awaitingRunId)).toBeNull();
    expect(await qaSummaryFor(other, crypto.randomUUID())).toBeNull();
    // And this tenant still sees everything.
    expect(await listQaQueue(tenant)).toHaveLength(3);
  });
});
