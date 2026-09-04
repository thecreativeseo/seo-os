import { describe, expect, it } from "vitest";

import {
  ContentBriefStatus,
  ContentDraftStatus,
  ContentWorkItemStatus,
  ExecutionStatus,
  PublishApprovalStatus,
} from "@/generated/prisma/enums";
import {
  ACTIVE_EXECUTION_STATUSES,
  APPROVAL_TRANSITIONS,
  BRIEF_TRANSITIONS,
  DRAFT_TRANSITIONS,
  EXECUTION_TRANSITIONS,
  OPEN_WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  canTransition,
  isTerminal,
  terminalStatuses,
} from "@/lib/execution/statuses";

/**
 * The state machines are data; these tests are the proof that the data is
 * complete. Every status the database knows must have a row in its table, and
 * every row must name only statuses the database knows.
 */

const TABLES = [
  ["work item", WORK_ITEM_TRANSITIONS, Object.values(ContentWorkItemStatus)],
  ["brief", BRIEF_TRANSITIONS, Object.values(ContentBriefStatus)],
  ["draft", DRAFT_TRANSITIONS, Object.values(ContentDraftStatus)],
  ["execution", EXECUTION_TRANSITIONS, Object.values(ExecutionStatus)],
  ["publish approval", APPROVAL_TRANSITIONS, Object.values(PublishApprovalStatus)],
] as const;

describe.each(TABLES)("the %s state machine", (_name, table, statuses) => {
  it("covers every status exactly once", () => {
    expect(Object.keys(table).sort()).toEqual([...statuses].sort());
  });

  it("only ever points at statuses that exist, and never at itself", () => {
    for (const [from, targets] of Object.entries(table)) {
      for (const to of targets) {
        expect(statuses).toContain(to);
        expect(to).not.toBe(from);
      }
    }
  });

  it("has at least one terminal state, and terminal states have no exits", () => {
    const terminals = terminalStatuses(table as Record<string, readonly string[]>);
    expect(terminals.length).toBeGreaterThan(0);
    for (const status of terminals) {
      expect(isTerminal(table as Record<string, readonly string[]>, status)).toBe(true);
    }
  });
});

describe("the rules the spec spells out", () => {
  it("lets a work item reach VERIFIED only through PUBLISHED and VERIFYING", () => {
    expect(canTransition(WORK_ITEM_TRANSITIONS, "PUBLISHING", "VERIFIED")).toBe(false);
    expect(canTransition(WORK_ITEM_TRANSITIONS, "PUBLISHED", "VERIFYING")).toBe(true);
    expect(canTransition(WORK_ITEM_TRANSITIONS, "VERIFYING", "VERIFIED")).toBe(true);
  });

  it("keeps a published item PUBLISHED when verification fails (D5)", () => {
    expect(canTransition(WORK_ITEM_TRANSITIONS, "VERIFYING", "PUBLISHED")).toBe(true);
    expect(canTransition(WORK_ITEM_TRANSITIONS, "VERIFYING", "FAILED")).toBe(false);
  });

  it("gives an execution one way out of VERIFYING: passing (D5)", () => {
    expect(EXECUTION_TRANSITIONS.VERIFYING).toEqual(["VERIFIED"]);
    expect(canTransition(EXECUTION_TRANSITIONS, "SUCCEEDED", "VERIFIED")).toBe(false);
  });

  it("never lets an execution jump from approval to success without executing", () => {
    expect(canTransition(EXECUTION_TRANSITIONS, "APPROVED", "SUCCEEDED")).toBe(false);
    expect(canTransition(EXECUTION_TRANSITIONS, "AWAITING_APPROVAL", "EXECUTING")).toBe(false);
  });

  it("never lets a decided approval change again", () => {
    for (const status of ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"] as const) {
      expect(isTerminal(APPROVAL_TRANSITIONS, status)).toBe(true);
    }
  });

  it("sends an approved brief only to SUPERSEDED or ARCHIVED", () => {
    expect([...BRIEF_TRANSITIONS.APPROVED].sort()).toEqual(["ARCHIVED", "SUPERSEDED"]);
  });

  it("sends an approved draft back to QA when its content changes", () => {
    expect(canTransition(DRAFT_TRANSITIONS, "APPROVED", "AWAITING_QA")).toBe(true);
  });

  it("agrees with the partial unique indexes about what counts as open or active", () => {
    const closed = Object.values(ContentWorkItemStatus).filter(
      (status) => !OPEN_WORK_ITEM_STATUSES.includes(status),
    );
    expect(closed.sort()).toEqual(["ARCHIVED", "CANCELLED"]);

    for (const status of ACTIVE_EXECUTION_STATUSES) {
      expect(isTerminal(EXECUTION_TRANSITIONS, status)).toBe(false);
    }
    expect(ACTIVE_EXECUTION_STATUSES).not.toContain("SUCCEEDED");
    expect(ACTIVE_EXECUTION_STATUSES).not.toContain("VERIFYING");
  });
});
