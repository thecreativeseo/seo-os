"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  ConnectionAuthError,
  disconnectProvider,
  selectProperty,
} from "@/server/services/connection-auth";
import { providerFromSlug } from "@/server/connectors/google/oauth";

export type ConnectionActionState = { error?: string };

export async function selectPropertyAction(
  _previous: ConnectionActionState,
  formData: FormData,
): Promise<ConnectionActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const provider = providerFromSlug(String(formData.get("__provider") ?? ""));
  const propertyId = String(formData.get("propertyId") ?? "");
  const propertyName = String(formData.get("propertyName") ?? propertyId);

  if (!provider || !propertyId) {
    return { error: "Choose a property to continue." };
  }

  const context = await requireWebsiteAccess(websiteId, REQUIRED.APPROVE, {
    throwOnDenied: true,
  });

  try {
    await selectProperty(context, provider, { id: propertyId, name: propertyName });
  } catch (error) {
    if (error instanceof ConnectionAuthError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return {};
}

export async function disconnectProviderAction(
  _previous: ConnectionActionState,
  formData: FormData,
): Promise<ConnectionActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const provider = providerFromSlug(String(formData.get("__provider") ?? ""));

  if (!provider) {
    return { error: "Unknown provider." };
  }

  const context = await requireWebsiteAccess(websiteId, REQUIRED.APPROVE, {
    throwOnDenied: true,
  });

  try {
    await disconnectProvider(context, provider);
  } catch (error) {
    if (error instanceof ConnectionAuthError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return {};
}
