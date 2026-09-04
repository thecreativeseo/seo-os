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

// env() throws while the config is being loaded, which would make every Prisma
// command need a database URL - including `generate`, which never touches a
// database and runs in builds that have none. So the direct URL is required only
// when it is actually there to require. Without it, generate works and migrate
// fails on the placeholder with a message that names the variable.
const directUrl = process.env.DIRECT_URL
  ? env("DIRECT_URL")
  : "postgresql://DIRECT_URL_is_not_set@localhost:5432/set_DIRECT_URL";

if (!process.env.DIRECT_URL) {
  console.warn("prisma.config: DIRECT_URL is not set. generate will work; migrate will not.");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: directUrl,
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
