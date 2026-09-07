import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { QaFinding } from "@/lib/content/qa";
import type {
  CmsApprovalView,
  QaProvenance,
  QaQueueRow,
  QaResultView,
  QaRunSummary,
  QaSummary,
} from "@/server/services/content-qa";
import {
  ApprovalPanel,
  FreshnessNotice,
  NotCheckedSection,
  QaFindingsSection,
  QaResultsTable,
  QaProvenanceBlock,
  QaRunFailureNotice,
  QaRunHistory,
  QaStatusBadge,
} from "@/components/execution/qa-report";
import { QaQueueTable } from "@/components/execution/qa-queue-table";
import { QaSummaryCard, RevisionQaRuns } from "@/components/execution/qa-summary";

/**
 * The QA screens, rendered (M5.4 §4-§9, §13-§18). What matters is what a
 * person can read: outcomes as words, a check that did not run saying so,
 * measured findings told apart from judgments, an excerpt only when it was
 * verified, provenance read from the run, and an approval whose QA has gone
 * stale never presented as ready.
 */

const html = (element: React.ReactElement) => renderToStaticMarkup(element);
const text = (element: React.ReactElement) =>
  html(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&middot;/g, "·")
    .replace(/\s+/g, " ")
    .trim();

const HASH = "sha256:abcdef0123456789abcdef0123456789";
const RUN_ID = "11111111-1111-4111-8111-111111111111";

const finding = (overrides: Partial<QaFinding> = {}): QaFinding => ({
  code: "RULE_FAILED",
  qaType: "SEO_RULE_VALIDATION",
  severity: "WARNING",
  source: "DETERMINISTIC",
  needsHumanConfirmation: false,
  message: "The meta title is 71 characters; the rule allows 60.",
  field: "meta_title",
  by: "qa-deterministic/1",
  ...overrides,
});

const result = (overrides: Partial<QaResultView> = {}): QaResultView =>
  ({
    id: `result-${overrides.qaType ?? "SEO_RULE_VALIDATION"}`,
    websiteId: "w1",
    contentRevisionId: "r1",
    qaRunId: RUN_ID,
    revisionHash: HASH,
    qaType: "SEO_RULE_VALIDATION",
    status: "PASS_WITH_WARNINGS",
    source: "DETERMINISTIC",
    score: null,
    notCheckedReason: null,
    issuesJson: {},
    warningsJson: [],
    blockingIssuesJson: [],
    checkedAt: new Date("2026-09-07T10:00:00Z"),
    checkerVersion: "qa-deterministic/1",
    aiRunId: null,
    createdAt: new Date("2026-09-07T10:00:00Z"),
    findings: [finding()],
    coverage: [{ check: "machine_rules", status: "CHECKED" }],
    considered: {},
    ...overrides,
  }) as QaResultView;

const run: QaRunSummary = {
  id: RUN_ID,
  status: "COMPLETED",
  outcome: "PASS_WITH_WARNINGS",
  revisionNumber: 2,
  revisionHash: HASH,
  briefVersion: 1,
  blockingCount: 0,
  warningCount: 3,
  infoCount: 1,
  notCheckedCount: 2,
  errorCode: null,
  checkerVersion: "qa-deterministic/1",
  startedAt: new Date("2026-09-07T10:00:00Z"),
  completedAt: new Date("2026-09-07T10:01:00Z"),
  requestedBy: "lead@example.com",
};

const current = {
  revisionApproved: true,
  inputsCurrent: true,
  latestForRevision: true,
  current: true,
};

describe("the ten checks", () => {
  it("names every check, its outcome in words, who found it, and how many findings", () => {
    const out = text(
      createElement(QaResultsTable, {
        results: [
          result(),
          result({
            id: "intent",
            qaType: "INTENT_ALIGNMENT",
            status: "NOT_CHECKED",
            source: "AI_JUDGED",
            notCheckedReason: "NO_PROVIDER",
            findings: [],
          }),
          result({
            id: "claims",
            qaType: "CLAIM_SAFETY",
            status: "PASS",
            source: "MIXED",
            findings: [],
          }),
        ],
      }),
    );
    expect(out).toContain("SEO rules");
    expect(out).toContain("Search intent");
    expect(out).toContain("Claim safety");
    expect(out).toContain("Passed with warnings");
    expect(out).toContain("Not checked");
    expect(out).toContain("No AI provider is configured");
    expect(out).toContain("Measured and AI judged");
    expect(out).not.toContain("SEO_RULE_VALIDATION");
    expect(out).not.toContain("PASS_WITH_WARNINGS");
  });

  it("says the outcome in words, not only in colour", () => {
    for (const [status, label] of [
      ["PASS", "Passed"],
      ["FAIL", "Failed"],
      ["NOT_CHECKED", "Not checked"],
    ] as const) {
      expect(text(createElement(QaStatusBadge, { status }))).toBe(label);
    }
  });
});

describe("findings", () => {
  it("explains each one, tells measured from judged, and marks what a person must confirm", () => {
    const out = text(
      createElement(QaFindingsSection, {
        results: [
          result({
            findings: [
              finding({
                code: "PROHIBITED_CLAIM",
                severity: "BLOCKING",
                message: "The approved Business Context prohibits this claim.",
                excerpt: "guaranteed compliance for every employer",
                field: "body",
              }),
              finding({
                code: "PARAPHRASED_PROHIBITION",
                severity: "WARNING",
                source: "AI_JUDGED",
                needsHumanConfirmation: true,
                message: "This reads as a prohibited claim in other words.",
                excerpt: "you can be sure every filing goes through",
              }),
              finding({
                code: "LINK_SUGGESTED",
                severity: "INFO",
                message: "/pricing owns a secondary keyword and is not linked.",
                refs: { pagePath: "/pricing" },
              }),
            ],
          }),
        ],
      }),
    );
    expect(out).toContain("Blocking (1)");
    expect(out).toContain("Warnings (1)");
    expect(out).toContain("For information (1)");
    expect(out).toContain("A claim the business prohibits");
    expect(out).toContain("Needs human confirmation");
    expect(out).toContain("Measured");
    expect(out).toContain("AI judged");
    expect(out).toContain("Why it matters");
    expect(out).toContain("What to do");
    expect(out).toContain("in Body");
    expect(out).toContain("Page: /pricing");
    expect(out).toContain("guaranteed compliance for every employer");
  });

  it("shows a note instead of an excerpt when the excerpt could not be verified", () => {
    const out = text(
      createElement(QaFindingsSection, {
        results: [
          result({
            findings: [
              finding({
                code: "INTENT_MISALIGNED",
                source: "AI_JUDGED",
                excerptNote: "AI excerpt could not be verified against the approved revision.",
              }),
            ],
          }),
        ],
      }),
    );
    expect(out).toContain("AI excerpt could not be verified against the approved revision.");
  });

  it("lists what was not checked, why, and what kind of gap it is", () => {
    const out = text(
      createElement(NotCheckedSection, {
        results: [
          result({
            qaType: "DUPLICATION_RISK",
            status: "PASS_WITH_WARNINGS",
            coverage: [
              { check: "target_page_overlap", status: "CHECKED" },
              { check: "other_pages_overlap", status: "NOT_CHECKED", reason: "NO_OTHER_PAGES" },
            ],
          }),
          result({
            id: "answers",
            qaType: "ANSWER_READINESS",
            status: "NOT_CHECKED",
            coverage: [{ check: "key_questions", status: "NOT_CHECKED", reason: "NO_PROVIDER" }],
          }),
        ],
      }),
    );
    expect(out).toContain("Not checked (2)");
    expect(out).toContain("They are not passes");
    expect(out).toContain("No comparison pages");
    expect(out).toContain("missing evidence");
    expect(out).toContain("No AI provider is configured");
    expect(out).toContain("capability unavailable");
    expect(out).toContain("Answer readiness");
    expect(out).not.toMatch(/\bPassed\b/);
  });
});

describe("provenance and history", () => {
  it("reads the provider, model and versions from the run rather than assuming them", () => {
    const provenance: QaProvenance = {
      runId: RUN_ID,
      checkerVersion: "qa-deterministic/1",
      inputsFingerprint: "sha256:0123456789abcdef",
      contextVersionId: "ctx-1",
      evidencePackage: {
        id: "pkg-1",
        contentHash: "sha256:packagehash",
        sealedAt: new Date("2026-09-07T10:00:30Z"),
        evidenceCount: 23,
        retrievalPolicy: { name: "content-qa", version: 1 },
      },
      aiRun: {
        id: "ai-1",
        provider: "anthropic",
        model: "claude-sonnet-5",
        promptTemplateVersion: 1,
        outputSchemaVersion: "1",
        status: "SUCCEEDED",
        inputTokens: 8479,
        outputTokens: 1160,
        errorCode: null,
      },
      requestedBy: "lead@example.com",
      startedAt: new Date("2026-09-07T10:00:00Z"),
      completedAt: new Date("2026-09-07T10:01:00Z"),
    };
    const out = text(createElement(QaProvenanceBlock, { provenance, run }));
    expect(out).toContain(RUN_ID);
    expect(out).toContain("qa-deterministic/1");
    expect(out).toContain("0123456789…");
    expect(out).toContain("content-qa v1");
    expect(out).toContain("23 records");
    expect(out).toContain("sealed");
    expect(out).toContain("anthropic");
    expect(out).toContain("claude-sonnet-5");
    expect(out).toContain("prompt v1");
    expect(out).toContain("schema v1");
    expect(out).toContain("lead@example.com");

    const withoutJudge = text(
      createElement(QaProvenanceBlock, {
        provenance: { ...provenance, aiRun: null, evidencePackage: null },
        run,
      }),
    );
    expect(withoutJudge).toContain("No AI judge ran for this report");
    expect(withoutJudge).toContain("No package is attached");
    expect(withoutJudge).not.toContain("anthropic");
  });

  it("lists every run, marks the current one, and links each report", () => {
    const older: QaRunSummary = {
      ...run,
      id: "22222222-2222-4222-8222-222222222222",
      outcome: "FAIL",
      blockingCount: 1,
      revisionNumber: 1,
    };
    const markup = html(
      createElement(QaRunHistory, {
        runs: [run, older],
        websiteId: "w1",
        workItemId: "i1",
        selectedRunId: run.id,
        currentRunId: run.id,
      }),
    );
    expect(markup).toContain(`/websites/w1/content/i1/qa?run=${run.id}`);
    expect(markup).toContain(`/websites/w1/content/i1/qa?run=${older.id}`);
    expect(markup).toContain('aria-current="page"');
    const out = text(
      createElement(QaRunHistory, {
        runs: [run, older],
        websiteId: "w1",
        workItemId: "i1",
        selectedRunId: run.id,
        currentRunId: run.id,
      }),
    );
    expect(out).toContain("Current");
    expect(out).toContain("Historical");
    expect(out).toContain("Failed");
    expect(out).toContain("qa-deterministic/1");
  });

  it("shows a run that could not finish as a failure, never as passes", () => {
    const out = text(
      createElement(QaRunFailureNotice, {
        run: { ...run, status: "FAILED", outcome: null, errorCode: "checker_error" },
      }),
    );
    expect(out).toContain("QA could not be completed");
    expect(out).toContain("nothing was recorded as passed");
    expect(out).not.toContain("Passed");
    const changed = text(
      createElement(QaRunFailureNotice, {
        run: { ...run, status: "FAILED", outcome: null, errorCode: "revision_changed" },
      }),
    );
    expect(changed).toContain("changed while QA was running");
  });

  it("says whether a report still speaks for the work", () => {
    expect(
      text(createElement(FreshnessNotice, { currency: current, runStatus: "COMPLETED" })),
    ).toContain("Current");
    const stale = text(
      createElement(FreshnessNotice, {
        currency: { ...current, inputsCurrent: false, current: false },
        runStatus: "COMPLETED",
      }),
    );
    expect(stale).toContain("Stale");
    expect(stale).toContain("Run QA again before approving");
  });
});

describe("the approval", () => {
  const approval = {
    id: "app-1",
    websiteId: "w1",
    contentWorkItemId: "i1",
    contentDraftId: "d1",
    contentRevisionId: "r1",
    revisionNumber: 2,
    revisionHash: HASH,
    qaRunId: RUN_ID,
    briefId: "b1",
    briefVersion: 1,
    briefSupersededAcknowledged: false,
    notCheckedAcknowledged: true,
    acknowledgedJson: {
      version: 1,
      notChecked: [{ qaType: "INTENT_ALIGNMENT", reason: "NO_PROVIDER" }],
      needsHumanConfirmation: [{ qaType: "SEO_RULE_VALIDATION", code: "RULE_FAILED" }],
      warningCount: 3,
      infoCount: 1,
      briefSuperseded: false,
    },
    status: "APPROVED" as const,
    approvedByUserId: "u1",
    approvedAt: new Date("2026-09-07T11:00:00Z"),
    note: "Warnings read.",
    selfDecided: true,
    invalidatedAt: null,
    invalidatedReason: null,
    createdAt: new Date("2026-09-07T11:00:00Z"),
    approvedBy: { email: "lead@example.com" },
  };

  it("shows what was approved, says no CMS action happened, and records self-approval", () => {
    const view: CmsApprovalView = { approval, run: null, executable: true, staleReasons: [] };
    const out = text(createElement(ApprovalPanel, { view }));
    expect(out).toContain("Approved for CMS");
    expect(out).toContain("Self-approval recorded");
    expect(out).toContain("lead@example.com");
    expect(out).toContain("Warnings read.");
    expect(out).toContain("1 check that did not run");
    expect(out).toContain("1 judgment needing confirmation");
    expect(out).toContain("No CMS action has been performed");
    // It says nothing is published; it never claims something was.
    expect(out).toContain("Nothing is published");
    expect(out).not.toMatch(/published to|live on|ready on wordpress/i);
  });

  it("never presents a stale approval as execution-ready", () => {
    const view: CmsApprovalView = {
      approval,
      run: null,
      executable: false,
      staleReasons: ["QA_INPUTS_CHANGED"],
    };
    const out = text(createElement(ApprovalPanel, { view }));
    expect(out).toContain("Approved for CMS");
    expect(out).toContain("QA is now stale");
    expect(out).toContain("changed after this approval");
    expect(out).toContain("cannot authorize execution now");
    expect(out).toContain("run QA again and obtain a fresh human approval");
    expect(out).not.toContain("No CMS action has been performed");
  });
});

describe("the queue and the work-item panels", () => {
  const queueRow: QaQueueRow = {
    workItemId: "i1",
    title: "Refresh the payroll guide",
    contentType: "CONTENT_REFRESH",
    itemStatus: "QA",
    revisionNumber: 2,
    revisionHash: HASH,
    briefVersion: 1,
    runId: RUN_ID,
    runStatus: "COMPLETED",
    outcome: "FAIL",
    blockingCount: 1,
    warningCount: 3,
    infoCount: 0,
    notCheckedCount: 2,
    runAt: new Date("2026-09-07T10:01:00Z"),
    runCurrent: true,
    aiProvider: "stub",
    aiModel: "stub-1",
    approved: false,
    approvalStale: false,
    approvalStaleReasons: [],
    approvedBy: null,
    approvedAt: null,
    selfDecided: false,
    updatedAt: new Date("2026-09-07T10:01:00Z"),
  };

  it("shows the exact revision, the outcome and the freshness, and marks demo rows", () => {
    const out = text(
      createElement(QaQueueTable, { rows: [queueRow], websiteId: "w1", isDemo: true }),
    );
    expect(out).toContain("Refresh the payroll guide");
    expect(out).toContain("QA blocked");
    expect(out).toContain("Failed");
    expect(out).toContain("Current");
    expect(out).toContain("Brief v1");
    expect(out).toContain("DEMO DATA");
    expect(out).toContain("abcdef012345…");
    const markup = html(
      createElement(QaQueueTable, { rows: [queueRow], websiteId: "w1", isDemo: false }),
    );
    expect(markup).toContain("/websites/w1/content/i1/qa");
    expect(markup).not.toContain("DEMO DATA");
  });

  it("shows a stale approval on the queue as approved but not ready", () => {
    const out = text(
      createElement(QaQueueTable, {
        rows: [
          {
            ...queueRow,
            itemStatus: "APPROVED_FOR_CMS",
            outcome: "PASS",
            blockingCount: 0,
            approved: true,
            approvalStale: true,
            approvalStaleReasons: ["QA_INPUTS_CHANGED"],
            approvedBy: "lead@example.com",
          },
        ],
        websiteId: "w1",
        isDemo: false,
      }),
    );
    expect(out).toContain("Approved · QA now stale");
    expect(out).toContain("changed after this approval");
  });

  it("summarises QA in the draft workspace, and links the report", () => {
    const summary: QaSummary = {
      itemStatus: "AWAITING_EDITOR_REVIEW",
      approvedRevision: {
        workItemId: "i1",
        draftId: "d1",
        reviewId: "rev-1",
        revisionId: "r1",
        revisionNumber: 2,
        revisionHash: HASH,
        briefId: "b1",
        briefVersion: 1,
        approvedByUserId: "u1",
        approvedAt: new Date("2026-09-07T09:00:00Z"),
      },
      latest: {
        ...run,
        current: true,
        currency: current,
        aiProvider: "anthropic",
        aiModel: "claude-sonnet-5",
      },
      approval: null,
      briefSuperseded: false,
    };
    const out = text(createElement(QaSummaryCard, { summary, websiteId: "w1", workItemId: "i1" }));
    expect(out).toContain("Awaiting final approval");
    expect(out).toContain("Passed with warnings");
    expect(out).toContain("Current");
    expect(out).toContain("Not checked 2");
    expect(
      html(createElement(QaSummaryCard, { summary, websiteId: "w1", workItemId: "i1" })),
    ).toContain("/websites/w1/content/i1/qa");

    const none = text(
      createElement(QaSummaryCard, {
        summary: { ...summary, latest: null, itemStatus: "QA" },
        websiteId: "w1",
        workItemId: "i1",
      }),
    );
    expect(none).toContain("QA has not run for this work yet");
    expect(none).toContain("Ready for QA");
  });

  it("lists the runs that judged one revision, and says so when there are none", () => {
    const out = text(
      createElement(RevisionQaRuns, {
        runs: [run],
        websiteId: "w1",
        workItemId: "i1",
        currentRunId: run.id,
      }),
    );
    expect(out).toContain("QA runs for this revision");
    expect(out).toContain("Passed with warnings");
    expect(out).toContain("Current");
    const empty = text(
      createElement(RevisionQaRuns, {
        runs: [],
        websiteId: "w1",
        workItemId: "i1",
        currentRunId: null,
      }),
    );
    expect(empty).toContain("No QA run has judged this revision");
    expect(empty).toContain("a run of another revision never appears here");
  });
});
