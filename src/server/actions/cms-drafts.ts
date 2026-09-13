"use server";

import { revalidatePath } from "next/cache";

import { requireWebsiteAccess } from "@/server/auth/guards";
import { REQUIRED } from "@/server/auth/roles";
import { isCmsEntityType } from "@/lib/cms/target";
import {
  requestCreateWordPressDraft,
  requestReconcileWordPressDraft,
  requestReverifyWordPressDraft,
  type CmsDraftActionResult,
} from "@/server/services/cms-draft-request";
import { CmsProviderError, type DiscoveredCapability } from "@/server/connectors/wordpress/types";
import {
  configureWordPressConnection,
  markConnectionTested,
  testCmsConnection,
} from "@/server/services/cms-connection";
import { loadWordPressConnection } from "@/server/services/cms-connection";

/**
 * The forms behind the CMS screens (M6.4).
 *
 * Thin on purpose. Each of these reads a few fields, resolves the tenant, and
 * hands over to the service that owns the decision — M6.3 for the three human
 * acts, M6.2 for the connection test. None of them decides anything itself, and
 * none of them can widen what the service permits: the confirmation constant,
 * the provider, the auth type and the publishing policy are all fixed on the
 * server side of this boundary.
 *
 * Nothing here returns a credential, a provider body or an exception's text. A
 * result carries an outcome, our own code and our own sentence.
 */

export type CmsDraftActionState = {
  outcome?: CmsDraftActionResult["outcome"];
  message?: string;
  error?: string;
  code?: string;
};

export type CmsConnectionActionState = {
  message?: string;
  error?: string;
  code?: string;
  capabilities?: DiscoveredCapability[];
};

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** What a person is told for each outcome (M6.4 §17, §20). */
const OUTCOME_MESSAGES: Record<CmsDraftActionResult["outcome"], string> = {
  VERIFIED: "WordPress draft created and verified. It has not been published.",
  CREATED_VERIFICATION_FAILED:
    "The draft was created in WordPress, but SEO OS could not verify an exact match. No second draft will be created.",
  AMBIGUOUS_RECONCILIATION_REQUIRED:
    "SEO OS cannot prove whether WordPress created the draft. Do not try again — use Reconcile.",
  ALREADY_CREATED: "A WordPress draft already exists for this work.",
  ALREADY_IN_PROGRESS: "Draft creation is already in progress.",
  RETRY_SAFE_FAILURE:
    "No WordPress draft was created. Creating one can be attempted again when you are ready.",
  REFUSED: "This could not be done.",
};

/** Reconciliation says something different for the same outcomes (§20). */
const RECONCILE_MESSAGES: Partial<Record<CmsDraftActionResult["outcome"], string>> = {
  VERIFIED: "The draft was found in WordPress and verified against the approved revision.",
  CREATED_VERIFICATION_FAILED:
    "A draft was found, but its content or status does not exactly match the approved revision.",
  AMBIGUOUS_RECONCILIATION_REQUIRED:
    "SEO OS could not settle this: either more than one possible draft was found, or the search could not be completed. No retry has been authorized.",
  RETRY_SAFE_FAILURE:
    "No matching WordPress draft was found, so nothing was created. Creating one can be attempted again.",
};

/** And re-verification says something different again (§21). */
const REVERIFY_MESSAGES: Partial<Record<CmsDraftActionResult["outcome"], string>> = {
  VERIFIED: "The WordPress draft still matches the approved revision.",
  CREATED_VERIFICATION_FAILED:
    "The WordPress draft no longer matches the approved revision. Nothing in WordPress was changed.",
};

function describe(
  result: CmsDraftActionResult,
  overrides: Partial<Record<CmsDraftActionResult["outcome"], string>> = {},
): CmsDraftActionState {
  const message = overrides[result.outcome] ?? OUTCOME_MESSAGES[result.outcome];

  if (result.outcome === "REFUSED") {
    return {
      outcome: result.outcome,
      code: result.code ?? undefined,
      // The service's own sentence, which never quotes a provider.
      error: result.message ?? message,
    };
  }

  return { outcome: result.outcome, code: result.code ?? undefined, message };
}

const cmsDraftsPath = (websiteId: string) => `/websites/${websiteId}/cms-drafts`;

/**
 * "Create WordPress Draft".
 *
 * The confirmation the person gave is checked here for shape and then sent to
 * the service, which is where it actually matters: a browser can send any
 * string, and only the server's comparison decides.
 */
export async function createWordPressDraftAction(
  _previous: CmsDraftActionState,
  formData: FormData,
): Promise<CmsDraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");
  const target = text(formData, "targetEntityType");
  const confirmation = text(formData, "confirmation");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.REVIEW, { throwOnDenied: true });

  if (!isCmsEntityType(target)) {
    return { outcome: "REFUSED", error: "Choose whether this should be a post or a page." };
  }

  const result = await requestCreateWordPressDraft(context, {
    contentWorkItemId: workItemId,
    targetEntityType: target,
    confirmation,
  });

  revalidatePath(cmsDraftsPath(websiteId));
  revalidatePath(`/websites/${websiteId}`, "layout");
  return describe(result);
}

/** "Reconcile WordPress Draft": searches, never creates. */
export async function reconcileWordPressDraftAction(
  _previous: CmsDraftActionState,
  formData: FormData,
): Promise<CmsDraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.REVIEW, { throwOnDenied: true });
  const result = await requestReconcileWordPressDraft(context, {
    contentWorkItemId: workItemId,
  });

  revalidatePath(cmsDraftsPath(websiteId));
  return describe(result, RECONCILE_MESSAGES);
}

/** "Re-verify WordPress Draft": reads the existing draft, changes nothing. */
export async function reverifyWordPressDraftAction(
  _previous: CmsDraftActionState,
  formData: FormData,
): Promise<CmsDraftActionState> {
  const websiteId = text(formData, "__websiteId");
  const workItemId = text(formData, "__workItemId");

  const context = await requireWebsiteAccess(websiteId, REQUIRED.REVIEW, { throwOnDenied: true });
  const result = await requestReverifyWordPressDraft(context, {
    contentWorkItemId: workItemId,
  });

  revalidatePath(cmsDraftsPath(websiteId));
  return describe(result, REVERIFY_MESSAGES);
}

/** What a person is told when a connection problem has a code we recognise. */
const CONNECTION_ERRORS: Record<string, string> = {
  forbidden: "You do not have permission to change CMS connection settings.",
  invalid_site_url:
    "Enter the site's own https address, such as https://example.com — not a REST endpoint.",
  auth_required: "Enter both the WordPress username and an application password.",
  not_configured: "Configure the WordPress connection before testing it.",
  connection_disabled: "This connection is not currently connected.",
  cms_unreachable: "WordPress could not be reached at that address.",
  cms_permission_denied: "That WordPress account is not permitted to read this site.",
  cms_invalid_response: "That address answered, but not like a WordPress REST API.",
  cms_client_error: "WordPress refused the request.",
  cms_server_error: "WordPress returned a server error.",
  rate_limited: "WordPress asked us to slow down. Try again in a few minutes.",
  capability_missing: "The connected WordPress account does not have the permission required.",
  entity_not_found: "That WordPress REST API could not be found at this address.",
  target_invalid: "That address is not usable as a WordPress site address.",
};

function connectionError(error: unknown): CmsConnectionActionState {
  if (error instanceof CmsProviderError) {
    return {
      code: error.code,
      error:
        error.code === "auth_required"
          ? "WordPress did not accept those credentials."
          : (CONNECTION_ERRORS[error.code] ?? "The WordPress connection could not be completed."),
    };
  }
  throw error;
}

/**
 * Saves where the WordPress is and how to sign in to it.
 *
 * The application password arrives in a FormData field, goes straight into the
 * service that encrypts it, and is never put back into a result, a redirect or
 * a revalidated page. Nothing in this function returns it, and the form that
 * sends it is never pre-filled.
 */
export async function configureWordPressAction(
  _previous: CmsConnectionActionState,
  formData: FormData,
): Promise<CmsConnectionActionState> {
  const websiteId = text(formData, "__websiteId");

  // Changing credentials is administrative, and a stricter gate than executing
  // a draft somebody already approved.
  const context = await requireWebsiteAccess(websiteId, REQUIRED.APPROVE, { throwOnDenied: true });

  try {
    const saved = await configureWordPressConnection(context, {
      baseUrl: text(formData, "baseUrl"),
      username: text(formData, "username"),
      applicationPassword: String(formData.get("applicationPassword") ?? ""),
    });

    revalidatePath(`/websites/${websiteId}/connections`);
    return {
      message: `Saved for ${saved.siteHost}. Test the connection to check what the account may do.`,
    };
  } catch (error) {
    return connectionError(error);
  }
}

/**
 * "Test connection": one read, and what it proves.
 *
 * Read-only against WordPress. It asks who the credentials belong to and what
 * they may do, and stores the answer; it never creates anything to find out.
 */
export async function testWordPressConnectionAction(
  _previous: CmsConnectionActionState,
  formData: FormData,
): Promise<CmsConnectionActionState> {
  const websiteId = text(formData, "__websiteId");
  const context = await requireWebsiteAccess(websiteId, REQUIRED.APPROVE, { throwOnDenied: true });

  let connectionId: string;
  try {
    ({
      connection: { id: connectionId },
    } = await loadWordPressConnection(context));
  } catch (error) {
    return connectionError(error);
  }

  try {
    const outcome = await testCmsConnection(context);
    await markConnectionTested(context, connectionId, { ok: true });

    const granted = outcome.capabilities.filter((capability) => capability.granted).length;
    revalidatePath(`/websites/${websiteId}/connections`);

    return {
      capabilities: outcome.capabilities,
      message:
        granted === 0
          ? "Connected, but WordPress did not confirm any permissions for this account. Creating drafts is unavailable."
          : `Connected as ${outcome.accountName ?? "the configured account"}.`,
    };
  } catch (error) {
    const state = connectionError(error);
    await markConnectionTested(context, connectionId, { ok: false, errorCode: state.code });
    revalidatePath(`/websites/${websiteId}/connections`);
    return state;
  }
}
