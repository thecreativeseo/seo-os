import { extractLinks, plainText, stripLink } from "@/lib/content/markdown";

/**
 * What the server checks about a revision before it is stored (docs/P4_SPEC.md
 * §11, §15; M4 plan, "enforcement on the way in").
 *
 * Deterministic and lexical. It catches what the business wrote down - the
 * prohibited claims and avoid-topics of the approved context, a claim whose
 * fact has since been revoked, a number nobody approved, a link that leaves
 * the site - and says so in a finding attached to the revision. Judged checks
 * (intent, readability, paraphrased prohibitions) belong to QA in M5.
 *
 * Links are treated by who wrote them. A model's external links are removed
 * and reported: it was told to use only the brief's targets. A person's safe
 * http(s) links are kept and flagged for QA; only unsafe schemes, unsafe
 * markup, and links an explicit rule forbids are removed from human text.
 */

export type FindingKind =
  | "PROHIBITED_CLAIM"
  | "AVOID_TOPIC"
  | "STALE_CLAIM"
  | "UNSUPPORTED_NUMERIC_CLAIM"
  | "EXTERNAL_LINK_REMOVED"
  | "EXTERNAL_LINK_UNAPPROVED"
  | "UNSAFE_LINK_REMOVED"
  | "LINK_TARGET_NOT_IN_BRIEF"
  | "RULE_CHECK";

export type FindingSeverity = "BLOCKING" | "WARNING" | "INFO";

export type DraftFinding = {
  kind: FindingKind;
  severity: FindingSeverity;
  message: string;
  /** Where it was found: title, meta_title, meta_description, excerpt, body. */
  field?: string;
  excerpt?: string;
  url?: string;
  ruleId?: string;
};

/** A rule with a machine-readable check (SeoRule.checkJson, D8). */
export type MachineRule = {
  ruleId: string;
  severity: "INFO" | "WARNING" | "BLOCKING";
  check: unknown;
};

export type ConstraintInput = {
  /** Who wrote the text: the model or a person. Links are handled differently. */
  mode: "ai" | "human";
  title: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  excerpt?: string | null;
  bodyMarkdown: string;
  /** From the approved context, via the brief. Any occurrence blocks. */
  prohibitedPhrases: string[];
  avoidTopics: string[];
  /** Brief claims whose fact is no longer approved. Using one blocks. */
  staleClaims: string[];
  /** Approved claim texts; a sentence carrying one is not an unsupported number. */
  approvedClaimTexts: string[];
  /** Site-relative paths the brief named as link targets. */
  allowedLinkPaths: string[];
  /** The website's own host; links to it are internal. */
  siteHost: string;
  rules: MachineRule[];
};

export type ConstraintResult = {
  /** The markdown after removals. Identical to the input when nothing was removed. */
  bodyMarkdown: string;
  findings: DraftFinding[];
  blocking: boolean;
};

type Field = { name: string; text: string };

const UNSAFE_SCHEMES = /^(javascript|data|vbscript|file|about|blob):/i;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A phrase as a loose, case-insensitive pattern: any whitespace between words, word edges respected. */
function phrasePattern(phrase: string): RegExp | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || phrase.trim().length < 3) return null;
  const body = words.map(escapeRegExp).join("\\s+");
  const leading = /^[\p{L}\p{N}]/u.test(phrase.trim()) ? "(?<![\\p{L}\\p{N}])" : "";
  const trailing = /[\p{L}\p{N}]$/u.test(phrase.trim()) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${leading}${body}${trailing}`, "iu");
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function scanPhrases(
  fields: Field[],
  phrases: string[],
  kind: FindingKind,
  severity: FindingSeverity,
  describe: (phrase: string) => string,
): DraftFinding[] {
  const findings: DraftFinding[] = [];
  for (const phrase of phrases) {
    const pattern = phrasePattern(phrase);
    if (!pattern) continue;
    for (const field of fields) {
      const match = pattern.exec(field.text);
      if (!match) continue;
      findings.push({
        kind,
        severity,
        message: describe(phrase),
        field: field.name,
        excerpt: excerptAround(field.text, match.index, match[0].length),
      });
    }
  }
  return findings;
}

/**
 * Sentences that state a figure about the business. Percentages, money,
 * multipliers, and counts of customers, users and the like. A figure is fine
 * when the sentence carries an approved claim; otherwise nobody approved it.
 */
const NUMERIC_CLAIM = new RegExp(
  [
    String.raw`\d[\d,.]*\s?%`,
    String.raw`[$€£₱¥]\s?\d`,
    String.raw`\b\d[\d,.]*\s?(?:k|m|bn|million|billion)?\s*(?:customers|users|clients|businesses|companies|teams|employees|countries|reviews|downloads|installs|subscribers|members)\b`,
    String.raw`\b\d+(?:\.\d+)?x\b`,
    String.raw`\b(?:top|number|no\.?|#)\s?1\b`,
  ].join("|"),
  "i",
);

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function numericClaims(fields: Field[], approvedClaimTexts: string[]): DraftFinding[] {
  const approved = approvedClaimTexts.map((text) => text.toLowerCase());
  const findings: DraftFinding[] = [];
  for (const field of fields) {
    for (const sentence of splitSentences(field.text)) {
      if (!NUMERIC_CLAIM.test(sentence)) continue;
      const lower = sentence.toLowerCase();
      if (approved.some((claim) => claim.length > 0 && lower.includes(claim))) continue;
      findings.push({
        kind: "UNSUPPORTED_NUMERIC_CLAIM",
        severity: "WARNING",
        message: "A figure about the business with no approved fact behind it.",
        field: field.name,
        excerpt: sentence.length > 160 ? `${sentence.slice(0, 160)}…` : sentence,
      });
    }
  }
  return findings;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sameSite(host: string | null, siteHost: string): boolean {
  if (!host) return false;
  const site = siteHost.toLowerCase().replace(/^www\./, "");
  const candidate = host.replace(/^www\./, "");
  return candidate === site;
}

function pathOf(href: string, siteHost: string): string {
  if (href.startsWith("/")) return href.split(/[?#]/)[0] ?? href;
  try {
    return new URL(href, `https://${siteHost}`).pathname;
  } catch {
    return href;
  }
}

type RuleCheck =
  | { kind: "max_length"; field: string; max: number }
  | { kind: "min_length"; field: string; min: number }
  | { kind: "required_phrase"; field?: string; phrase: string }
  | { kind: "forbidden_phrase"; phrase: string }
  | { kind: "no_external_links" };

function parseCheck(value: unknown): RuleCheck | null {
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  const check = value as Record<string, unknown>;
  switch (check.kind) {
    case "max_length":
      return typeof check.field === "string" && typeof check.max === "number"
        ? { kind: "max_length", field: check.field, max: check.max }
        : null;
    case "min_length":
      return typeof check.field === "string" && typeof check.min === "number"
        ? { kind: "min_length", field: check.field, min: check.min }
        : null;
    case "required_phrase":
      return typeof check.phrase === "string"
        ? {
            kind: "required_phrase",
            phrase: check.phrase,
            field: typeof check.field === "string" ? check.field : undefined,
          }
        : null;
    case "forbidden_phrase":
      return typeof check.phrase === "string"
        ? { kind: "forbidden_phrase", phrase: check.phrase }
        : null;
    case "no_external_links":
      return { kind: "no_external_links" };
    default:
      return null;
  }
}

/** Runs every check the brief and the rules imply. Pure: no I/O, no clock. */
export function checkDraftConstraints(input: ConstraintInput): ConstraintResult {
  const findings: DraftFinding[] = [];
  let body = input.bodyMarkdown;

  // --- Links first, because removals change the body the other checks read.
  const parsedRules = input.rules
    .map((rule) => ({ rule, check: parseCheck(rule.check) }))
    .filter((entry): entry is { rule: MachineRule; check: RuleCheck } => entry.check !== null);
  const noExternal = parsedRules.find((entry) => entry.check.kind === "no_external_links");

  const seen = new Set<string>();
  for (const link of extractLinks(body)) {
    if (seen.has(link.href)) continue;
    seen.add(link.href);

    if (UNSAFE_SCHEMES.test(link.href) || link.href.startsWith("//")) {
      body = stripLink(body, link.href);
      findings.push({
        kind: "UNSAFE_LINK_REMOVED",
        severity: "WARNING",
        message: "A link with an unsafe scheme was removed.",
        url: link.href,
      });
      continue;
    }

    const absolute = ABSOLUTE.test(link.href);
    if (absolute && !/^https?:/i.test(link.href)) {
      // mailto:, tel: and the like: allowed, nothing to check.
      continue;
    }

    const host = absolute ? hostOf(link.href) : null;
    const internal = !absolute || sameSite(host, input.siteHost);

    if (!internal) {
      if (input.mode === "ai") {
        body = stripLink(body, link.href);
        findings.push({
          kind: "EXTERNAL_LINK_REMOVED",
          severity: "WARNING",
          message:
            "The model linked outside the site; generated text may only link to the brief's targets. The link was removed and its text kept.",
          url: link.href,
        });
      } else if (noExternal) {
        body = stripLink(body, link.href);
        findings.push({
          kind: "RULE_CHECK",
          severity: noExternal.rule.severity,
          message: "An SEO rule forbids external links; the link was removed and its text kept.",
          url: link.href,
          ruleId: noExternal.rule.ruleId,
        });
      } else {
        findings.push({
          kind: "EXTERNAL_LINK_UNAPPROVED",
          severity: "WARNING",
          message: "An external link that is not an approved target. Kept; flagged for QA.",
          url: link.href,
        });
      }
      continue;
    }

    const path = pathOf(link.href, input.siteHost);
    if (input.allowedLinkPaths.length > 0 && !input.allowedLinkPaths.includes(path)) {
      findings.push({
        kind: "LINK_TARGET_NOT_IN_BRIEF",
        severity: "INFO",
        message: "An internal link to a page the brief did not name as a target.",
        url: link.href,
      });
    }
  }

  // --- The text, after removals.
  const fields: Field[] = [
    { name: "title", text: input.title },
    { name: "meta_title", text: input.metaTitle ?? "" },
    { name: "meta_description", text: input.metaDescription ?? "" },
    { name: "excerpt", text: input.excerpt ?? "" },
    { name: "body", text: plainText(body) },
  ].filter((field) => field.text.length > 0);

  findings.push(
    ...scanPhrases(
      fields,
      input.prohibitedPhrases,
      "PROHIBITED_CLAIM",
      "BLOCKING",
      (phrase) => `The approved Business Context prohibits this claim: "${phrase}".`,
    ),
    ...scanPhrases(
      fields,
      input.avoidTopics,
      "AVOID_TOPIC",
      "BLOCKING",
      (phrase) => `The approved Business Context says to avoid this topic: "${phrase}".`,
    ),
    ...scanPhrases(
      fields,
      input.staleClaims,
      "STALE_CLAIM",
      "BLOCKING",
      (phrase) =>
        `This claim rested on a fact that is no longer approved: "${phrase}". Remove it, or have the fact approved again.`,
    ),
    ...numericClaims(fields, input.approvedClaimTexts),
  );

  // --- Machine-checkable rules (D8).
  const fieldText = (name: string): string | null => {
    switch (name) {
      case "title":
        return input.title;
      case "meta_title":
        return input.metaTitle ?? "";
      case "meta_description":
        return input.metaDescription ?? "";
      case "excerpt":
        return input.excerpt ?? "";
      case "body":
        return plainText(body);
      default:
        return null;
    }
  };

  for (const { rule, check } of parsedRules) {
    const finding = (message: string, field?: string): DraftFinding => ({
      kind: "RULE_CHECK",
      severity: rule.severity,
      message,
      field,
      ruleId: rule.ruleId,
    });

    switch (check.kind) {
      case "max_length": {
        const text = fieldText(check.field);
        if (text !== null && text.length > check.max) {
          findings.push(
            finding(
              `${check.field} is ${text.length} characters; the rule allows ${check.max}.`,
              check.field,
            ),
          );
        }
        break;
      }
      case "min_length": {
        const text = fieldText(check.field);
        if (text !== null && text.length < check.min) {
          findings.push(
            finding(
              `${check.field} is ${text.length} characters; the rule wants at least ${check.min}.`,
              check.field,
            ),
          );
        }
        break;
      }
      case "required_phrase": {
        const pattern = phrasePattern(check.phrase);
        const targets = check.field ? [check.field] : ["title", "body"];
        const present = targets.some((name) => {
          const text = fieldText(name);
          return text !== null && pattern !== null && pattern.test(text);
        });
        if (!present) {
          findings.push(
            finding(`The rule requires "${check.phrase}" in ${targets.join(" or ")}.`, check.field),
          );
        }
        break;
      }
      case "forbidden_phrase": {
        findings.push(
          ...scanPhrases(
            fields,
            [check.phrase],
            "RULE_CHECK",
            rule.severity,
            () => `An SEO rule forbids "${check.phrase}".`,
          ).map((row) => ({ ...row, ruleId: rule.ruleId })),
        );
        break;
      }
      case "no_external_links":
        // Handled with the links above.
        break;
    }
  }

  return {
    bodyMarkdown: body,
    findings,
    blocking: findings.some((row) => row.severity === "BLOCKING"),
  };
}
