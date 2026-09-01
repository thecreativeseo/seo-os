"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  GovernanceError,
  addCompetitor,
  archiveBrandFact,
  archiveCompetitor,
  createGoal,
  createSeoRule,
  decideBrandFact,
  proposeBrandFact,
  retireGoal,
  saveTechnicalContext,
  setSeoRuleActive,
  updateGoal,
} from "@/server/services/governance";

export type GovernanceState = { error?: string };

const ok: GovernanceState = {};

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
};

/**
 * Every action re-establishes authorization from the session before touching
 * anything. The website id in the form is a claim to verify, not a scope to trust.
 */
async function withWebsite<T>(
  formData: FormData,
  minimumRole: Parameters<typeof requireWebsiteAccess>[1],
  run: (context: Awaited<ReturnType<typeof requireWebsiteAccess>>) => Promise<T>,
): Promise<GovernanceState> {
  const websiteId = text(formData, "__websiteId");

  if (!websiteId) {
    return { error: "Missing website." };
  }

  const context = await requireWebsiteAccess(websiteId, minimumRole, {
    throwOnDenied: true,
  });

  try {
    await run(context);
  } catch (error) {
    if (error instanceof GovernanceError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return ok;
}

/* ------------------------------------------------------------------ goals */

const goalSchema = z.object({
  title: z.string().trim().min(2, "Enter a goal title").max(200),
  businessObjective: z.string().trim().max(500).optional(),
  primaryMetric: z.string().trim().max(120).optional(),
  baseline: z.string().trim().max(40).optional(),
  baselineSource: z.string().trim().max(200).optional(),
});

export async function createGoalAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const parsed = goalSchema.safeParse({
    title: text(formData, "title"),
    businessObjective: text(formData, "businessObjective"),
    primaryMetric: text(formData, "primaryMetric"),
    baseline: text(formData, "baseline"),
    baselineSource: text(formData, "baselineSource"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the goal details." };
  }

  return withWebsite(formData, REQUIRED.WRITE, (context) =>
    createGoal(context, {
      title: parsed.data.title,
      businessObjective: parsed.data.businessObjective || null,
      primaryMetric: parsed.data.primaryMetric || null,
      // Blank means unknown, not zero.
      baseline: parsed.data.baseline || null,
      baselineSource: parsed.data.baselineSource || null,
      ownerUserId: null,
    }),
  );
}

export async function activateGoalAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const goalId = text(formData, "__goalId");
  return withWebsite(formData, REQUIRED.WRITE, (context) =>
    updateGoal(context, goalId, { status: "ACTIVE" }),
  );
}

export async function retireGoalAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const goalId = text(formData, "__goalId");
  return withWebsite(formData, REQUIRED.WRITE, (context) => retireGoal(context, goalId));
}

/* ------------------------------------------------------------- brand facts */

const factSchema = z.object({
  category: z.string().trim().min(1, "Choose a category").max(80),
  factKey: z.string().trim().min(1, "Enter what this fact is").max(120),
  value: z.string().trim().min(1, "Enter the value").max(1000),
  sourceUrl: z.string().trim().max(500).optional(),
});

export async function proposeBrandFactAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const parsed = factSchema.safeParse({
    category: text(formData, "category"),
    factKey: text(formData, "factKey"),
    value: text(formData, "value"),
    sourceUrl: text(formData, "sourceUrl"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fact details." };
  }

  return withWebsite(formData, REQUIRED.WRITE, (context) =>
    proposeBrandFact(context, {
      category: parsed.data.category,
      factKey: parsed.data.factKey,
      value: parsed.data.value,
      // Never invent a source. Blank stays blank.
      sourceUrl: parsed.data.sourceUrl || null,
    }),
  );
}

export async function approveBrandFactAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const factId = text(formData, "__factId");
  return withWebsite(formData, REQUIRED.APPROVE, (context) =>
    decideBrandFact(context, factId, "APPROVED"),
  );
}

export async function rejectBrandFactAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const factId = text(formData, "__factId");
  return withWebsite(formData, REQUIRED.APPROVE, (context) =>
    decideBrandFact(context, factId, "REJECTED"),
  );
}

export async function archiveBrandFactAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const factId = text(formData, "__factId");
  return withWebsite(formData, REQUIRED.WRITE, (context) =>
    archiveBrandFact(context, factId),
  );
}

/* ------------------------------------------------------------- competitors */

const competitorSchema = z.object({
  name: z.string().trim().min(1, "Enter a competitor name").max(200),
  domain: z.string().trim().max(253).optional(),
  notes: z.string().trim().max(500).optional(),
  type: z
    .enum(["DIRECT", "ADJACENT", "SEARCH", "PUBLISHER", "AGGREGATOR", "UNKNOWN"])
    .optional(),
});

export async function addCompetitorAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const parsed = competitorSchema.safeParse({
    name: text(formData, "name"),
    domain: text(formData, "domain"),
    notes: text(formData, "notes"),
    type: text(formData, "type") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the competitor details." };
  }

  return withWebsite(formData, REQUIRED.WRITE, (context) =>
    addCompetitor(context, {
      name: parsed.data.name,
      domain: parsed.data.domain || null,
      notes: parsed.data.notes || null,
      type: parsed.data.type,
    }),
  );
}

export async function archiveCompetitorAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const competitorId = text(formData, "__competitorId");
  return withWebsite(formData, REQUIRED.WRITE, (context) =>
    archiveCompetitor(context, competitorId),
  );
}

/* --------------------------------------------------------------- seo rules */

const ruleSchema = z.object({
  category: z.string().trim().min(1, "Choose a category").max(80),
  rule: z.string().trim().min(3, "Describe the rule").max(1000),
  severity: z.enum(["INFO", "WARNING", "BLOCKING"]),
  appliesTo: z.string().trim().max(200).optional(),
});

export async function createSeoRuleAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const parsed = ruleSchema.safeParse({
    category: text(formData, "category"),
    rule: text(formData, "rule"),
    severity: text(formData, "severity") || "INFO",
    appliesTo: text(formData, "appliesTo"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the rule details." };
  }

  return withWebsite(formData, REQUIRED.WRITE, (context) =>
    createSeoRule(context, {
      category: parsed.data.category,
      rule: parsed.data.rule,
      severity: parsed.data.severity,
      appliesTo: parsed.data.appliesTo || null,
    }),
  );
}

export async function toggleSeoRuleAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const ruleId = text(formData, "__ruleId");
  const active = text(formData, "__active") === "true";
  return withWebsite(formData, REQUIRED.WRITE, (context) =>
    setSeoRuleActive(context, ruleId, active),
  );
}

/* ------------------------------------------------------- technical context */

export async function saveTechnicalContextAction(
  _previous: GovernanceState,
  formData: FormData,
): Promise<GovernanceState> {
  const staging = text(formData, "stagingAvailable");

  return withWebsite(formData, REQUIRED.WRITE, (context) =>
    saveTechnicalContext(context, {
      hostingNotes: text(formData, "hostingNotes") || null,
      knownMigrations: text(formData, "knownMigrations") || null,
      knownConstraints: text(formData, "knownConstraints") || null,
      // "" means the question was not answered — that stays unknown, not false.
      stagingAvailable: staging === "" ? null : staging === "yes",
      developerContact: text(formData, "developerContact") || null,
      publicationProcess: text(formData, "publicationProcess") || null,
      technicalNotes: text(formData, "technicalNotes") || null,
    }),
  );
}
