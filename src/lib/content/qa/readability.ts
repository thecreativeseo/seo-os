import { plainText } from "@/lib/content/markdown";
import {
  clip,
  notCheckedFinding,
  typeResult,
  type QaCoverage,
  type QaFinding,
  type QaTypeResult,
} from "@/lib/content/qa/findings";
import { countWords, extractParagraphs, splitSentences } from "@/lib/content/qa/text";
import type { QaContext, QaSubject } from "@/lib/content/qa/types";

/**
 * Readability (M5 plan §3). Measured, not scored: how long the sentences
 * run, how much of the piece is in very long sentences, whether a paragraph
 * has become a wall. No reading-grade figure is shown as a verdict. Whether
 * the piece sounds like the brand is a judgement, and belongs to the AI pass.
 */

export const LONG_SENTENCE_WORDS = 30;
export const LONG_SENTENCE_SHARE_WARN = 0.25;
export const LONG_SENTENCE_SHARE_INFO = 0.1;
export const WALL_OF_TEXT_WORDS = 120;

export function checkReadability(subject: QaSubject, ctx: QaContext): QaTypeResult {
  const by = ctx.checkerVersion;
  const findings: QaFinding[] = [];
  const coverage: QaCoverage[] = [];
  const base = {
    qaType: "READABILITY" as const,
    source: "DETERMINISTIC" as const,
    needsHumanConfirmation: false,
    field: "body",
    by,
  };

  const sentences = splitSentences(plainText(subject.bodyMarkdown));
  const lengths = sentences.map(countWords);
  const long = lengths.filter((length) => length > LONG_SENTENCE_WORDS).length;
  const share = sentences.length > 0 ? long / sentences.length : 0;
  const average =
    sentences.length > 0
      ? Math.round(lengths.reduce((sum, n) => sum + n, 0) / sentences.length)
      : 0;
  if (sentences.length > 0 && share >= LONG_SENTENCE_SHARE_INFO) {
    const longest = sentences[lengths.indexOf(Math.max(...lengths))] ?? "";
    findings.push({
      ...base,
      code: "LONG_SENTENCES",
      severity: share >= LONG_SENTENCE_SHARE_WARN ? "WARNING" : "INFO",
      message: `${Math.round(share * 100)}% of sentences run past ${LONG_SENTENCE_WORDS} words (average ${average}).`,
      excerpt: clip(longest, 160),
    });
  }
  coverage.push({ check: "sentence_length", status: "CHECKED" });

  const paragraphs = extractParagraphs(subject.bodyMarkdown);
  for (const paragraph of paragraphs) {
    const words = countWords(paragraph);
    if (words > WALL_OF_TEXT_WORDS) {
      findings.push({
        ...base,
        code: "WALL_OF_TEXT",
        severity: "WARNING",
        message: `A paragraph runs to ${words} words; readers skim past walls of text.`,
        excerpt: clip(paragraph, 120),
      });
    }
  }
  coverage.push({ check: "paragraph_length", status: "CHECKED" });

  const judgedReason = "NO_PROVIDER";
  coverage.push({ check: "brand_voice", status: "NOT_CHECKED", reason: judgedReason });
  findings.push(notCheckedFinding("READABILITY", "brand_voice", judgedReason, by));

  return typeResult({
    qaType: "READABILITY",
    findings,
    coverage,
    considered: {
      sentences: sentences.length,
      averageSentenceWords: average,
      paragraphs: paragraphs.length,
    },
  });
}
