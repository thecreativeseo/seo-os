import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { normalizeUrl } from "@/lib/url/normalize-url";
import {
  SITEMAP_ERROR_MESSAGES,
  SitemapError,
  fetchSitemap,
  validateSitemapUrl,
} from "@/server/connectors/sitemap/fetch";
import type { Sitemap } from "@/generated/prisma/client";

/**
 * Sitemap ingestion (docs/P1_SPEC.md §12).
 *
 * Discovered URLs become Pages with sitemapPresent = true and
 * sourceFirstSeen = SITEMAP. That flag is never rendered as "indexed": a sitemap is
 * the site's own claim about what exists, and Google is under no obligation to
 * agree. The acceptance criteria call this out twice, which suggests it is a
 * mistake people make.
 */

export async function listSitemaps(context: TenantContext): Promise<Sitemap[]> {
  return prisma.sitemap.findMany({
    where: websiteScope(context),
    orderBy: { createdAt: "asc" },
  });
}

export async function addSitemap(
  context: TenantContext,
  url: string,
): Promise<Sitemap> {
  const validated = validateSitemapUrl(url, context.website.normalizedDomain);

  if (!validated.ok) {
    throw new SitemapError(SITEMAP_ERROR_MESSAGES[validated.code], validated.code);
  }

  return prisma.$transaction(async (tx) => {
    const sitemap = await tx.sitemap.upsert({
      where: {
        websiteId_url: { websiteId: context.website.id, url: validated.url },
      },
      update: {},
      create: {
        websiteId: context.website.id,
        url: validated.url,
        fetchStatus: "NEVER_FETCHED",
      },
    });

    await recordAudit(tx, context, {
      entityType: "Sitemap",
      entityId: sitemap.id,
      action: "CREATE",
      after: { url: sitemap.url },
    });

    return sitemap;
  });
}

export type SitemapSyncResult = {
  sitemap: Sitemap;
  discovered: number;
  created: number;
  skipped: number;
};

/**
 * Fetches a sitemap and folds its URLs into the Page inventory.
 *
 * A page already known from Search Console is marked as present in the sitemap
 * rather than duplicated — the two sources describe the same page, and the whole
 * point of normalizing URLs is that they resolve to one row.
 *
 * A failed fetch records the failure and does NOT advance lastSuccessfulFetchAt:
 * "we last read this successfully three weeks ago" and "we read it this morning"
 * have to stay distinguishable.
 */
export async function syncSitemap(
  context: TenantContext,
  sitemapId: string,
): Promise<SitemapSyncResult> {
  const existing = await prisma.sitemap.findFirst({
    where: { id: sitemapId, ...websiteScope(context) },
  });

  if (!existing) {
    throw new SitemapError("That sitemap is not available.", "invalid_url");
  }

  await prisma.sitemap.update({
    where: { id: existing.id },
    data: { fetchStatus: "FETCHING", lastFetchedAt: new Date() },
  });

  let result;
  try {
    result = await fetchSitemap(existing.url, context.website.normalizedDomain);
  } catch (error) {
    const code = error instanceof SitemapError ? error.code : "unreachable";

    const failed = await prisma.sitemap.update({
      where: { id: existing.id },
      data: {
        fetchStatus: "FAILED",
        // Deliberately not touching lastSuccessfulFetchAt or urlCount.
        lastError: code,
      },
    });

    return { sitemap: failed, discovered: 0, created: 0, skipped: 0 };
  }

  let created = 0;

  for (const url of result.urls) {
    const normalized = normalizeUrl(url, context.website.normalizedDomain);
    if (!normalized.ok) continue;

    const page = await prisma.page.findFirst({
      where: {
        websiteId: context.website.id,
        normalizedUrl: normalized.value.normalized,
      },
    });

    if (page) {
      // Known from Search Console already: record that the sitemap lists it too.
      await prisma.page.update({
        where: { id: page.id },
        data: { sitemapPresent: true, lastSeenAt: new Date() },
      });
      continue;
    }

    await prisma.page.create({
      data: {
        websiteId: context.website.id,
        url: normalized.value.normalized,
        normalizedUrl: normalized.value.normalized,
        path: normalized.value.path,
        hostname: normalized.value.hostname,
        protocol: normalized.value.protocol,
        sourceFirstSeen: "SITEMAP",
        sitemapPresent: true,
      },
    });
    created += 1;
  }

  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const sitemap = await tx.sitemap.update({
      where: { id: existing.id },
      data: {
        fetchStatus: "SUCCEEDED",
        lastSuccessfulFetchAt: now,
        urlCount: result.urls.length,
        lastError: null,
      },
    });

    await recordAudit(tx, context, {
      entityType: "Sitemap",
      entityId: sitemap.id,
      action: "UPDATE",
      after: {
        urlCount: result.urls.length,
        pagesCreated: created,
        skipped: result.skipped.length,
      },
    });

    return sitemap;
  });

  return {
    sitemap: updated,
    discovered: result.urls.length,
    created,
    // Surfaced rather than silently dropped: a sitemap listing a CDN or partner
    // domain is normal, and importing those would attribute other people's URLs
    // to this site.
    skipped: result.skipped.length,
  };
}

export async function removeSitemap(
  context: TenantContext,
  sitemapId: string,
): Promise<void> {
  const existing = await prisma.sitemap.findFirst({
    where: { id: sitemapId, ...websiteScope(context) },
  });

  if (!existing) return;

  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, context, {
      entityType: "Sitemap",
      entityId: existing.id,
      action: "ARCHIVE",
      before: { url: existing.url },
    });

    await tx.sitemap.delete({ where: { id: existing.id } });
  });

  // Pages discovered from it are kept: they were really observed, and a page does
  // not stop existing because the sitemap listing it was removed.
}
