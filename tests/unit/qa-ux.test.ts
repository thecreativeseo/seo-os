import { describe, expect, it } from "vitest";

import { QA_TYPES, type QaFinding } from "@/lib/content/qa";
import {
  DEFAULT_QA_FILTERS,
  applyQaFilters,
  fieldLabel,
  findingPresentation,
  findingSourceLabel,
  freshnessLabel,
  freshnessReason,
  groupFindings,
  notCheckedKind,
  notCheckedNext,
  notCheckedReasonLabel,
  parseQaFilters,
  qaColumnLabel,
  qaControls,
  qaFiltersToQuery,
  qaQueueRank,
  qaSourceLabel,
  qaStatusLabel,
  qaStatusTone,
  qaTypeDescription,
  qaTypeLabel,
  qaWorkItemLabel,
  severityLabel,
  shortFingerprint,
  staleReasonLabel,
  type QaFilterable,
} from "@/lib/content/qa-ux";
import { NOT_CHECKED_REASONS } from "@/lib/content/qa/findings";

/**
 * QA in words (M5.4). The screens read from here, so what a person sees is
 * tested here: every check named, every outcome and reason worded, nothing
 * left to a colour, and controls that offer exactly what the service allows.
 */

const finding = (overrides: Partial<QaFinding> = {}): QaFinding => ({
  code: "RULE_FAILED",
  qaType: "SEO_RULE_VALIDATION",
  severity: "WARNING",
  source: "DETERMINISTIC",
  needsHumanConfirmation: false,
  message: "A rule is not met.",
  by: "qa-deterministic/1",
  ...overrides,
});

describe("naming what QA looked at", () => {
  it("gives every one of the ten checks a name and a description, never a raw enum", () => {
    for (const type of QA_TYPES) {
      const label = qaTypeLabel(type);
      expect(label, type).not.toContain("_");
      expect(label).not.toBe(type);
      expect(qaTypeDescription(type).length).toBeGreaterThan(20);
    }
    expect(qaTypeLabel("BRAND_FACT_VALIDATION")).toBe("Brand facts");
    expect(qaTypeLabel("SOMETHING_NEW")).toBe("Something new");
  });

  it("words every outcome, run state and source", () => {
    expect(qaStatusLabel("PASS")).toBe("Passed");
    expect(qaStatusLabel("PASS_WITH_WARNINGS")).toBe("Passed with warnings");
    expect(qaStatusLabel("FAIL")).toBe("Failed");
    expect(qaStatusLabel("NOT_CHECKED")).toBe("Not checked");
    expect(qaStatusTone("PASS")).toBe("pass");
    expect(qaStatusTone("NOT_CHECKED")).toBe("unknown");
    expect(qaSourceLabel("DETERMINISTIC")).toBe("Measured");
    expect(qaSourceLabel("AI_JUDGED")).toBe("AI judged");
    expect(qaSourceLabel("MIXED")).toBe("Measured and AI judged");
    expect(findingSourceLabel("AI_JUDGED")).toBe("AI judged");
    expect(findingSourceLabel("DETERMINISTIC")).toBe("Measured");
    expect(severityLabel("BLOCKING")).toBe("Blocking");
    expect(severityLabel("INFO")).toBe("For information");
  });

  it("names the work item's QA state without renaming the database enum", () => {
    expect(qaWorkItemLabel("QA", null)).toBe("Ready for QA");
    expect(qaWorkItemLabel("QA", "FAIL")).toBe("QA blocked");
    expect(qaWorkItemLabel("QA", "PASS_WITH_WARNINGS")).toBe("QA passed");
    expect(qaWorkItemLabel("AWAITING_EDITOR_REVIEW", "PASS")).toBe("Awaiting final approval");
    expect(qaWorkItemLabel("APPROVED_FOR_CMS", "PASS")).toBe("Approved for CMS");
    expect(qaWorkItemLabel("DRAFTING", null)).toBe("Drafting");
  });

  it("gives the work queue a short QA state, and a dash when there is none", () => {
    expect(qaColumnLabel({ itemStatus: "DRAFTING" })).toBe("—");
    expect(qaColumnLabel({ itemStatus: "QA" })).toBe("Ready");
    expect(qaColumnLabel({ itemStatus: "QA", runStatus: "RUNNING" })).toBe("Running");
    expect(qaColumnLabel({ itemStatus: "QA", runStatus: "FAILED" })).toBe("Run failed");
    expect(qaColumnLabel({ itemStatus: "QA", runStatus: "COMPLETED", outcome: "FAIL" })).toBe(
      "Fail",
    );
    expect(
      qaColumnLabel({ itemStatus: "QA", runStatus: "COMPLETED", outcome: "PASS", stale: true }),
    ).toBe("Stale");
    expect(qaColumnLabel({ itemStatus: "APPROVED_FOR_CMS", approved: true })).toBe(
      "Approved for CMS",
    );
  });
});

describe("checks that did not run", () => {
  it("words every reason, sorts it into missing evidence or unavailable capability, and says what to do", () => {
    for (const reason of NOT_CHECKED_REASONS) {
      const label = notCheckedReasonLabel(reason);
      expect(label, reason).not.toContain("_");
      expect(notCheckedKind(reason), reason).not.toBe("unknown");
      expect(notCheckedNext(reason).length, reason).toBeGreaterThan(10);
    }
    expect(notCheckedReasonLabel("NO_PAGE_SNAPSHOT")).toBe("No page snapshot");
    expect(notCheckedKind("NO_PAGE_SNAPSHOT")).toBe("missing evidence");
    expect(notCheckedKind("NO_PROVIDER")).toBe("capability unavailable");
    expect(notCheckedReasonLabel(null)).toBe("No reason recorded");
  });

  it("never reads as a pass", () => {
    expect(qaStatusLabel("NOT_CHECKED")).not.toMatch(/pass/i);
    expect(qaStatusTone("NOT_CHECKED")).not.toBe("pass");
  });
});

describe("findings", () => {
  it("explains what, why and what next for every code the checks can raise", () => {
    const codes: QaFinding["code"][] = [
      "MISSING_APPROVED_FACT",
      "STALE_CLAIM",
      "UNSUPPORTED_CLAIM",
      "PROHIBITED_CLAIM",
      "AVOID_TOPIC",
      "UNSUPPORTED_NUMERIC_CLAIM",
      "HIGH_RISK_CLAIM",
      "UNLISTED_CLAIM",
      "PARAPHRASED_PROHIBITION",
      "RULE_FAILED",
      "RULE_UNCLEAR",
      "SLUG_TAKEN",
      "KEYWORD_ABSENT",
      "SECTION_MISSING",
      "LINK_UNRESOLVED",
      "NEAR_DUPLICATE",
      "INTENT_MISALIGNED",
      "QUESTION_UNANSWERED",
      "CTA_MISSING",
      "VOICE_MISMATCH",
    ];
    for (const code of codes) {
      const presentation = findingPresentation({ code });
      expect(presentation.title, code).not.toBe("A finding");
      expect(presentation.why.length, code).toBeGreaterThan(15);
      expect(presentation.next.length, code).toBeGreaterThan(10);
    }
    // An unknown code still renders rather than throwing.
    expect(findingPresentation({ code: "SOMETHING_NEW" as QaFinding["code"] }).title).toBe(
      "A finding",
    );
  });

  it("groups by what a person must do about them", () => {
    const grouped = groupFindings([
      finding({ severity: "BLOCKING", code: "PROHIBITED_CLAIM" }),
      finding({ severity: "WARNING" }),
      finding({ severity: "INFO", code: "LINK_SUGGESTED" }),
      finding({ code: "NOT_CHECKED", severity: "WARNING" }),
    ]);
    expect(grouped.blocking).toHaveLength(1);
    expect(grouped.warning).toHaveLength(1);
    expect(grouped.info).toHaveLength(1);
    expect(grouped.notChecked).toHaveLength(1);
  });

  it("names the field a finding points at", () => {
    expect(fieldLabel("meta_description")).toBe("Meta description");
    expect(fieldLabel("claims")).toBe("Claim list");
    expect(fieldLabel(undefined)).toBeNull();
  });
});

describe("freshness and staleness", () => {
  const current = {
    revisionApproved: true,
    inputsCurrent: true,
    latestForRevision: true,
    current: true,
  };

  it("says whether a report still speaks for the work, and why not", () => {
    expect(freshnessLabel(current, "COMPLETED")).toBe("Current");
    expect(freshnessReason(current)).toBeNull();
    expect(
      freshnessLabel({ ...current, latestForRevision: false, current: false }, "COMPLETED"),
    ).toBe("Historical");
    const stale = { ...current, inputsCurrent: false, current: false };
    expect(freshnessLabel(stale, "COMPLETED")).toBe("Stale");
    expect(freshnessReason(stale)).toMatch(/facts, SEO rules or Business Context changed/);
    const moved = { ...current, revisionApproved: false, current: false };
    expect(freshnessReason(moved)).toMatch(/no longer the approved one/);
    expect(freshnessLabel(current, "RUNNING")).toBe("Running");
    expect(freshnessLabel(current, "FAILED")).toBe("Did not complete");
  });

  it("words why an approval no longer authorizes execution", () => {
    expect(staleReasonLabel("QA_INPUTS_CHANGED")).toMatch(/changed after this approval/);
    expect(staleReasonLabel("REVISION_CHANGED")).toMatch(/approved revision changed/);
    expect(staleReasonLabel("BRIEF_SUPERSEDED")).toMatch(/newer brief/);
    expect(staleReasonLabel("QA_SUPERSEDED")).toMatch(/later QA run/);
  });

  it("shortens a fingerprint without pretending it is the whole thing", () => {
    expect(shortFingerprint("sha256:0123456789abcdef")).toBe("0123456789…");
    expect(shortFingerprint(null)).toBe("—");
  });
});

describe("what a person may do", () => {
  const base = {
    canWrite: true,
    canReview: true,
    itemStatus: "QA",
    hasApprovedRevision: true,
  };

  it("offers Run QA to a writer with an approved revision, and Re-run once a run exists", () => {
    const first = qaControls(base);
    expect(first).toMatchObject({ canRun: true, runLabel: "Run QA", runReason: null });
    const second = qaControls({ ...base, runStatus: "COMPLETED", runOutcome: "PASS" });
    expect(second.runLabel).toBe("Re-run QA");
  });

  it("refuses to run without a revision, in the wrong state, while running, or without write", () => {
    expect(qaControls({ ...base, hasApprovedRevision: false })).toMatchObject({
      canRun: false,
      runReason: expect.stringContaining("no approved revision"),
    });
    expect(qaControls({ ...base, itemStatus: "DRAFTING" }).canRun).toBe(false);
    expect(qaControls({ ...base, runStatus: "RUNNING" })).toMatchObject({
      canRun: false,
      runReason: expect.stringContaining("running"),
    });
    expect(qaControls({ ...base, canWrite: false })).toMatchObject({
      canRun: false,
      runReason: expect.stringContaining("member's access"),
    });
  });

  it("offers approval only at the gate, on a passing current run, to a reviewer", () => {
    const gate = {
      ...base,
      itemStatus: "AWAITING_EDITOR_REVIEW",
      runStatus: "COMPLETED",
      runOutcome: "PASS_WITH_WARNINGS",
      runCurrent: true,
      blockingCount: 0,
    };
    expect(qaControls(gate)).toMatchObject({ canApprove: true, approveReason: null });
    expect(qaControls({ ...gate, canReview: false })).toMatchObject({
      canApprove: false,
      approveReason: expect.stringContaining("SEO lead"),
    });
    expect(qaControls({ ...gate, itemStatus: "QA" }).canApprove).toBe(false);
    expect(qaControls({ ...gate, itemStatus: "APPROVED_FOR_CMS" })).toMatchObject({
      canApprove: false,
      approveReason: expect.stringContaining("already approved"),
    });
    expect(qaControls({ ...gate, blockingCount: 2 })).toMatchObject({
      canApprove: false,
      approveReason: expect.stringContaining("blocking"),
    });
    expect(qaControls({ ...gate, runOutcome: "FAIL" }).canApprove).toBe(false);
    expect(qaControls({ ...gate, runCurrent: false })).toMatchObject({
      canApprove: false,
      approveReason: expect.stringContaining("stale"),
    });
    // No override exists: nothing turns a blocking finding into an approval.
    expect(
      qaControls({ ...gate, blockingCount: 1, runCurrent: true, runOutcome: "FAIL" }).canApprove,
    ).toBe(false);
  });

  it("asks for the acknowledgements the service requires, and no others", () => {
    const gate = {
      ...base,
      itemStatus: "AWAITING_EDITOR_REVIEW",
      runStatus: "COMPLETED",
      runOutcome: "PASS",
      runCurrent: true,
    };
    expect(qaControls(gate)).toMatchObject({
      needsNotCheckedAcknowledgement: false,
      needsBriefAcknowledgement: false,
    });
    expect(qaControls({ ...gate, notCheckedCount: 2, briefSuperseded: true })).toMatchObject({
      needsNotCheckedAcknowledgement: true,
      needsBriefAcknowledgement: true,
    });
  });

  it("offers Return for revision to a writer anywhere at the gate", () => {
    for (const itemStatus of ["QA", "AWAITING_EDITOR_REVIEW", "APPROVED_FOR_CMS"]) {
      expect(qaControls({ ...base, itemStatus }).canReturn, itemStatus).toBe(true);
    }
    expect(qaControls({ ...base, canWrite: false }).canReturn).toBe(false);
    expect(qaControls({ ...base, itemStatus: "DRAFTING" }).canReturn).toBe(false);
  });
});

describe("the queue's filters and order", () => {
  const row = (overrides: Partial<QaFilterable> = {}): QaFilterable => ({
    itemStatus: "QA",
    contentType: "CONTENT_REFRESH",
    outcome: "PASS_WITH_WARNINGS",
    runStatus: "COMPLETED",
    runCurrent: true,
    notCheckedCount: 0,
    approved: false,
    approvalStale: false,
    ...overrides,
  });

  it("reads and writes the query, ignoring anything it does not know", () => {
    expect(parseQaFilters({})).toEqual(DEFAULT_QA_FILTERS);
    expect(parseQaFilters({ state: "blocked", type: "NEW_CONTENT", stale: "1" })).toEqual({
      state: "blocked",
      contentType: "NEW_CONTENT",
      stale: true,
      notChecked: false,
    });
    expect(parseQaFilters({ state: "nonsense", type: "../etc" }).state).toBe("all");
    expect(parseQaFilters({ type: "../etc" }).contentType).toBe("all");
    expect(
      qaFiltersToQuery({ ...DEFAULT_QA_FILTERS, state: "awaiting", notChecked: true }),
    ).toEqual({ state: "awaiting", notChecked: "1" });
    expect(qaFiltersToQuery(DEFAULT_QA_FILTERS)).toEqual({});
  });

  it("filters by state, type, staleness and unchecked checks", () => {
    const rows = [
      row({ outcome: "FAIL" }),
      row({ itemStatus: "AWAITING_EDITOR_REVIEW" }),
      row({ itemStatus: "APPROVED_FOR_CMS", approved: true }),
      row({ itemStatus: "QA", runStatus: null, outcome: null, runCurrent: false }),
      row({ notCheckedCount: 3, contentType: "NEW_CONTENT" }),
      row({ itemStatus: "APPROVED_FOR_CMS", approved: true, approvalStale: true }),
    ];
    const of = (filters: Partial<typeof DEFAULT_QA_FILTERS>) =>
      applyQaFilters(rows, { ...DEFAULT_QA_FILTERS, ...filters }).length;
    expect(of({})).toBe(rows.length);
    expect(of({ state: "blocked" })).toBe(1);
    expect(of({ state: "awaiting" })).toBe(1);
    expect(of({ state: "approved" })).toBe(2);
    // Two: the item with no run, and the one that passed with warnings. The
    // blocked one is in QA but is not ready for anything.
    expect(of({ state: "ready" })).toBe(2);
    expect(of({ state: "warnings" })).toBe(4);
    expect(of({ notChecked: true })).toBe(1);
    expect(of({ stale: true })).toBe(1);
    expect(of({ contentType: "NEW_CONTENT" })).toBe(1);
  });

  it("puts what needs doing first", () => {
    const ranked = [
      row({ itemStatus: "QA", outcome: null, runStatus: null }),
      row({ itemStatus: "APPROVED_FOR_CMS", approved: true, approvalStale: true }),
      row({ outcome: "FAIL" }),
      row({ itemStatus: "AWAITING_EDITOR_REVIEW" }),
      row({ itemStatus: "APPROVED_FOR_CMS", approved: true }),
    ]
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => qaQueueRank(a.entry) - qaQueueRank(b.entry) || a.index - b.index)
      .map(({ entry }) => entry);
    expect(ranked.map((entry) => qaQueueRank(entry))).toEqual([0, 1, 2, 3, 4]);
    expect(ranked[0]!.outcome).toBe("FAIL");
    expect(ranked[1]!.itemStatus).toBe("AWAITING_EDITOR_REVIEW");
  });
});
