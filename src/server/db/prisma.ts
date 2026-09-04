import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * The application's Prisma client.
 *
 * Runtime traffic goes through the Supabase transaction pooler
 * (DATABASE_URL, port 6543); migrations use DIRECT_URL via prisma.config.ts.
 *
 * Created on first use, not at import. The distinction matters in one place:
 * `next build` imports every route module to collect page data, and a route
 * that imports this file would otherwise need a live database secret just to
 * be built. A build should never need one - it runs in CI and on hosts before
 * variables exist - so the client is constructed the first time something
 * actually asks it for a query. The error for a missing DATABASE_URL is the
 * same as before; it just arrives at the first query rather than the first
 * import, which is also where a person can do something about it.
 *
 * Outside production the instance is cached on globalThis so hot reloads reuse
 * one connection pool instead of opening a new one per reload. The dev wrapper
 * (scripts/dev.mjs) restarts the process when the generated client changes, so
 * the cache never outlives the schema it was built for.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill in the Supabase pooled connection string.",
    );
  }

  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({
    adapter,
    // Never log query parameters: they can carry business data, and in future
    // phases could carry credential references. Errors and warnings only.
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

let instance: PrismaClient | undefined = globalForPrisma.prisma;

function client(): PrismaClient {
  if (!instance) {
    instance = createPrismaClient();

    if (process.env.NODE_ENV !== "production") {
      globalForPrisma.prisma = instance;
    }
  }

  return instance;
}

/**
 * Behaves exactly like a PrismaClient at every call site - `prisma.website`,
 * `prisma.$transaction` - while deferring construction to the first property
 * access. Methods are bound to the real client so `this` inside them is right.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const target = client();
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
