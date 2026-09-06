import { plainText } from "@/lib/content/markdown";
import { targetLengthFor } from "@/lib/content/draft-ux";
import {
  clip,
  notCheckedFinding,
  typeResult,
  type QaCoverage,
  type QaFinding,
  type QaTypeResult,
} from "@/lib/content/qa/findings";
import { countWords, extractSections, normalizePhrase } from "@/lib/content/qa/text";
import type { QaContext, QaSubject } from "@/lib/content/qa/types";

/**
 * Structure (M5 plan §3, §10). The brief's required sections, by heading;
 * their order; sections with nothing under them; the length band the work
 * type asks for. When a heading is worded differently from the brief, the
 * writer's own sections-covered list is consulted before calling it missing.
 */

/** "900-1,500 words" -> [900, 1500]; null when the text names no band. */
export function parseLengthBand(text: string): [number, number] | null {
  const numbers = [...text.matchAll(/\d[\d,]*/g)].map((match) =>
    Number(match[0].replace(/,/g, "")),
  );
  if (numbers.length < 2) return null;
  return [numbers[0]!, numbers[1]!];
}

function sectionMatches(heading: string, section: string): boolean {
  const a = normalizePhrase(heading);
  const b = normalizePhrase(section);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function checkStructure(subject: QaSubject, ctx: QaContext): QaTypeResult {
  const by = ctx.checkerVersion;
  const findings: QaFinding[] = [];
  const coverage: QaCoverage[] = [];
  const base = {
    qaType: "STRUCTURE" as const,
    source: "DETERMINISTIC" as const,
    needsHumanConfirmation: false,
    field: "body",
    by,
  };
  const sections = extractSections(subject.bodyMarkdown);

  // Required sections, in order.
  const required = ctx.brief.requiredSections.filter((section) => section.trim().length > 0);
  if (required.length === 0) {
    coverage.push({
      check: "required_sections",
      status: "NOT_CHECKED",
      reason: "NO_REQUIRED_SECTIONS",
    });
    findings.push(notCheckedFinding("STRUCTURE", "required_sections", "NO_REQUIRED_SECTIONS", by));
  } else {
    const covered = subject.sectionsCovered.map(normalizePhrase);
    const positions: number[] = [];
    for (const section of required) {
      const index = sections.findIndex((entry) => sectionMatches(entry.text, section));
      if (index >= 0) {
        positions.push(index);
        continue;
      }
      if (covered.includes(normalizePhrase(section))) {
        findings.push({
          ...base,
          code: "SECTION_UNMATCHED",
          severity: "INFO",
          message: `The writer lists "${section}" as covered, but no heading matches it.`,
          refs: { section },
        });
      } else {
        findings.push({
          ...base,
          code: "SECTION_MISSING",
          severity: "WARNING",
          message: `The brief requires a section "${section}"; no heading matches it.`,
          refs: { section },
        });
      }
    }
    for (let index = 1; index < positions.length; index += 1) {
      if (positions[index]! < positions[index - 1]!) {
        findings.push({
          ...base,
          code: "SECTION_OUT_OF_ORDER",
          severity: "INFO",
          message: "The required sections are not in the order the brief lists them.",
        });
        break;
      }
    }
    coverage.push({ check: "required_sections", status: "CHECKED" });
  }

  // Empty sections.
  for (const section of sections) {
    if (section.words === 0) {
      findings.push({
        ...base,
        code: "SECTION_EMPTY",
        severity: "WARNING",
        message: `The heading "${section.text}" has nothing under it.`,
        excerpt: clip(section.text),
      });
    }
  }
  coverage.push({ check: "empty_sections", status: "CHECKED" });

  // Length.
  const words = countWords(plainText(subject.bodyMarkdown));
  const band = parseLengthBand(targetLengthFor(subject.workType));
  if (band) {
    const [min, max] = band;
    if (words < min || words > max) {
      findings.push({
        ...base,
        code: "LENGTH_OUT_OF_BAND",
        severity: words < min / 2 ? "WARNING" : "INFO",
        message: `The body is ${words} words; the brief's target for this work is ${min}-${max}.`,
      });
    }
  }
  coverage.push({ check: "length", status: "CHECKED" });

  return typeResult({
    qaType: "STRUCTURE",
    findings,
    coverage,
    considered: { requiredSections: required.length, headings: sections.length, words },
  });
}
