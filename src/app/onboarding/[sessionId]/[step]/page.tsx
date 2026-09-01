import { notFound, redirect } from "next/navigation";

import { requireUser } from "@/server/auth/session";
import { requireWorkspaceAccess } from "@/server/auth/guards";
import { REQUIRED, hasRole } from "@/server/auth/roles";
import { prisma } from "@/server/db/prisma";
import { answersOf, currentStepOf, draftOf } from "@/server/services/onboarding";
import { canOpenStep, getStep, isStepSlug } from "@/lib/onboarding/steps";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { StepForm } from "@/components/onboarding/step-form";

export default async function OnboardingStepPage({
  params,
}: {
  params: Promise<{ sessionId: string; step: string }>;
}) {
  const { sessionId, step } = await params;

  if (!isStepSlug(step)) {
    notFound();
  }

  const { memberships } = await requireUser();
  const organizationIds = memberships.map((membership) => membership.organizationId);

  // The session id from the URL is a claim: it only resolves inside an organization
  // the caller actually belongs to.
  const session = await prisma.onboardingSession.findFirst({
    where: { id: sessionId, organizationId: { in: organizationIds } },
  });

  if (!session) {
    notFound();
  }

  // Proves workspace access and the write role before rendering a form.
  const access = await requireWorkspaceAccess(session.workspaceId, REQUIRED.WRITE);
  const canApprove = hasRole(access.membership.role, REQUIRED.APPROVE);

  const current = currentStepOf(session);

  // Server-enforced order: jumping ahead of progress is not possible by URL.
  if (!canOpenStep(step, current)) {
    redirect(`/onboarding/${session.id}/${current}`);
  }

  const answers = answersOf(session);
  const website = session.websiteId
    ? await prisma.website.findUnique({ where: { id: session.websiteId } })
    : null;
  const competitors = session.websiteId
    ? await prisma.competitor.findMany({
        where: { websiteId: session.websiteId },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const goals = session.websiteId
    ? await prisma.businessGoal.findMany({
        where: { websiteId: session.websiteId, status: "DRAFT" },
        orderBy: { createdAt: "asc" },
      })
    : [];

  return (
    <OnboardingShell sessionId={session.id} current={current} active={step}>
      <StepForm
        step={step}
        title={getStep(step).title}
        sessionId={session.id}
        answers={answers}
        draft={draftOf(session, step)}
        canApprove={canApprove}
        website={
          website
            ? { domain: website.domain, normalizedDomain: website.normalizedDomain }
            : null
        }
        competitors={competitors.map((competitor) => ({
          name: competitor.name,
          domain: competitor.domain ?? "",
          notes: competitor.notes ?? "",
        }))}
        goals={goals.map((goal) => ({
          title: goal.title,
          businessObjective: goal.businessObjective ?? "",
          primaryMetric: goal.primaryMetric ?? "",
        }))}
      />
    </OnboardingShell>
  );
}
