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
        <p className="text-muted-foreground mt-6 text-xs">
          {context.membership.role}
        </p>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
