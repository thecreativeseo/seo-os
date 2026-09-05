import { describe, expect, it } from "vitest";

import type { DraftFinding } from "@/lib/content/constraints";
import {
  applyDraftFilters,
  claimPresentation,
  countFindings,
  describeFinding,
  draftControls,
  draftFiltersToQuery,
  draftStateText,
  evidenceSourceLabel,
  groupFindings,
  parseDraftFilters,
  reviewBlockers,
  shortHash,
  targetLengthFor,
  type ControlsInput,
} from "@/lib/content/draft-ux";

/**
 * The draft workflow in words (M4.4): what the screens say and offer, by
 * state and role, checked without a browser.
 */

const finding = (kind: DraftFinding["kind"], severity: DraftFinding["severity"]): DraftFinding => ({
  kind,
  severity,
  message: `message for ${kind}`,
  excerpt: "the passage",
  url: kind.includes("LINK") ? "https://example.org/x" : undefined,
  field: kind === "RULE_CHECK" ? "meta_title" : undefined,
});

const KINDS: DraftFinding["kind"][] = [
  "PROHIBITED_CLAIM",
  "AVOID_TOPIC",
  "STALE_CLAIM",
  "UNSUPPORTED_NUMERIC_CLAIM",
  "EXTERNAL_LINK_REMOVED",
  "EXTERNAL_LINK_UNAPPROVED",
  "UNSAFE_LINK_REMOVED",
  "LINK_TARGET_NOT_IN_BRIEF",
  "RULE_CHECK",
];

describe("findings, explained", () => {
  it("gives every kind a title, what, why and next step in plain words", () => {
    for (const kind of KINDS) {
      const explained = describeFinding(finding(kind, "WARNING"));
      expect(explained.title.length).toBeGreaterThan(3);
      expect(explained.what).toBe(`message for ${kind}`);
      expect(explained.why.length).toBeGreaterThan(20);
      expect(explained.next.length).toBeGreaterThan(10);
      expect(explained.title).not.toMatch(/_/);
    }
    expect(describeFinding(finding("PROHIBITED_CLAIM", "BLOCKING")).source).toBe(
      "Business Context",
    );
    expect(describeFinding(finding("STALE_CLAIM", "BLOCKING")).source).toBe("Brand Fact");
    expect(describeFinding(finding("RULE_CHECK", "BLOCKING")).next).toContain("meta title");
    expect(describeFinding(finding("EXTERNAL_LINK_UNAPPROVED", "WARNING")).next).toContain(
      "https://example.org/x",
    );
  });

  it("groups and counts by severity, and names what blocks review", () => {
    const findings = [
      finding("PROHIBITED_CLAIM", "BLOCKING"),
      finding("UNSUPPORTED_NUMERIC_CLAIM", "WARNING"),
      finding("LINK_TARGET_NOT_IN_BRIEF", "INFO"),
      finding("RULE_CHECK", "BLOCKING"),
    ];
    const groups = groupFindings(findings);
    expect(groups.BLOCKING).toHaveLength(2);
    expect(groups.WARNING).toHaveLength(1);
    expect(groups.INFO).toHaveLength(1);
    expect(countFindings(findings)).toEqual({ blocking: 2, warning: 1, info: 1 });

    const blockers = reviewBlockers(findings);
    expect(blockers).toHaveLength(2);
    expect(blockers[0]).toMatch(/^Prohibited claim: Remove or reword the passage “the passage”\./);
    expect(blockers[1]).toMatch(/^SEO rule not met: /);
    expect(reviewBlockers([finding("UNSUPPORTED_NUMERIC_CLAIM", "WARNING")])).toEqual([]);
  });
});

describe("controls by state and role", () => {
  const base: ControlsInput = {
    canWrite: true,
    canReview: false,
    draftStatus: "DRAFTING",
    itemDrafting: true,
    briefCurrent: true,
    hasRevision: true,
    blocking: false,
    aiConfigured: true,
  };

  it("lets a writer edit, generate and request review on a clean drafting draft", () => {
    const controls = draftControls(base);
    expect(controls).toMatchObject({
      readOnly: false,
      canEdit: true,
      canGenerate: true,
      canRequestReview: true,
      canReturn: false,
      canStartFromNewBrief: false,
    });
    expect(controls.generateReason).toBeNull();
    expect(controls.requestReviewReason).toBeNull();
  });

  it("explains why review is not offered: no revision, then blocking findings", () => {
    expect(draftControls({ ...base, hasRevision: false })).toMatchObject({
      canRequestReview: false,
      requestReviewReason: expect.stringMatching(/Nothing to review yet/),
    });
    expect(draftControls({ ...base, blocking: true })).toMatchObject({
      canRequestReview: false,
      requestReviewReason: expect.stringMatching(/blocking findings/),
      canEdit: true,
    });
  });

  it("closes generation, not editing, when the brief is superseded, and offers the restart", () => {
    const controls = draftControls({ ...base, briefCurrent: false });
    expect(controls.canGenerate).toBe(false);
    expect(controls.generateReason).toMatch(/superseded brief/);
    expect(controls.canEdit).toBe(true);
    expect(controls.canStartFromNewBrief).toBe(true);
  });

  it("says so when no provider is configured", () => {
    const controls = draftControls({ ...base, aiConfigured: false });
    expect(controls.canGenerate).toBe(false);
    expect(controls.generateReason).toBe(
      "No AI provider is configured — write the revision by hand.",
    );
  });

  it("under review: a writer may still edit, only a reviewer may return, nobody generates", () => {
    const writer = draftControls({ ...base, draftStatus: "AWAITING_EDITOR_REVIEW" });
    expect(writer).toMatchObject({
      canEdit: true,
      canGenerate: false,
      canRequestReview: false,
      canReturn: false,
    });
    expect(writer.generateReason).toMatch(/Review has been requested/);
    expect(writer.requestReviewReason).toMatch(/already been requested/);

    const reviewer = draftControls({
      ...base,
      draftStatus: "AWAITING_EDITOR_REVIEW",
      canReview: true,
    });
    expect(reviewer.canReturn).toBe(true);
  });

  it("makes a superseded draft read-only for everyone, with the reason", () => {
    const owner = draftControls({ ...base, draftStatus: "SUPERSEDED", canReview: true });
    expect(owner).toMatchObject({
      readOnly: true,
      canEdit: false,
      canGenerate: false,
      canRequestReview: false,
      canReturn: false,
      canStartFromNewBrief: false,
    });
    expect(owner.readOnlyReason).toMatch(/superseded/);
  });

  it("gives a viewer nothing to press, and says why", () => {
    const viewer = draftControls({ ...base, canWrite: false });
    expect(viewer.readOnly).toBe(true);
    expect(viewer.readOnlyReason).toMatch(/member's access/);
    expect(viewer.canEdit).toBe(false);
    expect(viewer.canGenerate).toBe(false);
    expect(viewer.canRequestReview).toBe(false);
    expect(viewer.generateReason).toBeNull();
  });
});

describe("claims in words", () => {
  const fact = "fact:00000000-0000-4000-8000-000000000001";
  const ctx = "ctx:00000000-0000-4000-8000-000000000002";

  it("names the source of a supported claim without leaning on the id", () => {
    const shown = claimPresentation({
      text: "Payslips follow BIR formats",
      evidenceId: fact,
      status: "SUPPORTED",
      reason: null,
    });
    expect(shown.status).toBe("SUPPORTED");
    expect(shown.source).toBe("Approved Brand Fact");
    expect(shown.detail).toMatch(/approved business evidence/);
    expect(
      claimPresentation({ text: "x", evidenceId: ctx, status: "SUPPORTED", reason: null }).source,
    ).toBe("Approved Business Context");
  });

  it("marks a claim stale when the brief's fact was revoked, and unsupported otherwise", () => {
    const stale = claimPresentation(
      {
        text: "Trusted by 10,000 businesses",
        evidenceId: fact,
        status: "UNSUPPORTED",
        reason: "x",
      },
      [
        {
          text: "Trusted by 10,000 businesses",
          evidenceId: fact,
          source: "BRAND_FACT",
          status: "STALE",
          reason: "The fact is no longer approved.",
        },
      ],
    );
    expect(stale.status).toBe("STALE");
    expect(stale.source).toMatch(/Brand Fact — no longer approved/);
    expect(stale.detail).toBe("The fact is no longer approved.");

    const invented = claimPresentation({
      text: "Best tool",
      evidenceId: "fact:00000000-0000-4000-8000-0000000000ff",
      status: "UNSUPPORTED",
      reason: "Not in the evidence.",
    });
    expect(invented.status).toBe("UNSUPPORTED");
    expect(invented.source).toBe("Brand Fact — not accepted");
    expect(
      claimPresentation({ text: "Fast", evidenceId: null, status: "UNSUPPORTED", reason: null })
        .source,
    ).toBe("No source");
  });

  it("labels evidence kinds and shortens hashes", () => {
    expect(evidenceSourceLabel("rule:abc")).toBe("SEO Rule");
    expect(evidenceSourceLabel("own:abc")).toBe("Internal link target");
    expect(evidenceSourceLabel("what:abc")).toBe("Evidence record");
    expect(evidenceSourceLabel(null)).toBe("No source");
    expect(shortHash("sha256:0123456789abcdef0123")).toBe("sha256:0123456789ab…");
    expect(shortHash("abc")).toBe("abc");
    expect(shortHash(null)).toBe("—");
  });
});

describe("the drafts list filters", () => {
  const rows = [
    {
      id: "a",
      status: "DRAFTING" as const,
      contentType: "GUIDE",
      blocking: true,
      authorKind: "AI" as const,
    },
    {
      id: "b",
      status: "AWAITING_EDITOR_REVIEW" as const,
      contentType: "GUIDE",
      blocking: false,
      authorKind: "HUMAN" as const,
    },
    {
      id: "c",
      status: "SUPERSEDED" as const,
      contentType: "LANDING_PAGE",
      blocking: false,
      authorKind: "AI" as const,
    },
    { id: "d", status: "DRAFTING" as const, contentType: null, blocking: false, authorKind: null },
  ];

  it("parses the query defensively and round-trips it", () => {
    const filters = parseDraftFilters({
      status: "AWAITING_EDITOR_REVIEW",
      type: "GUIDE",
      blocking: "1",
      author: "HUMAN",
    });
    expect(filters).toEqual({
      status: "AWAITING_EDITOR_REVIEW",
      contentType: "GUIDE",
      blocking: true,
      awaitingReview: false,
      superseded: false,
      author: "HUMAN",
    });
    expect(draftFiltersToQuery(filters)).toEqual({
      status: "AWAITING_EDITOR_REVIEW",
      type: "GUIDE",
      blocking: "1",
      author: "HUMAN",
    });
    expect(parseDraftFilters({ status: "DROP TABLE", type: "guide; --", author: "robot" })).toEqual(
      {
        status: "all",
        contentType: "all",
        blocking: false,
        awaitingReview: false,
        superseded: false,
        author: "all",
      },
    );
  });

  it("filters by status, type, blocking, review, supersession and author", () => {
    const ids = (filters: Partial<ReturnType<typeof parseDraftFilters>>) =>
      applyDraftFilters(rows, { ...parseDraftFilters({}), ...filters }).map((row) => row.id);
    expect(ids({})).toEqual(["a", "b", "c", "d"]);
    expect(ids({ status: "DRAFTING" })).toEqual(["a", "d"]);
    expect(ids({ contentType: "GUIDE" })).toEqual(["a", "b"]);
    expect(ids({ blocking: true })).toEqual(["a"]);
    expect(ids({ awaitingReview: true })).toEqual(["b"]);
    expect(ids({ superseded: true })).toEqual(["c"]);
    expect(ids({ author: "HUMAN" })).toEqual(["b"]);
    expect(ids({ author: "AI", contentType: "LANDING_PAGE" })).toEqual(["c"]);
  });
});

describe("states in plain English", () => {
  it("has a title and a body for every state, with the versions in the mismatch", () => {
    const newer = draftStateText("newer_brief", { briefVersion: 2, approvedVersion: 3 });
    expect(newer.title).toBe("This draft is based on Brief v2. Brief v3 is now approved.");
    expect(newer.body).toMatch(/not moved/);
    expect(draftStateText("no_provider").body).toContain(
      "No AI provider is configured — write the first revision by hand.",
    );
    expect(draftStateText("blocking", { count: 1 }).title).toBe("1 blocking finding");
    expect(draftStateText("blocking", { count: 2 }).title).toBe("2 blocking findings");
    expect(draftStateText("stale_evidence", { count: 1 }).title).toMatch(
      /1 brief claim no longer supported/,
    );
    for (const kind of [
      "no_drafts",
      "generation_in_progress",
      "generation_failed",
      "no_revision",
      "awaiting_review",
      "superseded",
    ] as const) {
      const text = draftStateText(kind);
      expect(text.title.length).toBeGreaterThan(5);
      expect(text.body.length).toBeGreaterThan(30);
    }
    expect(targetLengthFor("TITLE_META_UPDATE")).toMatch(/150-300 words/);
    expect(targetLengthFor("CONTENT_REFRESH")).toBe("900-1,500 words");
  });
});
