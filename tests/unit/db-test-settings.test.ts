import { describe, expect, it } from "vitest";

import { clientOptions } from "@/server/db/prisma";
import {
  TEST_DIRECT_POOL_MAX,
  TEST_DIRECT_POOL_MAX_VARIABLE,
  TEST_MAX_WAIT_VARIABLE,
  TEST_POOL_MAX,
  TEST_POOL_MAX_VARIABLE,
  TEST_TIMEOUT_VARIABLE,
  TEST_TRANSACTION_BUDGET,
  directPoolOptions,
  parsePositiveInteger,
  poolOptions,
  resolveDirectPoolMax,
  resolvePoolMax,
  resolveTransactionBudget,
} from "@/server/db/test-settings";

/**
 * The test-only database settings (M6.1 gate recovery, parts 2 and 3).
 *
 * Structural throughout. Nothing here opens a transaction, waits thirty
 * seconds, or checks out a connection to prove a number. The questions are what
 * gets resolved, in which environment, from which configuration.
 */

const test = { NODE_ENV: "test" };
const OTHERS = ["production", "development", undefined, "staging", "TEST"] as const;
// Whitespace is trimmed on purpose, so " 3 " is a good value, not a bad one.
const BAD = ["abc", "-5", "0", "1.5", "", "  ", "1e4", "NaN", "3.0", "0x10", "+5"] as const;

describe("the transaction budget", () => {
  it("is ten seconds to start and thirty to finish, by default", () => {
    expect(resolveTransactionBudget(test)).toEqual({ maxWait: 10_000, timeout: 30_000 });
    expect(TEST_TRANSACTION_BUDGET).toEqual({ maxWait: 10_000, timeout: 30_000 });
  });

  it("accepts an explicit override in whole milliseconds", () => {
    expect(
      resolveTransactionBudget({
        ...test,
        [TEST_MAX_WAIT_VARIABLE]: "12000",
        [TEST_TIMEOUT_VARIABLE]: "45000",
      }),
    ).toEqual({ maxWait: 12_000, timeout: 45_000 });
  });

  it("falls back to its own default for an unusable value, never to Prisma's", () => {
    for (const bad of BAD) {
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

describe("the pool ceiling", () => {
  it("is three for the shared client and one for a direct client, by default", () => {
    expect(resolvePoolMax(test)).toBe(3);
    expect(resolveDirectPoolMax(test)).toBe(1);
    expect(TEST_POOL_MAX).toBe(3);
    expect(TEST_DIRECT_POOL_MAX).toBe(1);
  });

  it("accepts explicit overrides", () => {
    expect(resolvePoolMax({ ...test, [TEST_POOL_MAX_VARIABLE]: "5" })).toBe(5);
    expect(resolveDirectPoolMax({ ...test, [TEST_DIRECT_POOL_MAX_VARIABLE]: "4" })).toBe(4);
  });

  it("never restores pg's default of ten through a bad value", () => {
    for (const bad of BAD) {
      expect(resolvePoolMax({ ...test, [TEST_POOL_MAX_VARIABLE]: bad }), JSON.stringify(bad)).toBe(
        3,
      );
      expect(
        resolveDirectPoolMax({ ...test, [TEST_DIRECT_POOL_MAX_VARIABLE]: bad }),
        JSON.stringify(bad),
      ).toBe(1);
      expect(poolOptions({ ...test, [TEST_POOL_MAX_VARIABLE]: bad }).max).not.toBe(10);
    }
  });

  it("lets a suite justify a second connection, and lets an operator overrule it", () => {
    // database.test.ts issues one Promise.all of five counts, so more than one
    // connection is genuinely useful there. Two bounds it.
    expect(directPoolOptions(test, 2)).toEqual({ max: 2 });
    expect(directPoolOptions({ ...test, [TEST_DIRECT_POOL_MAX_VARIABLE]: "1" }, 2)).toEqual({
      max: 1,
    });
  });
});

describe("every other environment", () => {
  it("resolves no budget and no pool ceiling, even with the variables set", () => {
    for (const NODE_ENV of OTHERS) {
      const env = {
        NODE_ENV,
        [TEST_MAX_WAIT_VARIABLE]: "12000",
        [TEST_TIMEOUT_VARIABLE]: "45000",
        [TEST_POOL_MAX_VARIABLE]: "5",
        [TEST_DIRECT_POOL_MAX_VARIABLE]: "4",
      };
      const where = `NODE_ENV=${String(NODE_ENV)}`;
      expect(resolveTransactionBudget(env), where).toBeNull();
      expect(resolvePoolMax(env), where).toBeNull();
      expect(resolveDirectPoolMax(env), where).toBeNull();
    }
  });

  it("passes no max at all, so pg decides exactly as it did before", () => {
    for (const NODE_ENV of OTHERS) {
      const where = `NODE_ENV=${String(NODE_ENV)}`;
      expect("max" in poolOptions({ NODE_ENV }), where).toBe(false);
      expect("max" in directPoolOptions({ NODE_ENV }, 2), where).toBe(false);
    }
  });
});

describe("what the client is constructed with", () => {
  it("carries the budget as Prisma transactionOptions under test", () => {
    expect(clientOptions(test).transactionOptions).toEqual({ maxWait: 10_000, timeout: 30_000 });
  });

  it("carries no transactionOptions key anywhere else, so Prisma's defaults stand", () => {
    for (const NODE_ENV of ["production", "development", undefined]) {
      expect(
        "transactionOptions" in clientOptions({ NODE_ENV }),
        `NODE_ENV=${String(NODE_ENV)}`,
      ).toBe(false);
    }
  });

  it("does not change what is logged", () => {
    expect(clientOptions({ NODE_ENV: "development" }).log).toEqual(["warn", "error"]);
    expect(clientOptions({ NODE_ENV: "production" }).log).toEqual(["error"]);
    expect(clientOptions(test).log).toEqual(["error"]);
  });
});

describe("this very process", () => {
  it("is running under the test settings, or the suite is silently on the old limits", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(resolveTransactionBudget()).not.toBeNull();
    expect(resolvePoolMax()).toBe(3);
  });
});

describe("parsing", () => {
  it("takes whole positive integers only", () => {
    expect(parsePositiveInteger("30000")).toBe(30_000);
    expect(parsePositiveInteger(" 3 ")).toBe(3);
    for (const bad of BAD) expect(parsePositiveInteger(bad), JSON.stringify(bad)).toBeNull();
    expect(parsePositiveInteger(undefined)).toBeNull();
    expect(parsePositiveInteger("99999999999999999999")).toBeNull();
  });
});
