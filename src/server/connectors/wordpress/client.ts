import type { CmsEntityType } from "@/generated/prisma/client";
import { cmsRestUrl } from "@/lib/cms/url";
import { compareText } from "@/lib/cms/content";
import { basicAuthHeader } from "./transport";
import {
  CmsProviderError,
  type CmsEntity,
  type CmsProvider,
  type ConnectionTestResult,
  type CreateDraftInput,
  type DiscoveredCapability,
  type ProviderContext,
  type ReconcileCandidate,
} from "./types";

/**
 * WordPress, over its own REST API.
 *
 * Core endpoints only. `wp/v2/posts` and `wp/v2/pages` are what WordPress ships
 * with, and everything M6 writes is a field WordPress itself defines: title,
 * slug, content, excerpt, and a status that is always the literal "draft".
 * Nothing here knows about Yoast, Rank Math or ACF, and that is not an omission
 * to be fixed later without deciding to: a meta key belongs to a plugin, and
 * writing to one we have not confirmed exists would write to nothing while
 * reporting success.
 *
 * Two rules run through the file. The URL always comes from `cmsRestUrl` over
 * an already-validated base, so no caller can name a host. And the credential is
 * turned into a header at the moment of the call and never held anywhere else.
 */

const ENDPOINTS: Record<CmsEntityType, string> = {
  POST: "/wp-json/wp/v2/posts",
  PAGE: "/wp-json/wp/v2/pages",
};

/** WordPress capability names, and what each one lets us promise. */
const CAPABILITY_EVIDENCE: { key: string; entityType: CmsEntityType }[] = [
  { key: "edit_posts", entityType: "POST" },
  { key: "edit_pages", entityType: "PAGE" },
];

function url(context: ProviderContext, path: string, query: Record<string, string | number> = {}) {
  const built = cmsRestUrl(context.site, path, query);
  if (!built.ok) throw new CmsProviderError("target_invalid");
  return built.value;
}

function headers(context: ProviderContext, json: boolean): Record<string, string> {
  return {
    Authorization: basicAuthHeader(
      context.credential.username,
      context.credential.applicationPassword,
    ),
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

/**
 * Maps an HTTP status to our vocabulary. The body is never read for meaning.
 *
 * 404 means two different things by method. Asked for one entity, it is gone.
 * Answering a create, it is the REST route that is missing — the API disabled,
 * or a base URL pointing at something that is not this WordPress — and calling
 * that "entity not found" would send someone looking for a post that was never
 * asked for.
 */
function statusCode(status: number, mutating: boolean): CmsProviderError {
  if (status === 401) return new CmsProviderError("auth_required", false, status);
  if (status === 403) return new CmsProviderError("cms_permission_denied", false, status);
  if (status === 404) {
    return new CmsProviderError(mutating ? "cms_client_error" : "entity_not_found", false, status);
  }
  if (status === 429) return new CmsProviderError("rate_limited", false, status);
  if (status >= 500) return new CmsProviderError("cms_server_error", false, status);
  return new CmsProviderError("cms_client_error", false, status);
}

async function send(
  context: ProviderContext,
  request: { method: "GET" | "POST"; url: string; body?: string; mutating: boolean },
): Promise<unknown> {
  const result = await context.transport({
    method: request.method,
    url: request.url,
    headers: headers(context, request.method === "POST"),
    body: request.body,
    mutating: request.mutating,
  });

  if (!result.ok) {
    // `sent` is the whole question for a create: a request that may have arrived
    // cannot be treated as a clean failure.
    throw new CmsProviderError(result.code, request.mutating && result.sent);
  }

  if (result.status < 200 || result.status >= 300) {
    const error = statusCode(result.status, request.mutating);
    // A 5xx answer to a create is ambiguous: WordPress may have written the row
    // and failed afterwards.
    throw new CmsProviderError(error.code, request.mutating && result.status >= 500, result.status);
  }

  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    throw new CmsProviderError("cms_invalid_response", false, result.status);
  }
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** WordPress returns `{ raw, rendered }` under edit context; raw is what it stored. */
function field(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const shape = value as { raw?: unknown; rendered?: unknown };
    return text(shape.raw) ?? text(shape.rendered);
  }
  return null;
}

/**
 * Reads an entity out of a WordPress response.
 *
 * An id and a status are required: without an id there is nothing to verify
 * against later, and a create that cannot name what it made is not a success.
 * Anything missing those is an unrecognisable answer rather than a partial one.
 */
function readEntity(payload: unknown): CmsEntity {
  if (!payload || typeof payload !== "object") throw new CmsProviderError("cms_invalid_response");

  const body = payload as Record<string, unknown>;
  const id = typeof body.id === "number" ? String(body.id) : text(body.id);
  const status = text(body.status);

  if (!id || id.length === 0 || !status) throw new CmsProviderError("cms_invalid_response");

  return {
    externalId: id,
    status,
    title: field(body.title) ?? "",
    content: field(body.content) ?? "",
    excerpt: field(body.excerpt),
    slug: text(body.slug) ?? "",
    // `link` for a draft is a permalink WordPress will use once published. It
    // carries no token, and it is stored only when it is a plain address.
    url: safeLink(text(body.link)),
  };
}

/**
 * Whether a returned address is safe to keep.
 *
 * A draft preview address carries a nonce or a token, and one of those in the
 * database is a credential we did not mean to store and cannot expire. Anything
 * with a query string is refused for that reason alone.
 */
export function safeLink(link: string | null): string | null {
  if (!link) return null;
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.search.length > 0 || parsed.hash.length > 0) return null;
    if (parsed.username.length > 0 || parsed.password.length > 0) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export class WordPressProvider implements CmsProvider {
  readonly name = "wordpress";
  readonly simulated = false;

  async testConnection(context: ProviderContext): Promise<ConnectionTestResult> {
    const me = await send(context, {
      method: "GET",
      url: url(context, "/wp-json/wp/v2/users/me", { context: "edit" }),
      mutating: false,
    });

    if (!me || typeof me !== "object") throw new CmsProviderError("cms_invalid_response");

    const body = me as { name?: unknown; capabilities?: unknown };
    return {
      accountName: text(body.name),
      capabilities: this.readCapabilities(body.capabilities),
    };
  }

  async discoverCapabilities(context: ProviderContext): Promise<DiscoveredCapability[]> {
    return (await this.testConnection(context)).capabilities;
  }

  /**
   * What the connected user may do, from what WordPress says rather than from
   * the fact that it let us in.
   *
   * `users/me` under edit context returns the capability map, which is the only
   * thing core offers that answers this without writing something. When the map
   * is absent the answer is not granted: an unknown permission and a denied one
   * are treated the same, because acting on a guess is what this exists to
   * prevent. Creating a draft to find out is not an option, for the obvious
   * reason that it would create a draft.
   */
  private readCapabilities(raw: unknown): DiscoveredCapability[] {
    const map = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const source = map ? "wp_users_me" : "wp_users_me_absent";
    const granted = (key: string) => (map ? map[key] === true : false);

    return [
      {
        capability: "READ_CONTENT",
        entityType: null,
        granted: granted("read"),
        source,
      },
      ...CAPABILITY_EVIDENCE.map(({ key, entityType }) => ({
        capability: "CREATE_DRAFT" as const,
        entityType,
        granted: granted(key),
        source,
      })),
    ];
  }

  async createDraft(context: ProviderContext, input: CreateDraftInput): Promise<CmsEntity> {
    // Core fields only, and a status that is a literal. There is no path
    // through this object by which a caller could publish.
    const body: Record<string, string> = {
      title: input.title,
      content: input.contentHtml,
      status: "draft",
    };
    if (input.slug) body.slug = input.slug;
    if (input.excerpt) body.excerpt = input.excerpt;

    const payload = await send(context, {
      method: "POST",
      url: url(context, ENDPOINTS[input.entityType], { context: "edit" }),
      body: JSON.stringify(body),
      mutating: true,
    });

    // Returned as WordPress described it, including a status that is not the
    // draft we asked for. That is a verification failure and not a create
    // failure: the entity exists and has an id, and losing the id here would
    // leave a real post nothing points at. The caller persists it and records
    // CMS_STATUS_DRAFT as failed.
    return readEntity(payload);
  }

  async getEntity(
    context: ProviderContext,
    entityType: CmsEntityType,
    externalId: string,
  ): Promise<CmsEntity> {
    if (!/^\d+$/.test(externalId)) throw new CmsProviderError("target_invalid");

    return readEntity(
      await send(context, {
        method: "GET",
        url: url(context, `${ENDPOINTS[entityType]}/${externalId}`, { context: "edit" }),
        mutating: false,
      }),
    );
  }

  async reconcileCreate(
    context: ProviderContext,
    input: CreateDraftInput,
    window: { after: Date; before: Date },
  ): Promise<ReconcileCandidate[]> {
    const payload = await send(context, {
      method: "GET",
      url: url(context, ENDPOINTS[input.entityType], {
        context: "edit",
        status: "draft",
        per_page: 50,
        after: window.after.toISOString(),
        before: window.before.toISOString(),
        // Narrowed by title, but never decided by it: the caller compares the
        // whole canonical content before attaching anything.
        search: input.title,
      }),
      mutating: false,
    });

    if (!Array.isArray(payload)) throw new CmsProviderError("cms_invalid_response");

    const candidates: ReconcileCandidate[] = [];
    for (const item of payload) {
      try {
        candidates.push({ entity: readEntity(item) });
      } catch {
        // An unreadable row is not a candidate. It is also not a reason to fail
        // the search, which would turn an ambiguous create into an unresolvable one.
      }
    }
    return candidates;
  }
}

/** Whether an observed draft is the same title we asked for. Used by reconciliation. */
export function titleMatches(expected: string, observed: string): boolean {
  return compareText(expected, observed);
}
