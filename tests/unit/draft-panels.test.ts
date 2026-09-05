import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DraftFinding } from "@/lib/content/constraints";
import { BriefPanel, type BriefPanelData } from "@/components/execution/brief-panel";
import { ClaimsPanel } from "@/components/execution/claims-panel";
import { DraftStateNotice } from "@/components/execution/draft-state";
import { FindingsPanel, ReviewBlockers } from "@/components/execution/findings-panel";
import { DraftsTable } from "@/components/execution/drafts-table";
import {
  AuthorLabel,
  ProvenancePanel,
  type ProvenanceLineage,
  type ProvenanceRevision,
} from "@/components/execution/provenance-panel";
import type { DraftListRow } from "@/server/services/content-draft";

/**
 * The draft screens' panels, rendered to HTML on the server (M4.4 §5-§7,
 * §13-§16): findings grouped and explained, claims named by their source,
 * provenance for AI and for people, the brief as constraints, the states in
 * words, and the list rows with their labels.
 */

const html = (element: React.ReactElement) => renderToStaticMarkup(element);
const text = (element: React.ReactElement) =>
  html(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

const finding = (
  kind: DraftFinding["kind"],
  severity: DraftFinding["severity"],
  extra: Partial<DraftFinding> = {},
): DraftFinding => ({
  kind,
  severity,
  message: `Found: ${kind.toLowerCase().replace(/_/g, " ")}.`,
  ...extra,
});

describe("FindingsPanel", () => {
  it("groups by severity with the word on every row, and explains each finding", () => {
    const findings = [
      finding("PROHIBITED_CLAIM", "BLOCKING", { excerpt: "guaranteed compliance", field: "body" }),
      finding("UNSUPPORTED_NUMERIC_CLAIM", "WARNING", { excerpt: "by 40%" }),
      finding("LINK_TARGET_NOT_IN_BRIEF", "INFO", { url: "/about" }),
    ];
    const out = text(createElement(FindingsPanel, { findings }));
    expect(out).toContain("1 blocking · 1 warning · 1 note");
    expect(out).toContain("Blocking — must be resolved before review");
    expect(out).toContain("Warning — QA will look at these");
    expect(out).toContain("Prohibited claim");
    expect(out).toContain("Why it matters");
    expect(out).toContain("What to do");
    expect(out).toContain("Remove or reword the passage “guaranteed compliance”.");
    expect(out).toContain("Comes from Business Context");
    expect(out).toContain("Figure without an approved fact");
    expect(out).not.toContain("PROHIBITED_CLAIM");
    expect(out).not.toContain("constraintFindingsJson");
  });

  it("says when there is nothing to report, and lists stale brief claims", () => {
    expect(text(createElement(FindingsPanel, { findings: [] }))).toContain("Nothing to report");
    const out = text(
      createElement(FindingsPanel, {
        findings: [],
        staleClaims: [
          {
            text: "Trusted by 10,000 businesses",
            evidenceId: "fact:x",
            source: "BRAND_FACT",
            status: "STALE",
            reason: "The fact was revoked.",
          },
        ],
      }),
    );
    expect(out).toContain("1 brief claim no longer supported");
    expect(out).toContain("“Trusted by 10,000 businesses” — The fact was revoked.");
  });

  it("tells the person exactly what to fix before review, and nothing when review is open", () => {
    const blocked = text(
      createElement(ReviewBlockers, {
        findings: [
          finding("STALE_CLAIM", "BLOCKING", { excerpt: "Trusted by 10,000 businesses" }),
          finding("RULE_CHECK", "BLOCKING", { field: "meta_title" }),
          finding("UNSUPPORTED_NUMERIC_CLAIM", "WARNING"),
        ],
      }),
    );
    expect(blocked).toContain(
      "Request review is not available: 2 things to fix in a new revision.",
    );
    expect(blocked).toContain(
      "Claim rests on a fact that is no longer approved: Remove the claim “Trusted by 10,000 businesses”",
    );
    expect(blocked).toContain("SEO rule not met: Change the meta title so the rule is met.");
    expect(
      html(
        createElement(ReviewBlockers, {
          findings: [finding("UNSUPPORTED_NUMERIC_CLAIM", "WARNING")],
        }),
      ),
    ).toBe("");
  });
});

describe("ClaimsPanel", () => {
  it("names each claim's support by the kind of record, with the id only in small type", () => {
    const out = html(
      createElement(ClaimsPanel, {
        claims: [
          {
            text: "Payslips follow BIR formats",
            evidenceId: "fact:00000000-0000-4000-8000-000000000001",
            status: "SUPPORTED",
            reason: null,
          },
          {
            text: "Rated first by everyone",
            evidenceId: "fact:00000000-0000-4000-8000-0000000000ff",
            status: "UNSUPPORTED",
            reason: "Not in the evidence.",
          },
          {
            text: "Trusted by 10,000 businesses",
            evidenceId: "fact:00000000-0000-4000-8000-000000000002",
            status: "UNSUPPORTED",
            reason: "x",
          },
        ],
        staleClaims: [
          {
            text: "Trusted by 10,000 businesses",
            evidenceId: "fact:00000000-0000-4000-8000-000000000002",
            source: "BRAND_FACT",
            status: "STALE",
            reason: "The fact is no longer approved.",
          },
        ],
        openQuestions: ["A verified customer count."],
      }),
    );
    const plain = out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(plain).toContain("1 of 3 supported");
    expect(plain).toContain("Supported");
    expect(plain).toContain(
      "Approved Brand Fact · This claim comes from approved business evidence.",
    );
    expect(plain).toContain("Unsupported");
    expect(plain).toContain("Brand Fact — not accepted · Not in the evidence.");
    expect(plain).toContain("Stale — fact revoked");
    expect(plain).toContain("Open questions the writer left");
    expect(out).toContain("text-[10px]");
    expect(out).toContain("fact:00000000-0000-4000-8000-000000000001");
  });

  it("says when no claims are declared", () => {
    expect(text(createElement(ClaimsPanel, { claims: [] }))).toContain(
      "No business claims are declared",
    );
  });
});

const lineage: ProvenanceLineage = {
  briefVersion: 2,
  briefSuperseded: false,
  workItem: { title: "Refresh the guide", type: "CONTENT_REFRESH" },
  recommendation: { title: "Refresh the cohort analysis guide" },
  decision: {
    decision: "APPROVED",
    decidedBy: "owner@example.com",
    decidedAt: new Date("2026-09-01T10:00:00Z"),
  },
};

const aiRevision: ProvenanceRevision = {
  revisionNumber: 1,
  basedOnRevisionNumber: null,
  changeSummary: "First draft from the approved brief.",
  createdAt: new Date("2026-09-05T09:00:00Z"),
  contentHash: "sha256:0123456789abcdef0123456789abcdef",
  wordCount: 812,
  generationToken: "demo-refresh-1",
  createdByUserId: null,
  createdBy: null,
  createdByAiRun: {
    id: "11111111-2222-4333-8444-555555555555",
    provider: "anthropic",
    model: "claude-sonnet-5",
    promptTemplateVersion: 1,
    outputSchemaVersion: "1",
    createdAt: new Date("2026-09-05T08:59:00Z"),
  },
  evidencePackage: {
    id: "pkg",
    contentHash: "sha256:fedcba9876543210fedcba9876543210",
    sealedAt: new Date("2026-09-05T09:00:00Z"),
    evidenceCount: 23,
    contextVersionId: "99999999-8888-4777-8666-555555555555",
    retrievalPolicy: { name: "content-draft", version: 1 },
  },
};

describe("ProvenancePanel", () => {
  it("answers who, from which brief, using which evidence, for a generated revision", () => {
    const out = text(createElement(ProvenancePanel, { revision: aiRevision, lineage }));
    expect(out).toContain("Generated by AI");
    expect(out).toContain("anthropic · claude-sonnet-5");
    expect(out).toContain("Content draft (CONTENT_DRAFT · GENERATE_DRAFT)");
    expect(out).toContain("prompt v1 · output schema v1");
    expect(out).toContain("Brief v2");
    expect(out).toContain("Refresh the guide");
    expect(out).toContain("Refresh the cohort analysis guide");
    expect(out).toContain("approved by owner@example.com");
    expect(out).toContain("content-draft v1");
    expect(out).toContain("23 records · sealed");
    expect(out).toContain("sha256:fedcba987654…");
    expect(out).not.toContain("sha256:fedcba9876543210fedcba9876543210 ");
    expect(out).toContain("812 words");
  });

  it("shows the person, the base revision and the change summary for a hand-written one", () => {
    const human: ProvenanceRevision = {
      ...aiRevision,
      revisionNumber: 2,
      basedOnRevisionNumber: 1,
      changeSummary: "Removed the customer count.",
      generationToken: null,
      createdByUserId: "u1",
      createdBy: { email: "editor@example.com" },
      createdByAiRun: null,
      evidencePackage: null,
    };
    const out = text(
      createElement(ProvenancePanel, {
        revision: human,
        lineage: { ...lineage, briefSuperseded: true },
      }),
    );
    expect(out).toContain("Edited by editor@example.com");
    expect(out).toContain("Revision 1");
    expect(out).toContain("Removed the customer count.");
    expect(out).toContain("by hand, against the facts approved at the time");
    expect(out).toContain("(since superseded)");
    expect(out).not.toContain("Provider · model");
    expect(text(createElement(AuthorLabel, { revision: human, viewerUserId: "u1" }))).toContain(
      "Edited by you",
    );
  });
});

describe("BriefPanel", () => {
  const brief: BriefPanelData = {
    version: 2,
    status: "SUPERSEDED",
    title: "Cohort analysis guide, refreshed",
    contentType: "GUIDE",
    searchIntent: "COMMERCIAL",
    audience: "Analysts choosing a tool",
    customerProblem: "The guide stops before the practical step.",
    desiredOutcome: "The reader runs a first cohort analysis.",
    recommendedAngle: "Concept, then walkthrough, then the tool decision.",
    primaryConversion: "Start a free trial",
    brandVoiceNotes: "Direct, specific.",
    businessGoal: { title: "Grow qualified trials" },
    primaryKeyword: { keyword: "cohort analysis" },
    secondaryKeywords: [{ keyword: "retention curve" }],
    targetPage: { path: "/blog/cohort-analysis-guide" },
    keyQuestions: ["How do I set up a cohort?"],
    requiredSections: [{ heading: "What a cohort is", purpose: "Kept." }],
    optionalSections: [{ heading: "Glossary", purpose: "Terms." }],
    validClaims: [
      {
        text: "Cohort reports refresh hourly",
        evidenceId: "fact:a",
        source: "BRAND_FACT",
        status: "VALID",
        reason: null,
      },
    ],
    staleClaims: [
      {
        text: "Trusted by 10,000 businesses",
        evidenceId: "fact:b",
        source: "BRAND_FACT",
        status: "STALE",
        reason: "The fact was revoked.",
      },
    ],
    prohibitedClaims: [
      { text: "Any specific customer revenue figure", source: "BUSINESS_CONTEXT" },
    ],
    rules: [{ rule: "Never quote customer counts.", severity: "BLOCKING", constraint: null }],
    linkTargets: [
      {
        path: "/product/cohort-reports",
        anchorText: "cohort reports",
        reason: "The commercial step.",
      },
    ],
    targetLength: "900-1,500 words",
  };

  it("states the pinned version, the mismatch, and every constraint in words", () => {
    const out = text(createElement(BriefPanel, { brief, mismatch: { approvedVersion: 3 } }));
    expect(out).toContain("Draft based on Brief v2");
    expect(out).toContain("This draft is based on Brief v2. Brief v3 is now approved.");
    expect(out).toContain("The draft was not moved.");
    expect(out).toContain("Analysts choosing a tool");
    expect(out).toContain("Grow qualified trials");
    expect(out).toContain("Primary keyword: cohort analysis");
    expect(out).toContain("Secondary: retention curve");
    expect(out).toContain("/blog/cohort-analysis-guide");
    expect(out).toContain("How do I set up a cohort?");
    expect(out).toContain("What a cohort is — Kept.");
    expect(out).toContain("Cohort reports refresh hourly — approved Brand Fact");
    expect(out).toContain("Stale: “Trusted by 10,000 businesses” — The fact was revoked.");
    expect(out).toContain("Any specific customer revenue figure — Business context");
    expect(out).toContain("[Blocking] Never quote customer counts.");
    expect(out).toContain("/product/cohort-reports — “cohort reports”: The commercial step.");
    expect(out).toContain("900-1,500 words");
  });

  it("reads as the approved version when nothing newer exists", () => {
    const out = text(
      createElement(BriefPanel, {
        brief: { ...brief, status: "APPROVED", staleClaims: [] },
        mismatch: null,
      }),
    );
    expect(out).toContain("The approved version.");
    expect(out).not.toContain("is now approved");
    expect(out).not.toContain("Claims no longer supported");
  });
});

describe("DraftStateNotice", () => {
  it("carries the state as a word, a title and a body", () => {
    const out = text(
      createElement(DraftStateNotice, {
        kind: "newer_brief",
        detail: { briefVersion: 1, approvedVersion: 2 },
      }),
    );
    expect(out).toContain("Notice");
    expect(out).toContain("This draft is based on Brief v1. Brief v2 is now approved.");
    expect(text(createElement(DraftStateNotice, { kind: "superseded" }))).toContain("Read-only");
    expect(text(createElement(DraftStateNotice, { kind: "no_provider" }))).toContain(
      "No AI provider is configured — write the first revision by hand.",
    );
    expect(text(createElement(DraftStateNotice, { kind: "no_drafts" }))).toContain("No drafts yet");
    expect(
      text(createElement(DraftStateNotice, { kind: "blocking", detail: { count: 2 } })),
    ).toContain("2 blocking findings");
    expect(html(createElement(DraftStateNotice, { kind: "awaiting_review" }))).toContain(
      'role="status"',
    );
  });
});

describe("DraftsTable", () => {
  const row = (overrides: Partial<DraftListRow>): DraftListRow => ({
    id: "d1",
    workItemId: "w1",
    workItemTitle: "Refresh the guide",
    workItemType: "CONTENT_REFRESH",
    workItemStatus: "DRAFTING",
    contentType: "GUIDE",
    briefId: "b1",
    briefVersion: 2,
    briefStatus: "APPROVED",
    briefMismatch: null,
    status: "DRAFTING",
    awaitingReview: false,
    currentRevisionNumber: 2,
    currentTitle: "Cohort analysis, from first cohort to first decision",
    revisionCount: 2,
    authorKind: "HUMAN",
    findings: { blocking: 0, warning: 1, info: 0 },
    blocking: false,
    updatedAt: new Date("2026-09-05T09:00:00Z"),
    ...overrides,
  });

  it("writes every state as a word and marks demo rows", () => {
    const rows = [
      row({}),
      row({
        id: "d2",
        status: "AWAITING_EDITOR_REVIEW",
        awaitingReview: true,
        authorKind: "AI",
        blocking: true,
        findings: { blocking: 1, warning: 0, info: 0 },
      }),
      row({
        id: "d3",
        status: "SUPERSEDED",
        briefStatus: "SUPERSEDED",
        briefVersion: 1,
        briefMismatch: { approvedVersion: 2, approvedBriefId: "b2" },
        currentRevisionNumber: null,
        currentTitle: null,
        revisionCount: 0,
        authorKind: null,
      }),
    ];
    const out = html(createElement(DraftsTable, { rows, websiteId: "site", isDemo: true }));
    const plain = out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(plain).toContain("Edited by a person · 2 revisions");
    expect(plain).toContain("Generated by AI");
    expect(plain).toContain("Review requested");
    expect(plain).toContain("Blocking");
    expect(plain).toContain("1 blocking · 0 warning · 0 note");
    expect(plain).toContain("Newer brief v2 approved");
    expect(plain).toContain("No revision yet");
    expect(plain).toContain("Superseded");
    expect((out.match(/DEMO DATA/g) ?? []).length).toBe(3);
    expect(out).toContain('href="/websites/site/content/w1/draft?draft=d1"');
  });

  it("shows no demo marker on a real website", () => {
    const out = html(
      createElement(DraftsTable, { rows: [row({})], websiteId: "site", isDemo: false }),
    );
    expect(out).not.toContain("DEMO DATA");
  });
});
