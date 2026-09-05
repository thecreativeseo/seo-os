import { config as loadEnv } from "dotenv";

/**
 * P4 demo data - SYNTHETIC, isolated, repeatable (docs/P4_SPEC.md §34, §35).
 *
 * Runs the M3 brief stories through the real services under the stub
 * provider, into the demo website seeded by `db:seed:demo` (P0) and the P1-P3
 * demo seeds. See src/server/demo/p4.ts for what that means.
 *
 * Run: npm run db:seed:demo:p4
 */

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

// Briefs are written in interactive transactions, which the pooled connection
// (transaction mode) cannot hold; the direct URL is used for this process.
if (process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

if (!process.env.DATABASE_URL) {
  throw new Error("DIRECT_URL (or DATABASE_URL) must be set to run the demo seed.");
}

const DEMO_ORG_SLUG = "seo-os-demo";

async function main(): Promise<void> {
  const { prisma } = await import("../src/server/db/prisma");
  const { PROTECTED_DOMAINS } = await import("../src/server/demo/p3");
  const { seedP4Demo } = await import("../src/server/demo/p4");

  const website = await prisma.website.findFirst({
    where: { workspace: { organization: { slug: DEMO_ORG_SLUG } } },
    include: { workspace: { include: { organization: true } } },
  });

  if (!website) {
    throw new Error("The demo website does not exist yet. Run `npm run db:seed:demo` first.");
  }

  if (PROTECTED_DOMAINS.includes(website.normalizedDomain) || !website.isDemo) {
    throw new Error(
      `Refusing to write synthetic execution records into ${website.normalizedDomain}: it is not a demo website.`,
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
        },
      })
    : null;

  if (!user || !membership) {
    throw new Error(`${ownerEmail} is not an active member of the demo organization.`);
  }

  const { workspace, ...websiteFields } = website;
  const { organization, ...workspaceFields } = workspace;

  const result = await seedP4Demo({
    user,
    membership,
    organization,
    workspace: workspaceFields,
    website: websiteFields,
  });

  console.log(
    JSON.stringify(
      {
        website: website.normalizedDomain,
        refreshItemId: result.refreshItemId,
        newContentItemId: result.newContentItemId,
        startedFromP3: result.startedFromP3,
        briefs: result.briefs,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
