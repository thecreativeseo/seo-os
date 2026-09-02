/**
 * Deterministic demo dataset (docs/P1_SPEC.md §24).
 *
 * Pure: no database, no clock beyond the end date it is given, no Math.random.
 * The same seed always produces the same numbers, which is what makes an investor
 * demo repeatable — the decline shown on Tuesday is the same decline on Friday.
 *
 * The stories are shaped into the DATA, not asserted as conclusions. The signal
 * engine in N4 detects them from these numbers exactly as it would from live
 * Search Console data. Writing Signal rows here instead would make the demo prove
 * nothing about the engine.
 */

/** mulberry32 — small, fast, and stable across platforms. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_SEED = 20260902;
export const DEMO_DAYS = 90;
/** Search Console data lags two to three days; the demo reflects that rather than pretending today is available. */
export const DEMO_LAG_DAYS = 3;

export type DemoPage = {
  path: string;
  title: string;
  pageType: "HOME" | "COMMERCIAL" | "BLOG_POST" | "CATEGORY" | "LANDING" | "DOCUMENTATION";
  /** Relative traffic weight before any story is applied. */
  weight: number;
};

export const DEMO_PAGES: DemoPage[] = [
  { path: "/", title: "Northwind Analytics", pageType: "HOME", weight: 10 },
  { path: "/pricing", title: "Pricing", pageType: "COMMERCIAL", weight: 8 },
  { path: "/product/retention-analytics", title: "Retention analytics", pageType: "COMMERCIAL", weight: 9 },
  { path: "/product/funnel-analysis", title: "Funnel analysis", pageType: "COMMERCIAL", weight: 6 },
  { path: "/product/cohort-reports", title: "Cohort reports", pageType: "COMMERCIAL", weight: 5 },
  { path: "/product/product-analytics", title: "Product analytics", pageType: "COMMERCIAL", weight: 7 },
  { path: "/compare/mixpanel-alternative", title: "Mixpanel alternative", pageType: "LANDING", weight: 6 },
  { path: "/compare/amplitude-alternative", title: "Amplitude alternative", pageType: "LANDING", weight: 5 },
  { path: "/compare/posthog-alternative", title: "PostHog alternative", pageType: "LANDING", weight: 4 },
  { path: "/integrations", title: "Integrations", pageType: "CATEGORY", weight: 3 },
  { path: "/integrations/segment", title: "Segment integration", pageType: "DOCUMENTATION", weight: 2 },
  { path: "/integrations/stripe", title: "Stripe integration", pageType: "DOCUMENTATION", weight: 2 },
  { path: "/docs/install", title: "Install the SDK", pageType: "DOCUMENTATION", weight: 4 },
  { path: "/docs/events", title: "Tracking events", pageType: "DOCUMENTATION", weight: 3 },
  { path: "/docs/api", title: "API reference", pageType: "DOCUMENTATION", weight: 2 },
  { path: "/blog", title: "Blog", pageType: "CATEGORY", weight: 3 },
  { path: "/blog/what-is-retention", title: "What is retention?", pageType: "BLOG_POST", weight: 7 },
  { path: "/blog/cohort-analysis-guide", title: "A guide to cohort analysis", pageType: "BLOG_POST", weight: 6 },
  { path: "/blog/activation-metrics", title: "Activation metrics that matter", pageType: "BLOG_POST", weight: 5 },
  { path: "/blog/churn-vs-retention", title: "Churn vs retention", pageType: "BLOG_POST", weight: 5 },
  { path: "/blog/north-star-metric", title: "Choosing a north star metric", pageType: "BLOG_POST", weight: 4 },
  { path: "/blog/product-analytics-stack", title: "Building a product analytics stack", pageType: "BLOG_POST", weight: 4 },
  { path: "/blog/dau-mau-ratio", title: "The DAU/MAU ratio, explained", pageType: "BLOG_POST", weight: 3 },
  { path: "/blog/event-taxonomy", title: "Designing an event taxonomy", pageType: "BLOG_POST", weight: 3 },
  { path: "/blog/self-serve-onboarding", title: "Self-serve onboarding metrics", pageType: "BLOG_POST", weight: 3 },
  { path: "/customers", title: "Customers", pageType: "CATEGORY", weight: 2 },
  { path: "/about", title: "About", pageType: "LANDING", weight: 2 },
  { path: "/security", title: "Security", pageType: "LANDING", weight: 2 },
  { path: "/changelog", title: "Changelog", pageType: "CATEGORY", weight: 1 },
  { path: "/trial", title: "Start a trial", pageType: "COMMERCIAL", weight: 4 },
];

/**
 * The demo stories, from the blueprint. Each is a multiplier applied to the
 * CURRENT 28-day window only, so a period comparison surfaces it.
 */
export type DemoStory = {
  path: string;
  kind: "decline" | "winner" | "ctr_opportunity" | "conversion_decline";
  /** Applied to clicks in the current window. */
  clickMultiplier: number;
  /** Applied to impressions in the current window. */
  impressionMultiplier: number;
  /** Applied to GA4 key events in the current window. */
  keyEventMultiplier: number;
};

export const DEMO_STORIES: DemoStory[] = [
  // One meaningful traffic decline — the blueprint's headline example.
  {
    path: "/product/retention-analytics",
    kind: "decline",
    clickMultiplier: 0.742,
    impressionMultiplier: 0.95,
    keyEventMultiplier: 0.8,
  },
  // One strong winner.
  {
    path: "/compare/mixpanel-alternative",
    kind: "winner",
    clickMultiplier: 1.32,
    impressionMultiplier: 1.28,
    keyEventMultiplier: 1.25,
  },
  // Two CTR opportunities: impressions climb, clicks do not follow.
  {
    path: "/blog/what-is-retention",
    kind: "ctr_opportunity",
    clickMultiplier: 1.02,
    impressionMultiplier: 1.85,
    keyEventMultiplier: 1,
  },
  {
    path: "/blog/cohort-analysis-guide",
    kind: "ctr_opportunity",
    clickMultiplier: 0.98,
    impressionMultiplier: 1.7,
    keyEventMultiplier: 1,
  },
  // One conversion decline with search traffic broadly flat, so the change is
  // visibly on the analytics side rather than the search side.
  {
    path: "/pricing",
    kind: "conversion_decline",
    clickMultiplier: 1.01,
    impressionMultiplier: 1.03,
    keyEventMultiplier: 0.68,
  },
];

/** Queries whose position sits in the 8–20 band with real impression volume. */
export const STRIKING_DISTANCE_QUERIES = [
  "product analytics for saas",
  "retention analytics tool",
  "cohort analysis software",
];

const QUERY_HEADS = [
  "product analytics",
  "retention analytics",
  "cohort analysis",
  "funnel analysis",
  "user retention",
  "churn analysis",
  "activation metrics",
  "north star metric",
  "event tracking",
  "dau mau ratio",
  "self serve analytics",
  "saas analytics",
];

const QUERY_MODIFIERS = [
  "",
  " tool",
  " software",
  " platform",
  " for saas",
  " for startups",
  " guide",
  " example",
  " vs mixpanel",
  " vs amplitude",
  " pricing",
  " tutorial",
  " best practices",
  " uk",
  " open source",
  " definition",
  " dashboard",
];

export type DemoQuery = {
  query: string;
  path: string;
  /** Baseline daily impressions before seasonality and noise. */
  baseImpressions: number;
  /** Average position, held roughly stable across the window. */
  position: number;
  /** Baseline click-through rate for this query's position band. */
  baseCtr: number;
};

/**
 * Builds the query set. Each query belongs to one page, so clicks roll up to a
 * page total that a person can check by hand.
 */
export function buildDemoQueries(): DemoQuery[] {
  const random = makeRandom(DEMO_SEED);
  const queries: DemoQuery[] = [];
  const seen = new Set<string>();

  for (const head of QUERY_HEADS) {
    for (const modifier of QUERY_MODIFIERS) {
      const query = `${head}${modifier}`.trim();
      if (seen.has(query)) continue;
      seen.add(query);

      // Longer queries are rarer and rank better; head terms are competitive.
      const words = query.split(" ").length;
      const striking = STRIKING_DISTANCE_QUERIES.includes(query);

      const position = striking
        ? 8 + random() * 11 // squarely inside the striking-distance band
        : words <= 2
          ? 4 + random() * 22
          : 2 + random() * 14;

      const baseImpressions = striking
        ? 120 + Math.floor(random() * 260)
        : Math.max(3, Math.floor((40 / words) * (1 + random() * 6)));

      // CTR falls off sharply with position. This is a plausible curve, not a
      // measured one, and it exists only to make the demo internally consistent.
      const baseCtr = Math.max(0.004, 0.31 * Math.exp(-0.28 * (position - 1)));

      queries.push({
        query,
        path: pickPathForQuery(query, random),
        baseImpressions,
        position: Math.round(position * 10) / 10,
        baseCtr,
      });
    }
  }

  return queries;
}

function pickPathForQuery(query: string, random: () => number): string {
  if (query.includes("mixpanel")) return "/compare/mixpanel-alternative";
  if (query.includes("amplitude")) return "/compare/amplitude-alternative";
  if (query.includes("pricing")) return "/pricing";
  if (query.includes("retention analytics")) return "/product/retention-analytics";
  if (query.includes("cohort analysis")) return "/blog/cohort-analysis-guide";
  if (query.includes("funnel")) return "/product/funnel-analysis";
  if (query.includes("churn")) return "/blog/churn-vs-retention";
  if (query.includes("activation")) return "/blog/activation-metrics";
  if (query.includes("north star")) return "/blog/north-star-metric";
  if (query.includes("dau")) return "/blog/dau-mau-ratio";
  if (query.includes("event tracking")) return "/docs/events";
  if (query.includes("user retention")) return "/blog/what-is-retention";
  if (query.includes("product analytics")) return "/product/product-analytics";

  const candidates = DEMO_PAGES.filter((page) => page.pageType !== "HOME");
  return candidates[Math.floor(random() * candidates.length)]!.path;
}

export type GscFixtureRow = {
  date: string; // YYYY-MM-DD
  path: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
};

export type Ga4FixtureRow = {
  date: string;
  path: string;
  sessions: number;
  engagedSessions: number;
  users: number;
  newUsers: number;
  keyEvents: number;
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Weekday seasonality: B2B search is quieter at weekends. */
function seasonality(date: Date): number {
  const day = date.getUTCDay();
  if (day === 0) return 0.62;
  if (day === 6) return 0.68;
  if (day === 1) return 1.08;
  return 1;
}

/**
 * Generates the full fixture.
 *
 * `endDate` is the most recent day WITH data, which is deliberately not today —
 * Search Console lags, and a demo that claimed same-day data would be teaching
 * the viewer something false about how the product behaves.
 */
export function buildDemoFixture(endDate: Date): {
  gsc: GscFixtureRow[];
  ga4: Ga4FixtureRow[];
  currentPeriodStart: string;
  currentPeriodEnd: string;
  previousPeriodStart: string;
  previousPeriodEnd: string;
} {
  const random = makeRandom(DEMO_SEED + 1);
  const queries = buildDemoQueries();
  const storyByPath = new Map(DEMO_STORIES.map((story) => [story.path, story]));
  const weightByPath = new Map(DEMO_PAGES.map((page) => [page.path, page.weight]));

  const days: Date[] = [];
  for (let offset = DEMO_DAYS - 1; offset >= 0; offset -= 1) {
    const day = new Date(endDate);
    day.setUTCDate(day.getUTCDate() - offset);
    days.push(day);
  }

  // The current window is the most recent 28 days; the comparison window is the 28
  // before it. This is the spec's default comparison.
  const currentStart = days[days.length - 28]!;
  const previousEnd = days[days.length - 29]!;
  const previousStart = days[days.length - 56]!;

  const gsc: GscFixtureRow[] = [];
  const ga4: Ga4FixtureRow[] = [];
  const sessionsByPathDate = new Map<string, number>();

  for (const day of days) {
    const inCurrent = day >= currentStart;
    const season = seasonality(day);

    for (const query of queries) {
      // Not every query appears every day; rare ones are intermittent, exactly as
      // Search Console reports them.
      if (query.baseImpressions < 8 && random() > 0.55) continue;

      const story = storyByPath.get(query.path);
      const pageWeight = (weightByPath.get(query.path) ?? 3) / 5;

      const impressionMultiplier = inCurrent ? (story?.impressionMultiplier ?? 1) : 1;
      const clickMultiplier = inCurrent ? (story?.clickMultiplier ?? 1) : 1;

      const noise = 0.82 + random() * 0.36;

      // Clicks are anchored to the pre-story baseline, not to the multiplied
      // impressions. Extra impressions generally arrive at weaker positions and do
      // not convert at the same rate — which is what a CTR opportunity IS. Deriving
      // clicks from the raised impressions would make CTR constant by construction
      // and the story impossible to detect.
      const baseline = Math.max(1, query.baseImpressions * pageWeight * season * noise);
      const impressions = Math.max(1, Math.round(baseline * impressionMultiplier));

      const ctrNoise = 0.9 + random() * 0.2;
      const clicks = Math.min(
        impressions,
        Math.round(baseline * query.baseCtr * ctrNoise * clickMultiplier),
      );

      const position = Math.round((query.position + (random() - 0.5) * 1.6) * 10) / 10;

      gsc.push({
        date: isoDate(day),
        path: query.path,
        query: query.query,
        clicks,
        impressions,
        position: Math.max(1, position),
      });

      const key = `${isoDate(day)}|${query.path}`;
      sessionsByPathDate.set(key, (sessionsByPathDate.get(key) ?? 0) + clicks);
    }
  }

  // GA4 sessions exceed organic clicks: a landing page also receives direct and
  // referral traffic. The demo keeps the two sources visibly distinct rather than
  // implying analytics simply mirrors search.
  for (const day of days) {
    const inCurrent = day >= currentStart;

    for (const page of DEMO_PAGES) {
      const key = `${isoDate(day)}|${page.path}`;
      const organic = sessionsByPathDate.get(key) ?? 0;
      if (organic === 0 && page.weight < 3) continue;

      const story = storyByPath.get(page.path);
      const nonOrganic = Math.round(page.weight * (0.6 + random() * 1.4));
      const sessions = organic + nonOrganic;
      if (sessions === 0) continue;

      const engagedSessions = Math.round(sessions * (0.52 + random() * 0.2));
      const users = Math.round(sessions * (0.86 + random() * 0.1));
      const newUsers = Math.round(users * (0.55 + random() * 0.2));

      // Only commercial and trial pages record key events. A blog post that never
      // converts reports zero, which is a measured zero rather than a missing one.
      const converts =
        page.pageType === "COMMERCIAL" || page.path === "/trial" || page.path === "/";
      const keyEventMultiplier = inCurrent ? (story?.keyEventMultiplier ?? 1) : 1;
      const keyEvents = converts
        ? Math.round(sessions * (0.03 + random() * 0.03) * keyEventMultiplier)
        : 0;

      ga4.push({
        date: isoDate(day),
        path: page.path,
        sessions,
        engagedSessions,
        users,
        newUsers,
        keyEvents,
      });
    }
  }

  return {
    gsc,
    ga4,
    currentPeriodStart: isoDate(currentStart),
    currentPeriodEnd: isoDate(endDate),
    previousPeriodStart: isoDate(previousStart),
    previousPeriodEnd: isoDate(previousEnd),
  };
}

/** The most recent day the demo has data for, given a "today". */
export function demoEndDate(today: Date): Date {
  const end = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  end.setUTCDate(end.getUTCDate() - DEMO_LAG_DAYS);
  return end;
}
