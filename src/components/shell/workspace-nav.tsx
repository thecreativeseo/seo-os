"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { slug: "team", label: "Team" },
  { slug: "audit", label: "Audit History" },
  { slug: "settings", label: "Settings" },
] as const;

export function WorkspaceNav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Workspace" className="mt-6">
      <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
        Workspace
      </p>
      <ul className="space-y-0.5">
        {SECTIONS.map((section) => {
          const href = `/workspaces/${workspaceId}/${section.slug}`;
          const active = pathname === href;

          return (
            <li key={section.slug}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${
                  active ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60"
                }`}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
