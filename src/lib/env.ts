import { z } from "zod";

/**
 * Validated environment access.
 *
 * Fail loudly at boot rather than producing a confusing runtime error deep inside
 * an auth flow. Only variables the application actually reads appear here:
 * GOOGLE_CLIENT_ID/SECRET live in the Supabase dashboard, and no P0 code path uses
 * SUPABASE_SERVICE_ROLE_KEY.
 */

const urlString = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be an absolute URL" },
  );

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: urlString,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: urlString,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;

  // Referenced statically so Next can inline NEXT_PUBLIC_* at build time.
  const parsed = schema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n  ");
    throw new Error(
      `Invalid environment configuration:\n  ${missing}\n\n` +
        "Copy .env.example to .env.local and fill in the Supabase values.",
    );
  }

  cached = parsed.data;
  return cached;
}
