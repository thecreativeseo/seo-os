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

/**
 * What a content brief may be built from (docs/P4_SPEC.md §8).
 *
 * Governance first and in full - the approved context, the goals, every
 * approved fact and every active rule - because a brief is mostly a statement
 * of constraints. Then what the work is about: the keyword and its demand,
 * who owns it, the topic, the target page and what it says today, and the
 * diagnosis and decision the recommendation came from. Measurements are kept
 * small: a brief is not a diagnosis, and the diagnosis it rests on already
 * read them.
 */
export const CONTENT_BRIEF_POLICY: RetrievalPolicyDefinition = {
  name: "content-brief",
  version: 1,
  description:
    "Evidence gathered for briefing one piece of content work: the approved context, " +
    "facts and rules it must respect, the keyword and topic it serves, the page it " +
    "changes or joins, and the diagnosis and decision that asked for it.",
  windowDays: 28,
  maxEvidence: 90,
  maxContentChars: 6_000,
  budgets: {
    BUSINESS_CONTEXT: {
      max: 1,
      rationale: "The current approved version only. Superseded context is not evidence.",
    },
    BUSINESS_GOAL: {
      max: 5,
      rationale: "Active goals, so the brief can say what the piece is for.",
    },
    BRAND_FACT: {
      max: 20,
      rationale: "Every approved fact: the only sources a claim in the piece may rest on.",
    },
    SEO_RULE: {
      max: 15,
      rationale: "Every active rule. A brief that omits one invites a QA block.",
    },
    KEYWORD_METRIC: { max: 10, rationale: "Demand for the primary keyword and its neighbours." },
    RANKING_SNAPSHOT: { max: 6, rationale: "Where the target page stands today on its keywords." },
    KEYWORD_OWNERSHIP: {
      max: 12,
      rationale: "Which pages own which keywords: the target, and the pages a link can point at.",
    },
    TOPIC_MAPPING: { max: 6, rationale: "The topic this piece belongs to and its neighbours." },
    GSC_METRIC: {
      max: 4,
      rationale: "Page totals for both windows, so a refresh knows its baseline.",
    },
    COMPETITOR_OBSERVATION: {
      max: 6,
      rationale: "Who else ranks for the primary keyword. Overlap only.",
    },
    PAGE_CONTENT: {
      max: 1,
      rationale: "What the target page says now, so a refresh changes it rather than restarts it.",
    },
    PREVIOUS_DIAGNOSIS: {
      max: 1,
      rationale: "The diagnosis the recommendation came from: the findings the brief answers.",
    },
    PREVIOUS_CHANGE: {
      max: 4,
      rationale:
        "The opportunity and the decision behind this work, so the brief knows what was approved.",
    },
  },
  rules: [
    "Business Context: the current APPROVED version, never a draft; its prohibited claims and avoid-topics are canonical.",
    "Brand Facts: APPROVED only. A proposed or rejected fact is not a fact the piece may use.",
    "SEO Rules: every active rule, BLOCKING first.",
    "Keyword: the work item's keyword, its latest demand snapshot per provider, and the pages that own it.",
    "Topic: the work item's topic and the keywords mapped to it.",
    "Page: the target page's latest content snapshot, its ownership records, and its last two measurement windows.",
    "History: the diagnosis, opportunity and decision this work item was started from.",
    "Everything is scoped to this website. Nothing else is reachable.",
  ],
};

/**
 * What a draft may be written from (docs/P4_SPEC.md §11; M4 plan, D-M4-2).
 *
 * Truth as of now, in full: the approved context, every approved fact, every
 * active rule. The brief carries the piece's purpose and structure and is
 * pinned by id; this package decides which of the brief's claims are still
 * usable. Then the material: the target page as it stands, the pages the
 * brief named as link targets, the keyword and its demand. Nothing else - a
 * draft does not re-diagnose.
 */
export const CONTENT_DRAFT_POLICY: RetrievalPolicyDefinition = {
  name: "content-draft",
  version: 1,
  description:
    "Evidence gathered for writing one draft: the approved context, every approved " +
    "fact and active rule as of now, the target page as it stands, the pages the " +
    "brief links to, and the keyword the piece serves.",
  windowDays: 28,
  maxEvidence: 80,
  maxContentChars: 12_000,
  budgets: {
    BUSINESS_CONTEXT: {
      max: 1,
      rationale: "The current approved version only; its voice, claims and prohibitions.",
    },
    BUSINESS_GOAL: { max: 3, rationale: "What the piece is for." },
    BRAND_FACT: {
      max: 25,
      rationale: "Every approved fact: the only claims the draft may make.",
    },
    SEO_RULE: {
      max: 15,
      rationale: "Every active rule, so the draft is held to what applies now.",
    },
    PAGE_CONTENT: {
      max: 1,
      rationale:
        "The target page as it stands, in full, so a refresh changes it rather than restarts it.",
    },
    KEYWORD_OWNERSHIP: {
      max: 12,
      rationale: "The target page's keywords and the pages the brief links to, by path.",
    },
    KEYWORD_METRIC: {
      max: 5,
      rationale: "Demand for the primary keyword, for emphasis not figures.",
    },
    TOPIC_MAPPING: { max: 3, rationale: "The topic, for context." },
  },
  rules: [
    "Business Context: the current APPROVED version, never a draft.",
    "Brand Facts: APPROVED only, as of drafting time. A fact revoked since the brief was approved is absent, and the brief's claim on it is stale.",
    "SEO Rules: every active rule as of drafting time.",
    "Page: the target page's latest content snapshot, in full up to the character cap.",
    "Links: ownership records for the pages the brief named as targets, so each has a path and an ID.",
    "Everything is scoped to this website. Nothing else is reachable.",
  ],
};

export const RETRIEVAL_POLICIES: readonly RetrievalPolicyDefinition[] = [
  PAGE_DIAGNOSIS_POLICY,
  CONTENT_BRIEF_POLICY,
  CONTENT_DRAFT_POLICY,
];

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
