import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { extractContent, type ExtractedContent } from "@/lib/content/extract";
import { SAME_SITE_URL_MESSAGES, validateSameSiteUrl } from "@/lib/url/same-site";
import type { ContentSource, PageContentSnapshot } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Capturing what a page actually says (docs/P3_SPEC.md §28).
 *
 * Every diagnosis so far reasons about a page from the outside: its clicks, its
 * impressions, its rank. None of them can see the words on it, which means no
 * diagnosis can be about the content — the single thing an SEO team can change
 * directly. This is the source that closes that gap.
 *
 * Three ways in, and no fourth:
 *
 *   - paste, for a page behind a login or not yet published
 *   - upload, for an export somebody already has
 *   - fetch, for one URL on the website's own domain
 *
 * Fetch is deliberately the narrowest of the three. It reads exactly the URL it
 * was given, follows no links, and discovers nothing. SEO OS is not a crawler in
 * any phase, and the difference between "fetch this page" and "crawl this site" is
 * one loop nobody meant to write.
 *
 * Captured content is UNTRUSTED. It can be written by whoever controls the page,
 * so a snapshot is never treated as an instruction — it becomes evidence with an
 * ID, and anything a model says about it is validated against the package.
 */

export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;

export type PageContentError =
  | "page_not_found"
  | "empty_content"
  | "too_large"
  | "unreachable"
  | "http_error"
  | "invalid_url"
  | "unsupported_protocol"
  | "ip_address_not_allowed"
  | "host_mismatch";

export class PageContentCaptureError extends Error {
  constructor(
    message: string,
    readonly code: PageContentError,
  ) {
    super(message);
    this.name = "PageContentCaptureError";
  }
}

export const PAGE_CONTENT_ERROR_MESSAGES: Record<PageContentError, string> = {
  ...SAME_SITE_URL_MESSAGES,
  page_not_found: "That page is not available.",
  empty_content: "That content is empty. Paste or upload the page text.",
  too_large: "That page is too large to capture.",
  unreachable: "Could not reach that page.",
  http_error: "That page could not be fetched.",
};

export type CaptureResult = {
  snapshot: PageContentSnapshot;
  extracted: ExtractedContent;
  /** False when this content matches the page's most recent snapshot. */
  changed: boolean;
};

/**
 * Stores an extraction as a snapshot.
 *
 * The same content twice is not a new snapshot. `(pageId, contentHash)` is unique
 * precisely so re-capturing an unchanged page returns what is already there: a
 * timeline of identical rows would suggest the page kept changing, which is a
 * fabricated fact of exactly the kind the data rules forbid.
 */
async function storeSnapshot(
  context: TenantContext,
  pageId: string,
  extracted: ExtractedContent,
  source: ContentSource,
): Promise<CaptureResult> {
  const existing = await prisma.pageContentSnapshot.findUnique({
    where: { pageId_contentHash: { pageId, contentHash: extracted.contentHash } },
  });

  if (existing) {
    return { snapshot: existing, extracted, changed: false };
  }

  const snapshot = await prisma.$transaction(async (tx) => {
    const created = await tx.pageContentSnapshot.create({
      data: {
        websiteId: context.website.id,
        pageId,
        contentHash: extracted.contentHash,
        title: extracted.title,
        metaDescription: extracted.metaDescription,
        headingsJson: extracted.headings as unknown as Prisma.InputJsonValue,
        bodyText: extracted.bodyText,
        wordCount: extracted.wordCount,
        source,
        capturedByUserId: context.user.id,
      },
    });

    await recordAudit(tx, context, {
      entityType: "PageContentSnapshot",
      entityId: created.id,
      action: "CREATE",
      // The captured text itself is not snapshotted into the audit trail. What
      // matters for accountability is who captured what, from where, and when —
      // and an audit event is not the place to duplicate a page's body.
      after: {
        pageId,
        source,
        contentHash: extracted.contentHash,
        wordCount: extracted.wordCount,
        truncated: extracted.truncated,
      },
    });

    return created;
  });

  return { snapshot, extracted, changed: true };
}

async function requirePage(context: TenantContext, pageId: string) {
  const page = await prisma.page.findFirst({
    where: { id: pageId, ...websiteScope(context) },
  });

  if (!page) {
    throw new PageContentCaptureError(
      PAGE_CONTENT_ERROR_MESSAGES.page_not_found,
      "page_not_found",
    );
  }

  return page;
}

/**
 * Captures content somebody supplied directly — pasted, or read out of a file
 * they uploaded. The two differ only in provenance, which is why they share a
 * function and not a code path.
 */
export async function capturePageContent(
  context: TenantContext,
  input: { pageId: string; content: string; source: "MANUAL_PASTE" | "UPLOAD" },
): Promise<CaptureResult> {
  await requirePage(context, input.pageId);

  if (input.content.length > MAX_CONTENT_BYTES) {
    throw new PageContentCaptureError(PAGE_CONTENT_ERROR_MESSAGES.too_large, "too_large");
  }

  const extracted = extractContent(input.content);

  if (extracted.bodyText.trim().length === 0) {
    throw new PageContentCaptureError(
      PAGE_CONTENT_ERROR_MESSAGES.empty_content,
      "empty_content",
    );
  }

  return storeSnapshot(context, input.pageId, extracted, input.source);
}

/**
 * Fetches one page on the website's own domain.
 *
 * The URL is re-validated here against the website in the caller's tenant context
 * rather than trusted from the Page row. Both are server-side, but the guard costs
 * nothing and this is the request that leaves our network.
 */
export async function fetchPageContent(
  context: TenantContext,
  pageId: string,
): Promise<CaptureResult> {
  const page = await requirePage(context, pageId);

  const validated = validateSameSiteUrl(page.url, context.website.normalizedDomain);

  if (!validated.ok) {
    throw new PageContentCaptureError(
      PAGE_CONTENT_ERROR_MESSAGES[validated.code],
      validated.code,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(validated.url, {
      signal: controller.signal,
      headers: { Accept: "text/html, text/plain, */*" },
      // A redirect can land on a host the guard already rejected, so it is not
      // followed silently. Same rule as the sitemap fetcher.
      redirect: "manual",
    });
  } catch {
    throw new PageContentCaptureError(
      PAGE_CONTENT_ERROR_MESSAGES.unreachable,
      "unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new PageContentCaptureError(
      "That page redirects. Capture the final URL instead.",
      "http_error",
    );
  }

  if (!response.ok) {
    throw new PageContentCaptureError(
      `That page returned ${response.status}.`,
      "http_error",
    );
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_CONTENT_BYTES) {
    throw new PageContentCaptureError(PAGE_CONTENT_ERROR_MESSAGES.too_large, "too_large");
  }

  const body = await response.text();

  // Checked again after reading: content-length is a claim, not a guarantee.
  if (body.length > MAX_CONTENT_BYTES) {
    throw new PageContentCaptureError(PAGE_CONTENT_ERROR_MESSAGES.too_large, "too_large");
  }

  const extracted = extractContent(body);

  if (extracted.bodyText.trim().length === 0) {
    throw new PageContentCaptureError(
      PAGE_CONTENT_ERROR_MESSAGES.empty_content,
      "empty_content",
    );
  }

  return storeSnapshot(context, pageId, extracted, "FETCH");
}

/** The most recent snapshot for a page, or null if it has never been captured. */
export async function latestSnapshot(
  context: TenantContext,
  pageId: string,
): Promise<PageContentSnapshot | null> {
  return prisma.pageContentSnapshot.findFirst({
    where: { pageId, ...websiteScope(context) },
    orderBy: { capturedAt: "desc" },
  });
}

/** Snapshot history for a page, newest first. */
export async function snapshotHistory(
  context: TenantContext,
  pageId: string,
  limit = 20,
): Promise<PageContentSnapshot[]> {
  return prisma.pageContentSnapshot.findMany({
    where: { pageId, ...websiteScope(context) },
    orderBy: { capturedAt: "desc" },
    take: limit,
  });
}

/**
 * Resolves a snapshot for evidence.
 *
 * Scoped to the website like every other read: an evidence ID is a string a
 * caller supplies, and a resolver that trusts it is the whole reason evidence IDs
 * are re-resolved under tenant scope rather than dereferenced directly.
 */
export async function snapshotById(
  context: TenantContext,
  snapshotId: string,
): Promise<PageContentSnapshot | null> {
  return prisma.pageContentSnapshot.findFirst({
    where: { id: snapshotId, ...websiteScope(context) },
  });
}
