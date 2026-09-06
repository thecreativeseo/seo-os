import { plainText } from "@/lib/content/markdown";
import { SLUG_PATTERN } from "@/lib/ai/schemas/content-draft";
import {
  clip,
  notCheckedFinding,
  typeResult,
  type QaCoverage,
  type QaFinding,
  type QaTypeResult,
} from "@/lib/content/qa/findings";
import { extractHeadings, normalizePhrase, phrasePattern } from "@/lib/content/qa/text";
import type { QaContext, QaSubject } from "@/lib/content/qa/types";

/**
 * On-page SEO (docs/P4_SPEC.md §13; M5 plan §3, §12). Presence, length
 * bands, one H1, heading order, a valid slug, the primary keyword somewhere
 * a reader would expect it, and titles or descriptions another page of the
 * website already uses. Presence only, never density. The judged parts -
 * whether the keyword reads naturally, whether the call to action the brief
 * asked for is there - belong to the AI pass.
 */

export const TITLE_MAX = 70;
export const META_TITLE_MAX = 60;
export const META_DESCRIPTION_MAX = 160;
const OPENING_WORDS = 100;

function lastSegment(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

export function checkOnPage(subject: QaSubject, ctx: QaContext): QaTypeResult {
  const by = ctx.checkerVersion;
  const findings: QaFinding[] = [];
  const coverage: QaCoverage[] = [];
  const base = {
    qaType: "ON_PAGE_SEO" as const,
    source: "DETERMINISTIC" as const,
    needsHumanConfirmation: false,
    by,
  };

  // Title and description.
  if (subject.title.trim().length === 0) {
    findings.push({
      ...base,
      code: "TITLE_MISSING",
      severity: "WARNING",
      message: "The piece has no title.",
      field: "title",
    });
  } else if (subject.title.length > TITLE_MAX) {
    findings.push({
      ...base,
      code: "TITLE_TOO_LONG",
      severity: "INFO",
      message: `The title is ${subject.title.length} characters; past ${TITLE_MAX} it will be cut in search results.`,
      field: "title",
      excerpt: clip(subject.title),
    });
  }
  const metaTitle = subject.metaTitle?.trim() ?? "";
  if (metaTitle.length > META_TITLE_MAX) {
    findings.push({
      ...base,
      code: "TITLE_TOO_LONG",
      severity: "WARNING",
      message: `The meta title is ${metaTitle.length} characters; past ${META_TITLE_MAX} it will be cut in search results.`,
      field: "meta_title",
      excerpt: clip(metaTitle),
    });
  }
  const meta = subject.metaDescription?.trim() ?? "";
  if (meta.length === 0) {
    findings.push({
      ...base,
      code: "META_MISSING",
      severity: "WARNING",
      message: "There is no meta description.",
      field: "meta_description",
    });
  } else if (meta.length > META_DESCRIPTION_MAX) {
    findings.push({
      ...base,
      code: "META_TOO_LONG",
      severity: "WARNING",
      message: `The meta description is ${meta.length} characters; past ${META_DESCRIPTION_MAX} it will be cut in search results.`,
      field: "meta_description",
      excerpt: clip(meta),
    });
  }
  coverage.push({ check: "title_and_description", status: "CHECKED" });

  // Headings.
  const headings = extractHeadings(subject.bodyMarkdown);
  const h1s = headings.filter((heading) => heading.level === 1);
  if (h1s.length === 0) {
    findings.push({
      ...base,
      code: "H1_MISSING",
      severity: "INFO",
      message: "The body has no H1; the title will serve as the page heading.",
      field: "body",
    });
  } else if (h1s.length > 1) {
    findings.push({
      ...base,
      code: "H1_MULTIPLE",
      severity: "WARNING",
      message: `The body has ${h1s.length} H1 headings; a page should have one.`,
      field: "body",
      excerpt: clip(h1s[1]!.text),
    });
  }
  for (let index = 1; index < headings.length; index += 1) {
    const previous = headings[index - 1]!;
    const heading = headings[index]!;
    if (heading.level > previous.level + 1) {
      findings.push({
        ...base,
        code: "HEADING_SKIP",
        severity: "INFO",
        message: `An H${heading.level} follows an H${previous.level}; a level was skipped.`,
        field: "body",
        excerpt: clip(heading.text),
      });
    }
  }
  coverage.push({ check: "headings", status: "CHECKED" });

  // Slug.
  const isNew = subject.workType === "NEW_CONTENT";
  if (!subject.slug) {
    findings.push({
      ...base,
      code: "SLUG_MISSING",
      severity: isNew ? "WARNING" : "INFO",
      message: isNew
        ? "New content needs a slug before it can have a URL."
        : "No slug; the existing page keeps its URL.",
      field: "slug",
    });
  } else if (!SLUG_PATTERN.test(subject.slug)) {
    findings.push({
      ...base,
      code: "SLUG_INVALID",
      severity: "WARNING",
      message: "The slug is not lowercase letters, digits and single hyphens.",
      field: "slug",
      excerpt: subject.slug,
    });
  } else {
    const taken = ctx.otherPages.find((page) => lastSegment(page.path) === subject.slug);
    if (isNew && taken) {
      findings.push({
        ...base,
        code: "SLUG_TAKEN",
        severity: "WARNING",
        message: `Another page of this website already ends in "${subject.slug}".`,
        field: "slug",
        excerpt: subject.slug,
        refs: { pageId: taken.id, pagePath: taken.path },
      });
    }
    if (!isNew && ctx.targetPage && lastSegment(ctx.targetPage.path) !== subject.slug) {
      findings.push({
        ...base,
        code: "SLUG_DIFFERS",
        severity: "INFO",
        message: `The slug differs from the page's current path segment "${lastSegment(ctx.targetPage.path)}"; a URL change needs a redirect.`,
        field: "slug",
        excerpt: subject.slug,
        refs: { pageId: ctx.targetPage.id, pagePath: ctx.targetPage.path },
      });
    }
  }
  coverage.push({ check: "slug", status: "CHECKED" });

  // The primary keyword, where a reader would look for it.
  const keyword = ctx.brief.primaryKeyword?.trim() ?? "";
  const pattern = keyword ? phrasePattern(keyword) : null;
  if (!pattern) {
    coverage.push({ check: "primary_keyword", status: "NOT_CHECKED", reason: "NO_KEYWORD" });
    findings.push(notCheckedFinding("ON_PAGE_SEO", "primary_keyword", "NO_KEYWORD", by));
  } else {
    const body = plainText(subject.bodyMarkdown);
    const opening = body.split(/\s+/).slice(0, OPENING_WORDS).join(" ");
    const inTitle = pattern.test(subject.title) || pattern.test(metaTitle);
    const inH1 = h1s.some((heading) => pattern.test(heading.text));
    const inOpening = pattern.test(opening);
    const inBody = pattern.test(body);
    if (!inTitle && !inH1 && !inOpening && !inBody) {
      findings.push({
        ...base,
        code: "KEYWORD_ABSENT",
        severity: "WARNING",
        message: `The primary keyword "${keyword}" does not appear in the title, headings or body.`,
        field: "body",
      });
    } else if (!inTitle && !inH1) {
      findings.push({
        ...base,
        code: "KEYWORD_NOT_IN_TITLE",
        severity: "INFO",
        message: `The primary keyword "${keyword}" is in the body but not in the title or H1.`,
        field: "title",
      });
    }
    coverage.push({ check: "primary_keyword", status: "CHECKED" });
  }

  // Duplicates against what other pages already say.
  const withText = ctx.otherPages.filter((page) => page.title || page.metaDescription);
  if (withText.length === 0) {
    coverage.push({
      check: "duplicate_title_meta",
      status: "NOT_CHECKED",
      reason: "NO_OTHER_PAGES",
    });
    findings.push(notCheckedFinding("ON_PAGE_SEO", "duplicate_title_meta", "NO_OTHER_PAGES", by));
  } else {
    const title = normalizePhrase(metaTitle || subject.title);
    const description = normalizePhrase(meta);
    for (const page of withText) {
      if (title && page.title && normalizePhrase(page.title) === title) {
        findings.push({
          ...base,
          code: "DUPLICATE_TITLE",
          severity: "WARNING",
          message: `The title is the same as the title of ${page.path}.`,
          field: metaTitle ? "meta_title" : "title",
          refs: { pageId: page.id, pagePath: page.path },
        });
      }
      if (
        description &&
        page.metaDescription &&
        normalizePhrase(page.metaDescription) === description
      ) {
        findings.push({
          ...base,
          code: "DUPLICATE_META",
          severity: "WARNING",
          message: `The meta description is the same as that of ${page.path}.`,
          field: "meta_description",
          refs: { pageId: page.id, pagePath: page.path },
        });
      }
    }
    coverage.push({ check: "duplicate_title_meta", status: "CHECKED" });
  }

  // Judged parts.
  const judgedReason = "NO_PROVIDER";
  coverage.push({ check: "keyword_reads_naturally", status: "NOT_CHECKED", reason: judgedReason });
  findings.push(notCheckedFinding("ON_PAGE_SEO", "keyword_reads_naturally", judgedReason, by));
  if (ctx.brief.primaryConversion) {
    coverage.push({ check: "call_to_action", status: "NOT_CHECKED", reason: judgedReason });
    findings.push(notCheckedFinding("ON_PAGE_SEO", "call_to_action", judgedReason, by));
  }

  return typeResult({
    qaType: "ON_PAGE_SEO",
    findings,
    coverage,
    considered: {
      headings: headings.length,
      otherPages: ctx.otherPages.length,
      primaryKeyword: keyword,
    },
  });
}
