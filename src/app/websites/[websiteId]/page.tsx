import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { getReadiness } from "@/server/services/readiness";

export const metadata = { title: "Command Center · SEO OS" };

/**
 * Command Center (docs/P0_SPEC.md §20).
 *
 * A setup dashboard, not an SEO dashboard. Everything shown is a fact about how
 * completely the business has described itself. There are no metrics here, no
 * score, and nothing that implies SEO OS has measured anything — because in this
 * phase it has not.
 */
export default async function CommandCenterPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const { websiteId } = await params;
  const context = await requireWebsiteAccess(websiteId);
  const readiness = await getReadiness(context);

  return (
    <main className="space-y-10">
      <header className="space-y-1">
        <p className="text-muted-foreground font-mono text-sm">
          {context.website.normalizedDomain}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Command Center</h1>
      </header>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium">Setup completion</h2>
          <p className="text-sm tabular-nums">
            <span className="font-medium">{readiness.percentage}%</span>
            <span className="text-muted-foreground">
              {" "}
              · {readiness.countedComplete} of {readiness.countedTotal}
            </span>
          </p>
        </div>

        <div
          role="progressbar"
          aria-valuenow={readiness.percentage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Setup completion"
          className="bg-accent h-2 w-full overflow-hidden rounded-full"
        >
          <div
            className="bg-foreground h-full rounded-full transition-all"
            style={{ width: `${readiness.percentage}%` }}
          />
        </div>

        <p className="text-muted-foreground text-xs">
          How completely this business has been described. Not a measure of search
          performance.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Readiness</h2>
        <ul className="divide-border border-border divide-y rounded-lg border">
          {readiness.items.map((item) => (
            <li
              key={item.key}
              className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
            >
              {item.path ? (
                <Link
                  href={`/websites/${websiteId}/${item.path}`}
                  className="hover:underline"
                >
                  {item.label}
                </Link>
              ) : (
                <span>{item.label}</span>
              )}

              <span
                className={
                  item.state === "COMPLETE"
                    ? "text-muted-foreground"
                    : item.state === "INFORMATIONAL"
                      ? "text-muted-foreground font-mono text-xs"
                      : "font-medium"
                }
              >
                {item.detail}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {readiness.nextBestStep ? (
        <section className="border-border space-y-3 rounded-lg border p-5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Next best step
          </h2>
          <p className="text-base">{readiness.nextBestStep.action}</p>
          <Link
            href={`/websites/${websiteId}/${readiness.nextBestStep.path}`}
            className="bg-foreground text-background inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
          >
            Go to {readiness.nextBestStep.label}
          </Link>
        </section>
      ) : (
        <section className="border-border space-y-2 rounded-lg border border-dashed p-5">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Next best step
          </h2>
          <p className="text-sm">
            Setup is complete. Connecting Search Console and Analytics is the next
            phase of work — nothing further is needed here.
          </p>
        </section>
      )}
    </main>
  );
}
