import { config as loadEnv } from "dotenv";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 configuration.
 *
 * Connection URLs live here rather than in schema.prisma — the `url` property was
 * removed from the datasource block in Prisma 7.
 *
 *   datasource.url                direct connection (5432). Migrations only.
 *   datasource.shadowDatabaseUrl  separate Supabase project. `migrate dev` must be
 *                                 able to create and drop a shadow database, which
 *                                 managed Postgres does not permit on the primary
 *                                 instance.
 *
 * Runtime queries do NOT use this file. The application connects through the pooled
 * DATABASE_URL (6543) via @prisma/adapter-pg — see src/server/db/prisma.ts.
 *
 * Next.js loads .env.local automatically; the Prisma CLI does not, so we load it
 * here to keep one source of truth for connection strings.
 */
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

// Optional. `migrate deploy` applies existing migrations and needs no shadow
// database; only `migrate dev` does. env() throws on an unset variable, so this
// is read directly and omitted when empty.
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL || undefined;

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DIRECT_URL"),
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
