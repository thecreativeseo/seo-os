import Link from "next/link";

import { requireWorkspaceAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db/prisma";
import { WorkspaceNav } from "@/components/shell/workspace-nav";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await requireWorkspaceAccess(workspaceId);

  // Link back to a website so the two sections of the app are navigable both ways.
  const website = await prisma.website.findFirst({
    where: { workspaceId: context.workspace.id, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { id: true, normalizedDomain: true },
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10 md:flex-row md:gap-12">
      <aside className="md:w-52 md:shrink-0">
        <Link href="/" className="block">
          <p className="text-sm font-semibold tracking-tight">{context.organization.name}</p>
          <p className="text-muted-foreground text-xs">{context.workspace.name}</p>
        </Link>

        {website ? (
          <Link
            href={`/websites/${website.id}/overview`}
            className="text-muted-foreground hover:text-foreground mt-4 block font-mono text-xs"
          >
            ← {website.normalizedDomain}
          </Link>
        ) : null}

        <WorkspaceNav workspaceId={workspaceId} />

        <div className="border-border mt-8 space-y-2 border-t pt-4">
          <p className="text-muted-foreground truncate text-xs" title={context.user.email}>
            {context.user.email}
          </p>
          <p className="text-muted-foreground font-mono text-[10px] tracking-wide">
            {context.membership.role}
          </p>
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
