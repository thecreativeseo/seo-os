/**
 * Retrieval policy (docs/P3_SPEC.md §13).
 *
 * "Retrieval must be named/versioned and inspectable." The rules for what a
 * diagnosis is allowed to see live here as data, get stored against the package
 * that used them, and are rendered on screen next to the diagnosis.
 *
 * The reason this is a versioned artefact and not a set of constants scattered
 * through the assembler: when a diagnosis turns out to be wrong, the first useful
 * question is almost never "was the model wrong" — it is "what did it not see".
 * A policy you can read afterwards answers that. Constants inlined at fourteen
 * call sites do not.
 *
 * Caps are part of the policy for the same reason. A context window is finite, so
 * something is always left out; the choice is whether that happens according to a
 * stated rule or according to whichever query happened to run last.
 */

export type CategoryBudget = {
  /** Most records of this kind that may enter a package. */
  max: number;
  /** Why this many, in words that belong in a review conversation. */
  rationale: string;
};

export type RetrievalPolicyDefinition = {
  name: string;
  version: number;
  description: string;
  /** Metric comparison window, in days. */
  windowDays: number;
  /** Hard ceiling across all categories. */
  maxEvidence: number;
  /** Characters of page text. Beyond this a diagnosis is reading, not diagnosing. */
  maxContentChars: number;
  budgets: Record<string, CategoryBudget>;
  rules: string[];
};

export const PAGE_DIAGNOSIS_POLICY: RetrievalPolicyDefinition = {
  name: "page-diagnosis",
  version: 1,
  description:
    "Evidence gathered for diagnosing one page: its own measurements, the keywords " +
    "it owns, what the business said it is for, and what the page actually says.",
  windowDays: 28,
  maxEvidence: 120,
  maxContentChars: 8_000,
  budgets: {
    BUSINESS_CONTEXT: {
      max: 1,
      rationale: "The current approved version only. Superseded context is not evidence.",
    },
    BUSINESS_GOAL: {
      max: 5,
      rationale: "Active goals, so a finding can be tied to what the business is trying to do.",
    },
    BRAND_FACT: {
      max: 10,
      rationale: "Approved facts, which constrain what a recommendation may claim.",
    },
    SEO_RULE: {
      max: 10,
      rationale: "Active rules. A recommendation that breaks one must be blocked, so they travel.",
    },
    GSC_METRIC: {
      max: 20,
      rationale: "Page totals for both windows plus the top queries by impressions.",
    },
    GA4_METRIC: { max: 4, rationale: "Page totals for both windows." },
    KEYWORD_METRIC: { max: 15, rationale: "Demand for the keywords this page owns." },
    RANKING_SNAPSHOT: {
      max: 20,
      rationale: "Latest and previous position per owned keyword, so movement is visible.",
    },
    KEYWORD_OWNERSHIP: { max: 15, rationale: "What this page is supposed to rank for." },
    TOPIC_MAPPING: { max: 5, rationale: "The topic this page belongs to, and its role in it." },
    COMPETITOR_OBSERVATION: {
      max: 15,
      rationale: "Competitor positions on the same keywords. Overlap only.",
    },
    PAGE_CONTENT: { max: 1, rationale: "The most recent snapshot. Older ones are not this page." },
    TECHNICAL_FINDING: { max: 10, rationale: "Open signals for this page." },
    PREVIOUS_DIAGNOSIS: {
      max: 3,
      rationale:
        "Recent diagnoses of this page, so the agent does not repeat a conclusion a human already rejected.",
    },
    PREVIOUS_CHANGE: {
      max: 10,
      rationale: "Opportunities and decisions already recorded against this page.",
    },
  },
  rules: [
    "Business Context: the current APPROVED version, never a draft.",
    "GSC and GA4: the last 28 days against the prior 28 days, ending at the latest date with data.",
    "Queries: top by impressions for the target page in the current window.",
    "Keywords: those this page owns, plus their demand and ranking history.",
    "Rankings: the latest snapshot and the one before it, per keyword and provider.",
    "Competitors: observations on keywords this page owns. No unrelated keywords.",
    "Content: the most recent snapshot of the target page only. No other page's text.",
    "Previous diagnoses: this page only, most recent first, excluding superseded ones.",
    "Everything is scoped to this website. Nothing else is reachable.",
  ],
};

export const RETRIEVAL_POLICIES: readonly RetrievalPolicyDefinition[] = [PAGE_DIAGNOSIS_POLICY];

export function findPolicy(name: string, version?: number): RetrievalPolicyDefinition | null {
  const candidates = RETRIEVAL_POLICIES.filter((policy) => policy.name === name);

  if (version !== undefined) {
    return candidates.find((policy) => policy.version === version) ?? null;
  }

  return candidates.reduce<RetrievalPolicyDefinition | null>(
    (latest, policy) => (latest === null || policy.version > latest.version ? policy : latest),
    null,
  );
}
