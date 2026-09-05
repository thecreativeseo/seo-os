import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

/**
 * Markdown is the canonical form of a revision (docs/P4_SPEC.md §10). This is
 * the one place it is turned into HTML, and the HTML is sanitized on the way
 * out whether it is going to a preview or, later, to the CMS.
 *
 * Raw HTML inside the markdown is escaped, not rendered: a model's draft and
 * a person's edit are both text, and text does not get to inject markup.
 * The sanitizer is defence in depth over that - an allowlist of tags and
 * attributes, http(s)/mailto/tel and relative links only, no scripts, no
 * frames, no event handlers, no external images.
 */

const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "strong",
    "em",
    "b",
    "i",
    "s",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "img",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    th: ["align"],
    td: ["align"],
    code: ["class"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["https"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

/** Sanitized HTML for a preview or a CMS payload. */
export function renderMarkdown(markdown: string): string {
  return sanitizeHtml(parser.render(markdown), SANITIZE);
}

export type MarkdownLink = {
  href: string;
  text: string;
};

/** Every link the markdown carries, in document order. Autolinks included. */
export function extractLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const tokens = parser.parse(markdown, {});

  for (const token of tokens) {
    if (!token.children) continue;
    let open: string | null = null;
    let text = "";
    for (const child of token.children) {
      if (child.type === "link_open") {
        const href = child.attrGet("href");
        open = href == null ? "" : String(href);
        text = "";
      } else if (child.type === "link_close") {
        if (open !== null) links.push({ href: open, text });
        open = null;
      } else if (open !== null && (child.type === "text" || child.type === "code_inline")) {
        text += child.content;
      }
    }
  }

  return links;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes every link to `href`, leaving its text. `[text](href)` and
 * `[text](href "title")` become `text`; an autolink `<href>` disappears.
 */
export function stripLink(markdown: string, href: string): string {
  const target = escapeRegExp(href);
  return markdown
    .replace(new RegExp(`\\[([^\\]]*)\\]\\(\\s*${target}(?:\\s+"[^"]*")?\\s*\\)`, "g"), "$1")
    .replace(new RegExp(`<${target}>`, "g"), "");
}

/** Words in the rendered text, not the markup. */
export function wordCount(markdown: string): number {
  const text = sanitizeHtml(parser.render(markdown), { allowedTags: [], allowedAttributes: {} });
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/** The markdown's own text, for scanning: markup and link targets removed. */
export function plainText(markdown: string): string {
  return sanitizeHtml(parser.render(markdown), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}
