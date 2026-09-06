import { createHash } from "node:crypto";

/**
 * The inputs fingerprint (M5 plan §17, D8): a hash over the facts, rules and
 * context version a QA run judged against. Recomputed at approval time and
 * before execution; a difference means the QA is stale and must be re-run,
 * and no old approval can authorize execution against a different report.
 */

export const INPUTS_FINGERPRINT_VERSION = 1;

export type FingerprintInputs = {
  contextVersionId: string | null;
  facts: { id: string; value: string; approved: boolean }[];
  rules: { ruleId: string; rule: string; severity: string; check: unknown | null }[];
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value ?? null;
}

export function inputsFingerprint(inputs: FingerprintInputs): string {
  const canonical = JSON.stringify(
    stable({
      v: INPUTS_FINGERPRINT_VERSION,
      contextVersionId: inputs.contextVersionId,
      facts: [...inputs.facts]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((fact) => ({ id: fact.id, value: fact.value, approved: fact.approved })),
      rules: [...inputs.rules]
        .sort((a, b) => a.ruleId.localeCompare(b.ruleId))
        .map((rule) => ({
          ruleId: rule.ruleId,
          rule: rule.rule,
          severity: rule.severity,
          check: rule.check ?? null,
        })),
    }),
  );
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
