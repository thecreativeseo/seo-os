import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../src/generated/prisma/client";
import {
  CAPTURE_WEEKS,
  DEMO_COMPETITORS,
  DEMO_GOALS,
  DEMO_TOPICS,
  buildDemoKeywords,
  buildRankingSeries,
} from "../src/lib/demo/p2-fixture";
import { normalizeKeyword } from "../src/lib/keyword/normalize-keyword";
import { slugify } from "../src/lib/topic/slug";

/**
 * P2 demo data — SYNTHETIC, isolated, idempotent.
 *
 * Loads keywords, topics, competitors and market snapshots into the same demo
 * website P0 and P1 use, so the investor journey runs on one site.
 *
 * Idempotent by construction: every write is an upsert on the same identity the
 * application uses, so running this twice produces the same database rather than
 * two of everything. That is not a convenience — a demo that drifts each time it
 * is prepared is a demo that will surprise somebody on stage.
 *
 * Deliberately does NOT write Opportunity rows. The rules detect them from this
 * data exactly as they would from a real Semrush export; seeding opportunities
 * directly would make the demo prove nothing about the engine. Run detection from
 * the Opportunity Queue afterwards, or call detectAndStoreOpportunities.
 *
 * Run: npm run db:seed:demo:p2
 */

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DIRECT_URL (or DATABASE_URL) must be set.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const DEMO_ORG_SLUG = "seo-os-demo";
const PROTECTED_DOMAINS = ["thecreativeseo.com"];

/** Weekly captures, ending on the most recent Monday before the reporting lag. */
function captureDate(weeksAgo: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - 3 - weeksAgo * 7);
  return date;
}

async function main(): Promise<void> {
  const website = await prisma.website.findFirst({
    where: { workspace: { organization: { slug: DEMO_ORG_SLUG } } },
    include: { workspace: { include: { organization: true } } },
  });

  if (!website) {
    throw new Error(
      "The demo website does not exist yet. Run `npm run db:seed:demo` first.",
    );
  }

  // The guard that matters. Synthetic market data must never reach a real site,
  // and the check is on the domain rather than on a flag somebody could flip.
  if (PROTECTED_DOMAINS.includes(website.normalizedDomain)) {
    throw new Error(
      `Refusing to write synthetic market data into ${website.normalizedDomain}: it is a real website.`,
    );
  }

  if (!website.isDemo) {
    throw new Error(
      `${website.normalizedDomain} is not flagged as a demo website. Refusing to write synthetic market data.`,
    );
  }

  console.log(`Seeding P2 demo data into ${website.normalizedDomain}`);

  const pages = await prisma.page.findMany({
    where: { websiteId: website.id },
    select: { id: true, path: true },
  });
  const pageByPath = new Map(pages.map((page) => [page.path, page.id]));

  if (pages.length === 0) {
    throw new Error("No pages found. Run `npm run db:seed:demo:p1` first.");
  }

  /* ---- Business goals ------------------------------------------------- */

  const goalIdBySlug = new Map<string, string>();

  for (const goal of DEMO_GOALS) {
    const existing = await prisma.businessGoal.findFirst({
      where: { websiteId: website.id, title: goal.title },
    });

    const stored =
      existing ??
      (await prisma.businessGoal.create({
        data: {
          websiteId: website.id,
          title: goal.title,
          seoOutcome: goal.seoOutcome,
          primaryMetric: goal.primaryMetric,
          status: "ACTIVE",
        },
      }));

    for (const slug of goal.topicSlugs) goalIdBySlug.set(slug, stored.id);
  }

  /* ---- Topics --------------------------------------------------------- */

  const topicIdBySlug = new Map<string, string>();

  for (const topic of DEMO_TOPICS) {
    const stored = await prisma.topic.upsert({
      where: { websiteId_slug: { websiteId: website.id, slug: slugify(topic.name) } },
      update: {
        name: topic.name,
        customerLanguage: topic.customerLanguage,
        businessOutcome: topic.businessOutcome,
        priority: topic.priority,
        pillarPageId: topic.pillarPath ? (pageByPath.get(topic.pillarPath) ?? null) : null,
        commercialDestinationPageId: topic.commercialPath
          ? (pageByPath.get(topic.commercialPath) ?? null)
          : null,
        businessGoalId: goalIdBySlug.get(topic.slug) ?? null,
      },
      create: {
        websiteId: website.id,
        name: topic.name,
        slug: slugify(topic.name),
        customerLanguage: topic.customerLanguage,
        businessOutcome: topic.businessOutcome,
        priority: topic.priority,
        pillarPageId: topic.pillarPath ? (pageByPath.get(topic.pillarPath) ?? null) : null,
        commercialDestinationPageId: topic.commercialPath
          ? (pageByPath.get(topic.commercialPath) ?? null)
          : null,
        businessGoalId: goalIdBySlug.get(topic.slug) ?? null,
      },
    });

    topicIdBySlug.set(topic.slug, stored.id);

    const rolePaths: readonly (readonly [
      string,
      "PILLAR" | "COMMERCIAL" | "SUPPORTING",
    ])[] = [
      ...(topic.pillarPath ? ([[topic.pillarPath, "PILLAR"]] as const) : []),
      ...(topic.commercialPath ? ([[topic.commercialPath, "COMMERCIAL"]] as const) : []),
      ...topic.supportingPaths.map((path) => [path, "SUPPORTING"] as const),
    ];

    for (const [path, role] of rolePaths) {
      const pageId = pageByPath.get(path);
      if (!pageId) continue;

      await prisma.topicPage.upsert({
        where: { topicId_pageId: { topicId: stored.id, pageId } },
        update: { role },
        create: { topicId: stored.id, pageId, role },
      });
    }
  }

  console.log(`  ${DEMO_TOPICS.length} topics`);

  /* ---- Competitors ---------------------------------------------------- */

  const competitorIds: string[] = [];

  for (const competitor of DEMO_COMPETITORS) {
    const existing = await prisma.competitor.findFirst({
      where: { websiteId: website.id, normalizedDomain: competitor.domain },
    });

    const stored =
      existing ??
      (await prisma.competitor.create({
        data: {
          websiteId: website.id,
          name: competitor.name,
          domain: competitor.domain,
          normalizedDomain: competitor.domain,
          type: "DIRECT",
        },
      }));

    competitorIds.push(stored.id);
  }

  console.log(`  ${competitorIds.length} competitors`);

  /* ---- Keywords, snapshots, ownership --------------------------------- */

  const keywords = buildDemoKeywords();
  // Counted, not assumed. The first version of this logged the fixture length and
  // reported "80 keywords" while writing none of them — a seed that claims
  // success it did not have is the exact failure that surprises somebody on stage.
  let keywordsWritten = 0;
  let skipped = 0;
  let ownerships = 0;
  let rankings = 0;
  let competitorRows = 0;

  for (const [index, fixture] of keywords.entries()) {
    const normalized = normalizeKeyword(fixture.keyword, {
      language: website.primaryLanguage,
      market: website.primaryMarket,
    });

    if (!normalized.ok) {
      skipped += 1;
      continue;
    }

    keywordsWritten += 1;

    const identity = {
      websiteId: website.id,
      normalizedKeyword: normalized.value.normalized,
      locale: normalized.value.locale,
      language: normalized.value.language,
      market: normalized.value.market,
    };

    const keyword = await prisma.keyword.upsert({
      where: { websiteId_normalizedKeyword_locale_language_market: identity },
      update: {
        intent: fixture.intent,
        intentProvenance: "PROVIDER_PROVIDED",
        businessRelevance: fixture.businessRelevance,
        commercialValue: fixture.commercialValue,
        businessGoalId: goalIdBySlug.get(fixture.topicSlug) ?? null,
      },
      create: {
        ...identity,
        keyword: fixture.keyword,
        intent: fixture.intent,
        intentProvenance: "PROVIDER_PROVIDED",
        businessRelevance: fixture.businessRelevance,
        commercialValue: fixture.commercialValue,
        businessGoalId: goalIdBySlug.get(fixture.topicSlug) ?? null,
      },
    });

    const topicId = topicIdBySlug.get(fixture.topicSlug);
    if (topicId) {
      await prisma.topicKeyword.upsert({
        where: { topicId_keywordId: { topicId, keywordId: keyword.id } },
        update: {},
        create: { topicId, keywordId: keyword.id },
      });
    }

    // Metric snapshots, weekly. Volume drifts slightly so history is not flat.
    for (let weeksAgo = 0; weeksAgo < CAPTURE_WEEKS; weeksAgo += 1) {
      const capturedAt = captureDate(weeksAgo);
      const drift = 1 - weeksAgo * 0.01;

      await prisma.keywordMetricsSnapshot.upsert({
        where: {
          keywordId_capturedAt_sourceProvider: {
            keywordId: keyword.id,
            capturedAt,
            sourceProvider: "SEMRUSH",
          },
        },
        update: {},
        create: {
          websiteId: website.id,
          keywordId: keyword.id,
          capturedAt,
          searchVolume: Math.max(10, Math.round(fixture.volume * drift)),
          keywordDifficulty: fixture.difficulty,
          sourceProvider: "SEMRUSH",
        },
      });
    }

    // Ownership: a nomination somebody made, distinct from what ranks.
    if (fixture.ownerPath) {
      const pageId = pageByPath.get(fixture.ownerPath);

      if (pageId) {
        const existing = await prisma.keywordPageOwnership.findFirst({
          where: {
            keywordId: keyword.id,
            ownershipType: "PRIMARY",
            status: "ACTIVE",
          },
        });

        if (!existing) {
          await prisma.keywordPageOwnership.create({
            data: {
              websiteId: website.id,
              keywordId: keyword.id,
              pageId,
              ownershipType: "PRIMARY",
              status: "ACTIVE",
              market: normalized.value.market,
              language: normalized.value.language,
              locale: normalized.value.locale,
            },
          });
          ownerships += 1;
        }
      }
    }

    for (const point of buildRankingSeries(fixture, index)) {
      const capturedAt = captureDate(point.weeksAgo);

      await prisma.rankingSnapshot.upsert({
        where: {
          keywordId_capturedAt_sourceProvider: {
            keywordId: keyword.id,
            capturedAt,
            sourceProvider: "SEMRUSH",
          },
        },
        update: {},
        create: {
          websiteId: website.id,
          keywordId: keyword.id,
          pageId: point.path ? (pageByPath.get(point.path) ?? null) : null,
          capturedAt,
          position: point.position,
          rankingUrl: point.path
            ? `https://${website.normalizedDomain}${point.path}`
            : null,
          sourceProvider: "SEMRUSH",
        },
      });
      rankings += 1;
    }

    for (const competitorIndex of fixture.competitorsAhead) {
      const competitorId = competitorIds[competitorIndex];
      if (!competitorId) continue;

      const capturedAt = captureDate(0);

      await prisma.competitorKeywordSnapshot.upsert({
        where: {
          competitorId_keywordId_capturedAt_sourceProvider: {
            competitorId,
            keywordId: keyword.id,
            capturedAt,
            sourceProvider: "SEMRUSH",
          },
        },
        update: {},
        create: {
          websiteId: website.id,
          competitorId,
          keywordId: keyword.id,
          capturedAt,
          // Above ours where one exists, so the gap is real rather than asserted.
          position: Math.max(1, (fixture.position ?? 12) - 2 - competitorIndex),
          rankingUrl: `https://${DEMO_COMPETITORS[competitorIndex]!.domain}/`,
          sourceProvider: "SEMRUSH",
        },
      });
      competitorRows += 1;
    }
  }

  console.log(
    `  ${keywordsWritten} keywords${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
  );
  console.log(`  ${ownerships} ownership nominations`);
  console.log(`  ${rankings} ranking snapshots`);
  console.log(`  ${competitorRows} competitor snapshots`);

  if (keywordsWritten === 0) {
    throw new Error("No keywords were written. The demo would be empty.");
  }
  console.log(
    "\nRun Find opportunities on the Opportunity Queue to detect from this data.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
