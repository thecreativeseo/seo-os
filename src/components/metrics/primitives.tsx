import { compareValues } from "@/lib/metrics/compare";
import {
  changeDirection,
  formatAbsoluteChange,
  formatChange,
} from "@/lib/metrics/format";

/**
 * Shared display pieces for the intelligence tables.
 *
 * Colour is not the only carrier of meaning: every delta shows a sign and a word,
 * so the information survives greyscale, colour blindness, and a screenshot in a
 * deck.
 */

export function Delta({
  current,
  previous,
  /** Set when a falling number is the good outcome, as with average position. */
  lowerIsBetter = false,
  showAbsolute = false,
}: {
  current: number | null;
  previous: number | null;
  lowerIsBetter?: boolean;
  showAbsolute?: boolean;
}) {
  const change = compareValues(current, previous);
  const direction = changeDirection(change.state);

  const tone =
    direction === "neutral"
      ? "text-muted-foreground"
      : (direction === "positive") !== lowerIsBetter
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-red-700 dark:text-red-400";

  return (
    <span className={`font-mono text-xs tabular-nums ${tone}`}>
      {formatChange(change)}
      {showAbsolute && change.absolute !== null && change.state !== "flat" ? (
        <span className="text-muted-foreground"> ({formatAbsoluteChange(change)})</span>
      ) : null}
    </span>
  );
}

/** A metric with its source named, so nobody has to guess where a number came from. */
export function MetricCard({
  label,
  value,
  source,
  current,
  previous,
  lowerIsBetter = false,
  note,
}: {
  label: string;
  value: string;
  source: "GSC" | "GA4";
  current: number | null;
  previous: number | null;
  lowerIsBetter?: boolean;
  note?: string;
}) {
  return (
    <div className="border-border flex flex-col gap-1 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <span className="border-border text-muted-foreground rounded border px-1 py-0.5 font-mono text-[10px]">
          {source}
        </span>
      </div>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <Delta current={current} previous={previous} lowerIsBetter={lowerIsBetter} />
      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
    </div>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const tone =
    severity === "HIGH"
      ? "border-red-300 text-red-800 dark:border-red-900 dark:text-red-300"
      : severity === "MEDIUM"
        ? "border-amber-300 text-amber-800 dark:border-amber-900 dark:text-amber-300"
        : "border-border text-muted-foreground";

  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wide ${tone}`}>
      {severity}
    </span>
  );
}

/**
 * A persistent marker on every screen showing demo data.
 *
 * Not a footnote: someone arriving mid-demo, or seeing a screenshot later, has to
 * be able to tell that these numbers are synthetic.
 */
export function DemoBadge() {
  return (
    <span className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
      DEMO DATA
    </span>
  );
}

export function TableEmpty({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={99} className="text-muted-foreground px-4 py-8 text-center text-sm">
        {children}
      </td>
    </tr>
  );
}
