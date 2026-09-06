import { plainText } from "@/lib/content/markdown";
import {
  notCheckedFinding,
  typeResult,
  type QaCoverage,
  type QaFinding,
  type QaTypeResult,
} from "@/lib/content/qa/findings";
import { containment, jaccard, shingles } from "@/lib/content/qa/text";
import type { QaContext, QaSubject } from "@/lib/content/qa/types";

/**
 * Duplication risk (M5 plan §3). Word shingles, compared lexically: a
 * refresh that changed nothing, or new content that repeats a page the
 * website already has, is named with the page. No model, no scores beyond
 * the overlap itself.
 */

export const SHINGLE_WORDS = 8;
export const UNCHANGED_CONTAINMENT = 0.9;
export const NEAR_DUPLICATE_JACCARD = 0.5;
export const OVERLAP_INFO_JACCARD = 0.25;

export function checkDuplication(subject: QaSubject, ctx: QaContext): QaTypeResult {
  const by = ctx.checkerVersion;
  const findings: QaFinding[] = [];
  const coverage: QaCoverage[] = [];
  const base = {
    qaType: "DUPLICATION_RISK" as const,
    source: "DETERMINISTIC" as const,
    needsHumanConfirmation: false,
    field: "body",
    by,
  };
  const body = shingles(plainText(subject.bodyMarkdown), SHINGLE_WORDS);
  const isRefresh = subject.workType !== "NEW_CONTENT" && ctx.targetPage !== null;

  // Against the page it refreshes.
  if (isRefresh) {
    if (ctx.targetPage?.bodyText) {
      const current = shingles(ctx.targetPage.bodyText, SHINGLE_WORDS);
      const kept = containment(body, current);
      if (kept >= UNCHANGED_CONTAINMENT && jaccard(body, current) >= 0.8) {
        findings.push({
          ...base,
          code: "UNCHANGED_REFRESH",
          severity: "WARNING",
          message: `${Math.round(kept * 100)}% of the piece is already on ${ctx.targetPage.path}; a refresh that changes nothing changes nothing.`,
          refs: { pageId: ctx.targetPage.id, pagePath: ctx.targetPage.path },
        });
      }
      coverage.push({ check: "target_page_overlap", status: "CHECKED" });
    } else {
      coverage.push({
        check: "target_page_overlap",
        status: "NOT_CHECKED",
        reason: "NO_PAGE_SNAPSHOT",
      });
      findings.push(
        notCheckedFinding("DUPLICATION_RISK", "target_page_overlap", "NO_PAGE_SNAPSHOT", by),
      );
    }
  }

  // Against everything else the website says.
  const others = ctx.otherPages.filter((page) => page.bodyText && page.bodyText.trim().length > 0);
  if (others.length === 0) {
    coverage.push({
      check: "other_pages_overlap",
      status: "NOT_CHECKED",
      reason: "NO_OTHER_PAGES",
    });
    findings.push(
      notCheckedFinding("DUPLICATION_RISK", "other_pages_overlap", "NO_OTHER_PAGES", by),
    );
  } else {
    let best: { page: (typeof others)[number]; similarity: number } | null = null;
    for (const page of others) {
      const similarity = jaccard(body, shingles(page.bodyText!, SHINGLE_WORDS));
      if (!best || similarity > best.similarity) best = { page, similarity };
    }
    if (best && best.similarity >= OVERLAP_INFO_JACCARD) {
      findings.push({
        ...base,
        code: "NEAR_DUPLICATE",
        severity: best.similarity >= NEAR_DUPLICATE_JACCARD ? "WARNING" : "INFO",
        message: `${Math.round(best.similarity * 100)}% overlap with ${best.page.path}.`,
        refs: { pageId: best.page.id, pagePath: best.page.path },
      });
    }
    coverage.push({ check: "other_pages_overlap", status: "CHECKED" });
  }

  return typeResult({
    qaType: "DUPLICATION_RISK",
    findings,
    coverage,
    considered: {
      shingles: body.size,
      otherPagesWithText: others.length,
      targetPage: ctx.targetPage?.path ?? "",
    },
  });
}
