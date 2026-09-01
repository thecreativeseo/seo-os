import Link from "next/link";

/**
 * Generic sign-in failure page.
 *
 * Reasons are mapped from a fixed allowlist. Provider error text is never shown:
 * it can carry request details, and an attacker-controlled string must not reach
 * the page.
 */
const REASONS: Record<string, string> = {
  access_denied: "Sign-in was cancelled, or this Google account is not permitted.",
  missing_code: "The sign-in response was incomplete.",
  exchange_failed: "The sign-in could not be completed.",
  user_resolution_failed: "Signed in, but your SEO OS account could not be prepared.",
  oauth_start_failed: "Sign-in could not be started.",
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const message =
    (reason && REASONS[reason]) ?? "Sign-in could not be completed.";

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Sign-in failed</h1>
        <p className="text-muted-foreground text-sm">{message}</p>
        <Link
          href="/login"
          className="border-border hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium"
        >
          Try again
        </Link>
      </div>
    </main>
  );
}
