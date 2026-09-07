import { describe, expect, it } from "vitest";

import { clientOptions } from "@/server/db/prisma";
import {
  TEST_MAX_WAIT_VARIABLE,
  TEST_TIMEOUT_VARIABLE,
  TEST_TRANSACTION_BUDGET,
  parseMilliseconds,
  resolveTransactionBudget,
} from "@/server/db/transaction-budget";

/**
 * The test-only transaction budget (M6.1 gate recovery, part 2).
 *
 * Structural: nothing here opens a transaction or waits thirty seconds to prove
 * a number. The question is what the client is constructed with, in which
 * environment, from which configuration.
 */

const test = { NODE_ENV: "test" };

describe("the budget the test environment receives", () => {
  it("is ten seconds to start and thirty to finish, by default", () => {
    expect(resolveTransactionBudget(test)).toEqual({ maxWait: 10_000, timeout: 30_000 });
    expect(TEST_TRANSACTION_BUDGET).toEqual({ maxWait: 10_000, timeout: 30_000 });
  });

  it("is what this very suite is running under", () => {
    // Vitest sets NODE_ENV; if that ever changed, the suite would silently be
    // back on Prisma's five seconds, and this is the test that would say so.
    expect(process.env.NODE_ENV).toBe("test");
    expect(resolveTransactionBudget()).not.toBeNull();
  });

  it("accepts an explicit override that is a positive whole number of milliseconds", () => {
    expect(
      resolveTransactionBudget({
        ...test,
        [TEST_MAX_WAIT_VARIABLE]: "12000",
        [TEST_TIMEOUT_VARIABLE]: "45000",
      }),
    ).toEqual({ maxWait: 12_000, timeout: 45_000 });
  });

  it("falls back to the default for each value that is not usable, never to Prisma's", () => {
    for (const bad of ["abc", "-5", "0", "1.5", "", "  ", "1e4", "NaN"]) {
      expect(
        resolveTransactionBudget({ ...test, [TEST_MAX_WAIT_VARIABLE]: bad }),
        `maxWait=${JSON.stringify(bad)}`,
      ).toEqual({ maxWait: 10_000, timeout: 30_000 });
      expect(
        resolveTransactionBudget({ ...test, [TEST_TIMEOUT_VARIABLE]: bad }),
        `timeout=${JSON.stringify(bad)}`,
      ).toEqual({ maxWait: 10_000, timeout: 30_000 });
    }
  });

  it("never lets a transaction wait longer to start than it may then live", () => {
    expect(
      resolveTransactionBudget({
        ...test,
        [TEST_MAX_WAIT_VARIABLE]: "60000",
        [TEST_TIMEOUT_VARIABLE]: "20000",
      }),
    ).toEqual({ maxWait: 20_000, timeout: 20_000 });
  });
});

describe("every other environment", () => {
  it("gets no budget at all, even with the variables set", () => {
    for (const NODE_ENV of ["production", "development", undefined, "staging", "TEST"]) {
      expect(
        resolveTransactionBudget({
          NODE_ENV,
          [TEST_MAX_WAIT_VARIABLE]: "12000",
          [TEST_TIMEOUT_VARIABLE]: "45000",
        }),
        `NODE_ENV=${String(NODE_ENV)}`,
      ).toBeNull();
    }
  });
});

describe("what the client is constructed with", () => {
  it("carries the budget as Prisma transactionOptions under test", () => {
    expect(clientOptions(test).transactionOptions).toEqual({ maxWait: 10_000, timeout: 30_000 });
  });

  it("carries no transactionOptions key anywhere else, so Prisma's defaults stand", () => {
    for (const NODE_ENV of ["production", "development", undefined]) {
      const options = clientOptions({ NODE_ENV });
      expect("transactionOptions" in options, `NODE_ENV=${String(NODE_ENV)}`).toBe(false);
    }
  });

  it("does not change what is logged", () => {
    expect(clientOptions({ NODE_ENV: "development" }).log).toEqual(["warn", "error"]);
    expect(clientOptions({ NODE_ENV: "production" }).log).toEqual(["error"]);
    expect(clientOptions(test).log).toEqual(["error"]);
  });
});

describe("parsing milliseconds", () => {
  it("takes whole positive integers only", () => {
    expect(parseMilliseconds("30000")).toBe(30_000);
    expect(parseMilliseconds(" 30000 ")).toBe(30_000);
    expect(parseMilliseconds("0")).toBeNull();
    expect(parseMilliseconds("-1")).toBeNull();
    expect(parseMilliseconds("30000.5")).toBeNull();
    expect(parseMilliseconds("30s")).toBeNull();
    expect(parseMilliseconds(undefined)).toBeNull();
    expect(parseMilliseconds("99999999999999999999")).toBeNull();
  });
});
