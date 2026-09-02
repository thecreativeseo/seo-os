"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { SitemapError } from "@/server/connectors/sitemap/fetch";
import { addSitemap, removeSitemap, syncSitemap } from "@/server/services/sitemap";

export type SitemapActionState = { error?: string; message?: string };

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
