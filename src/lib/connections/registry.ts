import type { ConnectionProvider } from "@/generated/prisma/client";

/**
 * Provider registry (docs/P0_SPEC.md §18, blueprint "Connections").
 *
 * Static configuration, not database rows. Availability is stated honestly, and
 * no card offers an action a provider cannot actually perform.
 *
 * These strings describe what is true now rather than which phase will deliver
 * it. They were originally written as roadmap labels — "Coming in P1" — and went
 * stale the moment P1 shipped, leaving the page promising a future for something
 * the button beside it already did. A label that names a phase has to be revised
 * every time a phase lands, and the one that is forgotten is the one a customer
 * reads.
 */
export type ProviderCard = {
  provider: ConnectionProvider;
  name: string;
  purpose: string;
  availability: string;
  /**
   * Set where a provider's data arrives some way other than by connecting.
   *
   * Semrush and Ahrefs are the case this exists for: P2 delivered them through
   * CSV import (P2_SPEC §7 IMPORT MODE), so a card that said only "not
   * connected" would be hiding a feature that works.
   */
  alternative?: { label: string; href: (websiteId: string) => string };
};

const importsHref = (websiteId: string) => `/websites/${websiteId}/imports`;

export const CONNECTION_PROVIDERS: readonly ProviderCard[] = [
  {
    provider: "GOOGLE_SEARCH_CONSOLE",
    name: "Google Search Console",
    purpose: "Search visibility",
    availability: "Available",
  },
  {
    provider: "GOOGLE_ANALYTICS",
    name: "Google Analytics 4",
    purpose: "Behavior + conversions",
    availability: "Available",
  },
  {
    provider: "HUBSPOT",
    name: "HubSpot",
    purpose: "Leads + pipeline + campaigns",
    availability: "Not yet available",
  },
  {
    provider: "SEMRUSH",
    name: "Semrush",
    purpose: "Keywords + rankings + competitors",
    availability: "By CSV import",
    alternative: { label: "Import a Semrush export", href: importsHref },
  },
  {
    provider: "AHREFS",
    name: "Ahrefs",
    purpose: "Keywords + rankings + competitors",
    availability: "By CSV import",
    alternative: { label: "Import an Ahrefs export", href: importsHref },
  },
  {
    provider: "SIMILARWEB",
    name: "Similarweb",
    purpose: "Market + competitor intelligence",
    availability: "Not yet available",
  },
  {
    provider: "SCREAMING_FROG",
    name: "Screaming Frog",
    purpose: "Technical crawl",
    availability: "Not yet available",
  },
  {
    provider: "WORDPRESS",
    name: "WordPress",
    purpose: "Content + publishing",
    availability: "Not yet available",
  },
] as const;
