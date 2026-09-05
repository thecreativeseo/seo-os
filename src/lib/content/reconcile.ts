/**
 * The pinned brief against the fresh package (M4 plan, D-M4-2 as clarified).
 *
 * The approved brief is authoritative for what the piece is: audience,
 * intent, structure, questions, provenance. The package assembled at drafting
 * time is authoritative for what is true now: which brand facts are approved,
 * which rules are active. Where the two disagree - a brief claim whose fact
 * has since been revoked, removed, or otherwise dropped out of the package -
 * the claim is marked STALE: not offered to the model as allowed, surfaced to
 * the editor, never silently replaced, and never written back into the brief.
 */

export type BriefClaimLike = { text: string; evidenceId: string; source: string };

export type ReconciledClaim = BriefClaimLike & {
  status: "VALID" | "STALE";
  reason: string | null;
};

export type ReconciledClaims = {
  valid: ReconciledClaim[];
  stale: ReconciledClaim[];
};

const CLAIM_SOURCES = new Set(["BRAND_FACT", "BUSINESS_CONTEXT"]);

/**
 * Splits the brief's approved claims by whether the current package still
 * vouches for them. `packageTypes` maps each evidence ID in the fresh package
 * to its category.
 */
export function reconcileBriefClaims(
  claims: BriefClaimLike[],
  packageTypes: Map<string, string>,
): ReconciledClaims {
  const valid: ReconciledClaim[] = [];
  const stale: ReconciledClaim[] = [];

  for (const claim of claims) {
    const type = packageTypes.get(claim.evidenceId);
    if (type && CLAIM_SOURCES.has(type)) {
      valid.push({ ...claim, status: "VALID", reason: null });
    } else if (type) {
      stale.push({
        ...claim,
        status: "STALE",
        reason: "The record behind this claim is not a brand fact or business context record.",
      });
    } else {
      stale.push({
        ...claim,
        status: "STALE",
        reason:
          "The fact behind this claim is no longer approved, or was removed, since the brief was approved.",
      });
    }
  }

  return { valid, stale };
}

export type BriefRuleLike = { ruleId: string; evidenceId: string; severity: string; rule: string };

export type ReconciledRules = {
  /** Rules active now, from the package. These are what the draft is held to. */
  active: {
    ruleId: string;
    evidenceId: string;
    severity: string;
    rule: string;
    checkJson: unknown;
  }[];
  /** Rules the brief named that are no longer active. Shown, not enforced. */
  retired: BriefRuleLike[];
};

/**
 * Rules come from the package, not the brief: a rule added since the brief
 * was approved applies, and one retired since does not.
 */
export function reconcileRules(
  briefRules: BriefRuleLike[],
  packageRules: ReconciledRules["active"],
): ReconciledRules {
  const activeIds = new Set(packageRules.map((rule) => rule.ruleId));
  return {
    active: packageRules,
    retired: briefRules.filter((rule) => !activeIds.has(rule.ruleId)),
  };
}
