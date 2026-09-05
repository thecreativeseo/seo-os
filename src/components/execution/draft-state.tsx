import { draftStateText, type DraftStateKind } from "@/lib/content/draft-ux";

/**
 * A state of the draft workflow, said plainly (M4.4 §13). The tone is
 * carried by a word on the left as well as by the border, so nothing rests
 * on colour.
 */

const TONE: Record<DraftStateKind, { word: string; className: string }> = {
  no_drafts: { word: "Empty", className: "border-border border-dashed" },
  no_provider: { word: "Setup", className: "border-amber-300 dark:border-amber-900" },
  generation_in_progress: { word: "Running", className: "border-amber-300 dark:border-amber-900" },
  generation_failed: { word: "Failed", className: "border-red-300 dark:border-red-900" },
  no_revision: { word: "Empty", className: "border-border border-dashed" },
  blocking: { word: "Blocked", className: "border-red-300 dark:border-red-900" },
  awaiting_review: { word: "In review", className: "border-amber-300 dark:border-amber-900" },
  newer_brief: { word: "Notice", className: "border-amber-300 dark:border-amber-900" },
  superseded: { word: "Read-only", className: "border-border" },
  stale_evidence: { word: "Notice", className: "border-red-300 dark:border-red-900" },
};

export function DraftStateNotice({
  kind,
  detail,
  children,
}: {
  kind: DraftStateKind;
  detail?: { briefVersion?: number; approvedVersion?: number; count?: number };
  /** Controls or links that belong to the state. */
  children?: React.ReactNode;
}) {
  const text = draftStateText(kind, detail);
  const tone = TONE[kind];
  return (
    <div role="status" className={`rounded-lg border p-3 text-sm ${tone.className}`}>
      <p className="flex flex-wrap items-baseline gap-2">
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {tone.word}
        </span>
        <span className="font-medium">{text.title}</span>
      </p>
      <p className="text-muted-foreground mt-1">{text.body}</p>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}
