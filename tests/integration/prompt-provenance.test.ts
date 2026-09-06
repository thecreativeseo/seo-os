import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import { PROMPTS, findPrompt, hashInstructions } from "@/lib/ai/prompts/registry";
import { CONTENT_BRIEF_SCHEMA_VERSION } from "@/lib/ai/schemas/content-brief";
import { CONTENT_DRAFT_SCHEMA_VERSION } from "@/lib/ai/schemas/content-draft";

/**
 * P4 M4.5.3: prompt provenance. The registry says which version of each
 * prompt is active and on which schema; the database holds a row for every
 * version a run has used, with the exact text it was given; every run points
 * at the row of the version it carries. Read-only, across all tenants: a
 * prompt is not tenant data, and a mismatch anywhere is a provenance defect.
 */

afterAll(() => prisma.$disconnect());

describe("the prompt registry after the P4 provider fixes", () => {
  it("has CONTENT_BRIEF v2 active on schema 2, and v1 preserved, inactive", () => {
    const active = findPrompt("CONTENT_BRIEF", "GENERATE_BRIEF");
    expect(active?.version).toBe(2);
    expect(active?.outputSchemaVersion).toBe("2");
    expect(active?.outputSchemaVersion).toBe(CONTENT_BRIEF_SCHEMA_VERSION);
    const v1 = findPrompt("CONTENT_BRIEF", "GENERATE_BRIEF", 1);
    expect(v1?.active).toBe(false);
    expect(v1?.outputSchemaVersion).toBe("1");
  });

  it("has CONTENT_DRAFT v3 active on schema 2, with v1 and v2 preserved, inactive", () => {
    const active = findPrompt("CONTENT_DRAFT", "GENERATE_DRAFT");
    expect(active?.version).toBe(3);
    expect(active?.outputSchemaVersion).toBe("2");
    expect(active?.outputSchemaVersion).toBe(CONTENT_DRAFT_SCHEMA_VERSION);
    expect(findPrompt("CONTENT_DRAFT", "GENERATE_DRAFT", 1)).toMatchObject({
      active: false,
      outputSchemaVersion: "1",
    });
    expect(findPrompt("CONTENT_DRAFT", "GENERATE_DRAFT", 2)).toMatchObject({
      active: false,
      outputSchemaVersion: "2",
    });
  });

  it("has exactly one active version per agent and task", () => {
    const active = new Map<string, number>();
    for (const prompt of PROMPTS.filter((row) => row.active)) {
      const key = `${prompt.agentType}/${prompt.taskType}`;
      expect(active.has(key), key).toBe(false);
      active.set(key, prompt.version);
    }
    expect([...active.keys()].sort()).toEqual([
      "CONTENT_BRIEF/GENERATE_BRIEF",
      "CONTENT_DRAFT/GENERATE_DRAFT",
      "PAGE_DIAGNOSIS/DIAGNOSE_PAGE",
    ]);
  });
});

describe("prompt rows and the runs that cite them", () => {
  it("holds, for every version a run has used, exactly the text the registry has for it", async () => {
    const rows = await prisma.promptTemplate.findMany({
      where: { runs: { some: {} } },
      select: {
        agentType: true,
        taskType: true,
        version: true,
        systemInstructions: true,
        outputSchemaVersion: true,
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const registered = findPrompt(row.agentType, row.taskType, row.version);
      const label = `${row.agentType}/${row.taskType} v${row.version}`;
      expect(registered, label).toBeDefined();
      expect(hashInstructions(row.systemInstructions), label).toBe(
        hashInstructions(registered!.systemInstructions),
      );
      expect(row.outputSchemaVersion, label).toBe(registered!.outputSchemaVersion);
    }
  });

  it("links every run to the row of the version it carries, so history resolves to what it was given", async () => {
    const mismatched = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
      FROM ai_run a
      JOIN prompt_template t ON t.id = a.prompt_template_id
      WHERE t.version <> a.prompt_template_version
         OR t.agent_type <> a.agent_type
         OR t.task_type <> a.task_type
         OR t.output_schema_version <> a.output_schema_version
    `;
    expect(Number(mismatched[0]?.n ?? 0)).toBe(0);
    // A run against a real provider always resolves to its prompt row. Test
    // fixtures write stub runs straight into the table, so those are not held
    // to it; they never reach a model.
    const unlinked = await prisma.aiRun.count({
      where: {
        promptTemplateVersion: { not: null },
        promptTemplateId: null,
        provider: { not: "stub" },
      },
    });
    expect(unlinked).toBe(0);
  });

  it("keeps the runs of the retired draft prompt versions on those versions", async () => {
    // Versions 1 and 2 were used by real runs before version 3 existed; their
    // runs still say so, and still resolve to the text they were given.
    const byVersion = await prisma.aiRun.groupBy({
      by: ["promptTemplateVersion"],
      where: { agentType: "CONTENT_DRAFT", taskType: "GENERATE_DRAFT" },
      _count: { _all: true },
    });
    for (const group of byVersion) {
      const version = group.promptTemplateVersion;
      if (version === null) continue;
      expect(findPrompt("CONTENT_DRAFT", "GENERATE_DRAFT", version)?.version, `v${version}`).toBe(
        version,
      );
    }
  });
});
