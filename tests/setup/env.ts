import { config as loadEnv } from "dotenv";

// Vitest does not read .env.local the way Next.js does.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });
