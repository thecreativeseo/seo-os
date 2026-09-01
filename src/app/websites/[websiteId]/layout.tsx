import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { WebsiteNav } from "@/components/shell/website-nav";

/**
 * Website shell.
 *
 * The guard runs here so every page under /websites/[websiteId] is authorized even
 * if a future page forgets — though each page still calls it independently, since a
 * layout is not a security boundary either.
 *
 * Navigation follows docs/P0_SPEC.md §21. Sections that do not exist yet are absent
 * rather than shown disabled: a link to nothing is a promise the prototype cannot
 * keep.
 */
export default async function WebsiteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10 md:flex-row md:gap-12">
      <aside className="md:w-52 md:shrink-0">
        <Link href="/" className="block">
          <p className="text-sm font-semibold tracking-tight">
            {context.organization.name}
          </p>
          <p className="text-muted-foreground font-mono text-xs">
            {context.website.normalizedDomain}
          </p>
        </Link>
        <WebsiteNav websiteId={websiteId} />

        <nav aria-label="Workspace" className="mt-5">
          <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            Workspace
          </p>
          <ul className="space-y-0.5">
            {[
              { slug: "team", label: "Team" },
              { slug: "audit", label: "Audit History" },
              { slug: "settings", label: "Settings" },
            ].map((section) => (
              <li key={section.slug}>
                <Link
                  href={`/workspaces/${context.workspace.id}/${section.slug}`}
                  className="text-muted-foreground hover:bg-accent/60 block rounded-md px-2 py-1.5 text-sm transition-colors"
                >
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-border mt-8 space-y-2 border-t pt-4">
          <p className="text-muted-foreground truncate text-xs" title={context.user.email}>
            {context.user.email}
          </p>
          <p className="text-muted-foreground font-mono text-[10px] tracking-wide">
            {context.membership.role}
          </p>
          {/* POST, not a link: a GET sign-out could be triggered by a prefetch or
              a third-party page embedding the URL. */}
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -ml-2 inline-flex h-8 items-center rounded-md px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
