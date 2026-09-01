import { redirect } from "next/navigation";

import { requireUser } from "@/server/auth/session";
import { requireWorkspaceAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { prisma } from "@/server/db/prisma";
import { currentStepOf, getOrCreateSession } from "@/server/services/onboarding";

/**
 * Onboarding entry point. Creates or resumes the workspace's session and sends the
 * user to whichever step they left off on — this is what makes "leave and resume"
 * work without the client tracking anything.
 */
export default async function OnboardingEntryPage() {
  const { memberships } = await requireUser();
  const membership = memberships[0];

  if (!membership) {
    redirect("/onboarding/organization");
  }

  const workspace = await prisma.workspace.findFirst({
    where: { organizationId: membership.organizationId, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });

  if (!workspace) {
    redirect("/");
  }

  const context = await requireWorkspaceAccess(workspace.id, REQUIRED.WRITE);
  const session = await getOrCreateSession(context);

  redirect(`/onboarding/${session.id}/${currentStepOf(session)}`);
}
