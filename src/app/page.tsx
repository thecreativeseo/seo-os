import Link from "next/link";
import { redirect } from "next/navigation";

import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";

/**
 * Post-sign-in routing.
 *
 *   no membership  -> create an organization (the only self-serve path to access)
 *   membership     -> the organization's workspace overview
 *
 * M5 will route onward into website onboarding; M10 replaces the destination with
 * the Command Center.
 */
export default async function Home() {
  const current = await getCurrentUser();

  if (!current) {
    redirect("/login");
  }

  const { user, memberships } = current;

  if (memberships.length === 0) {
    redirect("/onboarding/organization");
  }

  const membership = memberships[0]!;

  const organization = await prisma.organization.findFirst({
    where: { id: membership.organizationId },
    include: {
      workspaces: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        include: { websites: { where: { status: "ACTIVE" } } },
      },
    },
  });

  const workspace = organization?.workspaces[0];

  // No website yet: the workspace exists but has nothing to operate on, so continue
  // (or resume) onboarding rather than showing an empty shell.
  if (workspace && workspace.websites.length === 0) {
    redirect("/onboarding");
  }

  return (
    <main className="flex flex-1 items-start justify-center px-6 py-16">
      <div className="w-full max-w-xl space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {organization?.name ?? "SEO OS"}
          </h1>
          <p className="text-muted-foreground text-sm">
            Signed in as {user.email} · {membership.role}
          </p>
        </header>

        <section className="border-border space-y-3 rounded-lg border p-5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Workspace
          </h2>
          {workspace ? (
            <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{workspace.name}</dd>
              <dt className="text-muted-foreground">Websites</dt>
              <dd className="space-y-1">
                {workspace.websites.map((site) => (
                  <div key={site.id}>
                    <Link
                      href={`/websites/${site.id}/context`}
                      className="font-mono text-xs hover:underline"
                    >
                      {site.normalizedDomain}
                    </Link>
                  </div>
                ))}
              </dd>
            </dl>
          ) : (
            <p className="text-sm">No workspace found.</p>
          )}
        </section>

        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
          >
            Sign out
          </button>
        </form>

        <p className="text-muted-foreground border-border border-t pt-4 text-xs">
          P0 · M4. Website onboarding, business context, and the Command Center are
          not built yet.
        </p>
      </div>
    </main>
  );
}
