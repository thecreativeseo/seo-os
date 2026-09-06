import crypto from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { buildEvidenceId } from "@/lib/evidence/id";
import { getPackage } from "@/server/services/evidence-assembler";
import {
  getQaRun,
  latestQaRun,
  listQaRuns,
  qaRunsForRevision,
  runQa,
} from "@/server/services/content-qa";
import { QaFixtures } from "../helpers/qa-fixture";

/**
 * P4 M5.1 attack tests (docs/P4_ACCEPTANCE_CRITERIA.md, security attack
 * tests: ContentQAResult). Tenant B may not read, run or list Tenant A's QA,
 * by any id it can guess or copy, and a package assembled for A holds
 * nothing of B's. Any success here is a P4 FAIL.
 */

const fixtures = new QaFixtures();

beforeAll(() => {
  vi.stubEnv("AI_PROVIDER", "null");
  resetProvider();
});
afterEach(() => resetProvider());
afterAll(async () => {
  await fixtures.teardown();
  await prisma.$disconnect();
});

describe("Tenant B against Tenant A's QA", () => {
  it("cannot run, read or list it, and sees not-found rather than forbidden", async () => {
    const a = await fixtures.tenant("a");
    const leadA = await fixtures.colleague(a, "SEO_LEAD");
    const b = await fixtures.tenant("b");
    const { item, revision } = await fixtures.readyForQa(a, leadA);
    const run = await runQa(a, item.id);
    if (!run.ok) throw new Error("A's run failed");

    // B, as an owner of its own organization, gets nothing of A's.
    await expect(runQa(b, item.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await getQaRun(b, run.run.id)).toBeNull();
    expect(await latestQaRun(b, item.id)).toBeNull();
    expect(await listQaRuns(b, item.id)).toEqual([]);
    expect(await qaRunsForRevision(b, revision.id)).toEqual([]);
    expect(await getPackage(b, run.run.evidencePackageId!)).toBeNull();
    // And A still sees everything.
    expect((await getQaRun(a, run.run.id))?.results).toHaveLength(10);
    expect(await prisma.contentQaRun.count({ where: { contentWorkItemId: item.id } })).toBe(1);
  });

  it("gets nothing for ids that are well-formed but name nothing of its own", async () => {
    const b = await fixtures.tenant("b2");
    const nothing = crypto.randomUUID();
    await expect(runQa(b, nothing)).rejects.toMatchObject({ code: "not_found" });
    expect(await getQaRun(b, nothing)).toBeNull();
    expect(await latestQaRun(b, nothing)).toBeNull();
    expect(await listQaRuns(b, nothing)).toEqual([]);
    expect(await qaRunsForRevision(b, nothing)).toEqual([]);
  });

  it("assembles A's QA package from A's records only, whatever ids are around", async () => {
    const a = await fixtures.tenant("a3");
    const leadA = await fixtures.colleague(a, "SEO_LEAD");
    const b = await fixtures.tenant("b3");
    const { item } = await fixtures.readyForQa(a, leadA);
    const run = await runQa(a, item.id);
    if (!run.ok) throw new Error("A's run failed");
    const pkg = await getPackage(a, run.run.evidencePackageId!);
    expect(pkg).not.toBeNull();
    const ids = pkg!.refs.map((ref) => ref.evidenceId);
    expect(ids).toContain(buildEvidenceId({ kind: "fact", brandFactId: a.factApproved }));
    expect(ids).not.toContain(buildEvidenceId({ kind: "fact", brandFactId: b.factApproved }));
    expect(ids).not.toContain(buildEvidenceId({ kind: "rule", seoRuleId: b.ruleId }));
    expect(ids.some((id) => id.includes(b.pageId))).toBe(false);
    // The results named nothing of B's either.
    const rows = await prisma.contentQaResult.findMany({ where: { qaRunId: run.run.id } });
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(b.factApproved);
    expect(everything).not.toContain(b.pageId);
    expect(everything).not.toContain(b.website.id);
  });
});
