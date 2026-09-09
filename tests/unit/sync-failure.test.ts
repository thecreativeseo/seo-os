import { describe, expect, it } from "vitest";

import {
  SYNC_STAGES,
  fingerprintError,
  fingerprintFields,
  newStageTracker,
} from "@/lib/sync/failure";

/**
 * What may be said about a failure (P1 sync observability).
 *
 * The production run that motivated this wrote seventy thousand rows and then
 * failed with `unknown`, and nothing recorded anywhere could say whether the
 * database had deadlocked, closed the connection, or run out of pool. The
 * fingerprint exists to answer that next time — and it has one hard rule: it
 * may carry the shape of an error and never its content. A message can hold
 * the SQL and the row; a code cannot.
 *
 * So most of these tests are about what is left out.
 */

/** A shape like Prisma's known request error over the pg adapter. */
class PrismaClientKnownRequestError extends Error {
  code = "P2010";
  meta: Record<string, unknown> = {
    code: "40P01",
    message: "deadlock detected",
    driverAdapterError: {
      cause: {
        originalCode: "40P01",
        originalMessage: "deadlock detected while updating gsc_metric_daily",
      },
    },
  };
  constructor() {
    super("Raw query failed. Code: `40P01`. Message: `deadlock detected`");
  }
}

/** A node-pg driver error, as it looks before Prisma wraps it. */
class DatabaseError extends Error {
  code = "57P01";
  severity = "FATAL";
  detail = "the server closed the connection while inserting into gsc_metric_daily";
  constructor() {
    super("terminating connection due to administrator command");
  }
}

describe("naming an error", () => {
  it("keeps the class, the Prisma code and the SQLSTATE of a database error", () => {
    const fingerprint = fingerprintError(new PrismaClientKnownRequestError(), "database_write");

    expect(fingerprint).toEqual({
      name: "PrismaClientKnownRequestError",
      prismaCode: "P2010",
      sqlState: "40P01",
      stage: "database_write",
    });
  });

  it("reads a SQLSTATE straight off a driver error", () => {
    const fingerprint = fingerprintError(new DatabaseError(), "database_write");

    expect(fingerprint.name).toBe("DatabaseError");
    expect(fingerprint.prismaCode).toBeNull();
    expect(fingerprint.sqlState).toBe("57P01");
  });

  it("accepts a socket errno where a SQLSTATE would be", () => {
    // A connection that drops mid-statement never gets as far as Postgres
    // saying anything; Node says ECONNRESET instead, and that is the fact.
    const error = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
      errno: -104,
    });

    expect(fingerprintError(error).sqlState).toBe("ECONNRESET");
  });

  it("follows the chain of causes", () => {
    const inner = Object.assign(new Error("inner"), { code: "53300" });
    const outer = new Error("outer", { cause: inner });

    expect(fingerprintError(outer).sqlState).toBe("53300");
  });

  it("stops following causes rather than looping", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;

    expect(() => fingerprintError(a)).not.toThrow();
    expect(fingerprintError(a).sqlState).toBeNull();
  });

  it("normalizes an ordinary error to its class and nothing else", () => {
    const fingerprint = fingerprintError(new TypeError("fetch failed"), "provider_fetch");

    expect(fingerprint).toEqual({
      name: "TypeError",
      prismaCode: null,
      sqlState: null,
      stage: "provider_fetch",
    });
  });

  it("copes with things that are not errors at all", () => {
    expect(fingerprintError("a string")).toEqual({
      name: null,
      prismaCode: null,
      sqlState: null,
      stage: null,
    });
    expect(fingerprintError(null).name).toBeNull();
    expect(fingerprintError(undefined).name).toBeNull();
    expect(fingerprintError(42).name).toBeNull();
  });
});

describe("what a fingerprint refuses to carry", () => {
  it("never contains the message, the SQL, the parameters or a stack", () => {
    const error = new PrismaClientKnownRequestError();
    const serialized = JSON.stringify(fingerprintError(error, "database_write"));

    for (const forbidden of [
      "deadlock detected",
      "gsc_metric_daily",
      "Raw query failed",
      "administrator",
      "at ",
      "message",
      "stack",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("drops a code-shaped field whose value is really a sentence", () => {
    // A library that stores its message under `code` must not get it through.
    const error = Object.assign(new Error("x"), {
      code: "connection to server at 10.0.0.5, port 5432 failed",
    });

    expect(fingerprintError(error).sqlState).toBeNull();
    expect(fingerprintError(error).prismaCode).toBeNull();
  });

  it("drops a class name that is not an identifier", () => {
    const error = new Error("x");
    Object.defineProperty(error, "constructor", {
      value: { name: "Error: password=hunter2 in the URL" },
    });

    expect(fingerprintError(error).name).toBeNull();
  });

  it("flattens to log fields with no room for anything else", () => {
    const fields = fingerprintFields(fingerprintError(new DatabaseError(), "identity_lookup"));

    expect(Object.keys(fields).sort()).toEqual(["errorName", "prismaCode", "sqlState", "stage"]);
    expect(fields).toEqual({
      errorName: "DatabaseError",
      prismaCode: null,
      sqlState: "57P01",
      stage: "identity_lookup",
    });
    expect(fingerprintFields(null)).toEqual({
      errorName: null,
      prismaCode: null,
      sqlState: null,
      stage: null,
    });
  });
});

describe("the stages", () => {
  it("names every place a sync can fail, including the one the queue reports", () => {
    expect(SYNC_STAGES).toEqual([
      "provider_fetch",
      "normalize",
      "identity_lookup",
      "database_write",
      "snapshot_open",
      "snapshot_finalize",
      "sync_run_finalize",
      "queue_acknowledgement",
    ]);
  });

  it("starts unknown, so a failure before the first boundary says so", () => {
    expect(newStageTracker()).toEqual({ stage: null });
  });
});
