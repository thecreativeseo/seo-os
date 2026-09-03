"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  MAX_CONTENT_BYTES,
  PageContentCaptureError,
  capturePageContent,
  fetchPageContent,
} from "@/server/services/page-content";

export type PageContentActionState = { error?: string; message?: string };

/**
 * Capturing a page's content (docs/P3_SPEC.md §28).
 *
 * WRITE is required. Capturing content is a write that also makes an outbound
 * request, so a viewer cannot use the product as a fetching proxy.
 */
async function withPage(
  formData: FormData,
  run: (
    context: Awaited<ReturnType<typeof requireWebsiteAccess>>,
    pageId: string,
  ) => Promise<string | void>,
): Promise<PageContentActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const pageId = String(formData.get("__pageId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, {
    throwOnDenied: true,
  });

  let message: string | void;

  try {
    message = await run(context, pageId);
  } catch (error) {
    if (error instanceof PageContentCaptureError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}/pages/${pageId}`);
  return message ? { message } : {};
}

export async function capturePageContentAction(
  _previous: PageContentActionState,
  formData: FormData,
): Promise<PageContentActionState> {
  const pasted = String(formData.get("content") ?? "");
  const file = formData.get("file");

  const uploaded =
    file instanceof File && file.size > 0
      ? file.size > MAX_CONTENT_BYTES
        ? null
        : await file.text()
      : "";

  if (uploaded === null) {
    return { error: "That file is too large to capture." };
  }

  const content = uploaded.length > 0 ? uploaded : pasted;

  if (content.trim().length === 0) {
    return { error: "Paste the page content or choose a file." };
  }

  return withPage(formData, async (context, pageId) => {
    const result = await capturePageContent(context, {
      pageId,
      content,
      source: uploaded.length > 0 ? "UPLOAD" : "MANUAL_PASTE",
    });

    // An unchanged page is said plainly rather than reported as a new capture:
    // a snapshot per attempt would imply the page kept changing.
    return result.changed
      ? `Captured ${result.extracted.wordCount} words${
          result.extracted.truncated ? ", trimmed to the length limit" : ""
        }.`
      : "That content matches the snapshot already stored. Nothing changed.";
  });
}

export async function fetchPageContentAction(
  _previous: PageContentActionState,
  formData: FormData,
): Promise<PageContentActionState> {
  return withPage(formData, async (context, pageId) => {
    const result = await fetchPageContent(context, pageId);

    return result.changed
      ? `Fetched ${result.extracted.wordCount} words${
          result.extracted.truncated ? ", trimmed to the length limit" : ""
        }.`
      : "That page matches the snapshot already stored. Nothing changed.";
  });
}
