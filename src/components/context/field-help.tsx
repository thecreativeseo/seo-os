/**
 * What each Business Context field is for.
 *
 * Written to reduce vague answers: a Business Context full of generic statements is
 * worse than an empty one, because later phases would treat it as fact.
 */
export const FIELD_HELP: Record<string, string> = {
  companySummary:
    "One or two sentences on what the company actually is. This is the opening context for every piece of SEO work that follows.",
  productService:
    "What this website sells or supports. Be concrete: “SEO consulting for B2B SaaS” rather than “marketing services”.",
  businessModel:
    "How the business earns revenue — retainer, subscription, one-off projects, ecommerce, marketplace. It shapes which conversions matter.",
  primaryCustomer:
    "Who actually buys. Describe the organisation or person, not the job title: “mid-market B2B SaaS companies in APAC”.",
  primaryMarket:
    "The country you are trying to win, chosen from the list. Where revenue should come from, not everywhere you happen to get traffic, and the country whose search data the connectors report.",
  additionalMarkets:
    "Other countries that matter, up to five. One per line, by name or code. They are recorded here; keyword data still follows the primary market.",
  primaryConversion:
    "The single action that matters most on this site. If two feel equal, pick the one closer to revenue and put the other under secondary.",
  competitorSummary:
    "How you differ from the competitors you listed, in your own words. Specific contrasts, not a list of adjectives.",
  brandVoice:
    "How the business sounds in writing — tone, formality, words you use and words you avoid.",
  buyerRoles:
    "Job titles involved in the buying decision, including people who influence it but do not sign. One per line.",
  languages: "Languages this website publishes in. One per line.",
  secondaryConversions:
    "Other actions worth tracking that are genuinely less important than the primary one. One per line.",
  businessPriorities:
    "What the business is trying to achieve this period beyond SEO — the goals SEO has to serve. One per line.",
  seoPriorities: "Where SEO effort should focus. One per line.",
  differentiators:
    "Specific, checkable reasons a buyer picks you over an alternative. “Faster” is not a differentiator; “results in 90 days or we refund” is.",
  priorityTopics: "Subjects you want to be known for and will publish on. One per line.",
  avoidTopics:
    "Subjects not to publish about — off-strategy, sensitive, or legally constrained. One per line.",
  approvedClaims:
    "Statements about the business that are verified and may be used in content as written. Anything not listed here has to be checked before it is published.",
  prohibitedClaims:
    "Statements that must never appear — unverified numbers, superlatives you cannot defend, or wording that creates a compliance problem. One per line.",
};
