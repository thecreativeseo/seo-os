import { plainText } from "@/lib/content/markdown";

/**
 * The parts of a revision the deterministic checks read: headings with their
 * levels and the text under each, sentences, paragraphs, word shingles. All
 * lexical, all pure.
 */

export type Heading = { level: number; text: string; line: number };

export type Section = Heading & { body: string; words: number };

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

/** ATX headings, in order, outside fenced code. */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let fenced = false;
  markdown.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    if (FENCE.test(line.trim())) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const match = HEADING.exec(line);
    if (match) {
      headings.push({ level: match[1]!.length, text: cleanInline(match[2]!), line: index });
    }
  });
  return headings;
}

/** Each heading with the text that follows it, up to the next heading. */
export function extractSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const headings = extractHeadings(markdown);
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.line ?? lines.length;
    const body = lines
      .slice(heading.line + 1, end)
      .join("\n")
      .trim();
    return { ...heading, body, words: countWords(plainText(body)) };
  });
}

/** Paragraphs of prose: blank-line separated blocks that are not headings, lists, code or tables. */
export function extractParagraphs(markdown: string): string[] {
  const blocks: string[] = [];
  let fenced = false;
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join(" "));
      current = [];
    }
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (FENCE.test(line)) {
      fenced = !fenced;
      flush();
      continue;
    }
    if (fenced) continue;
    if (line === "") {
      flush();
      continue;
    }
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks.map((block) => plainText(block)).filter((block) => block.length > 0);
}

/** Sentences of prose, from rendered text. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/** Lowercase words, letters and digits only, for matching and shingling. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizePhrase(text: string): string {
  return normalizeWords(text).join(" ");
}

/** Word shingles of a fixed size, as strings, for overlap measures. */
export function shingles(text: string, size = 8): Set<string> {
  const words = normalizeWords(text);
  const out = new Set<string>();
  if (words.length < size) {
    if (words.length > 0) out.add(words.join(" "));
    return out;
  }
  for (let index = 0; index + size <= words.length; index += 1) {
    out.add(words.slice(index, index + size).join(" "));
  }
  return out;
}

/** |A ∩ B| / |A ∪ B|, 0 when both are empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Share of A's shingles that B also has: how much of A is already in B. */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / a.size;
}

/** A phrase as a loose, case-insensitive, word-bounded pattern; null when too short to mean anything. */
export function phrasePattern(phrase: string): RegExp | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || phrase.trim().length < 3) return null;
  const body = words.map(escapeRegExp).join("\\s+");
  const leading = /^[\p{L}\p{N}]/u.test(phrase.trim()) ? "(?<![\\p{L}\\p{N}])" : "";
  const trailing = /[\p{L}\p{N}]$/u.test(phrase.trim()) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${leading}${body}${trailing}`, "iu");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .trim();
}
