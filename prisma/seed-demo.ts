import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../src/generated/prisma/client";

/**
 * Investor demo seed — SYNTHETIC DATA, fully isolated.
 *
 * CLAUDE.md: "Synthetic investor demo data must be isolated in a clearly labeled
 * Demo Workspace" and "Never insert synthetic SEO metrics into the real
 * thecreativeseo.com workspace."
 *
 * Isolation here is structural, not a convention someone has to remember:
 *
 *   - everything lives under its own Organization, "SEO OS Demo"
 *   - the workspace is literally named "Demo Workspace"
 *   - the website is a fictional company on a domain that is not a real customer
 *   - the script refuses to run if the target names collide with a real tenant
 *
 * Northwind Analytics does not exist. Every fact below is invented for the
 * walkthrough, which is exactly why it may not live anywhere else.
 *
 * Run: DEMO_OWNER_EMAIL=you@example.com npm run db:seed:demo
 */

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DIRECT_URL (or DATABASE_URL) must be set to run the demo seed.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const ORGANIZATION = { name: "SEO OS Demo", slug: "seo-os-demo" };
const WORKSPACE = { name: "Demo Workspace", slug: "demo-workspace" };
const WEBSITE = {
  name: "Northwind Analytics (demo)",
  domain: "https://www.northwind-analytics.com/",
  normalizedDomain: "northwind-analytics.com",
  websiteType: "SAAS_PRODUCT" as const,
  cmsType: "WEBFLOW" as const,
  primaryMarket: "GB",
  primaryLanguage: "English",
  timezone: "Europe/London",
};

/** Domains that must never receive synthetic data. */
const PROTECTED_DOMAINS = ["thecreativeseo.com"];

async function main(): Promise<void> {
  if (PROTECTED_DOMAINS.includes(WEBSITE.normalizedDomain)) {
    throw new Error(
      `Refusing to seed demo data into ${WEBSITE.normalizedDomain}: it is a real workspace.`,
    );
  }

  const ownerEmail = process.env.DEMO_OWNER_EMAIL ?? process.env.SEED_OWNER_EMAIL;

  if (!ownerEmail) {
    throw new Error(
      "DEMO_OWNER_EMAIL is required so the demo organization has an owner.\n" +
        "Sign in with Google first, then run:\n" +
        "  DEMO_OWNER_EMAIL=<your address> npm run db:seed:demo",
    );
  }

  const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });

  if (!owner) {
    throw new Error(
      `${ownerEmail} has not signed in yet, so there is no user to own the demo.\n` +
        "Sign in with Google once, then re-run.",
    );
  }

  const organization = await prisma.organization.upsert({
    where: { slug: ORGANIZATION.slug },
    update: { name: ORGANIZATION.name },
    create: ORGANIZATION,
  });

  await prisma.organizationMembership.upsert({
    where: {
      organizationId_userId: { organizationId: organization.id, userId: owner.id },
    },
    update: { role: "OWNER", status: "ACTIVE" },
    create: {
      organizationId: organization.id,
      userId: owner.id,
      role: "OWNER",
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: {
      organizationId_slug: { organizationId: organization.id, slug: WORKSPACE.slug },
    },
    update: { name: WORKSPACE.name },
    create: { ...WORKSPACE, organizationId: organization.id },
  });

  const website = await prisma.website.upsert({
    where: {
      workspaceId_normalizedDomain: {
        workspaceId: workspace.id,
        normalizedDomain: WEBSITE.normalizedDomain,
      },
    },
    update: WEBSITE,
    create: { ...WEBSITE, workspaceId: workspace.id },
  });

  // Reset demo content so re-running produces the same state rather than duplicates.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
    await tx.businessGoal.deleteMany({ where: { websiteId: website.id } });
    await tx.brandFact.deleteMany({ where: { websiteId: website.id } });
    await tx.competitor.deleteMany({ where: { websiteId: website.id } });
    await tx.seoRule.deleteMany({ where: { websiteId: website.id } });
    await tx.auditEvent.deleteMany({ where: { websiteId: website.id } });
    await tx.businessContext.deleteMany({ where: { websiteId: website.id } });
  });

  const context = await prisma.businessContext.create({ data: { websiteId: website.id } });

  const version = await prisma.businessContextVersion.create({
    data: {
      businessContextId: context.id,
      versionNumber: 1,
      status: "APPROVED",
      createdByUserId: owner.id,
      ownerUserId: owner.id,
      approvedByUserId: owner.id,
      approvedAt: new Date(),
      companySummary:
        "Northwind Analytics builds product analytics for subscription businesses, focused on teams that need retention insight without a data engineer.",
      productService:
        "A hosted product analytics platform with retention, funnel and cohort reporting, sold as a monthly subscription.",
      businessModel: "SaaS subscription, self-serve with a sales-assisted tier above £2k/month.",
      primaryCustomer:
        "Subscription software companies between 20 and 200 staff, in the UK and Ireland, that already have a product team but no dedicated data function.",
      buyerRoles: ["Head of Product", "Product Analyst", "VP Engineering"],
      primaryMarket: "GB",
      additionalMarkets: ["IE"],
      languages: ["English"],
      primaryConversion: "Start a trial",
      secondaryConversions: ["Book a demo", "Subscribe to the newsletter"],
      businessPriorities: [
        "Grow self-serve trial volume",
        "Reduce reliance on outbound sales",
        "Expand into Ireland",
      ],
      seoPriorities: [
        "Content creation",
        "Commercial rankings",
        "Technical SEO",
        "Competitor visibility",
      ],
      competitorSummary:
        "Competes with general analytics suites on depth of retention reporting, and with warehouse-native tools on time to first insight.",
      differentiators: [
        "Retention cohorts available within an hour of installing the SDK",
        "No data warehouse required",
        "Published pricing up to the enterprise tier",
      ],
      brandVoice:
        "Plain, specific, and unhurried. Explains the mechanism rather than asserting the outcome. No superlatives.",
      priorityTopics: [
        "Retention measurement",
        "Product analytics for subscription businesses",
        "Activation and onboarding metrics",
      ],
      avoidTopics: ["Competitor teardowns", "Unverified benchmark comparisons"],
      approvedClaims: [
        "Installs with a single JavaScript snippet",
        "Retention cohorts available within one hour of install",
        "Pricing published up to the enterprise tier",
      ],
      prohibitedClaims: [
        "Any specific customer revenue figure",
        "Comparative uptime claims against named competitors",
        "GDPR compliance guarantees on behalf of customers",
      ],
    },
  });

  await prisma.businessContext.update({
    where: { id: context.id },
    data: { currentApprovedVersionId: version.id },
  });

  await prisma.businessGoal.createMany({
    data: [
      {
        websiteId: website.id,
        title: "Increase qualified organic trials",
        businessObjective: "Grow self-serve revenue without increasing paid spend",
        seoOutcome: "More organic sessions on commercial pages that start a trial",
        primaryMetric: "Organic trial starts",
        leadingIndicator: "Organic sessions on pricing and comparison pages",
        ownerUserId: owner.id,
        status: "ACTIVE",
      },
      {
        websiteId: website.id,
        title: "Build category visibility for retention analytics",
        businessObjective: "Be considered in the first shortlist",
        seoOutcome: "Presence on non-branded category terms",
        primaryMetric: "Non-branded impressions",
        ownerUserId: owner.id,
        status: "ACTIVE",
      },
      {
        websiteId: website.id,
        title: "Enter the Irish market",
        businessObjective: "Open a second geography in the same language",
        seoOutcome: "Country-level visibility in Ireland",
        primaryMetric: "Organic sessions from Ireland",
        ownerUserId: owner.id,
        status: "ACTIVE",
      },
      {
        websiteId: website.id,
        title: "Reduce paid acquisition dependency",
        businessObjective: "Lower blended customer acquisition cost",
        seoOutcome: "Organic share of trial starts",
        primaryMetric: "Organic share of new trials",
        ownerUserId: owner.id,
        status: "MET",
      },
    ],
  });

  await prisma.competitor.createMany({
    data: [
      {
        websiteId: website.id,
        name: "Mixpanel",
        domain: "mixpanel.com",
        normalizedDomain: "mixpanel.com",
        type: "DIRECT",
        notes: "Strongest on event analytics; less focused on retention cohorts.",
      },
      {
        websiteId: website.id,
        name: "Amplitude",
        domain: "amplitude.com",
        normalizedDomain: "amplitude.com",
        type: "DIRECT",
        notes: "Enterprise-heavy. Competes on breadth.",
      },
      {
        websiteId: website.id,
        name: "PostHog",
        domain: "posthog.com",
        normalizedDomain: "posthog.com",
        type: "ADJACENT",
        notes: "Open source; wins on developer preference and self-hosting.",
      },
      {
        websiteId: website.id,
        name: "Google Analytics 4",
        domain: "analytics.google.com",
        normalizedDomain: "analytics.google.com",
        type: "SEARCH",
        notes: "Ranks for many of the same informational queries.",
      },
    ],
  });

  await prisma.brandFact.createMany({
    data: [
      {
        websiteId: website.id,
        category: "Company",
        factKey: "Year founded",
        value: "2019",
        approvalStatus: "APPROVED",
        ownerUserId: owner.id,
        verifiedAt: new Date(),
        sourceUrl: "https://www.northwind-analytics.com/about",
      },
      {
        websiteId: website.id,
        category: "Product",
        factKey: "Installation",
        value: "Single JavaScript snippet; no data warehouse required",
        approvalStatus: "APPROVED",
        ownerUserId: owner.id,
        verifiedAt: new Date(),
      },
      {
        websiteId: website.id,
        category: "Pricing",
        factKey: "Entry price",
        value: "£99 per month",
        approvalStatus: "APPROVED",
        ownerUserId: owner.id,
        verifiedAt: new Date(),
        sourceUrl: "https://www.northwind-analytics.com/pricing",
      },
      {
        websiteId: website.id,
        category: "Company",
        factKey: "Head office",
        value: "Manchester, United Kingdom",
        approvalStatus: "APPROVED",
        ownerUserId: owner.id,
        verifiedAt: new Date(),
      },
      {
        // One proposed fact, so the review state is visible during the walkthrough.
        websiteId: website.id,
        category: "Product",
        factKey: "Data retention window",
        value: "24 months on all plans",
        approvalStatus: "PROPOSED",
        ownerUserId: owner.id,
      },
    ],
  });

  await prisma.seoRule.createMany({
    data: [
      {
        websiteId: website.id,
        category: "Legal",
        rule: "Never state or imply that using Northwind makes a customer GDPR compliant.",
        severity: "BLOCKING",
        appliesTo: "All published content",
        ownerUserId: owner.id,
        active: true,
      },
      {
        websiteId: website.id,
        category: "Brand",
        rule: "Do not name competitors in page titles or meta descriptions.",
        severity: "WARNING",
        appliesTo: "Comparison pages",
        ownerUserId: owner.id,
        active: true,
      },
      {
        websiteId: website.id,
        category: "Publishing",
        rule: "Pricing figures require finance approval before publication.",
        severity: "BLOCKING",
        appliesTo: "Pricing and comparison pages",
        ownerUserId: owner.id,
        active: true,
      },
    ],
  });

  await prisma.technicalContext.upsert({
    where: { websiteId: website.id },
    update: {},
    create: {
      websiteId: website.id,
      cms: WEBSITE.cmsType,
      hostingNotes: "Webflow hosting with Cloudflare in front. Redirects managed in Cloudflare.",
      knownMigrations: "Moved from WordPress to Webflow in March 2024; URL structure changed.",
      knownConstraints:
        "Blog templates are shared with the marketing site and cannot be changed independently.",
      stagingAvailable: true,
      developerContact: "Platform team",
      publicationProcess:
        "Draft in Webflow, review by content lead, legal review for pricing claims, publish on Tuesdays.",
      ownerUserId: owner.id,
    },
  });

  // A small audit trail so the history page is not empty during the walkthrough.
  await prisma.auditEvent.createMany({
    data: [
      {
        organizationId: organization.id,
        workspaceId: workspace.id,
        websiteId: website.id,
        actorUserId: owner.id,
        entityType: "Website",
        entityId: website.id,
        action: "CREATE",
        afterSnapshotJson: { normalizedDomain: website.normalizedDomain },
      },
      {
        organizationId: organization.id,
        workspaceId: workspace.id,
        websiteId: website.id,
        actorUserId: owner.id,
        entityType: "BusinessContextVersion",
        entityId: version.id,
        action: "APPROVE",
        beforeSnapshotJson: { status: "DRAFT" },
        afterSnapshotJson: { status: "APPROVED", versionNumber: 1 },
      },
    ],
  });

  const counts = {
    goals: await prisma.businessGoal.count({ where: { websiteId: website.id } }),
    brandFacts: await prisma.brandFact.count({ where: { websiteId: website.id } }),
    competitors: await prisma.competitor.count({ where: { websiteId: website.id } }),
    seoRules: await prisma.seoRule.count({ where: { websiteId: website.id } }),
  };

  console.log("Seeded the investor demo (synthetic data, isolated):");
  console.log(`  Organization  ${organization.name}`);
  console.log(`  Workspace     ${workspace.name}`);
  console.log(`  Website       ${website.normalizedDomain}`);
  console.log(`  Owner         ${owner.email}`);
  console.log(
    `  Content       ${counts.goals} goals · ${counts.brandFacts} brand facts · ` +
      `${counts.competitors} competitors · ${counts.seoRules} SEO rules`,
  );
  console.log("\nNothing was written to any real workspace.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
