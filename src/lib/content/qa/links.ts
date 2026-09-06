import { extractLinks } from "@/lib/content/markdown";
import {
  clip,
  typeResult,
  type QaCoverage,
  type QaFinding,
  type QaTypeResult,
} from "@/lib/content/qa/findings";
import type { QaContext, QaSubject } from "@/lib/content/qa/types";

/**
 * Links (M5 plan §3, §11, D9). Internal links must resolve to pages of this
 * website; targets the brief named should be used; anchors should say where
 * they go; links leaving the site are reported. Suggested targets are pages
 * that own the brief's secondary keywords and are not linked yet - findings,
 * never rows.
 */

const GENERIC_ANCHORS = new Set([
  "click here",
  "here",
  "read more",
  "more",
  "this",
  "link",
  "this page",
  "learn more",
]);
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function pathOf(href: string, siteHost: string): string {
  if (href.startsWith("/")) return href.split(/[?#]/)[0] ?? href;
  try {
    return new URL(href, `https://${siteHost}`).pathname;
  } catch {
    return href;
  }
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function checkLinks(subject: QaSubject, ctx: QaContext): QaTypeResult {
  const by = ctx.checkerVersion;
  const findings: QaFinding[] = [];
  const coverage: QaCoverage[] = [];
  const base = {
    qaType: "INTERNAL_LINKING" as const,
    source: "DETERMINISTIC" as const,
    needsHumanConfirmation: false,
    field: "body",
    by,
  };

  const pages = [ctx.targetPage, ...ctx.otherPages].filter(
    (page): page is NonNullable<typeof page> => page !== null,
  );
  const byPath = new Map(pages.map((page) => [normalizePath(page.path), page]));
  const linkedPaths = new Set<string>();
  let internal = 0;
  let external = 0;

  for (const link of extractLinks(subject.bodyMarkdown)) {
    const href = link.href.trim();
    if (href.startsWith("#")) continue;
    const absolute = ABSOLUTE.test(href);
    if (absolute && !/^https?:/i.test(href)) continue; // mailto:, tel:
    const host = absolute ? hostOf(href) : null;
    const isInternal = !absolute || (host !== null && bareHost(host) === bareHost(ctx.siteHost));

    if (!isInternal) {
      external += 1;
      findings.push({
        ...base,
        code: "EXTERNAL_LINK",
        severity: "WARNING",
        message: "A link leaves the site. Keep it only if the brief or an editor wants it there.",
        excerpt: clip(link.text || href, 120),
        refs: { pagePath: href },
      });
      continue;
    }

    internal += 1;
    const path = normalizePath(pathOf(href, ctx.siteHost));
    linkedPaths.add(path);
    const page = byPath.get(path);
    if (!page) {
      findings.push({
        ...base,
        code: "LINK_UNRESOLVED",
        severity: "WARNING",
        message: `The link to ${path} does not match any page this website knows.`,
        excerpt: clip(link.text || href, 120),
        refs: { pagePath: path },
      });
    }
    const anchor = (link.text ?? "").trim().toLowerCase();
    if (anchor && GENERIC_ANCHORS.has(anchor)) {
      findings.push({
        ...base,
        code: "GENERIC_ANCHOR",
        severity: "INFO",
        message: `The anchor text "${link.text}" does not say where the link goes.`,
        excerpt: clip(link.text ?? "", 120),
        refs: { pagePath: path },
      });
    }
  }
  coverage.push({ check: "internal_links", status: "CHECKED" });
  coverage.push({ check: "external_links", status: "CHECKED" });

  // Targets the brief named.
  for (const target of ctx.brief.linkTargets) {
    const path = target.path
      ? normalizePath(target.path)
      : byPath.size
        ? (pages.find((page) => page.id === target.pageId)?.path ?? null)
        : null;
    if (!path) continue;
    if (!linkedPaths.has(normalizePath(path))) {
      findings.push({
        ...base,
        code: "LINK_TARGET_UNUSED",
        severity: "INFO",
        message: `The brief named ${path} as a link target; the piece does not link to it.`,
        refs: { pageId: target.pageId, pagePath: path },
      });
    }
  }
  coverage.push({ check: "brief_targets", status: "CHECKED" });

  // Suggestions: pages that own the secondary keywords, not linked yet.
  const suggested = new Set<string>();
  for (const secondary of ctx.brief.secondaryKeywords) {
    for (const page of secondary.pages) {
      const path = normalizePath(page.path);
      if (linkedPaths.has(path) || suggested.has(path)) continue;
      if (ctx.targetPage && normalizePath(ctx.targetPage.path) === path) continue;
      suggested.add(path);
      findings.push({
        ...base,
        code: "LINK_SUGGESTED",
        severity: "INFO",
        message: `${path} owns "${secondary.keyword}" and is not linked; consider a link where the piece touches that topic.`,
        refs: { pageId: page.pageId, pagePath: path },
      });
    }
  }
  coverage.push({ check: "suggestions", status: "CHECKED" });

  return typeResult({
    qaType: "INTERNAL_LINKING",
    findings,
    coverage,
    considered: {
      internalLinks: internal,
      externalLinks: external,
      knownPages: pages.length,
      briefTargets: ctx.brief.linkTargets.length,
      suggestions: suggested.size,
    },
  });
}
