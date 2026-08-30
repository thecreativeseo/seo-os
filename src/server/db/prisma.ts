import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter — the datasource `url` property no longer
 * exists in schema.prisma. Runtime queries go through the pooled connection
 * (DATABASE_URL, port 6543); migrations use DIRECT_URL via prisma.config.ts.
 *
 * This module is server-only. It must never be imported from a client component:
 * every tenant query runs behind the authorization guards in src/server/auth.
 */

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill in the Supabase pooled connection string.",
  );
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({
    adapter,
    // Never log query parameters: they can carry business data, and in future
    // phases could carry credential references. Errors and warnings only.
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
