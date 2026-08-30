import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../src/generated/prisma/client";

/**
 * P0 development seed — STRUCTURE ONLY.
 *
 * Creates the tenant skeleton named in docs/P0_SPEC.md §8:
 *
 *   Organization  The Creative SEO
 *   Workspace     SEO Team
 *   Website       thecreativeseo.com
 *
 * It deliberately seeds NO business facts: no business context, no goals, no
 * competitors, no brand facts, no SEO rules, no metrics. CLAUDE.md forbids
 * fabricating business facts, and P0_SPEC.md §8 says not to seed unconfirmed ones.
 * Everything below is a container, not a claim about the business.
 *
 * Synthetic investor-demo content belongs in a separately created, clearly labeled
 * Demo Workspace — never in the real thecreativeseo.com workspace.
 *
 * Ownership: this script does not create users. Users exist only after signing in
 * with Google. If SEED_OWNER_EMAIL names a user who has already signed in, that
 * user is granted an OWNER membership. That is an explicit operator provisioning
 * action naming one exact address — it is NOT email-domain matching, and no login
 * path anywhere in the app grants access this way.
 *
 * Idempotent: safe to run repeatedly.
 */

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DIRECT_URL (or DATABASE_URL) must be set to run the seed.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const ORGANIZATION = { name: "The Creative SEO", slug: "the-creative-seo" };
const WORKSPACE = { name: "SEO Team", slug: "seo-team" };
const WEBSITE = {
  name: "The Creative SEO",
  domain: "thecreativeseo.com",
  // Already in normalized form. The normalizer itself arrives in M5; this value is
  // not derived from it, so the seed cannot mask a normalization bug.
  normalizedDomain: "thecreativeseo.com",
};

async function main(): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { slug: ORGANIZATION.slug },
    update: { name: ORGANIZATION.name },
    create: ORGANIZATION,
  });

  const workspace = await prisma.workspace.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: WORKSPACE.slug,
      },
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
    // No update: re-running the seed must never overwrite real values a user has
    // entered through onboarding.
    update: {},
    create: { ...WEBSITE, workspaceId: workspace.id },
  });

  console.log("Seeded tenant structure (no business facts):");
  console.log(`  Organization  ${organization.name}  ${organization.id}`);
  console.log(`  Workspace     ${workspace.name}  ${workspace.id}`);
  console.log(`  Website       ${website.domain}  ${website.id}`);

  const ownerEmail = process.env.SEED_OWNER_EMAIL;

  if (!ownerEmail) {
    console.log(
      "\nNo SEED_OWNER_EMAIL set. Sign in with Google first, then re-run the seed\n" +
        "with SEED_OWNER_EMAIL=<your address> to grant yourself OWNER on this organization.",
    );
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: ownerEmail } });

  if (!user) {
    console.log(
      `\nSEED_OWNER_EMAIL=${ownerEmail} has not signed in yet, so no membership was created.\n` +
        "Sign in with Google once, then re-run the seed.",
    );
    return;
  }

  const membership = await prisma.organizationMembership.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id,
      },
    },
    update: { role: "OWNER", status: "ACTIVE" },
    create: {
      organizationId: organization.id,
      userId: user.id,
      role: "OWNER",
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  console.log(`\n  Membership    ${user.email} -> ${membership.role} (${membership.status})`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
