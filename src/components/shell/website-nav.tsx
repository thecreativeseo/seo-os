"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Website navigation (docs/P0_SPEC.md §21).
 *
 * Only sections that exist are listed. Connections, Team, Audit History and
 * Settings arrive in M8–M10 and are added then, rather than shown now as dead
 * links.
 */
const SECTIONS = [
  { slug: "overview", label: "Overview" },
  { slug: "goals", label: "Business Goals" },
  { slug: "context", label: "Business Context" },
  { slug: "brand-facts", label: "Brand Facts" },
  { slug: "competitors", label: "Competitors" },
  { slug: "seo-rules", label: "SEO Rules" },
] as const;

export function WebsiteNav({ websiteId }: { websiteId: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Website" className="mt-6">
      <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
        Website
      </p>
      <ul className="space-y-0.5">
        {SECTIONS.map((section) => {
          const href = `/websites/${websiteId}/${section.slug}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);

          return (
            <li key={section.slug}>
              <Link
                href={href as never}
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
