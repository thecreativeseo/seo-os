import { config as loadEnv } from "dotenv";

/**
 * P3 demo data - SYNTHETIC, isolated, repeatable (docs/P3_SPEC.md §33).
 *
 * Runs the five investor stories through the real diagnosis pipeline under the
 * stub provider, into the demo website seeded by `db:seed:demo` (P0),
 * `db:seed:demo:p1` and `db:seed:demo:p2`. See src/server/demo/p3.ts for what
 * that means and why it is done that way.
 *
 * Run: npm run db:seed:demo:p3
 */

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

// The services reach Postgres through the application singleton, which reads
// DATABASE_URL. A diagnosis is written in an interactive transaction, and the
// pooled connection (transaction mode) cannot hold one, so the direct URL is
// used for this process - the same choice the other seeds make.
if (process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

if (!process.env.DATABASE_URL) {
  throw new Error("DIRECT_URL (or DATABASE_URL) must be set to run the demo seed.");
}

const DEMO_ORG_SLUG = "seo-os-demo";

/** Which demo page plays which part. Paths from src/lib/demo/fixture.ts. */
const STORY_PATHS = {
  commercial: "/product/cohort-reports",
  guide: "/blog/cohort-analysis-guide",
  pricing: "/pricing",
  compare: "/compare/mixpanel-alternative",
  thin: "/security",
} as const;

async function main(): Promise<void> {
  // Imported after the environment is loaded: the singleton throws at import
  // time without DATABASE_URL, and ES imports at the top would run first.
  const { prisma } = await import("../src/server/db/prisma");
  const { PROTECTED_DOMAINS, seedP3Demo } = await import("../src/server/demo/p3");

  const website = await prisma.website.findFirst({
    where: { workspace: { organization: { slug: DEMO_ORG_SLUG } } },
    include: { workspace: { include: { organization: true } } },
  });

  if (!website) {
    throw new Error("The demo website does not exist yet. Run `npm run db:seed:demo` first.");
  }

  if (PROTECTED_DOMAINS.includes(website.normalizedDomain) || !website.isDemo) {
    throw new Error(
      `Refusing to write synthetic P3 records into ${website.normalizedDomain}: it is not a demo website.`,
    );
  }

  const ownerEmail = process.env.DEMO_OWNER_EMAIL ?? process.env.SEED_OWNER_EMAIL;

  if (!ownerEmail) {
    throw new Error("Set DEMO_OWNER_EMAIL (or SEED_OWNER_EMAIL) to the demo owner's email.");
  }

  const user = await prisma.user.findFirst({ where: { email: ownerEmail } });
  const membership = user
    ? await prisma.organizationMembership.findFirst({
        where: {
          userId: user.id,
          organizationId: website.workspace.organizationId,
          status: "ACTIVE",
          role: { in: ["OWNER", "ADMIN"] },
        },
      })
    : null;

  if (!user || !membership) {
    throw new Error(
      `${ownerEmail} is not an active owner or admin of the demo organization. Run \`npm run db:seed:demo\` with that email first.`,
    );
  }

  const { workspace, ...websiteRow } = website;
  const { organization, ...workspaceRow } = workspace;

  const context = { user, membership, organization, workspace: workspaceRow, website: websiteRow };

  const pages = await prisma.page.findMany({
    where: { websiteId: website.id, path: { in: Object.values(STORY_PATHS) } },
    select: { id: true, path: true },
  });
  const pageIdByPath = new Map(pages.map((page) => [page.path, page.id]));

  for (const [story, path] of Object.entries(STORY_PATHS)) {
    if (!pageIdByPath.has(path)) {
      throw new Error(
        `Demo page ${path} (${story}) is missing. Run \`npm run db:seed:demo:p1\` first.`,
      );
    }
  }

  // The rule the pricing recommendation walks into. Seeded by P0.
  const blockingRule =
    (await prisma.seoRule.findFirst({
      where: {
        websiteId: website.id,
        severity: "BLOCKING",
        active: true,
        rule: { contains: "Pricing figures" },
      },
    })) ??
    (await prisma.seoRule.findFirst({
      where: { websiteId: website.id, severity: "BLOCKING", active: true },
    }));

  if (!blockingRule) {
    throw new Error(
      "No active BLOCKING SEO rule on the demo website. Run `npm run db:seed:demo` first.",
    );
  }

  console.log(`Seeding P3 demo data into ${website.normalizedDomain}`);

  const result = await seedP3Demo(context, {
    commercial: pageIdByPath.get(STORY_PATHS.commercial)!,
    guide: pageIdByPath.get(STORY_PATHS.guide)!,
    pricing: pageIdByPath.get(STORY_PATHS.pricing)!,
    compare: pageIdByPath.get(STORY_PATHS.compare)!,
    thin: pageIdByPath.get(STORY_PATHS.thin)!,
    blockingRuleId: blockingRule.id,
  });

  console.log(
    `  ${result.diagnoses} diagnoses · ${result.findings} findings · ${result.recommendations} recommendations · ${result.decisions} decisions`,
  );
  console.log(
    `  ${result.blocked} blocked by a rule · ${result.needsEvidence} needing evidence · ${result.reviewed} diagnoses reviewed`,
  );
  console.log("  Every AI run is recorded against the stub provider. DEMO DATA.");

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
