import { redirect } from "next/navigation";

import { getCurrentUser } from "@/server/auth/session";

/**
 * Post-sign-in landing.
 *
 * M3 delivers identity only. A newly signed-in user has no OrganizationMembership,
 * so they are authenticated and authorized for nothing — which is correct, and this
 * page says so plainly rather than implying access that does not exist.
 *
 * M4 replaces this with organization creation, and M10 with the Command Center.
 */
export default async function Home() {
  const current = await getCurrentUser();

  if (!current) {
    redirect("/login");
  }

  const { user, memberships } = current;

  return (
    <main className="flex flex-1 items-start justify-center px-6 py-16">
      <div className="w-full max-w-xl space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">SEO OS</h1>
          <p className="text-muted-foreground text-sm">
            Build the context your SEO team operates from.
          </p>
        </header>

        <section className="border-border space-y-3 rounded-lg border p-5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Signed in
          </h2>
          <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{user.displayName ?? "Not provided"}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{user.email}</dd>
            <dt className="text-muted-foreground">Last sign-in</dt>
            <dd>{user.lastLoginAt?.toLocaleString() ?? "Unknown"}</dd>
          </dl>
        </section>

        <section className="border-border space-y-3 rounded-lg border p-5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Organization access
          </h2>
          {memberships.length === 0 ? (
            <p className="text-sm leading-relaxed">
              No organization access yet. Signing in with Google proves who you are;
              it does not grant access to a workspace. Access comes from an
              organization membership, which arrives in the next milestone.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {memberships.map((membership) => (
                <li key={membership.id}>
                  {membership.organizationId} — {membership.role}
                </li>
              ))}
            </ul>
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
          P0 · M3. Onboarding, business context, and the Command Center are not built
          yet.
        </p>
      </div>
    </main>
  );
}
