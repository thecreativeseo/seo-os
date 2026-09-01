import { prisma } from "@/server/db/prisma";
import { redact } from "@/lib/redact";
import { normalizeDomain } from "@/lib/domain/normalize-domain";
import {
  FIRST_STEP,
  REVIEW_STEP,
  nextStep,
  stepIndex,
  type OnboardingStepSlug,
} from "@/lib/onboarding/steps";
import { STEP_SCHEMAS, type StepAnswers } from "@/lib/onboarding/schemas";
import type { OrgContext, WorkspaceContext } from "@/server/auth/guards";
import type { OnboardingSession } from "@/generated/prisma/client";

/**
 * Onboarding engine (docs/P0_SPEC.md §10–11).
 *
 * Progress is server-persisted, resumable, refresh-safe, tenant-scoped, and
 * server-validated. answers_json holds the working draft; entities with their own
 * lifecycle (Website, Competitors, Goals) are written as real rows when their step
 * commits, so a later step can depend on them.
 */

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

/**
 * answers_json holds two things:
 *   - committed, schema-validated answers, keyed by step
 *   - __drafts: raw in-progress input from autosave, keyed by step
 *
 * They are kept apart so autosave can persist half-typed input without ever
 * corrupting validated answers. A draft is discarded the moment its step commits.
 */
const DRAFTS_KEY = "__drafts";

type AnswersEnvelope = StepAnswers & {
  [DRAFTS_KEY]?: Record<string, Record<string, unknown>>;
};

function readEnvelope(session: OnboardingSession): AnswersEnvelope {
  const raw = session.answersJson;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as AnswersEnvelope;
  }
  return {};
}

function readAnswers(session: OnboardingSession): StepAnswers {
  const { [DRAFTS_KEY]: _drafts, ...answers } = readEnvelope(session);
  return answers;
}

/**
 * Returns the workspace's in-progress session, creating one if none exists.
 * Resumable by construction: the same workspace always returns the same session.
 */
export async function getOrCreateSession(
  context: WorkspaceContext,
): Promise<OnboardingSession> {
  const existing = await prisma.onboardingSession.findFirst({
    where: {
      workspaceId: context.workspace.id,
      organizationId: context.organization.id,
      status: { in: ["IN_PROGRESS", "REVIEW"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return existing;
  }

  return prisma.onboardingSession.create({
    data: {
      organizationId: context.organization.id,
      workspaceId: context.workspace.id,
      currentStep: FIRST_STEP,
      status: "IN_PROGRESS",
      startedByUserId: context.user.id,
      // websiteId stays null until the website step commits.
    },
  });
}

/**
 * Loads a session and proves it belongs to the caller's tenant.
 * Never trusts the session id from the URL.
 */
export async function loadSession(
  context: OrgContext,
  sessionId: string,
): Promise<OnboardingSession | null> {
  return prisma.onboardingSession.findFirst({
    where: { id: sessionId, organizationId: context.organization.id },
  });
}

export function currentStepOf(session: OnboardingSession): OnboardingStepSlug {
  const value = session.currentStep;
  return (value as OnboardingStepSlug) ?? FIRST_STEP;
}

export function answersOf(session: OnboardingSession): StepAnswers {
  return readAnswers(session);
}

/** Raw autosaved input for a step, if the user left mid-answer. */
export function draftOf(
  session: OnboardingSession,
  step: OnboardingStepSlug,
): Record<string, unknown> {
  return readEnvelope(session)[DRAFTS_KEY]?.[step] ?? {};
}

/**
 * Autosave. Persists raw input without validating it, without advancing the step,
 * and without writing any entity — so leaving the page mid-answer loses nothing,
 * while nothing half-formed can reach a real record.
 */
export async function saveDraft(
  context: WorkspaceContext,
  session: OnboardingSession,
  step: OnboardingStepSlug,
  input: Record<string, unknown>,
): Promise<void> {
  const envelope = readEnvelope(session);
  const drafts = { ...(envelope[DRAFTS_KEY] ?? {}), [step]: input };

  await prisma.onboardingSession.update({
    where: { id: session.id, organizationId: context.organization.id },
    data: { answersJson: { ...envelope, [DRAFTS_KEY]: drafts } as never },
  });
}

/**
 * Validates and persists one step, then advances the cursor.
 *
 * The cursor only ever moves forward: revisiting an earlier step to edit an answer
 * must not rewind progress the user already made.
 */
export async function saveStep(
  context: WorkspaceContext,
  session: OnboardingSession,
  step: OnboardingStepSlug,
  input: unknown,
): Promise<{ session: OnboardingSession; next: OnboardingStepSlug | null }> {
  const schema = STEP_SCHEMAS[step];
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OnboardingError(
      issue?.message ?? "Please check your answers.",
      issue?.path[0] ? String(issue.path[0]) : undefined,
    );
  }

  const envelope = readEnvelope(session);
  const { [step]: _discardedDraft, ...remainingDrafts } = envelope[DRAFTS_KEY] ?? {};

  // The committed answer supersedes the draft, so the draft is dropped.
  const answers: AnswersEnvelope = {
    ...readAnswers(session),
    [step]: parsed.data,
    [DRAFTS_KEY]: remainingDrafts,
  };

  let websiteId = session.websiteId;

  if (step === "website") {
    websiteId = await commitWebsite(context, session, parsed.data as never);
  }

  if (step === "competitors" && websiteId) {
    await commitCompetitors(websiteId, parsed.data as never);
  }

  if (step === "goals" && websiteId) {
    await commitGoals(websiteId, context.user.id, parsed.data as never);
  }

  if (step === "cms" && websiteId) {
    await commitCms(websiteId, context.user.id, parsed.data as never);
  }

  const following = nextStep(step);
  const currentIndex = stepIndex(currentStepOf(session));
  const candidateIndex = following ? stepIndex(following) : currentIndex;

  const updated = await prisma.onboardingSession.update({
    where: { id: session.id },
    data: {
      answersJson: answers as never,
      websiteId,
      // Forward-only cursor.
      currentStep:
        candidateIndex > currentIndex ? (following ?? session.currentStep) : session.currentStep,
      status: following === REVIEW_STEP ? "REVIEW" : session.status,
    },
  });

  return { session: updated, next: following };
}

async function commitWebsite(
  context: WorkspaceContext,
  session: OnboardingSession,
  input: {
    domain: string;
    name?: string;
    websiteType?: string;
    primaryLanguage?: string;
    primaryMarket?: string;
    timezone?: string;
  },
): Promise<string> {
  const result = normalizeDomain(input.domain);

  if (!result.ok) {
    throw new OnboardingError("Enter a valid domain, for example example.com", "domain");
  }

  const normalized = result.normalized;

  const clash = await prisma.website.findFirst({
    where: {
      workspaceId: context.workspace.id,
      normalizedDomain: normalized,
      ...(session.websiteId ? { NOT: { id: session.websiteId } } : {}),
    },
  });

  if (clash) {
    throw new OnboardingError(
      `${normalized} is already set up in this workspace.`,
      "domain",
    );
  }

  const data = {
    name: input.name ?? null,
    domain: input.domain.trim(),
    normalizedDomain: normalized,
    websiteType: (input.websiteType as never) ?? null,
    primaryLanguage: input.primaryLanguage ?? null,
    primaryMarket: input.primaryMarket ?? null,
    timezone: input.timezone ?? null,
  };

  if (session.websiteId) {
    const updated = await prisma.website.update({
      where: { id: session.websiteId },
      data,
    });
    return updated.id;
  }

  const created = await prisma.website.create({
    data: { ...data, workspaceId: context.workspace.id },
  });

  await prisma.auditEvent.create({
    data: {
      organizationId: context.organization.id,
      workspaceId: context.workspace.id,
      websiteId: created.id,
      actorUserId: context.user.id,
      entityType: "Website",
      entityId: created.id,
      action: "CREATE",
      afterSnapshotJson: redact({ domain: created.domain, normalizedDomain: normalized }),
    },
  });

  return created.id;
}

/**
 * Replaces the competitor set for this website.
 * P0 does not classify them: type stays UNKNOWN and provenance stays USER_PROVIDED.
 */
async function commitCompetitors(
  websiteId: string,
  input: { competitors: { name: string; domain?: string; notes?: string }[] },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.competitor.deleteMany({ where: { websiteId } });

    for (const competitor of input.competitors) {
      const normalized = competitor.domain ? normalizeDomain(competitor.domain) : null;

      await tx.competitor.create({
        data: {
          websiteId,
          name: competitor.name,
          domain: competitor.domain ?? null,
          normalizedDomain: normalized?.ok ? normalized.normalized : null,
          notes: competitor.notes ?? null,
          // No auto-classification in P0.
          type: "UNKNOWN",
          providedByUser: true,
          source: "USER_PROVIDED",
        },
      });
    }
  });
}

/**
 * Goals captured during onboarding stay DRAFT. Baseline stays null — onboarding
 * asks what the business wants, not what its numbers currently are, and inventing
 * a baseline would fabricate a business fact.
 */
async function commitGoals(
  websiteId: string,
  userId: string,
  input: { goals: { title: string; businessObjective?: string; primaryMetric?: string }[] },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.businessGoal.deleteMany({ where: { websiteId, status: "DRAFT" } });

    for (const goal of input.goals) {
      await tx.businessGoal.create({
        data: {
          websiteId,
          title: goal.title,
          businessObjective: goal.businessObjective ?? null,
          primaryMetric: goal.primaryMetric ?? null,
          ownerUserId: userId,
          status: "DRAFT",
        },
      });
    }
  });
}

async function commitCms(
  websiteId: string,
  userId: string,
  input: { cms: string; publicationProcess?: string; developerContact?: string },
): Promise<void> {
  await prisma.website.update({
    where: { id: websiteId },
    data: { cmsType: input.cms as never },
  });

  await prisma.technicalContext.upsert({
    where: { websiteId },
    update: {
      cms: input.cms as never,
      publicationProcess: input.publicationProcess ?? null,
      developerContact: input.developerContact ?? null,
    },
    create: {
      websiteId,
      cms: input.cms as never,
      publicationProcess: input.publicationProcess ?? null,
      developerContact: input.developerContact ?? null,
      ownerUserId: userId,
    },
  });
}
