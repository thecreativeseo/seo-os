"use server";

import { revalidatePath } from "next/cache";

import { requireWorkspaceAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { WorkspaceError, renameWorkspace } from "@/server/services/workspace";

export type WorkspaceState = { error?: string; saved?: boolean };

export async function renameWorkspaceAction(
  _previous: WorkspaceState,
  formData: FormData,
): Promise<WorkspaceState> {
  const workspaceId = String(formData.get("__workspaceId") ?? "");
  const name = String(formData.get("name") ?? "");

  const context = await requireWorkspaceAccess(workspaceId, REQUIRED.APPROVE, {
    throwOnDenied: true,
  });

  try {
    await renameWorkspace(context, name);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/workspaces/${workspaceId}`, "layout");
  return { saved: true };
}
