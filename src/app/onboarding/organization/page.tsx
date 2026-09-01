import { redirect } from "next/navigation";

import { requireUser } from "@/server/auth/session";
import { CreateOrganizationForm } from "@/components/onboarding/create-organization-form";

export const metadata = {
  title: "Create your organization · SEO OS",
};

/**
 * Pre-step of onboarding: Organization -> Workspace.
 *
 * Reached only by an authenticated user with no membership. This is the sole
 * self-serve path to tenant access; nothing is granted by email domain.
 */
export default async function CreateOrganizationPage() {
  const { memberships } = await requireUser();

  if (memberships.length > 0) {
    redirect("/");
  }

  return (
    <main className="flex flex-1 items-start justify-center px-6 py-16">
      <div className="w-full max-w-md space-y-8">
        <header className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Step 1 of 2 · Setup
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Create your organization
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            An organization owns your workspaces and websites. You will be its owner.
          </p>
        </header>

        <CreateOrganizationForm />
      </div>
    </main>
  );
}
