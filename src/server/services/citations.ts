import type { TenantContext } from "@/server/auth/guards";
import { resolveEvidenceId } from "@/server/services/evidence";
import { parseEvidenceId } from "@/lib/evidence/id";

/**
 * Checking what a model cited (docs/P3_SPEC.md §26, §36).
 *
 * Shared by findings and recommendations, because the rule is the same for
 * both and a rule with two implementations is a rule that drifts: an evidence ID
 * returned by a model is accepted only if it was in the sealed package the model
 * was shown, and it still resolves to a row inside the caller's tenant scope.
 */

/**
 * What happened to the IDs the model cited.
 *
 * Kept as separate buckets rather than a count, because they mean different
 * things when something has gone wrong. An unparseable string suggests a model
 * improvising; a well-formed ID that was never in the package suggests one
 * reaching past what it was shown; an in-package ID that no longer resolves
 * means a row was deleted between assembly and now — nobody's fault, and it
 * still has to lower whatever rested on it.
 */
export type CitationAudit = {
  accepted: number;
  /** Not evidence IDs at all. */
  malformed: string[];
  /** Well-formed, but not among the records this package contained. */
  outsidePackage: string[];
  /** In the package, but the underlying row is no longer visible to this tenant. */
  unresolved: string[];
};

export function emptyCitationAudit(): CitationAudit {
  return { accepted: 0, malformed: [], outsidePackage: [], unresolved: [] };
}

/**
 * Decides which cited IDs are real.
 *
 * Two conditions, both required. The ID must be one of the records this package
 * actually contained, and it must still resolve to a row inside this tenant's
 * scope. Membership alone would treat the package as a capability; resolution
 * alone would let a claim cite something from this website that was never put
 * in front of the model, which is a quieter kind of fabrication.
 *
 * IDs failing the membership test are never looked up. Refusing them costs one
 * set lookup, and running a database query for an identifier a model invented is
 * not a habit worth acquiring.
 */
export async function validateCitations(
  context: TenantContext,
  raw: string[],
  packageIds: Set<string>,
  audit: CitationAudit,
): Promise<string[]> {
  const accepted: string[] = [];

  for (const candidate of raw) {
    if (!packageIds.has(candidate)) {
      if (parseEvidenceId(candidate)) audit.outsidePackage.push(candidate);
      else audit.malformed.push(candidate);
      continue;
    }

    const evidence = await resolveEvidenceId(context, candidate);

    if (!evidence) {
      audit.unresolved.push(candidate);
      continue;
    }

    accepted.push(candidate);
    audit.accepted += 1;
  }

  // A model that cited the same record twice meant it once.
  return [...new Set(accepted)];
}
