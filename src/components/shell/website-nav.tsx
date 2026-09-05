"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Website navigation (docs/P0_SPEC.md §21).
 *
 * Only sections that exist are listed as links. A stage that is coming next
 * may be shown, disabled and labelled so, where it helps a reader see the
 * shape of the flow - never as a link, never implying it works.
 */
type Section = { slug: string; label: string; comingNext?: true };

const GROUPS: { heading: string; sections: Section[] }[] = [
  {
    heading: "Command Center",
    sections: [{ slug: "", label: "Command Center" }],
  },
  {
    heading: "Opportunities",
    sections: [{ slug: "opportunities", label: "Opportunity Queue" }],
  },
  {
    heading: "Intelligence",
    sections: [
      { slug: "pages", label: "Pages" },
      { slug: "queries", label: "Queries" },
      { slug: "keywords", label: "Keywords" },
      { slug: "topics", label: "Topics" },
      // Moved from Website in P2: competitors stopped being a list somebody
      // maintains and became something the product has evidence about.
      { slug: "competitors", label: "Competitors" },
      { slug: "signals", label: "Signals" },
    ],
  },
  {
    heading: "AI Workbench",
    sections: [
      { slug: "diagnoses", label: "Diagnoses" },
      { slug: "recommendations", label: "Recommendations" },
      { slug: "review", label: "Review Queue" },
    ],
  },
  {
    heading: "Execution",
    // P4 (docs/P4_SPEC.md §38). Content Work → Briefs → Drafts exist; QA and
    // Publishing are M5 and M6 and are shown disabled so the flow reads whole.
    sections: [
      { slug: "content", label: "Content Work" },
      { slug: "briefs", label: "Briefs" },
      { slug: "drafts", label: "Drafts" },
      { slug: "qa", label: "QA", comingNext: true },
      { slug: "publishing", label: "Publishing", comingNext: true },
    ],
  },
  {
    heading: "Website",
    sections: [
      { slug: "ownership", label: "Ownership" },
      { slug: "goals", label: "Business Goals" },
      { slug: "context", label: "Business Context" },
      { slug: "brand-facts", label: "Brand Facts" },
      { slug: "seo-rules", label: "SEO Rules" },
    ],
  },
  {
    heading: "Connections",
    sections: [
      { slug: "connections", label: "Data Sources" },
      { slug: "imports", label: "Imports" },
      { slug: "data-health", label: "Data Health" },
    ],
  },
];

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
              if (section.comingNext) {
                return (
                  <li key={section.slug}>
                    <span
                      aria-disabled="true"
                      title="Coming next - not available yet"
                      className="text-muted-foreground/60 flex items-center justify-between rounded-md px-2 py-1.5 text-sm"
                    >
                      {section.label}
                      <span className="text-[10px] tracking-wide uppercase">Coming next</span>
                    </span>
                  </li>
                );
              }

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
      ))}
    </div>
  );
}
