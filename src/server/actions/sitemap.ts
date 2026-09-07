"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { SitemapError } from "@/server/connectors/sitemap/fetch";
import {
  addSitemap,
  discoverAndAddSitemaps,
  removeSitemap,
  syncSitemap,
} from "@/server/services/sitemap";

export type SitemapActionState = { error?: string; message?: string };

/** A URL with no meaningful path — the site root — means “find my sitemap”. */
function isBareOrigin(input: string): boolean {
  try {
    const { pathname, search } = new URL(input);
    return (pathname === "" || pathname === "/") && search === "";
  } catch {
    return false;
  }
}

async function withWebsite(
  formData: FormData,
  run: (context: Awaited<ReturnType<typeof requireWebsiteAccess>>) => Promise<string | void>,
): Promise<SitemapActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  let message: string | void;

  try {
    message = await run(context);
  } catch (error) {
    if (error instanceof SitemapError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return message ? { message } : {};
}

export async function addSitemapAction(
  _previous: SitemapActionState,
  formData: FormData,
): Promise<SitemapActionState> {
  const url = String(formData.get("url") ?? "").trim();

  if (!url) {
    return { error: "Enter a sitemap URL." };
  }

  return withWebsite(formData, async (context) => {
    // A bare domain is a request to discover: prefer what robots.txt declares
    // over guessing a conventional path.
    if (isBareOrigin(url)) {
      const added = await discoverAndAddSitemaps(context);
      return `${added.length} sitemap${added.length === 1 ? "" : "s"} found in robots.txt and added.`;
    }
    await addSitemap(context, url);
  });
}

export async function syncSitemapAction(
  _previous: SitemapActionState,
  formData: FormData,
): Promise<SitemapActionState> {
  const sitemapId = String(formData.get("__sitemapId") ?? "");

  return withWebsite(formData, async (context) => {
    const result = await syncSitemap(context, sitemapId);

    if (result.sitemap.fetchStatus === "FAILED") {
      return "That sitemap could not be fetched. The last successful fetch is unchanged.";
    }

    // Skipped URLs are reported rather than hidden: a sitemap listing a CDN or a
    // partner domain is normal, and importing those would attribute other people's
    // URLs to this website.
    return `${result.discovered} URLs read, ${result.created} new pages${
      result.skipped > 0 ? `, ${result.skipped} skipped as not belonging to this site` : ""
    }.`;
  });
}

export async function removeSitemapAction(
  _previous: SitemapActionState,
  formData: FormData,
): Promise<SitemapActionState> {
  const sitemapId = String(formData.get("__sitemapId") ?? "");

  return withWebsite(formData, async (context) => {
    await removeSitemap(context, sitemapId);
  });
}
