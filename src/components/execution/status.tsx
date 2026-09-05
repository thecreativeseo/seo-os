import { draftStatusLabel, workItemStatusLabel } from "@/lib/content/draft-ux";

/**
 * Status badges for the execution screens (M4.5). The same shape as the
 * P3 badge, with the words the P4 flow uses: a work item at QA reads
 * "Ready for QA" until M5 runs checks; an approved draft reads "Approved
 * for QA". Tone follows the status; the word carries the meaning.
 */

const BADGE = "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium";

const TONE: Record<string, string> = {
  APPROVED: "border-emerald-700/40 text-emerald-700 dark:text-emerald-400",
  QA: "border-emerald-700/40 text-emerald-700 dark:text-emerald-400",
  AWAITING_EDITOR_REVIEW: "border-amber-700/40 text-amber-700 dark:text-amber-400",
  AWAITING_QA: "border-amber-700/40 text-amber-700 dark:text-amber-400",
  SUPERSEDED: "border-border text-muted-foreground",
  ARCHIVED: "border-border text-muted-foreground",
  CANCELLED: "border-border text-muted-foreground",
  REJECTED: "border-border text-muted-foreground",
  FAILED: "border-red-700/40 text-red-700 dark:text-red-400",
};

export function WorkItemStatusBadge({ status }: { status: string }) {
  return (
    <span className={`${BADGE} ${TONE[status] ?? "border-border"}`}>
      {workItemStatusLabel(status)}
    </span>
  );
}

export function DraftStatusBadge({ status }: { status: string }) {
  return (
    <span className={`${BADGE} ${TONE[status] ?? "border-border"}`}>
      {draftStatusLabel(status)}
    </span>
  );
}
