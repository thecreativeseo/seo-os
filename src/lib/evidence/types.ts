import type { EvidenceCategory, EvidenceReliability } from "@/generated/prisma/client";

/**
 * The normalized evidence record (docs/P3_SPEC.md §9, §10).
 *
 * One shape over records from every phase — Search Console days, ranking
 * snapshots, business context, a page's own words — so the assembler can gather,
 * deduplicate, cap and hash without knowing what any of them are, and so the
 * model receives one consistent thing rather than fourteen bespoke ones.
 *
 * Flattening is deliberate. Anything the model is asked to reason about arrives
 * as an identity, a label, a number or a string, and a small context object. A
 * record it cannot cite by ID is a record it should not have.
 *
 * Reliability is not decoration. §10 requires that AI-inferred evidence is never
 * presented as equivalent to something measured, and the only way to hold that
 * line is to carry the distinction on every record from the moment it is created.
 * A previous diagnosis is real evidence — it is also a model's opinion, and it
 * says so.
 */

export type Evidence = {
  /** The deterministic, re-resolvable identity from lib/evidence/id. */
  id: string;
  websiteId: string;
  type: EvidenceCategory;
  /** Where it came from, in words a person would use: "Search Console", "Semrush". */
  source: string;
  /** The table it was read from, so provenance stays inspectable. */
  sourceEntityType: string;
  sourceEntityId: string | null;
  capturedAt: Date | null;
  /** The date the fact is about, which is rarely the date it was captured. */
  asOfDate: Date | null;
  metricKey: string | null;
  numericValue: number | null;
  textValue: string | null;
  contextJson: Record<string, unknown> | null;
  reliability: EvidenceReliability;
};

/**
 * How much weight each source carries.
 *
 * Stated once, here, rather than decided at each of the fourteen call sites that
 * create evidence — because the one that gets it wrong is the one that quietly
 * promotes a model's guess to a measurement.
 */
export const RELIABILITY_BY_TYPE: Record<EvidenceCategory, EvidenceReliability> = {
  // Measured by us, about us.
  PAGE_CONTENT: "DIRECT_FIRST_PARTY",
  INTERNAL_LINK: "DIRECT_FIRST_PARTY",

  // Measured by a provider we connected to.
  GSC_METRIC: "DIRECT_PROVIDER",
  GA4_METRIC: "DIRECT_PROVIDER",
  KEYWORD_METRIC: "DIRECT_PROVIDER",
  RANKING_SNAPSHOT: "DIRECT_PROVIDER",
  COMPETITOR_OBSERVATION: "DIRECT_PROVIDER",

  // Stated by the customer. True by definition for context; a claim otherwise.
  BUSINESS_CONTEXT: "USER_PROVIDED",
  BUSINESS_GOAL: "USER_PROVIDED",
  BRAND_FACT: "USER_PROVIDED",
  SEO_RULE: "USER_PROVIDED",
  KEYWORD_OWNERSHIP: "USER_PROVIDED",
  MANUAL_VERIFICATION: "USER_PROVIDED",

  // Computed by SEO OS from the above. Deterministic, but a step removed.
  TOPIC_MAPPING: "SYSTEM_DERIVED",
  TECHNICAL_FINDING: "SYSTEM_DERIVED",
  PREVIOUS_CHANGE: "SYSTEM_DERIVED",

  // A model's earlier opinion. Usable, never equivalent to a measurement.
  PREVIOUS_DIAGNOSIS: "AI_INFERRED",
  PREVIOUS_LEARNING: "AI_INFERRED",
};

/** Ordering for display and for what survives a cap. Most direct first. */
export const RELIABILITY_ORDER: EvidenceReliability[] = [
  "DIRECT_FIRST_PARTY",
  "DIRECT_PROVIDER",
  "USER_PROVIDED",
  "SYSTEM_DERIVED",
  "AI_INFERRED",
  "UNKNOWN",
];

export function reliabilityRank(reliability: EvidenceReliability): number {
  const index = RELIABILITY_ORDER.indexOf(reliability);
  return index === -1 ? RELIABILITY_ORDER.length : index;
}

/** Words for a person, not an enum for a machine. */
export const RELIABILITY_LABELS: Record<EvidenceReliability, string> = {
  DIRECT_FIRST_PARTY: "Measured on this site",
  DIRECT_PROVIDER: "Reported by a connected provider",
  USER_PROVIDED: "Provided by your team",
  SYSTEM_DERIVED: "Calculated by SEO OS",
  AI_INFERRED: "Inferred by a model",
  UNKNOWN: "Source not recorded",
};

/**
 * A rendered evidence line, as the model sees it.
 *
 * Kept short on purpose. The context window is a budget, and a diagnosis is
 * better served by forty records it can cite than by six it can quote.
 */
export function renderEvidence(evidence: Evidence): string {
  const parts = [`[${evidence.id}]`, evidence.type];

  if (evidence.metricKey) parts.push(evidence.metricKey);
  if (evidence.numericValue !== null) parts.push(String(evidence.numericValue));
  if (evidence.asOfDate) parts.push(`as of ${evidence.asOfDate.toISOString().slice(0, 10)}`);

  parts.push(`(${evidence.source}, ${evidence.reliability})`);

  if (evidence.textValue) parts.push(`\n    ${evidence.textValue}`);

  if (evidence.contextJson && Object.keys(evidence.contextJson).length > 0) {
    parts.push(`\n    ${JSON.stringify(evidence.contextJson)}`);
  }

  return parts.join(" ");
}
