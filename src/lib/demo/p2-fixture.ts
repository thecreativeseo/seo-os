/**
 * Deterministic P2 demo dataset (docs/P2_SPEC.md §30).
 *
 * Extends the same fictional company the P1 fixture describes — Northwind
 * Analytics, a product-analytics tool — so the investor journey runs P0 context →
 * P1 evidence → P2 opportunity on one site rather than three.
 *
 * Pure: no database, no clock beyond the end date it is given, no Math.random. The
 * same seed always produces the same market, which is what makes a demo
 * repeatable.
 *
 * Two deliberate choices about honesty:
 *
 *   - **Competitors are fictional.** Northwind is invented, and inventing ranking
 *     positions for real companies would mean fabricating claims about real
 *     businesses. A product whose entire thesis is refusing to fabricate should
 *     not do that in its own demo, however clearly the screen is labelled.
 *   - **Stories are shaped into the data, not asserted.** The rules in
 *     lib/opportunity detect them from these numbers exactly as they would from a
 *     real Semrush export. Writing Opportunity rows directly would make the demo
 *     prove nothing about the engine.
 */

function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const P2_SEED = 20260903;
/** Weekly captures across the same window P1 covers. */
export const CAPTURE_WEEKS = 13;

export type DemoTopic = {
  slug: string;
  name: string;
  customerLanguage: string;
  businessOutcome: string;
  /** Page paths from the P1 fixture, by role. */
  pillarPath: string | null;
  commercialPath: string | null;
  supportingPaths: string[];
  priority: number;
};

export const DEMO_TOPICS: DemoTopic[] = [
  {
    slug: "retention-analytics",
    name: "Retention analytics",
    customerLanguage: "working out why people stop using the product",
    businessOutcome: "trial signups from product teams",
    pillarPath: "/blog/what-is-retention",
    commercialPath: "/product/retention-analytics",
    supportingPaths: ["/blog/churn-vs-retention"],
    priority: 5,
  },
  {
    slug: "cohort-analysis",
    name: "Cohort analysis",
    customerLanguage: "comparing groups of users who signed up at different times",
    businessOutcome: "trial signups from analysts",
    pillarPath: "/blog/cohort-analysis-guide",
    commercialPath: "/product/cohort-reports",
    supportingPaths: [],
    priority: 4,
  },
  {
    slug: "product-analytics",
    name: "Product analytics",
    customerLanguage: "seeing what people actually do in the product",
    businessOutcome: "demo requests from heads of product",
    pillarPath: null,
    commercialPath: "/product/product-analytics",
    supportingPaths: ["/blog/activation-metrics"],
    priority: 5,
  },
  {
    slug: "funnel-analysis",
    name: "Funnel analysis",
    customerLanguage: "finding the step where people drop out",
    businessOutcome: "trial signups",
    pillarPath: null,
    commercialPath: "/product/funnel-analysis",
    supportingPaths: [],
    priority: 3,
  },
  {
    slug: "tool-comparisons",
    name: "Tool comparisons",
    customerLanguage: "deciding between analytics tools",
    businessOutcome: "demo requests from teams already shopping",
    pillarPath: null,
    commercialPath: "/compare/mixpanel-alternative",
    supportingPaths: ["/compare/amplitude-alternative", "/compare/posthog-alternative"],
    priority: 4,
  },
  {
    slug: "implementation",
    name: "Implementation",
    customerLanguage: "getting tracking set up without breaking anything",
    businessOutcome: "fewer stalled trials",
    pillarPath: "/docs/install",
    commercialPath: null,
    supportingPaths: ["/docs/events", "/docs/api"],
    priority: 2,
  },
  {
    // Story 6: many keywords, one thin page. Coverage lands on PARTIAL and the
    // topic-gap rule fires from that, rather than the gap being asserted here.
    slug: "activation-onboarding",
    name: "Activation and onboarding",
    customerLanguage: "getting new users to their first real result",
    businessOutcome: "trial-to-paid conversion",
    pillarPath: null,
    commercialPath: null,
    supportingPaths: ["/blog/activation-metrics"],
    priority: 4,
  },
];

export type DemoCompetitor = {
  name: string;
  domain: string;
};

/** Invented, for the reason stated at the top of this file. */
export const DEMO_COMPETITORS: DemoCompetitor[] = [
  { name: "Meridian Metrics", domain: "meridianmetrics.example" },
  { name: "Lumen Analytics", domain: "lumenanalytics.example" },
  { name: "Trackline", domain: "trackline.example" },
  { name: "Pulsegrid", domain: "pulsegrid.example" },
];

export type DemoKeyword = {
  keyword: string;
  topicSlug: string;
  intent: "COMMERCIAL" | "TRANSACTIONAL" | "INFORMATIONAL" | "NAVIGATIONAL";
  volume: number;
  difficulty: number;
  /** Page nominated to own it, if any. */
  ownerPath: string | null;
  /** Page that actually ranks. Differs from the owner in the divergence story. */
  rankingPath: string | null;
  /** Latest position, or null when nothing of ours ranks. */
  position: number | null;
  businessRelevance: number | null;
  commercialValue: number | null;
  /** Competitors ranking above us, by index into DEMO_COMPETITORS. */
  competitorsAhead: number[];
  story?: string;
};

/**
 * Eighty keywords.
 *
 * The seven investor stories are placed first and named, so anyone reading this
 * file can see exactly which rows produce which moment on screen. The rest fill
 * the market out so the queue looks like a real one rather than a demo of seven
 * rows.
 */
export const STORY_KEYWORDS: DemoKeyword[] = [
  {
    // Story 1: a commercial keyword sitting just off page one, on a page that
    // already exists and is nominated to own it.
    keyword: "retention analytics software",
    topicSlug: "retention-analytics",
    intent: "COMMERCIAL",
    volume: 2900,
    difficulty: 46,
    ownerPath: "/product/retention-analytics",
    rankingPath: "/product/retention-analytics",
    position: 11,
    businessRelevance: 5,
    commercialValue: 5,
    competitorsAhead: [0, 1],
    story: "Commercial keyword at position 11 with an owning page",
  },
  {
    // Story 2: the commercial page is nominated, the blog post is what ranks.
    keyword: "cohort analysis tool",
    topicSlug: "cohort-analysis",
    intent: "COMMERCIAL",
    volume: 1600,
    difficulty: 41,
    ownerPath: "/product/cohort-reports",
    rankingPath: "/blog/cohort-analysis-guide",
    position: 9,
    businessRelevance: 5,
    commercialValue: 5,
    competitorsAhead: [1],
    story: "Intended owner differs from the ranking page",
  },
  {
    // Story 3: competitors rank, nothing of ours does.
    keyword: "user journey analytics",
    topicSlug: "product-analytics",
    intent: "COMMERCIAL",
    volume: 3600,
    difficulty: 52,
    ownerPath: null,
    rankingPath: null,
    position: null,
    businessRelevance: 4,
    commercialValue: 4,
    competitorsAhead: [0, 1, 2],
    story: "Competitors rank for a keyword this site does not appear for",
  },
  {
    // Story 5: real demand, nobody has nominated a page.
    keyword: "product analytics for saas",
    topicSlug: "product-analytics",
    intent: "COMMERCIAL",
    volume: 1900,
    difficulty: 44,
    ownerPath: null,
    rankingPath: null,
    position: null,
    businessRelevance: 4,
    commercialValue: 4,
    competitorsAhead: [3],
    story: "Demand with no nominated owning page",
  },
  {
    // Story 7: tied hard to a business goal, which lifts its score visibly.
    keyword: "mixpanel alternative",
    topicSlug: "tool-comparisons",
    intent: "TRANSACTIONAL",
    volume: 4400,
    difficulty: 38,
    ownerPath: "/compare/mixpanel-alternative",
    rankingPath: "/compare/mixpanel-alternative",
    position: 7,
    businessRelevance: 5,
    commercialValue: 5,
    competitorsAhead: [0],
    story: "Strongly aligned with a business goal",
  },
];

const FILLER_TERMS: { term: string; topicSlug: string; intent: DemoKeyword["intent"] }[] = [
  { term: "retention rate calculation", topicSlug: "retention-analytics", intent: "INFORMATIONAL" },
  { term: "customer retention metrics", topicSlug: "retention-analytics", intent: "INFORMATIONAL" },
  { term: "how to reduce churn", topicSlug: "retention-analytics", intent: "INFORMATIONAL" },
  { term: "retention curve", topicSlug: "retention-analytics", intent: "INFORMATIONAL" },
  { term: "n day retention", topicSlug: "retention-analytics", intent: "INFORMATIONAL" },
  { term: "rolling retention", topicSlug: "retention-analytics", intent: "INFORMATIONAL" },
  { term: "retention dashboard", topicSlug: "retention-analytics", intent: "COMMERCIAL" },
  { term: "churn analysis software", topicSlug: "retention-analytics", intent: "COMMERCIAL" },
  { term: "cohort retention chart", topicSlug: "cohort-analysis", intent: "INFORMATIONAL" },
  { term: "how to build a cohort report", topicSlug: "cohort-analysis", intent: "INFORMATIONAL" },
  { term: "weekly cohort analysis", topicSlug: "cohort-analysis", intent: "INFORMATIONAL" },
  { term: "cohort analysis excel", topicSlug: "cohort-analysis", intent: "INFORMATIONAL" },
  { term: "behavioural cohorts", topicSlug: "cohort-analysis", intent: "INFORMATIONAL" },
  { term: "cohort reporting software", topicSlug: "cohort-analysis", intent: "COMMERCIAL" },
  { term: "product analytics platform", topicSlug: "product-analytics", intent: "COMMERCIAL" },
  { term: "product analytics tools", topicSlug: "product-analytics", intent: "COMMERCIAL" },
  { term: "self serve analytics", topicSlug: "product-analytics", intent: "COMMERCIAL" },
  { term: "event tracking analytics", topicSlug: "product-analytics", intent: "INFORMATIONAL" },
  { term: "product metrics framework", topicSlug: "product-analytics", intent: "INFORMATIONAL" },
  { term: "north star metric", topicSlug: "product-analytics", intent: "INFORMATIONAL" },
  { term: "feature adoption tracking", topicSlug: "product-analytics", intent: "COMMERCIAL" },
  { term: "conversion funnel software", topicSlug: "funnel-analysis", intent: "COMMERCIAL" },
  { term: "funnel drop off analysis", topicSlug: "funnel-analysis", intent: "INFORMATIONAL" },
  { term: "multi step funnel tracking", topicSlug: "funnel-analysis", intent: "COMMERCIAL" },
  { term: "signup funnel optimisation", topicSlug: "funnel-analysis", intent: "INFORMATIONAL" },
  { term: "checkout funnel analytics", topicSlug: "funnel-analysis", intent: "COMMERCIAL" },
  { term: "amplitude alternative", topicSlug: "tool-comparisons", intent: "TRANSACTIONAL" },
  { term: "posthog alternative", topicSlug: "tool-comparisons", intent: "TRANSACTIONAL" },
  { term: "heap analytics alternative", topicSlug: "tool-comparisons", intent: "TRANSACTIONAL" },
  { term: "best product analytics tool", topicSlug: "tool-comparisons", intent: "COMMERCIAL" },
  { term: "analytics tool comparison", topicSlug: "tool-comparisons", intent: "COMMERCIAL" },
  { term: "cheapest product analytics", topicSlug: "tool-comparisons", intent: "TRANSACTIONAL" },
  { term: "install analytics sdk", topicSlug: "implementation", intent: "INFORMATIONAL" },
  { term: "javascript event tracking", topicSlug: "implementation", intent: "INFORMATIONAL" },
  { term: "server side event tracking", topicSlug: "implementation", intent: "INFORMATIONAL" },
  { term: "analytics api reference", topicSlug: "implementation", intent: "NAVIGATIONAL" },
  { term: "tracking plan template", topicSlug: "implementation", intent: "INFORMATIONAL" },
  { term: "user activation metrics", topicSlug: "activation-onboarding", intent: "INFORMATIONAL" },
  { term: "activation rate benchmark", topicSlug: "activation-onboarding", intent: "INFORMATIONAL" },
  { term: "time to value saas", topicSlug: "activation-onboarding", intent: "INFORMATIONAL" },
  { term: "user onboarding analytics", topicSlug: "activation-onboarding", intent: "COMMERCIAL" },
  { term: "aha moment analytics", topicSlug: "activation-onboarding", intent: "INFORMATIONAL" },
  { term: "onboarding funnel metrics", topicSlug: "activation-onboarding", intent: "INFORMATIONAL" },
  { term: "activation dashboard", topicSlug: "activation-onboarding", intent: "COMMERCIAL" },
  { term: "trial conversion analytics", topicSlug: "activation-onboarding", intent: "COMMERCIAL" },
];

/** Regional and long-tail variants, generated so the market has depth. */
const MODIFIERS = ["", " software", " tool", " for startups", " guide", " 2026", " comparison"];

export function buildDemoKeywords(): DemoKeyword[] {
  const random = makeRandom(P2_SEED);
  const keywords: DemoKeyword[] = [...STORY_KEYWORDS];

  for (const filler of FILLER_TERMS) {
    const topic = DEMO_TOPICS.find((entry) => entry.slug === filler.topicSlug)!;
    const commercial = filler.intent === "COMMERCIAL" || filler.intent === "TRANSACTIONAL";

    // A ranking exists for roughly two thirds of terms: a real market has plenty
    // a site does not appear for at all.
    const ranks = random() > 0.32;
    const position = ranks ? Math.round(2 + random() * 38) : null;

    // Activation keeps its pages thin on purpose — that is story 6.
    const ownerPath =
      commercial && topic.commercialPath && topic.slug !== "activation-onboarding"
        ? topic.commercialPath
        : null;

    keywords.push({
      keyword: filler.term,
      topicSlug: filler.topicSlug,
      intent: filler.intent,
      volume: Math.round(80 + random() * 3200),
      difficulty: Math.round(15 + random() * 60),
      ownerPath,
      rankingPath: ranks ? (ownerPath ?? topic.pillarPath ?? topic.supportingPaths[0] ?? null) : null,
      position,
      businessRelevance: commercial ? Math.round(2 + random() * 2) : null,
      commercialValue: commercial ? Math.round(2 + random() * 2) : null,
      competitorsAhead: DEMO_COMPETITORS.map((_, index) => index).filter(
        () => random() > 0.62,
      ),
    });
  }

  // Long-tail, to reach eighty.
  const bases = ["retention analytics", "cohort analysis", "product analytics", "funnel analysis"];
  let index = 0;

  while (keywords.length < 80) {
    const base = bases[index % bases.length]!;
    const modifier = MODIFIERS[Math.floor(random() * MODIFIERS.length)]!;
    const term = `${base}${modifier} ${Math.floor(index / bases.length) + 1}`.trim();
    index += 1;

    if (keywords.some((entry) => entry.keyword === term)) continue;

    keywords.push({
      keyword: term,
      topicSlug: base.replace(" ", "-"),
      intent: "INFORMATIONAL",
      volume: Math.round(20 + random() * 400),
      difficulty: Math.round(10 + random() * 40),
      ownerPath: null,
      rankingPath: null,
      position: random() > 0.5 ? Math.round(12 + random() * 40) : null,
      businessRelevance: null,
      commercialValue: null,
      competitorsAhead: [],
    });
  }

  return keywords;
}

export type RankingPoint = {
  weeksAgo: number;
  position: number | null;
  path: string | null;
};

/**
 * A ranking series for one keyword, ending at its stated position.
 *
 * Movement is gentle and mean-reverting rather than random: a real position wanders
 * a few places, and a series that jumps thirty would produce "market movement"
 * entries nobody believes.
 */
export function buildRankingSeries(
  keyword: DemoKeyword,
  seedOffset: number,
): RankingPoint[] {
  if (keyword.position === null) return [];

  const random = makeRandom(P2_SEED + seedOffset);
  const points: RankingPoint[] = [];
  let position = keyword.position;

  for (let weeksAgo = 0; weeksAgo < CAPTURE_WEEKS; weeksAgo += 1) {
    points.push({ weeksAgo, position: Math.round(position), path: keyword.rankingPath });

    // Walking backwards in time, so earlier captures drift away from today's.
    position = Math.max(1, Math.min(80, position + (random() - 0.45) * 4));
  }

  return points;
}

export const DEMO_GOALS = [
  {
    title: "Grow trial signups from organic search",
    seoOutcome: "More organic sessions reaching a signup",
    primaryMetric: "Organic trial signups",
    topicSlugs: ["retention-analytics", "cohort-analysis", "activation-onboarding"],
  },
  {
    title: "Win the comparison searches",
    seoOutcome: "Rank on the first page for alternative and comparison terms",
    primaryMetric: "Demo requests from comparison pages",
    topicSlugs: ["tool-comparisons", "product-analytics"],
  },
];
