import type { ReconciledClaim } from "@/lib/content/reconcile";
import {
  claimPresentation,
  type ClaimStatus,
  type RevisionClaimLike,
} from "@/lib/content/draft-ux";

/**
 * The claims a revision makes and where each stands (M4.4 §6): supported by
 * approved evidence, unsupported, or stale because the fact behind it was
 * revoked. Sources are named as kinds of record - Brand Fact, Business
 * Context - and the id sits underneath in small type for whoever needs it.
 */

const STATUS_LABEL: Record<ClaimStatus, string> = {
  SUPPORTED: "Supported",
  UNSUPPORTED: "Unsupported",
  STALE: "Stale — fact revoked",
};

const STATUS_TONE: Record<ClaimStatus, string> = {
  SUPPORTED: "border-emerald-700/40 text-emerald-700 dark:text-emerald-400",
  UNSUPPORTED: "border-amber-700/40 text-amber-700 dark:text-amber-400",
  STALE: "border-red-300 text-red-800 dark:border-red-900 dark:text-red-300",
};

export function ClaimStatusLabel({ status }: { status: ClaimStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function ClaimsPanel({
  claims,
  staleClaims = [],
  openQuestions = [],
}: {
  claims: RevisionClaimLike[];
  staleClaims?: ReconciledClaim[];
  openQuestions?: string[];
}) {
  const shown = claims.map((claim) => claimPresentation(claim, staleClaims));
  const supported = shown.filter((claim) => claim.status === "SUPPORTED").length;

  return (
    <section aria-labelledby="claims-heading" className="space-y-3">
      <h2 id="claims-heading" className="text-sm font-medium">
        Claims and evidence
        <span className="text-muted-foreground font-normal">
          {" "}
          · {supported} of {shown.length} supported
        </span>
      </h2>

      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No business claims are declared for this revision.
        </p>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border text-sm">
          {shown.map((claim, index) => (
            <li key={`${claim.text}-${index}`} className="space-y-1 px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <ClaimStatusLabel status={claim.status} />
                <span className="break-words">{claim.text}</span>
              </div>
              <p className="text-muted-foreground text-xs">
                {claim.source}
                {claim.detail ? ` · ${claim.detail}` : ""}
              </p>
              {claim.evidenceId ? (
                <p className="text-muted-foreground/70 font-mono text-[10px] break-all">
                  {claim.evidenceId}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {openQuestions.length > 0 ? (
        <div className="text-sm">
          <p className="font-medium">Open questions the writer left</p>
          <ul className="text-muted-foreground list-disc pl-5 text-xs">
            {openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
