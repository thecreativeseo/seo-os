import type { ConnectionProvider } from "@/generated/prisma/client";

/**
 * Provider registry (docs/P0_SPEC.md §18, blueprint "Connections").
 *
 * Static configuration, not database rows: P0 shows connection architecture only.
 * Availability is stated honestly — no provider connects in this phase, and none of
 * these cards offers an action that would imply otherwise.
 */
export type ProviderCard = {
  provider: ConnectionProvider;
  name: string;
  purpose: string;
  availability: string;
};

export const CONNECTION_PROVIDERS: readonly ProviderCard[] = [
  {
    provider: "GOOGLE_SEARCH_CONSOLE",
    name: "Google Search Console",
    purpose: "Search visibility",
    availability: "Coming in P1",
  },
  {
    provider: "GOOGLE_ANALYTICS",
    name: "Google Analytics 4",
    purpose: "Behavior + conversions",
    availability: "Coming in P1",
  },
  {
    provider: "HUBSPOT",
    name: "HubSpot",
    purpose: "Leads + pipeline + campaigns",
    availability: "Later",
  },
  {
    provider: "SEMRUSH",
    name: "Semrush",
    purpose: "Keywords + rankings + competitors",
    availability: "P2",
  },
  {
    provider: "AHREFS",
    name: "Ahrefs",
    purpose: "Keywords + rankings + competitors",
    availability: "P2",
  },
  {
    provider: "SIMILARWEB",
    name: "Similarweb",
    purpose: "Market + competitor intelligence",
    availability: "Later",
  },
  {
    provider: "SCREAMING_FROG",
    name: "Screaming Frog",
    purpose: "Technical crawl",
    availability: "Later",
  },
  {
    provider: "WORDPRESS",
    name: "WordPress",
    purpose: "Content + publishing",
    availability: "P4",
  },
] as const;
