import { prisma } from "@/server/db/prisma";
import { PROMPTS, findPrompt, hashInstructions, type PromptDefinition } from "@/lib/ai/prompts/registry";
import type { AgentType, AiTaskType, PromptTemplate } from "@/generated/prisma/client";

/**
 * PromptTemplateService (docs/P3_SPEC.md §8, §38).
 *
 * Reconciles the prompts defined in code with the rows that AiRuns point at.
 *
 * The invariant this exists to protect: an AiRun records a prompt template id and
 * version, and a person reading that run months later must be able to see the
 * exact instructions that produced it. So a published version is immutable. If
 * the text in code no longer matches the text stored for that version, this
 * refuses to sync rather than overwriting — because overwriting would leave every
 * historical run pointing at instructions that were never used.
 *
 * The remedy is always the same and always the one the spec names: add a version.
 *
 * Prompt templates are global, not tenant-scoped. They describe how SEO OS
 * reasons, not what any customer's data says, and every website gets the same
 * agent. That is why nothing here takes a TenantContext.
 */

export class PromptTemplateError extends Error {
  constructor(
    message: string,
    readonly code:
      | "version_changed"
      | "no_active_template"
      | "not_found"
      | "already_active",
  ) {
    super(message);
    this.name = "PromptTemplateError";
  }
}

/**
 * Stores the content hash where it can be compared later.
 *
 * The schema has no hash column, and adding one for this would be a migration in
 * service of a check. The instructions themselves are stored, so the hash is
 * computed from them on both sides — which is stricter, since it compares the
 * text rather than a claim about the text.
 */
function matches(stored: PromptTemplate, definition: PromptDefinition): boolean {
  return (
    hashInstructions(stored.systemInstructions) ===
      hashInstructions(definition.systemInstructions) &&
    stored.outputSchemaVersion === definition.outputSchemaVersion
  );
}

export type SyncResult = {
  created: number;
  activated: number;
  retired: number;
  unchanged: number;
};

/**
 * Brings the database in line with the prompts defined in code.
 *
 * Safe to call repeatedly — it is idempotent, and it is called lazily before a
 * diagnosis runs so a fresh database does not need a separate setup step.
 */
export async function syncPromptTemplates(): Promise<SyncResult> {
  const result: SyncResult = { created: 0, activated: 0, retired: 0, unchanged: 0 };

  for (const definition of PROMPTS) {
    const existing = await prisma.promptTemplate.findUnique({
      where: {
        agentType_taskType_version: {
          agentType: definition.agentType,
          taskType: definition.taskType,
          version: definition.version,
        },
      },
    });

    if (existing && !matches(existing, definition)) {
      throw new PromptTemplateError(
        `Prompt ${definition.agentType}/${definition.taskType} v${definition.version} has already been used and its text has changed. ` +
          "A published prompt is immutable because historical runs cite it. Add a new version instead.",
        "version_changed",
      );
    }

    if (!existing) {
      await prisma.promptTemplate.create({
        data: {
          name: definition.name,
          agentType: definition.agentType,
          taskType: definition.taskType,
          version: definition.version,
          systemInstructions: definition.systemInstructions,
          outputSchemaVersion: definition.outputSchemaVersion,
          status: definition.active ? "ACTIVE" : "DRAFT",
          activatedAt: definition.active ? new Date() : null,
        },
      });
      result.created += 1;
      if (definition.active) result.activated += 1;
      continue;
    }

    result.unchanged += 1;

    // The code says this version is now the active one.
    if (definition.active && existing.status !== "ACTIVE") {
      await prisma.promptTemplate.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", activatedAt: new Date(), retiredAt: null },
      });
      result.activated += 1;
    }
  }

  // Anything active in the database that code no longer marks active is retired
  // rather than deleted: runs point at it, and a run whose prompt vanished is a
  // run nobody can explain.
  const activeInDatabase = await prisma.promptTemplate.findMany({
    where: { status: "ACTIVE" },
  });

  for (const row of activeInDatabase) {
    const definition = findPrompt(row.agentType, row.taskType, row.version);

    if (!definition?.active) {
      await prisma.promptTemplate.update({
        where: { id: row.id },
        data: { status: "RETIRED", retiredAt: new Date() },
      });
      result.retired += 1;
    }
  }

  return result;
}

/**
 * The template a new run should use.
 *
 * Syncs first, so a database that has never seen a prompt gets one rather than
 * failing with a message about setup that nobody would know how to act on.
 */
export async function activeTemplate(
  agentType: AgentType,
  taskType: AiTaskType,
): Promise<PromptTemplate> {
  await syncPromptTemplates();

  const template = await prisma.promptTemplate.findFirst({
    where: { agentType, taskType, status: "ACTIVE" },
    orderBy: { version: "desc" },
  });

  if (!template) {
    throw new PromptTemplateError(
      `No active prompt template for ${agentType}/${taskType}.`,
      "no_active_template",
    );
  }

  return template;
}

/**
 * A specific stored version, for reading a historical run.
 *
 * Reads the database rather than the code registry on purpose: what matters when
 * explaining an old run is the text that was stored when it ran, not the text
 * that happens to be in the current checkout.
 */
export async function templateById(id: string): Promise<PromptTemplate | null> {
  return prisma.promptTemplate.findUnique({ where: { id } });
}

export async function listTemplates(): Promise<PromptTemplate[]> {
  return prisma.promptTemplate.findMany({
    orderBy: [{ agentType: "asc" }, { taskType: "asc" }, { version: "desc" }],
  });
}
