"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  ImportError,
  MAX_IMPORT_BYTES,
  cancelImport,
  commitImport,
  uploadImport,
  validateImport,
} from "@/server/services/import";
import type { ImportSource } from "@/generated/prisma/client";

export type ImportActionState = { error?: string; message?: string };

const SOURCES: ImportSource[] = [
  "SEMRUSH_POSITIONS",
  "SEMRUSH_KEYWORD_OVERVIEW",
  "SEMRUSH_COMPETITORS",
  "AHREFS_POSITIONS",
  "AHREFS_KEYWORD_OVERVIEW",
  "AHREFS_COMPETITORS",
  "MANUAL_CSV",
];

/**
 * Upload, then straight to the preview.
 *
 * The redirect is the point: an upload that silently succeeded would leave a
 * person believing data had been imported when nothing has been written. Landing
 * on the preview makes the next decision unavoidable.
 */
export async function uploadImportAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a CSV file to upload." };
  }

  if (file.size > MAX_IMPORT_BYTES) {
    return { error: "That file is larger than 5 MB." };
  }

  const declared = String(formData.get("source") ?? "");
  // Only a value from our own list is accepted. A source arriving from a form is
  // still an instruction about how to read somebody's numbers.
  const source = SOURCES.find((candidate) => candidate === declared);

  const capturedAt = String(formData.get("capturedAt") ?? "").trim();

  let importId: string;

  try {
    const result = await uploadImport(context, {
      fileName: file.name,
      content: await file.text(),
      source,
      capturedAt: /^\d{4}-\d{2}-\d{2}$/.test(capturedAt) ? capturedAt : undefined,
    });

    importId = result.record.id;
  } catch (error) {
    if (error instanceof ImportError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}/imports`);
  redirect(`/websites/${websiteId}/imports/${importId}`);
}

export async function revalidateImportAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const importId = String(formData.get("__importId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  try {
    await validateImport(context, importId);
  } catch (error) {
    if (error instanceof ImportError) return { error: error.message };
    throw error;
  }

  revalidatePath(`/websites/${websiteId}/imports/${importId}`);
  return {};
}

export async function commitImportAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const importId = String(formData.get("__importId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  try {
    const result = await commitImport(context, importId);

    revalidatePath(`/websites/${websiteId}`, "layout");

    // Says what was written, per table. A single "imported successfully" would
    // hide the case where a file produced far fewer rows than expected.
    const parts = [
      `${result.keywordsCreated} new keywords`,
      result.metricsWritten > 0 ? `${result.metricsWritten} metric snapshots` : null,
      result.rankingsWritten > 0 ? `${result.rankingsWritten} ranking snapshots` : null,
      result.competitorRowsWritten > 0
        ? `${result.competitorRowsWritten} competitor rows`
        : null,
      result.skipped > 0 ? `${result.skipped} rows skipped` : null,
    ].filter(Boolean);

    return { message: `Committed: ${parts.join(", ")}.` };
  } catch (error) {
    if (error instanceof ImportError) return { error: error.message };
    throw error;
  }
}

export async function cancelImportAction(
  _previous: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const importId = String(formData.get("__importId") ?? "");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.WRITE, { throwOnDenied: true });

  try {
    await cancelImport(context, importId);
  } catch (error) {
    if (error instanceof ImportError) return { error: error.message };
    throw error;
  }

  revalidatePath(`/websites/${websiteId}/imports`);
  redirect(`/websites/${websiteId}/imports`);
}
