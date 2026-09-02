import { SCORE_CAVEAT, type SubScore } from "@/lib/opportunity/scoring";

/**
 * Shared display pieces for the P2 screens.
 *
 * The scoring breakdown is the one that matters. "Hidden or untraceable priority
 * scoring = P2 FAIL" is a requirement about what a person can see, not only about
 * what the database holds — so the breakdown renders the stored basis sentences
 * rather than recomputing an explanation at display time. What is on screen is
 * what was recorded.
 */

const PRIORITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300",
  HIGH: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  MEDIUM: "bg-sky-50 text-sky-900 dark:bg-sky-950 dark:text-sky-300",
  LOW: "bg-muted text-muted-foreground",
};

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
        PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.LOW
      }`}
    >
      {priority}
    </span>
  );
}

export function ScorePill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground text-sm">—</span>;

  return (
    <span className="tabular-nums font-medium" title={SCORE_CAVEAT}>
      {score.toFixed(1)}
    </span>
  );
}

/**
 * Third-party attribution, stated rather than implied.
 *
 * A reader should never have to work out which numbers on a screen were measured
 * here and which were supplied by a vendor.
 */
export function ProviderTag({ provider }: { provider: string | null }) {
  if (!provider) return null;

  const firstParty =
    provider === "GOOGLE_SEARCH_CONSOLE" || provider === "GOOGLE_ANALYTICS";

  return (
    <span
      className={`ml-1.5 inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium tracking-wide uppercase ${
        firstParty
          ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "bg-muted text-muted-foreground"
      }`}
      title={
        firstParty
          ? "First-party: measured on this website."
          : "Third-party: reported by a provider, not measured here."
      }
    >
      {provider === "GOOGLE_SEARCH_CONSOLE"
        ? "GSC"
        : provider === "GOOGLE_ANALYTICS"
          ? "GA4"
          : provider.toLowerCase()}
    </span>
  );
}

/** Two providers disagreeing is a fact worth showing, not one to resolve away. */
export function DisagreementFlag({ show }: { show: boolean }) {
  if (!show) return null;

  return (
    <span
      className="ml-1.5 text-amber-600 dark:text-amber-400"
      title="Providers report materially different figures for this keyword."
      aria-label="Providers disagree"
    >
      ≠
    </span>
  );
}

export function ScoreBreakdown({
  subScores,
  score,
}: {
  subScores: SubScore[];
  score: number | null;
}) {
  const maxRaw = subScores.reduce((total, entry) => total + entry.weight * 5, 0);
  const raw = subScores.reduce((total, entry) => total + entry.score * entry.weight, 0);

  return (
    <div className="space-y-3">
      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border text-muted-foreground border-b text-left">
              <th className="px-4 py-2 font-medium">Criterion</th>
              <th className="px-3 py-2 text-right font-medium">Score</th>
              <th className="px-3 py-2 text-right font-medium">Weight</th>
              <th className="px-4 py-2 font-medium">Why</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {subScores.map((entry) => (
              <tr key={entry.key}>
                <td className="px-4 py-2.5 font-medium whitespace-nowrap">{entry.label}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{entry.score} / 5</td>
                <td className="text-muted-foreground px-3 py-2.5 text-right tabular-nums">
                  ×{entry.weight}
                </td>
                {/* The sentence recorded at detection time, not one composed now. */}
                <td className="text-muted-foreground px-4 py-2.5">{entry.basis}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-border border-t">
              <td className="px-4 py-2.5 font-medium">Total</td>
              <td className="px-3 py-2.5 text-right tabular-nums" colSpan={2}>
                {raw} / {maxRaw}
              </td>
              <td className="px-4 py-2.5 tabular-nums">
                {score === null ? "—" : `${score.toFixed(1)} / 100`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="text-muted-foreground text-xs">{SCORE_CAVEAT}</p>
    </div>
  );
}
