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
const GROUPS = [
  {
    heading: "Command Center",
    sections: [{ slug: "", label: "Command Center" }],
  },
  {
    heading: "Intelligence",
    sections: [
      { slug: "pages", label: "Pages" },
      { slug: "queries", label: "Queries" },
      { slug: "signals", label: "Signals" },
    ],
  },
  {
    heading: "Website",
    sections: [
      { slug: "overview", label: "Overview" },
      { slug: "ownership", label: "Ownership" },
      { slug: "goals", label: "Business Goals" },
      { slug: "context", label: "Business Context" },
      { slug: "brand-facts", label: "Brand Facts" },
      { slug: "competitors", label: "Competitors" },
      { slug: "seo-rules", label: "SEO Rules" },
    ],
  },
  {
    heading: "Connections",
    sections: [
      { slug: "connections", label: "Data Sources" },
      { slug: "data-health", label: "Data Health" },
    ],
  },
] as const;

export function WebsiteNav({ websiteId }: { websiteId: string }) {
  const pathname = usePathname();

  return (
    <div className="mt-6 space-y-5">
      {GROUPS.map((group) => (
        <nav key={group.heading} aria-label={group.heading}>
          <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            {group.heading}
          </p>
          <ul className="space-y-0.5">
            {group.sections.map((section) => {
              const href = section.slug
                ? `/websites/${websiteId}/${section.slug}`
                : `/websites/${websiteId}`;
              // The Command Center is the index route, so it must match exactly —
              // a prefix match would light it up on every child page.
              const active = section.slug
                ? pathname === href || pathname.startsWith(`${href}/`)
                : pathname === href;

              return (
                <li key={section.slug}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${
                      active
                        ? "bg-accent font-medium"
                        : "text-muted-foreground hover:bg-accent/60"
                    }`}
                  >
                    {section.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ))}
    </div>
  );
}
