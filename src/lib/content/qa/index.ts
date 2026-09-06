import { checkBrandFacts, checkClaimSafety } from "@/lib/content/qa/claims";
import { checkDuplication } from "@/lib/content/qa/duplication";
import { notCheckedFinding, typeResult, type QaTypeResult } from "@/lib/content/qa/findings";
import { checkLinks } from "@/lib/content/qa/links";
import { checkOnPage } from "@/lib/content/qa/on-page";
import { checkReadability } from "@/lib/content/qa/readability";
import { checkRules } from "@/lib/content/qa/rules";
import { checkStructure } from "@/lib/content/qa/structure";
import type { QaContext, QaSubject } from "@/lib/content/qa/types";

export * from "@/lib/content/qa/findings";
export * from "@/lib/content/qa/types";
export {
  approvedClaimTextsNow,
  classifyHighRisk,
  HIGH_RISK_PATTERNS,
} from "@/lib/content/qa/claims";
export { inputsFingerprint, type FingerprintInputs } from "@/lib/content/qa/fingerprint";
export * from "@/lib/content/qa/judged";

/** The version every deterministic result carries. Bump when any check's behavior changes. */
export const QA_CHECKER_VERSION = "qa-deterministic/1";

/**
 * Every type, in the spec's order, from the deterministic checks alone.
 * Pure: same subject and context, same results, forever. The two types that
 * are judgement through and through - intent, answer readiness - are NOT
 * CHECKED here and filled in by the AI pass when it exists.
 */
export function runDeterministicChecks(subject: QaSubject, ctx: QaContext): QaTypeResult[] {
  const by = ctx.checkerVersion;
  const judgedReason = "NO_PROVIDER";
  const intent = typeResult({
    qaType: "INTENT_ALIGNMENT",
    findings: [notCheckedFinding("INTENT_ALIGNMENT", "intent_alignment", judgedReason, by)],
    coverage: [{ check: "intent_alignment", status: "NOT_CHECKED", reason: judgedReason }],
    considered: { searchIntent: ctx.brief.searchIntent ?? "" },
  });
  const questions = ctx.brief.keyQuestions.filter((question) => question.trim().length > 0);
  const answerReason = questions.length === 0 ? "NO_KEY_QUESTIONS" : judgedReason;
  const answers = typeResult({
    qaType: "ANSWER_READINESS",
    findings: [notCheckedFinding("ANSWER_READINESS", "key_questions", answerReason, by)],
    coverage: [{ check: "key_questions", status: "NOT_CHECKED", reason: answerReason }],
    considered: { keyQuestions: questions.length },
  });

  return [
    checkBrandFacts(subject, ctx),
    checkRules(subject, ctx),
    checkOnPage(subject, ctx),
    intent,
    answers,
    checkLinks(subject, ctx),
    checkClaimSafety(subject, ctx),
    checkStructure(subject, ctx),
    checkReadability(subject, ctx),
    checkDuplication(subject, ctx),
  ];
}
