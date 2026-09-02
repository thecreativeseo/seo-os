import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../src/generated/prisma/client";
import {
  DEMO_PAGES,
  buildDemoFixture,
  demoEndDate,
} from "../src/lib/demo/fixture";
import { normalizeUrl } from "../src/lib/url/normalize-url";
import { normalizeQuery } from "../src/lib/query/normalize-query";

/**
 * P1 demo data — SYNTHETIC, isolated, idempotent.
 *
 * Loads the deterministic fixture into the existing demo website. Deviation worth
 * naming: P1_SPEC §5 names a new tenant (Demo Organization / Investor Demo /
 * demo.example), but P0 already seeded a labelled demo workspace, and the
 * blueprint's journey runs "P0 Business Context → P1 Command Center" on ONE site.
 * Two demo tenants would break that narrative. The isolation guarantees are
 * identical: a dedicated organization, a workspace named Demo Workspace, a
 * fictional company, an explicit isDemo flag, and a refusal to touch a real site.
 *
 * Run: npm run db:seed:demo:p1
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

/** Batch size for createMany; keeps a single statement well inside limits. */
const BATCH = 2000;

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

  if (PROTECTED_DOMAINS.includes(website.normalizedDomain)) {
    throw new Error(
      `Refusing to write synthetic metrics into ${website.normalizedDomain}: it is a real website.`,
    );
  }

  await prisma.website.update({
    where: { id: website.id },
    data: { isDemo: true },
  });

  const endDate = demoEndDate(new Date());
  const fixture = buildDemoFixture(endDate);

  // Demo connections. Status is CONNECTED because the demo is meant to show the
  // connected state, and the property name says plainly that it is synthetic — the
  // interface also carries a persistent DEMO DATA badge for this website.
  const gsc = await upsertDemoConnection(
    website.id,
    website.workspaceId,
    "GOOGLE_SEARCH_CONSOLE",
    "Demo property (synthetic data)",
    endDate,
  );
  const ga4 = await upsertDemoConnection(
    website.id,
    website.workspaceId,
    "GOOGLE_ANALYTICS",
    "Demo property (synthetic data)",
    endDate,
  );

  // Replace previous demo metrics so re-running is idempotent rather than additive.
  await prisma.$transaction([
    prisma.signalEvidence.deleteMany({ where: { signal: { websiteId: website.id } } }),
    prisma.signal.deleteMany({ where: { websiteId: website.id } }),
    prisma.gscMetricDaily.deleteMany({ where: { websiteId: website.id } }),
    prisma.ga4LandingPageMetricDaily.deleteMany({ where: { websiteId: website.id } }),
    prisma.page.deleteMany({ where: { websiteId: website.id } }),
    prisma.query.deleteMany({ where: { websiteId: website.id } }),
    prisma.sourceSnapshot.deleteMany({ where: { websiteId: website.id } }),
    prisma.syncRun.deleteMany({ where: { websiteId: website.id } }),
  ]);

  const snapshot = await prisma.sourceSnapshot.create({
    data: {
      websiteId: website.id,
      connectionId: gsc.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      periodStart: new Date(fixture.previousPeriodStart),
      periodEnd: new Date(fixture.currentPeriodEnd),
      // No object storage in P1: the pointer stays null rather than naming a
      // location that does not exist.
      objectStorageKey: null,
      checksum: null,
      metadataJson: {
        origin: "demo-fixture",
        synthetic: true,
        rows: fixture.gsc.length,
        note: "Generated locally from a fixed seed. Not from Google.",
      },
    },
  });

  // Pages
  const pageIdByPath = new Map<string, string>();
  for (const page of DEMO_PAGES) {
    const url = normalizeUrl(page.path, website.normalizedDomain);
    if (!url.ok) throw new Error(`Demo page path failed normalization: ${page.path}`);

    const created = await prisma.page.create({
      data: {
        websiteId: website.id,
        url: url.value.normalized,
        normalizedUrl: url.value.normalized,
        path: url.value.path,
        hostname: url.value.hostname,
        protocol: url.value.protocol,
        pageType: page.pageType,
        sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
        sitemapPresent: true,
        firstSeenAt: new Date(fixture.previousPeriodStart),
        lastSeenAt: new Date(fixture.currentPeriodEnd),
      },
    });
    pageIdByPath.set(page.path, created.id);
  }

  // Queries
  const queryIdByText = new Map<string, string>();
  const uniqueQueries = [...new Set(fixture.gsc.map((row) => row.query))];
  for (const text of uniqueQueries) {
    const normalized = normalizeQuery(text);
    if (!normalized.ok) continue;

    const created = await prisma.query.create({
      data: {
        websiteId: website.id,
        query: text,
        normalizedQuery: normalized.normalized,
        firstSeenAt: new Date(fixture.previousPeriodStart),
        lastSeenAt: new Date(fixture.currentPeriodEnd),
      },
    });
    queryIdByText.set(text, created.id);
  }

  // GSC metrics
  const gscRows = fixture.gsc.flatMap((row) => {
    const pageId = pageIdByPath.get(row.path);
    const queryId = queryIdByText.get(row.query);
    if (!pageId || !queryId) return [];

    return [
      {
        websiteId: website.id,
        pageId,
        queryId,
        date: new Date(row.date),
        clicks: row.clicks,
        impressions: row.impressions,
        // Stored as reported. Aggregation never averages these.
        ctr: row.impressions === 0 ? null : row.clicks / row.impressions,
        position: row.position,
        sourceConnectionId: gsc.id,
        sourceSnapshotId: snapshot.id,
      },
    ];
  });

  for (let index = 0; index < gscRows.length; index += BATCH) {
    await prisma.gscMetricDaily.createMany({ data: gscRows.slice(index, index + BATCH) });
  }

  // GA4 metrics
  const ga4Rows = fixture.ga4.flatMap((row) => {
    const pageId = pageIdByPath.get(row.path);
    if (!pageId) return [];

    return [
      {
        websiteId: website.id,
        pageId,
        date: new Date(row.date),
        sessions: row.sessions,
        engagedSessions: row.engagedSessions,
        users: row.users,
        newUsers: row.newUsers,
        keyEvents: row.keyEvents,
        // The demo property does not measure legacy conversions or revenue, so both
        // stay null. A zero here would be indistinguishable from a measured zero.
        conversions: null,
        revenue: null,
        sourceConnectionId: ga4.id,
        sourceSnapshotId: null,
      },
    ];
  });

  for (let index = 0; index < ga4Rows.length; index += BATCH) {
    await prisma.ga4LandingPageMetricDaily.createMany({
      data: ga4Rows.slice(index, index + BATCH),
    });
  }

  // A succeeded sync run for each provider, so Data Health has something true to
  // show. Only a SUCCEEDED run may advance freshness.
  for (const connection of [gsc, ga4]) {
    await prisma.syncRun.create({
      data: {
        websiteId: website.id,
        connectionId: connection.id,
        provider: connection.provider,
        syncType:
          connection.provider === "GOOGLE_SEARCH_CONSOLE" ? "GSC_METRICS" : "GA4_METRICS",
        status: "SUCCEEDED",
        periodStart: new Date(fixture.previousPeriodStart),
        periodEnd: new Date(fixture.currentPeriodEnd),
        startedAt: new Date(),
        finishedAt: new Date(),
        recordsReceived:
          connection.provider === "GOOGLE_SEARCH_CONSOLE" ? gscRows.length : ga4Rows.length,
        recordsWritten:
          connection.provider === "GOOGLE_SEARCH_CONSOLE" ? gscRows.length : ga4Rows.length,
        idempotencyKey: `demo:${connection.provider}:${fixture.currentPeriodEnd}`,
      },
    });
  }

  console.log("Seeded P1 demo data (synthetic, isolated):");
  console.log(`  Website        ${website.normalizedDomain}  [DEMO]`);
  console.log(`  Period         ${fixture.previousPeriodStart} → ${fixture.currentPeriodEnd}`);
  console.log(`  Comparison     ${fixture.currentPeriodStart} → ${fixture.currentPeriodEnd}`);
  console.log(`                 vs ${fixture.previousPeriodStart} → ${fixture.previousPeriodEnd}`);
  console.log(`  Pages          ${pageIdByPath.size}`);
  console.log(`  Queries        ${queryIdByText.size}`);
  console.log(`  GSC rows       ${gscRows.length}`);
  console.log(`  GA4 rows       ${ga4Rows.length}`);
  console.log("\nNo synthetic metric was written to any real website.");
}

async function upsertDemoConnection(
  websiteId: string,
  workspaceId: string,
  provider: "GOOGLE_SEARCH_CONSOLE" | "GOOGLE_ANALYTICS",
  propertyName: string,
  latestDataDate: Date,
) {
  return prisma.connection.upsert({
    where: { websiteId_provider: { websiteId, provider } },
    update: {
      status: "CONNECTED",
      externalPropertyName: propertyName,
      externalPropertyId: `demo-${provider.toLowerCase()}`,
      propertySelectedAt: new Date(),
      lastSyncedAt: new Date(),
      latestDataDate,
      // Demo connections hold no credential, because there is nothing to
      // authenticate against.
      credentialReference: null,
    },
    create: {
      websiteId,
      workspaceId,
      provider,
      status: "CONNECTED",
      externalPropertyName: propertyName,
      externalPropertyId: `demo-${provider.toLowerCase()}`,
      propertySelectedAt: new Date(),
      connectedAt: new Date(),
      lastSyncedAt: new Date(),
      latestDataDate,
    },
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
