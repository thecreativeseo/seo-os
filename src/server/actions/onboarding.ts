"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/server/auth/session";
import { requireWorkspaceAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db/prisma";
import { REQUIRED } from "@/server/auth/roles";
import { OnboardingError, currentStepOf, saveDraft, saveStep } from "@/server/services/onboarding";
import { isStepSlug, type OnboardingStepSlug } from "@/lib/onboarding/steps";

export type StepFormState = {
  error?: string;
  field?: string;
};

/**
 * Persists one onboarding step.
 *
 * Authorization is re-established from the session cookie on every call — the form
 * supplies a session id, which is a claim to verify, never a scope to trust.
 */
export async function saveStepAction(
  _previous: StepFormState,
  formData: FormData,
): Promise<StepFormState> {
  const sessionId = String(formData.get("__sessionId") ?? "");
  const stepSlug = String(formData.get("__step") ?? "");

  if (!sessionId || !isStepSlug(stepSlug)) {
    return { error: "That step is not recognised." };
  }

  const { memberships } = await requireUser();
  const organizationIds = memberships.map((membership) => membership.organizationId);

  const session = await prisma.onboardingSession.findFirst({
    where: { id: sessionId, organizationId: { in: organizationIds } },
  });

  if (!session) {
    return { error: "That onboarding session is not available." };
  }

  const context = await requireWorkspaceAccess(session.workspaceId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  let next: OnboardingStepSlug | null;

  try {
    const result = await saveStep(context, session, stepSlug, parseFormData(stepSlug, formData));
    next = result.next;
  } catch (error) {
    if (error instanceof OnboardingError) {
      return { error: error.message, field: error.field };
    }
    throw error;
  }

  redirect(`/onboarding/${session.id}/${next ?? currentStepOf(session)}`);
}

/**
 * Autosave one step's raw input.
 *
 * Same authorization path as a real save — a draft write is still a tenant write.
 * Returns quietly on any problem: autosave must never interrupt typing with an
 * error, and the user still gets a real error when they submit.
 */
export async function saveDraftAction(formData: FormData): Promise<void> {
  const sessionId = String(formData.get("__sessionId") ?? "");
  const stepSlug = String(formData.get("__step") ?? "");

  if (!sessionId || !isStepSlug(stepSlug)) {
    return;
  }

  const { memberships } = await requireUser();
  const organizationIds = memberships.map((membership) => membership.organizationId);

  const session = await prisma.onboardingSession.findFirst({
    where: { id: sessionId, organizationId: { in: organizationIds } },
  });

  if (!session || session.status === "COMPLETED") {
    return;
  }

  const context = await requireWorkspaceAccess(session.workspaceId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  const raw: Record<string, unknown> = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith("__")) continue;
    const values = formData.getAll(key).map(String);
    raw[key] = values.length > 1 ? values : (values[0] ?? "");
  }

  await saveDraft(context, session, stepSlug, raw);
}

/**
 * FormData is flat strings; each step declares how its fields become structured
 * input. Repeatable rows arrive as parallel arrays.
 */
function parseFormData(step: OnboardingStepSlug, formData: FormData): unknown {
  const text = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };
  const list = (key: string) =>
    formData
      .getAll(key)
      .map((value) => String(value).trim())
      .filter(Boolean);

  switch (step) {
    case "website":
      return {
        domain: text("domain"),
        name: text("name"),
        websiteType: text("websiteType") || undefined,
        primaryLanguage: text("primaryLanguage"),
        primaryMarket: text("primaryMarket"),
        additionalMarkets: list("additionalMarkets"),
        timezone: text("timezone"),
      };
    case "business":
      return {
        productService: text("productService"),
        businessModel: text("businessModel"),
        companySummary: text("companySummary"),
      };
    case "customer":
      return { primaryCustomer: text("primaryCustomer"), buyerRoles: list("buyerRoles") };
    case "conversion": {
      const choice = text("primaryConversion");
      const other = text("primaryConversionOther");
      return {
        primaryConversion: choice === "Other" && other ? other : choice,
        secondaryConversions: list("secondaryConversions"),
      };
    }
    case "market":
      return {
        primaryMarket: text("primaryMarket"),
        primaryLanguage: text("primaryLanguage"),
        additionalMarkets: list("additionalMarkets"),
      };
    case "competitors": {
      const names = formData.getAll("competitorName").map(String);
      const domains = formData.getAll("competitorDomain").map(String);
      const notes = formData.getAll("competitorNotes").map(String);
      return {
        competitors: names
          .map((name, index) => ({
            name: name.trim(),
            domain: (domains[index] ?? "").trim(),
            notes: (notes[index] ?? "").trim(),
          }))
          .filter((row) => row.name.length > 0),
      };
    }
    case "goals": {
      const titles = formData.getAll("goalTitle").map(String);
      const objectives = formData.getAll("goalObjective").map(String);
      const metrics = formData.getAll("goalMetric").map(String);
      return {
        goals: titles
          .map((title, index) => ({
            title: title.trim(),
            businessObjective: (objectives[index] ?? "").trim(),
            primaryMetric: (metrics[index] ?? "").trim(),
          }))
          .filter((row) => row.title.length > 0),
      };
    }
    case "seo-priorities":
      return { seoPriorities: list("seoPriorities") };
    case "cms":
      return {
        cms: text("cms") || "UNKNOWN",
        publicationProcess: text("publicationProcess"),
        developerContact: text("developerContact"),
      };
    case "connections":
    case "review":
      return {};
  }
}
