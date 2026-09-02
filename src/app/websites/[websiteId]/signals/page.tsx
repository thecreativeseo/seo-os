import Link from "next/link";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { hasRole } from "@/server/auth/roles";
import { listSignals } from "@/server/services/signals";
import { resolveWebsiteWindows } from "@/server/services/metrics";
import { formatDateRange } from "@/lib/metrics/format";
import { SeverityBadge } from "@/components/metrics/primitives";
import { SignalActions } from "@/components/metrics/signal-actions";
import { PageHeader } from "@/components/governance/primitives";

export const metadata = { title: "Signals · SEO OS" };

const STATUSES = [
  { value: "DETECTED", label: "Detected" },
  { value: "REVIEWED", label: "Reviewed" },
  { value: "DISMISSED", label: "Dismissed" },
  { value: "RESOLVED", label: "Resolved" },
] as const;

/**
 * Signals.
 *
 * Each one states what changed, for what, over which period, and from which
 * numbers. None of them says why — that distinction is the point of the phase, and
 * the closing line of the investor script.
 */
export default async function SignalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { websiteId } = await params;
  const { status } = await searchParams;
  const context = await requireWebsiteAccess(websiteId);
  const canWrite = hasRole(context.membership.role, "MEMBER");

  const selected = STATUSES.find((entry) => entry.value === status)?.value ?? "DETECTED";
  const [signals, { windows }] = await Promise.all([
    listSignals(context, { status: selected, limit: 200 }),
    resolveWebsiteWindows(context, "28d"),
  ]);

  return (
    <main className="space-y-6">
      <PageHeader
        title="Signals"
        description="Observations from first-party data. Each states what changed and over which period; none of them claims a cause."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {formatDateRange(windows.current)} vs {formatDateRange(windows.previous)}
        </p>
        <nav className="flex gap-1" aria-label="Filter by status">
          {STATUSES.map((entry) => (
            <Link
              key={entry.value}
              href={`/websites/${websiteId}/signals?status=${entry.value}`}
              aria-current={selected === entry.value ? "page" : undefined}
              className={`rounded-md px-2.5 py-1 text-sm ${
                selected === entry.value
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:bg-accent/60"
              }`}
            >
              {entry.label}
            </Link>
          ))}
        </nav>
      </div>

      {signals.length === 0 ? (
        <p className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-sm">
          Nothing {selected.toLowerCase()} for this period.
        </p>
      ) : (
        <ul className="space-y-3">
          {signals.map((signal) => (
            <li key={signal.id} className="border-border space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={signal.severity} />
                    <span className="text-muted-foreground font-mono text-[10px] tracking-wide">
                      {signal.type}
                    </span>
                  </div>
                  <p className="text-sm font-medium">{signal.headline}</p>
                  <p className="text-muted-foreground text-sm">{signal.summary}</p>
                </div>

                {signal.page ? (
                  <Link
                    href={`/websites/${websiteId}/pages/${signal.page.id}`}
                    className="border-border hover:bg-accent shrink-0 rounded-md border px-3 py-1.5 text-sm"
                  >
                    View page
                  </Link>
                ) : null}
              </div>

              {signal.evidence.length > 0 ? (
                <details className="text-sm">
                  <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
                    Evidence ({signal.evidence.length})
                  </summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground text-left">
                          <th className="py-1 pr-4 font-medium">Metric</th>
                          <th className="py-1 pr-4 text-right font-medium">Current</th>
                          <th className="py-1 pr-4 text-right font-medium">Previous</th>
                          <th className="py-1 font-medium">Period</th>
                        </tr>
                      </thead>
                      <tbody className="divide-border divide-y">
                        {signal.evidence.map((entry) => (
                          <tr key={entry.id}>
                            <td className="py-1 pr-4 font-mono">{entry.metricKey}</td>
                            <td className="py-1 pr-4 text-right tabular-nums">
                              {entry.currentValue === null
                                ? "Not available"
                                : Number(entry.currentValue).toLocaleString("en-GB", {
                                    maximumFractionDigits: 4,
                                  })}
                            </td>
                            <td className="py-1 pr-4 text-right tabular-nums">
                              {entry.previousValue === null
                                ? "—"
                                : Number(entry.previousValue).toLocaleString("en-GB", {
                                    maximumFractionDigits: 4,
                                  })}
                            </td>
                            <td className="text-muted-foreground py-1 font-mono">
                              {entry.periodStart?.toISOString().slice(0, 10)} →{" "}
                              {entry.periodEnd?.toISOString().slice(0, 10)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-muted-foreground mt-2 text-xs">
                    Source: Google Search Console. Detection model{" "}
                    <span className="font-mono">{signal.scoringModelVersion}</span>.
                  </p>
                </details>
              ) : null}

              {canWrite ? (
                <div className="border-border border-t pt-3">
                  <SignalActions
                    websiteId={websiteId}
                    signalId={signal.id}
                    status={signal.status}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
