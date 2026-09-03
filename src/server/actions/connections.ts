"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import {
  ConnectionAuthError,
  connectApiKey,
  disconnectProvider,
  isApiKeyProvider,
  selectProperty,
} from "@/server/services/connection-auth";
import { providerFromSlug } from "@/server/connectors/google/oauth";
import { databaseForMarket, fetchOrganicPositions } from "@/server/connectors/semrush/client";

export type ConnectionActionState = { error?: string };

/**
 * Stores an API key for a key-authenticated provider.
 *
 * The key is verified against the provider first, with a deliberately tiny
 * request — one row — because the alternative is a connection that reads
 * CONNECTED on a typo and fails on every sync afterwards. CLAUDE.md's "do not
 * fake a successful connection" is the rule; a one-row probe is what makes it
 * true rather than hopeful.
 *
 * The key reaches this function in a FormData field and goes straight into
 * `connectApiKey`, which encrypts it. It is never returned, never revalidated
 * into a page, and never logged.
 */
export async function connectApiKeyAction(
  _previous: ConnectionActionState,
  formData: FormData,
): Promise<ConnectionActionState> {
  const websiteId = String(formData.get("__websiteId") ?? "");
  const provider = String(formData.get("__provider") ?? "").toUpperCase();
  const apiKey = String(formData.get("apiKey") ?? "");

  if (!isApiKeyProvider(provider)) {
    return { error: "Unknown provider." };
  }

  if (!apiKey.trim()) {
    return { error: "Enter the API key." };
  }

  const context = await requireWebsiteAccess(websiteId, REQUIRED.APPROVE, {
    throwOnDenied: true,
  });

  if (provider === "AHREFS") {
    // The credential path is provider-agnostic; the Ahrefs connector is not
    // written yet. Saying so is better than storing a key nothing will read.
    return { error: "Ahrefs API access is not implemented yet. Import an export instead." };
  }

  const database = databaseForMarket(context.website.primaryMarket);

  if (!database) {
    return { error: "Set this website's primary market before connecting Semrush." };
  }

  try {
    await connectApiKey(context, provider, apiKey, async (key) => {
      await fetchOrganicPositions({
        apiKey: key,
        domain: context.website.normalizedDomain,
        database,
        // One row. Enough to prove the key, the plan and the database, and
        // cheap: rows are billed.
        maxRows: 1,
      });
    });
  } catch (error) {
    if (error instanceof ConnectionAuthError) {
      return { error: error.message };
    }
    throw error;
  }

  revalidatePath(`/websites/${websiteId}`, "layout");
  return {};
}

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
  const raw = String(formData.get("__provider") ?? "");

  // Google providers arrive as a URL slug; key providers as the enum name. Both
  // resolve through a whitelist rather than being cast, so a request naming an
  // arbitrary provider is refused here rather than reaching the database.
  const upper = raw.toUpperCase();
  const provider = isApiKeyProvider(upper) ? upper : providerFromSlug(raw);

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
