import { redirect } from "next/navigation";

import { signInWithGoogle } from "@/server/auth/actions";
import { getAuthUser } from "@/server/auth/supabase-server";

export const metadata = {
  title: "Sign in · SEO OS",
};

export default async function LoginPage() {
  // Already signed in — nothing to do here.
  if (await getAuthUser()) {
    redirect("/");
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">SEO OS</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          Build the context your SEO team operates from.
        </p>

        <form action={signInWithGoogle} className="mt-8">
          <button
            type="submit"
            className="border-border hover:bg-accent focus-visible:ring-ring inline-flex h-10 w-full items-center justify-center gap-3 rounded-md border bg-white px-4 text-sm font-medium text-neutral-900 transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <GoogleMark />
            Continue with Google
          </button>
        </form>

        <p className="text-muted-foreground mt-6 text-xs leading-relaxed">
          Signing in proves who you are. Access to a workspace is granted separately,
          by an invitation from that organization.
        </p>
      </div>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
