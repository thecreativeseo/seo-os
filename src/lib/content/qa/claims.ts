import { checkDraftConstraints } from "@/lib/content/constraints";
import { plainText } from "@/lib/content/markdown";
import {
  clip,
  notCheckedFinding,
  typeResult,
  type QaCoverage,
  type QaFinding,
  type QaTypeResult,
} from "@/lib/content/qa/findings";
import { phrasePattern, splitSentences } from "@/lib/content/qa/text";
import type { ClaimRef, QaContext, QaSubject } from "@/lib/content/qa/types";

/**
 * Claims (docs/P4_SPEC.md §15; M5 plan §7, §8, D7).
 *
 * BRAND_FACT_VALIDATION asks, of every claim the revision lists and every
 * claim the brief allowed that the text still makes, whether the fact behind
 * it is approved now. A fact revoked after the editorial approval makes its
 * claim stale, and stale blocks. A claim with nothing behind it blocks when
 * it is high-risk and warns when it is ordinary.
 *
 * CLAIM_SAFETY reads the text itself: the prohibited claims and avoid-topics
 * of the approved context, figures nobody approved, links with unsafe
 * schemes, and sentences that make a high-risk assertion in words rather
 * than digits. All lexical. The judged parts - claims the writer did not
 * list, prohibitions said in other words - belong to the AI pass.
 */

/**
 * High-risk categories (D7): assertions that, made without an approved fact,
 * put the business on the hook. Digits are the numeric scan's business; these
 * patterns catch the same risks said in words. Each pattern is deliberately
 * narrow: a false block stops legitimate content, and a person can always
 * list the claim with its fact.
 */
export const HIGH_RISK_PATTERNS: readonly { category: string; pattern: RegExp }[] = [
  { category: "percentage", pattern: /\d\s?%|\bpercent\b/iu },
  {
    category: "count",
    pattern:
      /\b(hundreds|thousands|millions|billions|dozens)\s+of\s+(?:\w+\s+){0,2}(customers|users|clients|businesses|companies|teams|employees|subscribers|members|downloads|installs|reviews|payslips|employers)\b/iu,
  },
  {
    category: "price",
    pattern:
      /[$€£₱¥]\s?\d|\b(free (?:trial|plan|forever)|(?:\d+%|half) off|discounted|discounts?)\b/iu,
  },
  {
    category: "certification",
    pattern: /\b(certified|accredited)\b|\biso\s?\d{4,5}\b|\bsoc\s?2\b|\bpci[- ]dss\b/iu,
  },
  {
    category: "compliance",
    pattern:
      /\b(?:we|it|they|our \w+|the (?:software|platform|tool|product|service|app|system))\s+(?:is|are|stays?|remains?|keeps? (?:you|them))\s+(?:\w+\s+){0,3}(?:compliant|certified|accredited|secure|encrypted)\b|\b(?:bir|dole|gdpr|hipaa|ccpa|sec)[- ](?:compliant|approved|registered|ready)\b|\b(?:fully|100%|always|completely)\s+(?:compliant|secure|accurate|safe)\b/iu,
  },
  {
    category: "guarantee",
    pattern:
      /\bguarantee[sd]?\b|\b(?:bank-level|military-grade|end-to-end)\s+(?:security|encryption)\b|\bnever\s+(?:shared|sold|lost|leaked)\b/iu,
  },
  {
    category: "superlative",
    pattern:
      /\b(?:the|our|is|are|as|be|remains?)\s+(?:best|fastest|leading|largest|biggest|most (?:trusted|popular|reliable|accurate|complete|affordable)|number one|#1|no\.\s?1|top[- ]rated)\s+(?!(?:practices?|way|ways|time|part|place|effort|of|thing|approach|option|options|fit|guess|case|bet)\b)\w/iu,
  },
  {
    category: "comparison",
    pattern:
      /\b(?:better|faster|cheaper|more (?:accurate|affordable|reliable|secure|powerful)|less expensive)\s+than\s+(?!(?:it|you|ever|before|expected|that|this)\b)|\boutperforms?\b|\bunlike (?:other|most|any)\b/iu,
  },
  {
    category: "outcome",
    pattern:
      /\b(?:increase|increases|boost|boosts|double|doubles|triple|triples|cut|cuts|reduce|reduces|save|saves|grow|grows)\s+(?:your\s+)?(?:\w+\s+){0,2}(?:revenue|profit|profits|sales|conversions?|traffic|rankings?|costs?|time|hours|churn|roi)\s+(?:by|in half|by half|twofold|tenfold|\d)|\bwill\s+(?:increase|boost|double|reduce|cut|save|grow)\b|\b(?:in|within)\s+(?:\d+|a few|two|three)\s+(?:days|weeks|hours|minutes)\b|\b(?:guaranteed|proven)\s+(?:roi|results|returns)\b/iu,
  },
];

/** The high-risk categories a sentence asserts; empty when it asserts none. */
export function classifyHighRisk(sentence: string): string[] {
  return HIGH_RISK_PATTERNS.filter(({ pattern }) => pattern.test(sentence)).map(
    ({ category }) => category,
  );
}

/** Whether the evidence behind a claim is approved now. */
function approvedNow(ref: ClaimRef | null, ctx: QaContext): boolean {
  if (!ref) return false;
  if (ref.kind === "fact") return ctx.facts.find((fact) => fact.id === ref.id)?.approved === true;
  if (ref.kind === "context") return ctx.contextVersion?.id === ref.id;
  return false;
}

/**
 * Claim texts that are safe to make right now: brief claims whose fact is
 * still approved, and listed claims whose fact is still approved. A sentence
 * carrying one of these is not an unsupported assertion.
 */
export function approvedClaimTextsNow(subject: QaSubject, ctx: QaContext): string[] {
  const texts = new Set<string>();
  for (const claim of ctx.brief.approvedClaims) {
    if (approvedNow(claim.ref, ctx)) texts.add(claim.text);
  }
  for (const claim of subject.claims) {
    if (approvedNow(claim.ref, ctx)) texts.add(claim.text);
  }
  return [...texts].filter((text) => text.length > 0);
}

function coveredByApproved(sentence: string, approvedTexts: string[]): boolean {
  const lower = sentence.toLowerCase();
  return approvedTexts.some((text) => text.length > 0 && lower.includes(text.toLowerCase()));
}

function revisionText(subject: QaSubject): string {
  return [
    subject.title,
    subject.metaTitle ?? "",
    subject.metaDescription ?? "",
    subject.excerpt ?? "",
    plainText(subject.bodyMarkdown),
  ].join("\n");
}

export function checkBrandFacts(subject: QaSubject, ctx: QaContext): QaTypeResult {
  const by = ctx.checkerVersion;
  const facts = new Map(ctx.facts.map((fact) => [fact.id, fact]));
  const findings: QaFinding[] = [];
  let supported = 0;
  const base = {
    qaType: "BRAND_FACT_VALIDATION" as const,
    source: "DETERMINISTIC" as const,
    needsHumanConfirmation: false,
    by,
  };

  // The claims the revision lists.
  for (const claim of subject.claims) {
    const highRisk = classifyHighRisk(claim.text);
    const where = { field: "claims", excerpt: clip(claim.text) };

    if (!claim.ref) {
      findings.push(
        highRisk.length > 0
          ? {
              ...base,
              ...where,
              code: "MISSING_APPROVED_FACT",
              severity: "BLOCKING",
              message: `MISSING APPROVED FACT: no approved Brand Fact supports this ${highRisk.join(", ")} claim.`,
              refs: { category: highRisk.join(",") },
            }
          : {
              ...base,
              ...where,
              code: "UNSUPPORTED_CLAIM",
              severity: "WARNING",
              message:
                "No approved Brand Fact supports this claim. Add the fact, or soften the claim.",
            },
      );
      continue;
    }

    if (claim.ref.kind === "fact") {
      const fact = facts.get(claim.ref.id);
      if (!fact) {
        findings.push({
          ...base,
          ...where,
          code: "UNRESOLVED_EVIDENCE",
          severity: highRisk.length > 0 ? "BLOCKING" : "WARNING",
          message: "The fact this claim cites is not one of this website's facts.",
          refs: { evidenceId: claim.evidenceId ?? undefined, factId: claim.ref.id },
        });
        continue;
      }
      if (!fact.approved) {
        findings.push({
          ...base,
          ...where,
          code: "STALE_CLAIM",
          severity: "BLOCKING",
          message:
            "This claim rested on a fact that is no longer approved. Remove it, or have the fact approved again.",
          refs: { factId: fact.id, evidenceId: claim.evidenceId ?? undefined },
        });
        continue;
      }
      supported += 1;
      continue;
    }

    if (claim.ref.kind === "context") {
      if (ctx.contextVersion && ctx.contextVersion.id === claim.ref.id) {
        supported += 1;
      } else {
        findings.push({
          ...base,
          ...where,
          code: "STALE_CLAIM",
          severity: "BLOCKING",
          message:
            "This claim rested on a Business Context version that is no longer the approved one.",
          refs: { evidenceId: claim.evidenceId ?? undefined },
        });
      }
      continue;
    }

    findings.push({
      ...base,
      ...where,
      code: "UNRESOLVED_EVIDENCE",
      severity: highRisk.length > 0 ? "BLOCKING" : "WARNING",
      message: "The evidence this claim cites cannot be resolved.",
      refs: { evidenceId: claim.evidenceId ?? undefined },
    });
  }

  // The claims the brief allowed, still made by the text, whose fact has
  // since gone: stale at QA time even when the writer never listed them.
  const listed = new Set(subject.claims.map((claim) => claim.text.toLowerCase()));
  const text = revisionText(subject);
  let briefClaimsStale = 0;
  for (const claim of ctx.brief.approvedClaims) {
    if (listed.has(claim.text.toLowerCase())) continue;
    if (!claim.ref || approvedNow(claim.ref, ctx)) continue;
    const pattern = phrasePattern(claim.text);
    if (!pattern) continue;
    const match = pattern.exec(text);
    if (!match) continue;
    briefClaimsStale += 1;
    findings.push({
      ...base,
      code: "STALE_CLAIM",
      severity: "BLOCKING",
      message: `The brief allowed "${claim.text}" on a fact that is no longer approved, and the text still makes it. Remove it, or have the fact approved again.`,
      field: "body",
      excerpt: clip(claim.text),
      refs: {
        factId: claim.ref.kind === "fact" ? claim.ref.id : undefined,
        evidenceId: claim.evidenceId ?? undefined,
      },
    });
  }

  const coverage: QaCoverage[] = [
    { check: "listed_claims", status: "CHECKED" },
    { check: "brief_claims", status: "CHECKED" },
  ];
  return typeResult({
    qaType: "BRAND_FACT_VALIDATION",
    findings,
    coverage,
    considered: {
      claims: subject.claims.length,
      supported,
      briefClaims: ctx.brief.approvedClaims.length,
      briefClaimsStale,
      approvedFacts: ctx.facts.filter((fact) => fact.approved).length,
    },
  });
}

export function checkClaimSafety(subject: QaSubject, ctx: QaContext): QaTypeResult {
  const by = ctx.checkerVersion;
  const findings: QaFinding[] = [];
  const coverage: QaCoverage[] = [];
  const approvedTexts = approvedClaimTextsNow(subject, ctx);

  // The draft-time scan, on the exact text, with nothing removed: findings only.
  const scan = checkDraftConstraints({
    mode: "human",
    title: subject.title,
    metaTitle: subject.metaTitle,
    metaDescription: subject.metaDescription,
    excerpt: subject.excerpt,
    bodyMarkdown: subject.bodyMarkdown,
    prohibitedPhrases: ctx.contextVersion?.prohibitedClaims ?? [],
    avoidTopics: ctx.contextVersion?.avoidTopics ?? [],
    staleClaims: [],
    approvedClaimTexts: approvedTexts,
    allowedLinkPaths: [],
    siteHost: ctx.siteHost,
    rules: [],
  });

  for (const found of scan.findings) {
    const base = {
      qaType: "CLAIM_SAFETY" as const,
      source: "DETERMINISTIC" as const,
      needsHumanConfirmation: false,
      field: found.field,
      excerpt: found.excerpt,
      by,
    };
    switch (found.kind) {
      case "PROHIBITED_CLAIM":
        findings.push({
          ...base,
          code: "PROHIBITED_CLAIM",
          severity: "BLOCKING",
          message: found.message,
        });
        break;
      case "AVOID_TOPIC":
        findings.push({ ...base, code: "AVOID_TOPIC", severity: "BLOCKING", message: found.message });
        break;
      case "UNSUPPORTED_NUMERIC_CLAIM":
        findings.push({
          ...base,
          code: "UNSUPPORTED_NUMERIC_CLAIM",
          severity: "BLOCKING",
          message:
            "A figure about the business with no approved fact behind it. Figures are high-risk: cite an approved fact, or remove the figure.",
        });
        break;
      case "UNSAFE_LINK_REMOVED":
        findings.push({
          ...base,
          code: "UNSAFE_LINK",
          severity: "BLOCKING",
          message: "A link with an unsafe scheme. It cannot be published.",
          refs: found.url ? { pagePath: found.url } : undefined,
        });
        break;
      default:
        // Links and rules are other types' business.
        break;
    }
  }

  // High-risk assertions in words.
  const fields: { name: string; text: string }[] = [
    { name: "title", text: subject.title },
    { name: "meta_title", text: subject.metaTitle ?? "" },
    { name: "meta_description", text: subject.metaDescription ?? "" },
    { name: "excerpt", text: subject.excerpt ?? "" },
    { name: "body", text: plainText(subject.bodyMarkdown) },
  ];
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field.text) continue;
    for (const sentence of splitSentences(field.text)) {
      const categories = classifyHighRisk(sentence).filter(
        (category) => category !== "percentage",
      );
      if (categories.length === 0) continue;
      if (coveredByApproved(sentence, approvedTexts)) continue;
      const key = `${field.name}:${sentence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        code: "HIGH_RISK_CLAIM",
        qaType: "CLAIM_SAFETY",
        severity: "BLOCKING",
        source: "DETERMINISTIC",
        needsHumanConfirmation: false,
        message: `A high-risk claim (${categories.join(", ")}) with no approved fact behind it. Cite an approved fact in the claim list, or take the claim out.`,
        field: field.name,
        excerpt: clip(sentence),
        refs: { category: categories.join(",") },
        by,
      });
    }
  }

  coverage.push(
    ctx.contextVersion
      ? { check: "prohibited_claims", status: "CHECKED" }
      : { check: "prohibited_claims", status: "NOT_CHECKED", reason: "NO_CONTEXT_VERSION" },
    ctx.contextVersion
      ? { check: "avoid_topics", status: "CHECKED" }
      : { check: "avoid_topics", status: "NOT_CHECKED", reason: "NO_CONTEXT_VERSION" },
    { check: "numeric_claims", status: "CHECKED" },
    { check: "high_risk_claims", status: "CHECKED" },
    { check: "unsafe_links", status: "CHECKED" },
    {
      check: "unlisted_claims",
      status: "NOT_CHECKED",
      reason: ctx.aiAvailable ? "NO_PROVIDER" : "NOT_PRODUCED_YET",
    },
    {
      check: "paraphrased_prohibitions",
      status: "NOT_CHECKED",
      reason: ctx.aiAvailable ? "NO_PROVIDER" : "NOT_PRODUCED_YET",
    },
  );
  for (const entry of coverage) {
    if (entry.status === "NOT_CHECKED" && entry.reason) {
      findings.push(notCheckedFinding("CLAIM_SAFETY", entry.check, entry.reason, by));
    }
  }

  return typeResult({
    qaType: "CLAIM_SAFETY",
    findings,
    coverage,
    considered: {
      prohibitedClaims: ctx.contextVersion?.prohibitedClaims.length ?? 0,
      avoidTopics: ctx.contextVersion?.avoidTopics.length ?? 0,
      approvedClaimTexts: approvedTexts.length,
      contextVersionId: ctx.contextVersion?.id ?? "",
    },
  });
}
