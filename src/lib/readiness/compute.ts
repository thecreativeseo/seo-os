/**
 * Setup readiness (docs/P0_SPEC.md §20).
 *
 * This is a SETUP dashboard, not an SEO dashboard. It reports how completely the
 * business has described itself — nothing here is a measurement of search
 * performance, and the percentage is called Setup completion, never a score.
 *
 * The function is pure: the same snapshot always produces the same items, the same
 * percentage and the same next step. That is what makes the demo reproducible and
 * lets the whole thing be tested without a database.
 */

export type ReadinessSnapshot = {
  hasDomain: boolean;
  hasWebsiteType: boolean;
  hasApprovedContext: boolean;
  hasPrimaryCustomer: boolean;
  hasPrimaryConversion: boolean;
  hasPrimaryMarket: boolean;
  competitorCount: number;
  activeGoalCount: number;
  draftGoalCount: number;
  approvedBrandFactCount: number;
  proposedBrandFactCount: number;
  activeSeoRuleCount: number;
  connectedProviderCount: number;
  providerCount: number;
};

export type ReadinessState = "COMPLETE" | "NEEDS_ATTENTION" | "INFORMATIONAL";

export type ReadinessItem = {
  key: string;
  label: string;
  state: ReadinessState;
  /** What the user sees in the right-hand column. */
  detail: string;
  /** Where to go to fix it, relative to the website. Null for informational rows. */
  path: string | null;
  /** What the Next Best Step card says when this item is the one to do. */
  action: string | null;
};

export type Readiness = {
  items: ReadinessItem[];
  /** Items that count toward completion — informational rows are excluded. */
  countedTotal: number;
  countedComplete: number;
  percentage: number;
  nextBestStep: { label: string; action: string; path: string } | null;
};

/**
 * Priority order for the Next Best Step: the first incomplete item wins.
 *
 * Ordered by what unblocks the most downstream work. Context before its own fields,
 * because approving context is what makes any of it canonical; goals before brand
 * facts, because a goal gives the work a purpose.
 */
const ORDER = [
  "website",
  "context",
  "customer",
  "conversion",
  "market",
  "competitors",
  "goals",
  "brandFacts",
  "seoRules",
] as const;

export function computeReadiness(snapshot: ReadinessSnapshot): Readiness {
  const items: ReadinessItem[] = [
    {
      key: "website",
      label: "Website",
      state: snapshot.hasDomain && snapshot.hasWebsiteType ? "COMPLETE" : "NEEDS_ATTENTION",
      detail: snapshot.hasDomain
        ? snapshot.hasWebsiteType
          ? "Complete"
          : "Website type not set"
        : "No domain",
      path: "ownership",
      action: "Finish the website details",
    },
    {
      key: "context",
      label: "Business Context",
      state: snapshot.hasApprovedContext ? "COMPLETE" : "NEEDS_ATTENTION",
      detail: snapshot.hasApprovedContext ? "Published" : "Not published",
      path: "context",
      action: "Publish your business context",
    },
    {
      key: "customer",
      label: "Customer",
      state: snapshot.hasPrimaryCustomer ? "COMPLETE" : "NEEDS_ATTENTION",
      detail: snapshot.hasPrimaryCustomer ? "Complete" : "Not described",
      path: "context",
      action: "Describe your primary customer",
    },
    {
      key: "conversion",
      label: "Conversion",
      state: snapshot.hasPrimaryConversion ? "COMPLETE" : "NEEDS_ATTENTION",
      detail: snapshot.hasPrimaryConversion ? "Complete" : "Not set",
      path: "context",
      action: "Set the action that matters most",
    },
    {
      key: "market",
      label: "Market",
      state: snapshot.hasPrimaryMarket ? "COMPLETE" : "NEEDS_ATTENTION",
      detail: snapshot.hasPrimaryMarket ? "Complete" : "Not set",
      path: "context",
      action: "Set your primary market",
    },
    {
      key: "competitors",
      label: "Competitors",
      state: snapshot.competitorCount > 0 ? "COMPLETE" : "NEEDS_ATTENTION",
      detail:
        snapshot.competitorCount > 0
          ? `${snapshot.competitorCount} recorded`
          : "None recorded",
      path: "competitors",
      action: "Add the competitors you care about",
    },
    {
      key: "goals",
      label: "Goals",
      // A draft goal is an intention, not a commitment. Activating it is the step.
      state: snapshot.activeGoalCount > 0 ? "COMPLETE" : "NEEDS_ATTENTION",
      detail:
        snapshot.activeGoalCount > 0
          ? `${snapshot.activeGoalCount} active`
          : snapshot.draftGoalCount > 0
            ? `${snapshot.draftGoalCount} in draft`
            : "None set",
      path: "goals",
      action:
        snapshot.draftGoalCount > 0 ? "Activate your business goals" : "Set a business goal",
    },
    {
      key: "brandFacts",
      label: "Brand Facts",
      // Only approved facts are canonical, so proposed ones do not count.
      state: snapshot.approvedBrandFactCount > 0 ? "COMPLETE" : "NEEDS_ATTENTION",
      detail:
        snapshot.approvedBrandFactCount > 0
          ? `${snapshot.approvedBrandFactCount} approved`
          : snapshot.proposedBrandFactCount > 0
            ? `${snapshot.proposedBrandFactCount} awaiting review`
            : "None recorded",
      path: "brand-facts",
      action:
        snapshot.proposedBrandFactCount > 0
          ? "Review your brand facts"
          : "Record your brand facts",
    },
    {
      key: "seoRules",
      label: "SEO Rules",
      state: snapshot.activeSeoRuleCount > 0 ? "COMPLETE" : "NEEDS_ATTENTION",
      detail:
        snapshot.activeSeoRuleCount > 0 ? `${snapshot.activeSeoRuleCount} active` : "None set",
      path: "seo-rules",
      action: "Record the rules SEO work must follow",
    },
    {
      key: "connections",
      label: "Connections",
      // Informational, and excluded from the percentage: nothing can be connected in
      // P0, so counting it would permanently cap completion for a reason the user
      // cannot act on. The count is still shown, honestly.
      state: "INFORMATIONAL",
      detail: `${snapshot.connectedProviderCount} / ${snapshot.providerCount}`,
      path: "connections",
      action: null,
    },
  ];

  const counted = items.filter((item) => item.state !== "INFORMATIONAL");
  const countedComplete = counted.filter((item) => item.state === "COMPLETE").length;
  const percentage =
    counted.length === 0 ? 0 : Math.round((countedComplete / counted.length) * 100);

  const byKey = new Map(items.map((item) => [item.key, item]));
  let nextBestStep: Readiness["nextBestStep"] = null;

  for (const key of ORDER) {
    const item = byKey.get(key);
    if (item && item.state === "NEEDS_ATTENTION" && item.path && item.action) {
      nextBestStep = { label: item.label, action: item.action, path: item.path };
      break;
    }
  }

  return {
    items,
    countedTotal: counted.length,
    countedComplete,
    percentage,
    nextBestStep,
  };
}
