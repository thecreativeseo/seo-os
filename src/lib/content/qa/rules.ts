import { checkDraftConstraints, type MachineRule } from "@/lib/content/constraints";
import {
  notCheckedFinding,
  typeResult,
  type QaCoverage,
  type QaFinding,
  type QaTypeResult,
} from "@/lib/content/qa/findings";
import type { QaContext, QaSubject } from "@/lib/content/qa/types";

/**
 * SEO rules (docs/P4_SPEC.md §12; M5 plan §9, D6). Rules with a machine
 * check are measured, at the severity the rule declares. Rules that are
 * prose can only be judged, and judging is the AI pass's job: until it
 * runs, each is NOT CHECKED, and a BLOCKING one is flagged for a person.
 */

export function checkRules(subject: QaSubject, ctx: QaContext): QaTypeResult {
  const by = ctx.checkerVersion;
  const findings: QaFinding[] = [];
  const coverage: QaCoverage[] = [];

  const machine: MachineRule[] = ctx.rules
    .filter((rule) => rule.check !== null && rule.check !== undefined)
    .map((rule) => ({ ruleId: rule.ruleId, severity: rule.severity, check: rule.check }));
  const textual = ctx.rules.filter((rule) => rule.check === null || rule.check === undefined);
  const byId = new Map(ctx.rules.map((rule) => [rule.ruleId, rule]));

  const scan = checkDraftConstraints({
    mode: "human",
    title: subject.title,
    metaTitle: subject.metaTitle,
    metaDescription: subject.metaDescription,
    excerpt: subject.excerpt,
    bodyMarkdown: subject.bodyMarkdown,
    prohibitedPhrases: [],
    avoidTopics: [],
    staleClaims: [],
    approvedClaimTexts: [],
    allowedLinkPaths: [],
    siteHost: ctx.siteHost,
    rules: machine,
  });
  for (const found of scan.findings) {
    if (found.kind !== "RULE_CHECK" || !found.ruleId) continue;
    const rule = byId.get(found.ruleId);
    findings.push({
      code: "RULE_FAILED",
      qaType: "SEO_RULE_VALIDATION",
      severity: found.severity,
      source: "DETERMINISTIC",
      needsHumanConfirmation: false,
      message: rule ? `${found.message} Rule: ${rule.rule}` : found.message,
      field: found.field,
      excerpt: found.excerpt,
      refs: { ruleId: found.ruleId, pagePath: found.url },
      by,
    });
  }
  coverage.push({ check: "machine_rules", status: "CHECKED" });

  if (textual.length > 0) {
    const reason = "NO_PROVIDER";
    for (const rule of textual) {
      coverage.push({ check: `rule:${rule.ruleId}`, status: "NOT_CHECKED", reason });
      findings.push(
        notCheckedFinding("SEO_RULE_VALIDATION", `rule:${rule.ruleId}`, reason, by, {
          needsHumanConfirmation: rule.severity === "BLOCKING",
          message:
            rule.severity === "BLOCKING"
              ? `A BLOCKING rule has no machine check and was not judged; a person must confirm it is met: ${rule.rule}`
              : `A rule has no machine check and was not judged: ${rule.rule}`,
        }),
      );
    }
    // The finding carries the rule id for the screen.
    for (const finding of findings) {
      if (finding.code === "NOT_CHECKED" && finding.refs?.check?.startsWith("rule:")) {
        finding.refs.ruleId = finding.refs.check.slice("rule:".length);
      }
    }
  } else {
    coverage.push({ check: "textual_rules", status: "CHECKED" });
  }

  return typeResult({
    qaType: "SEO_RULE_VALIDATION",
    findings,
    coverage,
    considered: {
      machineRules: machine.length,
      textualRules: textual.length,
      ruleIds: ctx.rules.map((rule) => rule.ruleId),
    },
  });
}
