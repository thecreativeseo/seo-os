import { createHash } from "node:crypto";

import sanitizeHtml from "sanitize-html";

/**
 * Deciding whether what WordPress holds is what we approved.
 *
 * This cannot be a byte comparison. WordPress re-serializes markup on save, may
 * wrap or unwrap paragraphs, and rewrites typography: an apostrophe becomes a
 * curly one, three dots become an ellipsis character, a double hyphen becomes a
 * dash. None of that changes the piece; all of it changes the bytes.
 *
 * Nor can it be a sample. Comparing the first and last few words would pass a
 * draft that lost every paragraph in between, which is precisely the failure a
 * person would never notice by eye and would most need told.
 *
 * So: a canonical form covering the whole document. Every block in order with
 * its tag and its complete text, every link with its destination and its anchor
 * text, and the full text sequence. Two documents match when their canonical
 * forms match, and the fingerprint over that form is what reconciliation
 * compares when it has to recognise a draft it may have created.
 *
 * What is deliberately normalized away is listed in NORMALIZATIONS below, and
 * each entry is a transformation WordPress is known to perform. What is
 * deliberately NOT normalized: a missing or added paragraph, a changed word, a
 * changed heading or a changed heading order, a missing or added link, and a
 * link whose destination differs. Those all change the canonical form.
 */

/** Blocks whose boundaries and order are part of the meaning. */
const BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "pre",
  "td",
  "th",
]);

/** The tag set the canonical form is built from. */
const CANONICAL_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...BLOCK_TAGS,
    "ul",
    "ol",
    "table",
    "thead",
    "tbody",
    "tr",
    "br",
    "hr",
    "code",
    "strong",
    "em",
    "b",
    "i",
    "s",
    "a",
    "img",
  ],
  allowedAttributes: { a: ["href"], img: ["src"] },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  disallowedTagsMode: "discard",
};

/**
 * Typographic rewrites WordPress performs, undone so they cannot fail a draft.
 *
 * Every one of these is wptexturize's doing and none of them can hide a
 * substantive difference: they map a character to the character it was written
 * as, not one word to another.
 */
const NORMALIZATIONS: [RegExp, string][] = [
  [/[‘’‚‛]/g, "'"], // curly single quotes
  [/[“”„‟]/g, '"'], // curly double quotes
  [/…/g, "..."], // ellipsis
  [/—/g, "---"], // em dash, as typed
  [/–/g, "--"], // en dash, as typed
  [/ /g, " "], // non-breaking space
  [/​/g, ""], // zero-width space
];

/** One block of the document: what it is, and everything it says. */
export type CanonicalBlock = { tag: string; text: string };

/** One link: where it goes, and the words that carry it. */
export type CanonicalLink = { href: string; text: string };

export type CanonicalContent = {
  blocks: CanonicalBlock[];
  links: CanonicalLink[];
  /** Every block's text, in order. The whole document, not a sample. */
  text: string;
  /** sha-256 over the canonical form. Stable across the normalizations above. */
  fingerprint: string;
};

/** Collapses whitespace and undoes the typographic rewrites. NFC throughout. */
export function normalizeText(value: string): string {
  let text = value.normalize("NFC");
  for (const [pattern, replacement] of NORMALIZATIONS) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, " ").trim();
}

/** A destination compared as a destination: case-insensitive host, no trailing slash. */
export function normalizeHref(href: string): string {
  const value = href.trim();
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    url.protocol = url.protocol.toLowerCase();
    const serialized = url.toString();
    return serialized.endsWith("/") && url.pathname === "/" ? serialized.slice(0, -1) : serialized;
  } catch {
    // A relative link. Compared as written, minus incidental whitespace.
    return value;
  }
}

const TOKENS = /<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s[^>]*)?)\/?>|([^<]+)/gi;
const HREF = /href="([^"]*)"/i;

/**
 * The canonical form of a fragment of HTML.
 *
 * Built by tokenizing sanitize-html's own output rather than by parsing
 * arbitrary markup: that output is well formed, uses only the tags above, and
 * carries only the attributes allowed, so a tokenizer over it is total. Text
 * outside any block still counts, as its own implicit block, so content cannot
 * disappear from the comparison by being unwrapped.
 */
export function canonicalContent(html: string): CanonicalContent {
  const safe = sanitizeHtml(html, CANONICAL_OPTIONS);

  const blocks: CanonicalBlock[] = [];
  const links: CanonicalLink[] = [];

  const open: { tag: string; parts: string[] }[] = [];
  let loose: string[] = [];
  let link: { href: string; parts: string[] } | null = null;

  const flushLoose = () => {
    const text = normalizeText(loose.join(" "));
    if (text.length > 0) blocks.push({ tag: "text", text });
    loose = [];
  };

  const addText = (raw: string) => {
    const text = sanitizeHtml(raw, { allowedTags: [], allowedAttributes: {} });
    if (link) link.parts.push(text);
    if (open.length > 0) open[open.length - 1]!.parts.push(text);
    else loose.push(text);
  };

  for (const match of safe.matchAll(TOKENS)) {
    const [, closing, opening, attributes, text] = match;

    if (text !== undefined) {
      addText(text);
      continue;
    }

    if (opening !== undefined) {
      const tag = opening.toLowerCase();
      if (tag === "a") {
        link = { href: HREF.exec(attributes ?? "")?.[1] ?? "", parts: [] };
      } else if (BLOCK_TAGS.has(tag)) {
        flushLoose();
        open.push({ tag, parts: [] });
      } else if (tag === "br") {
        addText(" ");
      }
      continue;
    }

    if (closing !== undefined) {
      const tag = closing.toLowerCase();
      if (tag === "a" && link) {
        links.push({ href: normalizeHref(link.href), text: normalizeText(link.parts.join("")) });
        link = null;
      } else if (BLOCK_TAGS.has(tag)) {
        const block = open.pop();
        if (block) {
          const value = normalizeText(block.parts.join(""));
          // An empty paragraph is presentation, not content. WordPress adds and
          // removes them freely, and neither changes what the piece says.
          if (value.length > 0) blocks.push({ tag: block.tag, text: value });
        }
      }
    }
  }

  while (open.length > 0) {
    const block = open.pop()!;
    const value = normalizeText(block.parts.join(""));
    if (value.length > 0) blocks.push({ tag: block.tag, text: value });
  }
  flushLoose();

  const text = blocks.map((block) => block.text).join("\n");
  const canonical = JSON.stringify({ blocks, links });

  return {
    blocks,
    links,
    text,
    fingerprint: `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
  };
}

export type ContentDifference =
  | { kind: "BLOCK_COUNT"; expected: number; observed: number }
  | { kind: "BLOCK"; index: number; expectedTag: string; observedTag: string }
  | { kind: "TEXT"; index: number }
  | { kind: "LINK_COUNT"; expected: number; observed: number }
  | { kind: "LINK"; index: number };

export type ContentComparison = {
  matches: boolean;
  /** The first difference found, described without quoting the content. */
  difference: ContentDifference | null;
  expectedFingerprint: string;
  observedFingerprint: string;
};

/**
 * Whether two documents say the same thing.
 *
 * Reports the first difference by kind and position rather than by quoting the
 * text, because this result is written to an ExecutionVerification row and
 * content bodies do not belong there. The fingerprints say whether they match;
 * the difference says where to look.
 */
export function compareContent(expectedHtml: string, observedHtml: string): ContentComparison {
  const expected = canonicalContent(expectedHtml);
  const observed = canonicalContent(observedHtml);

  const result = (difference: ContentDifference | null): ContentComparison => ({
    matches: difference === null,
    difference,
    expectedFingerprint: expected.fingerprint,
    observedFingerprint: observed.fingerprint,
  });

  if (expected.blocks.length !== observed.blocks.length) {
    return result({
      kind: "BLOCK_COUNT",
      expected: expected.blocks.length,
      observed: observed.blocks.length,
    });
  }

  for (const [index, block] of expected.blocks.entries()) {
    const other = observed.blocks[index]!;
    if (block.tag !== other.tag) {
      return result({
        kind: "BLOCK",
        index,
        expectedTag: block.tag,
        observedTag: other.tag,
      });
    }
    if (block.text !== other.text) return result({ kind: "TEXT", index });
  }

  if (expected.links.length !== observed.links.length) {
    return result({
      kind: "LINK_COUNT",
      expected: expected.links.length,
      observed: observed.links.length,
    });
  }

  for (const [index, link] of expected.links.entries()) {
    const other = observed.links[index]!;
    if (link.href !== other.href || link.text !== other.text) {
      return result({ kind: "LINK", index });
    }
  }

  return result(null);
}

/** Titles and excerpts: whole-value comparison, same normalization. */
export function compareText(expected: string | null, observed: string | null): boolean {
  return normalizeText(expected ?? "") === normalizeText(observed ?? "");
}
