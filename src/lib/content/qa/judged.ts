import type { ContentQaOutput } from "@/lib/ai/schemas/content-qa";
import { plainText } from "@/lib/content/markdown";
import { approvedClaimTextsNow, classifyHighRisk } from "@/lib/content/qa/claims";
import {
  clip,
  describeReason,
  typeResult,
  type NotCheckedReason,
  type QaCoverage,
  type QaFinding,
  type QaSeverity,
  type QaTypeResult,
} from "@/lib/content/qa/findings";
import { normalizePhrase } from "@/lib/content/qa/text";
import type { QaContext, QaSubject } from "@/lib/content/qa/types";

/**
 * What the server does with a semantic judgment (M5 plan §4, §5, D6; M5.2).
 *
 * The model reports; the server decides. Every AI finding is capped at
 * WARNING, carries the AI run that made it, has its excerpt verified as a
 * verbatim piece of the approved revision or loses it with a note, and names
 * only references that resolve inside the task it was given. Where a
 * deterministic check already said the same thing, the deterministic finding
 * stands and the judgment is not repeated. When the judge could not run, the
 * sub-checks that needed it say so, each with the reason.
 */

/** The highest severity a judgment may carry. Release blocking (M5.2 §5). */
export const AI_FINDING_MAX_SEVERITY: QaSeverity = "WARNING";

export type AiFailureReason = Extract<
  NotCheckedReason,
  "NO_PROVIDER" | "AI_RUN_FAILED" | "INVALID_AI_OUTPUT"
>;

export const AI_EXCERPT_UNVERIFIED_NOTE =
  "AI excerpt could not be verified against the approved revision.";
export const AI_EXCERPT_WITHHELD_NOTE =
  "AI excerpt withheld: it reads as an instruction rather than content.";

/** The sub-checks a judge fills in, by coverage name (rules are rule:<id>). */
export const AI_JUDGED_CHECKS: readonly string[] = [
  "intent_alignment",
  "key_questions",
  "unlisted_claims",
  "paraphrased_prohibitions",
  "keyword_reads_naturally",
  "call_to_action",
  "brand_voice",
];

export function isJudgedCheck(check: string): boolean {
  return (
    AI_JUDGED_CHECKS.includes(check) || check.startsWith("rule:") || check.startsWith("question:")
  );
}

/** Never above the ceiling, whatever was asked. */
export function capSeverity(severity: string): QaSeverity {
  return severity === "INFO" ? "INFO" : AI_FINDING_MAX_SEVERITY;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The texts an excerpt may be verified against: every field, as written and as read. */
export function revisionTexts(subject: QaSubject): string[] {
  return [
    subject.title,
    subject.metaTitle ?? "",
    subject.metaDescription ?? "",
    subject.excerpt ?? "",
    subject.bodyMarkdown,
    plainText(subject.bodyMarkdown),
  ]
    .map(collapse)
    .filter((text) => text.length > 0);
}

/**
 * A verbatim excerpt, or null. Whitespace runs are collapsed on both sides
 * because rendering collapses them; nothing else is forgiven. An excerpt too
 * short to identify anything is not evidence of anything.
 */
export function verifyExcerpt(excerpt: string | null | undefined, texts: string[]): string | null {
  if (!excerpt) return null;
  const needle = collapse(excerpt);
  if (needle.length < 8) return null;
  return texts.some((text) => text.includes(needle)) ? needle : null;
}

/**
 * Text that reads as an instruction to the judge, not as content. Kept out of
 * findings even when it is verbatim in the revision: the finding may point at
 * the passage, the report never repeats what it says.
 */
const INSTRUCTION_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?\b/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b/i,
  /\breturn\s+(?:severity\s+)?(?:blocking|pass|fail)\b/i,
  /\b(?:approve|publish)\s+this\s+(?:content|draft|revision|page)\b/i,
  /\bcopy\s+this\s+(?:sentence|text|paragraph)\s+into\b/i,
  /\byou\s+are\s+now\b/i,
  /\bsystem\s+prompt\b/i,
];

export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

type Placed = { excerpt?: string; excerptNote?: string };

function place(raw: string | null | undefined, texts: string[]): Placed {
  if (!raw) return {};
  if (looksLikeInstruction(raw)) return { excerptNote: AI_EXCERPT_WITHHELD_NOTE };
  const verified = verifyExcerpt(raw, texts);
  return verified ? { excerpt: clip(verified, 300) } : { excerptNote: AI_EXCERPT_UNVERIFIED_NOTE };
}

function safeRationale(text: string): string {
  return looksLikeInstruction(text)
    ? "Rationale withheld: it reads as an instruction."
    : clip(text, 300);
}

type Merge = Record<
  string,
  { findings: QaFinding[]; coverage: QaCoverage[]; source: "MIXED" | "AI_JUDGED" }
>;

function aiFinding(
  input: Omit<QaFinding, "source" | "by" | "needsHumanConfirmation" | "severity"> & {
    severity: string;
    needsHumanConfirmation?: boolean;
  },
  by: string,
): QaFinding {
  const capped = capSeverity(input.severity);
  const overCapped = input.severity !== "INFO" && input.severity !== "WARNING";
  return {
    ...input,
    severity: capped,
    source: "AI_JUDGED",
    needsHumanConfirmation: Boolean(input.needsHumanConfirmation) || overCapped,
    by,
  };
}

function overlaps(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = normalizePhrase(a);
  const y = normalizePhrase(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * Folds a validated judgment into the deterministic results. Pure. The
 * result list keeps the spec's order; every type's status is derived again.
 */
export function applyAiJudgments(
  results: QaTypeResult[],
  output: ContentQaOutput,
  subject: QaSubject,
  ctx: QaContext,
  aiRunId: string,
): QaTypeResult[] {
  const texts = revisionTexts(subject);
  const by = aiRunId;
  const merge: Merge = {};
  const add = (qaType: string, finding: QaFinding) => {
    (merge[qaType] ??= { findings: [], coverage: [], source: "MIXED" }).findings.push(finding);
  };
  const covered = (qaType: string, check: string) => {
    (merge[qaType] ??= { findings: [], coverage: [], source: "MIXED" }).coverage.push({
      check,
      status: "CHECKED",
    });
  };
  const droppedReferences: Record<string, number> = {};
  const unverifiedExcerpts: Record<string, number> = {};
  const dropped = (qaType: string) => {
    droppedReferences[qaType] = (droppedReferences[qaType] ?? 0) + 1;
  };
  const unverified = (qaType: string) => {
    unverifiedExcerpts[qaType] = (unverifiedExcerpts[qaType] ?? 0) + 1;
  };

  // A. Intent alignment.
  {
    const judgment = output.intent_alignment;
    const placedExcerpts = judgment.excerpts.map((raw) => place(raw, texts));
    const excerptText =
      placedExcerpts.find((p) => p.excerpt) ?? placedExcerpts.find((p) => p.excerptNote) ?? {};
    if (judgment.status !== "ALIGNED") {
      add(
        "INTENT_ALIGNMENT",
        aiFinding(
          {
            code: judgment.status === "PARTIAL" ? "INTENT_PARTIAL" : "INTENT_MISALIGNED",
            qaType: "INTENT_ALIGNMENT",
            severity: "WARNING",
            needsHumanConfirmation: judgment.status === "MISALIGNED",
            message:
              judgment.status === "PARTIAL"
                ? `The piece only partly serves the brief's intent${ctx.brief.searchIntent ? ` (${ctx.brief.searchIntent})` : ""}: ${safeRationale(judgment.rationale)}`
                : `The piece does not serve the brief's intent${ctx.brief.searchIntent ? ` (${ctx.brief.searchIntent})` : ""}: ${safeRationale(judgment.rationale)}`,
            field: "body",
            ...(excerptText ?? {}),
          },
          by,
        ),
      );
    }
    covered("INTENT_ALIGNMENT", "intent_alignment");
    merge.INTENT_ALIGNMENT!.source = "AI_JUDGED";
  }

  // B. Answer readiness, per key question of the brief.
  {
    const questions = ctx.brief.keyQuestions.filter((q) => q.trim().length > 0);
    const byNormalized = new Map(questions.map((q) => [normalizePhrase(q), q]));
    const judged = new Set<string>();
    for (const answer of output.answer_readiness) {
      const question = byNormalized.get(normalizePhrase(answer.question));
      if (!question) {
        dropped("ANSWER_READINESS");
        continue;
      }
      if (judged.has(question)) continue;
      judged.add(question);
      const placed = place(answer.excerpt, texts);
      if (answer.excerpt && !placed.excerpt) unverified("ANSWER_READINESS");
      if (answer.status !== "ANSWERED") {
        add(
          "ANSWER_READINESS",
          aiFinding(
            {
              code: answer.status === "NOT_ANSWERED" ? "QUESTION_UNANSWERED" : "QUESTION_PARTIAL",
              qaType: "ANSWER_READINESS",
              severity: answer.status === "NOT_ANSWERED" ? "WARNING" : "INFO",
              message:
                answer.status === "NOT_ANSWERED"
                  ? `The piece does not answer "${question}".`
                  : `The piece only partly answers "${question}"${answer.heading ? ` (under "${clip(answer.heading, 120)}")` : ""}${answer.form !== "NONE" ? `, as ${answer.form.toLowerCase()} text` : ""}.`,
              field: "body",
              refs: { question, section: answer.heading ?? undefined },
              ...placed,
            },
            by,
          ),
        );
      }
    }
    if (questions.length > 0) covered("ANSWER_READINESS", "key_questions");
    for (const question of questions) {
      if (!judged.has(question)) {
        (merge.ANSWER_READINESS ??= {
          findings: [],
          coverage: [],
          source: "AI_JUDGED",
        }).coverage.push({
          check: `question:${question}`,
          status: "NOT_CHECKED",
          reason: "INVALID_AI_OUTPUT",
        });
        add(
          "ANSWER_READINESS",
          aiFinding(
            {
              code: "NOT_CHECKED",
              qaType: "ANSWER_READINESS",
              severity: "WARNING",
              message: `The judge returned no answer for "${question}".`,
              refs: { question, check: `question:${question}`, reason: "INVALID_AI_OUTPUT" },
            },
            by,
          ),
        );
      }
    }
    if (merge.ANSWER_READINESS) merge.ANSWER_READINESS.source = "AI_JUDGED";
  }

  // C. Prose rules.
  {
    const prose = ctx.rules.filter((rule) => rule.check === null || rule.check === undefined);
    const byId = new Map(prose.map((rule) => [rule.ruleId, rule]));
    const judged = new Set<string>();
    for (const judgment of output.rule_judgments) {
      const id = judgment.rule_id.replace(/^rule:/, "");
      const rule = byId.get(id);
      if (!rule) {
        dropped("SEO_RULE_VALIDATION");
        continue;
      }
      if (judged.has(rule.ruleId)) continue;
      judged.add(rule.ruleId);
      covered("SEO_RULE_VALIDATION", `rule:${rule.ruleId}`);
      if (judgment.status === "RESPECTED") continue;
      const placed = place(judgment.excerpt, texts);
      if (judgment.excerpt && !placed.excerpt) unverified("SEO_RULE_VALIDATION");
      const blocking = rule.severity === "BLOCKING";
      add(
        "SEO_RULE_VALIDATION",
        aiFinding(
          {
            code: judgment.status === "NOT_RESPECTED" ? "RULE_FAILED" : "RULE_UNCLEAR",
            qaType: "SEO_RULE_VALIDATION",
            severity: judgment.status === "NOT_RESPECTED" || blocking ? "WARNING" : "INFO",
            needsHumanConfirmation: blocking,
            message:
              judgment.status === "NOT_RESPECTED"
                ? `${blocking ? "A BLOCKING rule reads as not met; a person must confirm before this can be acted on" : "A rule reads as not met"}: ${rule.rule} ${safeRationale(judgment.rationale)}`
                : `${blocking ? "Whether a BLOCKING rule is met is unclear; a person must confirm" : "Whether a rule is met is unclear"}: ${rule.rule} ${safeRationale(judgment.rationale)}`,
            field: "body",
            refs: { ruleId: rule.ruleId },
            ...placed,
          },
          by,
        ),
      );
    }
  }

  // A prose rule the judge did not mention stays unjudged, and says so: the
  // provider was there, the judgment was not given.
  {
    const prose = ctx.rules.filter((rule) => rule.check === null || rule.check === undefined);
    const judged = new Set(
      (merge.SEO_RULE_VALIDATION?.coverage ?? [])
        .filter((entry) => entry.status === "CHECKED")
        .map((entry) => entry.check),
    );
    for (const rule of prose) {
      if (judged.has(`rule:${rule.ruleId}`)) continue;
      const bucket = (merge.SEO_RULE_VALIDATION ??= {
        findings: [],
        coverage: [],
        source: "MIXED",
      });
      bucket.coverage.push({
        check: `rule:${rule.ruleId}`,
        status: "NOT_CHECKED",
        reason: "INVALID_AI_OUTPUT",
      });
      bucket.findings.push(
        aiFinding(
          {
            code: "NOT_CHECKED",
            qaType: "SEO_RULE_VALIDATION",
            severity: "WARNING",
            needsHumanConfirmation: rule.severity === "BLOCKING",
            message:
              rule.severity === "BLOCKING"
                ? `The judge returned no judgment for a BLOCKING rule; a person must confirm it is met: ${rule.rule}`
                : `The judge returned no judgment for this rule: ${rule.rule}`,
            refs: {
              ruleId: rule.ruleId,
              check: `rule:${rule.ruleId}`,
              reason: "INVALID_AI_OUTPUT",
            },
          },
          by,
        ),
      );
    }
  }

  // D. Unlisted business claims: the model points, the server resolves.
  {
    const approved = approvedClaimTextsNow(subject, ctx);
    const deterministic = results.find((r) => r.qaType === "CLAIM_SAFETY")?.findings ?? [];
    const alreadyFlagged = deterministic
      .filter((f) =>
        [
          "HIGH_RISK_CLAIM",
          "UNSUPPORTED_NUMERIC_CLAIM",
          "PROHIBITED_CLAIM",
          "AVOID_TOPIC",
        ].includes(f.code),
      )
      .map((f) => f.excerpt);
    const listed = subject.claims.map((claim) => claim.text);
    const seen = new Set<string>();
    for (const candidate of output.unlisted_claims) {
      const placed = place(candidate.excerpt, texts);
      if (!placed.excerpt) {
        // A claim the revision does not contain is not a claim of the revision.
        unverified("CLAIM_SAFETY");
        continue;
      }
      const sentence = placed.excerpt;
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      const lower = sentence.toLowerCase();
      // Resolved deterministically: an approved claim text covers it, or a
      // listed claim already carries it.
      if (approved.some((text) => lower.includes(text.toLowerCase()))) continue;
      if (listed.some((text) => overlaps(sentence, text))) continue;
      // The deterministic scan already blocked it: that finding stands.
      if (alreadyFlagged.some((flagged) => overlaps(sentence, flagged))) continue;
      const highRisk = classifyHighRisk(sentence);
      const confirm =
        highRisk.length > 0 ||
        [
          "PRICING",
          "RESULTS",
          "CERTIFICATION",
          "COMPARISON",
          "PERFORMANCE",
          "SECURITY_COMPLIANCE",
          "CUSTOMERS",
        ].includes(candidate.category);
      add(
        "CLAIM_SAFETY",
        aiFinding(
          {
            code: "UNLISTED_CLAIM",
            qaType: "CLAIM_SAFETY",
            severity: "WARNING",
            needsHumanConfirmation: confirm,
            message: `A ${candidate.category.toLowerCase().replace(/_/g, " ")} claim the writer did not list, with no approved fact matched to it. List it with its fact, or take it out. ${safeRationale(candidate.rationale)}`,
            field: "body",
            excerpt: sentence,
            refs: { category: candidate.category },
          },
          by,
        ),
      );
    }
    covered("CLAIM_SAFETY", "unlisted_claims");
  }

  // E. Prohibited claims said in other words.
  {
    const prohibited = [
      ...(ctx.contextVersion?.prohibitedClaims ?? []),
      ...(ctx.contextVersion?.avoidTopics ?? []),
    ];
    const byNormalized = new Map(prohibited.map((text) => [normalizePhrase(text), text]));
    const deterministic = results.find((r) => r.qaType === "CLAIM_SAFETY")?.findings ?? [];
    const alreadyFlagged = deterministic
      .filter((f) => f.code === "PROHIBITED_CLAIM" || f.code === "AVOID_TOPIC")
      .map((f) => f.excerpt);
    const seen = new Set<string>();
    for (const candidate of output.prohibited_paraphrases) {
      const claim = byNormalized.get(normalizePhrase(candidate.prohibited_claim));
      if (!claim) {
        dropped("CLAIM_SAFETY");
        continue;
      }
      const placed = place(candidate.excerpt, texts);
      if (!placed.excerpt) {
        unverified("CLAIM_SAFETY");
        continue;
      }
      if (seen.has(placed.excerpt)) continue;
      seen.add(placed.excerpt);
      if (alreadyFlagged.some((flagged) => overlaps(placed.excerpt, flagged))) continue;
      add(
        "CLAIM_SAFETY",
        aiFinding(
          {
            code: "PARAPHRASED_PROHIBITION",
            qaType: "CLAIM_SAFETY",
            severity: "WARNING",
            needsHumanConfirmation: true,
            message: `This reads as "${claim}" in other words, which the approved context prohibits; a person must confirm. ${safeRationale(candidate.rationale)}`,
            field: "body",
            excerpt: placed.excerpt,
          },
          by,
        ),
      );
    }
    if (prohibited.length > 0) covered("CLAIM_SAFETY", "paraphrased_prohibitions");
  }

  // F. Call to action.
  if (ctx.brief.primaryConversion) {
    const judgment = output.call_to_action;
    if (judgment) {
      const placed = place(judgment.excerpt, texts);
      if (judgment.excerpt && !placed.excerpt) unverified("ON_PAGE_SEO");
      if (judgment.status !== "PRESENT") {
        add(
          "ON_PAGE_SEO",
          aiFinding(
            {
              code: judgment.status === "ABSENT" ? "CTA_MISSING" : "CTA_WEAK",
              qaType: "ON_PAGE_SEO",
              severity: judgment.status === "ABSENT" ? "WARNING" : "INFO",
              message:
                judgment.status === "ABSENT"
                  ? `The brief's primary conversion ("${ctx.brief.primaryConversion}") has no call to action in the piece. ${safeRationale(judgment.rationale)}`
                  : `The call to action for "${ctx.brief.primaryConversion}" is weak. ${safeRationale(judgment.rationale)}`,
              field: "body",
              ...placed,
            },
            by,
          ),
        );
      }
      covered("ON_PAGE_SEO", "call_to_action");
    }
  }

  // G. Natural keyword use. Absence is the deterministic check's finding.
  if (ctx.brief.primaryKeyword) {
    const judgment = output.keyword_use;
    if (judgment) {
      const placed = place(judgment.excerpt, texts);
      if (judgment.excerpt && !placed.excerpt) unverified("ON_PAGE_SEO");
      if (judgment.status === "AWKWARD") {
        add(
          "ON_PAGE_SEO",
          aiFinding(
            {
              code: "KEYWORD_AWKWARD",
              qaType: "ON_PAGE_SEO",
              severity: "WARNING",
              message: `The primary keyword "${ctx.brief.primaryKeyword}" reads as forced. ${safeRationale(judgment.rationale)}`,
              field: "body",
              ...placed,
            },
            by,
          ),
        );
      }
      covered("ON_PAGE_SEO", "keyword_reads_naturally");
    }
  }

  // H. Brand voice.
  {
    const judgment = output.brand_voice;
    const placed = place(judgment.excerpt, texts);
    if (judgment.excerpt && !placed.excerpt) unverified("READABILITY");
    if (judgment.status !== "MATCHES") {
      add(
        "READABILITY",
        aiFinding(
          {
            code: "VOICE_MISMATCH",
            qaType: "READABILITY",
            severity: judgment.status === "DOES_NOT_MATCH" ? "WARNING" : "INFO",
            message:
              judgment.status === "DOES_NOT_MATCH"
                ? `The piece does not sound like the brand voice. ${safeRationale(judgment.rationale)}`
                : `The piece only partly matches the brand voice. ${safeRationale(judgment.rationale)}`,
            field: "body",
            ...placed,
          },
          by,
        ),
      );
    }
    covered("READABILITY", "brand_voice");
  }

  return results.map((result) => {
    const extra = merge[result.qaType];
    if (!extra) return result;
    // Every sub-check the judge spoke to - whether it judged it or said it
    // did not - replaces the placeholder the deterministic pass left.
    const named = new Set(extra.coverage.map((entry) => entry.check));
    const coverage = [
      ...result.coverage.filter((entry) => !named.has(entry.check)),
      ...extra.coverage,
    ];
    const findings = [
      ...result.findings.filter(
        (finding) =>
          !(finding.code === "NOT_CHECKED" && finding.refs?.check && named.has(finding.refs.check)),
      ),
      ...extra.findings,
    ];
    const deterministic = result.findings.some((finding) => finding.code !== "NOT_CHECKED");
    const source =
      extra.source === "AI_JUDGED" && !deterministic
        ? "AI_JUDGED"
        : deterministic ||
            result.coverage.some((c) => c.status === "CHECKED" && !isJudgedCheck(c.check))
          ? "MIXED"
          : "AI_JUDGED";
    return typeResult({
      qaType: result.qaType,
      findings,
      coverage,
      source,
      considered: {
        ...result.considered,
        aiRunId,
        droppedReferences: droppedReferences[result.qaType] ?? 0,
        unverifiedExcerpts: unverifiedExcerpts[result.qaType] ?? 0,
      },
    });
  });
}

/**
 * When the judge could not run: every judged sub-check says why, nothing
 * else changes. Deterministic findings stand exactly as they were.
 */
export function applyAiFailure(results: QaTypeResult[], reason: AiFailureReason): QaTypeResult[] {
  return results.map((result) => {
    const touched = result.coverage.some(
      (entry) => entry.status === "NOT_CHECKED" && isJudgedCheck(entry.check),
    );
    if (!touched) return result;
    const coverage = result.coverage.map((entry) =>
      entry.status === "NOT_CHECKED" && isJudgedCheck(entry.check) ? { ...entry, reason } : entry,
    );
    const findings = result.findings.map((finding) =>
      finding.code === "NOT_CHECKED" && finding.refs?.check && isJudgedCheck(finding.refs.check)
        ? {
            ...finding,
            message: finding.message
              .replace(
                /could not be checked: .*$/,
                `could not be checked: ${describeReason(reason)}.`,
              )
              .replace(/was not judged[^:]*:/, "was not judged:"),
            refs: { ...finding.refs, reason },
          }
        : finding,
    );
    return typeResult({
      qaType: result.qaType,
      findings,
      coverage,
      source: result.source,
      considered: { ...result.considered, aiFailure: reason },
    });
  });
}
