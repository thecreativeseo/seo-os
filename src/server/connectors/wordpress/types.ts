import type { CmsCapability, CmsEntityType } from "@/generated/prisma/client";
import type { ExecutionErrorCode } from "@/lib/execution/errors";
import type { CanonicalSiteUrl } from "@/lib/cms/url";

/**
 * What SEO OS needs a CMS to be able to do, and nothing more.
 *
 * Five operations, chosen because M6 needs exactly these five. There is no
 * update, no publish, no delete and no media: a provider cannot be asked to do
 * what this milestone has decided not to do, because there is no method to call.
 * When publishing arrives it will add a method and a capability, deliberately.
 *
 * Two implementations answer this: WordPress over its REST API, and a simulated
 * one backed by CmsSandboxPost for demo websites. They share the contract so an
 * execution is the same execution either way, and so the demo proves the real
 * path rather than a parallel one.
 */

/** Everything a provider needs to talk to one site, resolved and checked. */
export type ProviderContext = {
  /** Already through the SSRF policy. A provider cannot build a URL any other way. */
  site: CanonicalSiteUrl;
  /** Decrypted immediately before use and never stored, logged or returned. */
  credential: { username: string; applicationPassword: string };
  /** The transport, injected so tests never reach a network. */
  transport: CmsTransport;
};

/** One request, and one answer, with nothing secret in the answer. */
export type CmsTransport = (request: CmsRequest) => Promise<CmsTransportResult>;

export type CmsRequest = {
  method: "GET" | "POST";
  url: string;
  /** Built at call time and never persisted. */
  headers: Record<string, string>;
  body?: string;
  /**
   * Whether the request may have reached the CMS if it fails.
   *
   * A GET is safe to give up on. A POST that was transmitted may have been
   * acted on, so a failure after transmission is ambiguous rather than a
   * failure, and the transport is what knows which happened.
   */
  mutating: boolean;
};

export type CmsTransportResult =
  | { ok: true; status: number; body: string }
  /** Nothing was sent. Provably safe to try again. */
  | { ok: false; sent: false; code: ExecutionErrorCode }
  /** It may have been sent. The outcome is unknown and must not be retried. */
  | { ok: false; sent: true; code: ExecutionErrorCode };

/** What a provider says about an entity, in our terms rather than WordPress's. */
export type CmsEntity = {
  externalId: string;
  status: string;
  title: string;
  /** The stored content, preferred over any rendered form. */
  content: string;
  excerpt: string | null;
  slug: string;
  /** Only ever a stable, non-secret address. Null when only an authenticated one exists. */
  url: string | null;
};

export type CreateDraftInput = {
  entityType: CmsEntityType;
  title: string;
  slug: string | null;
  contentHtml: string;
  excerpt: string | null;
};

/** A provider failure, classified, with no provider text attached. */
export class CmsProviderError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    /** True when the CMS may have acted despite the failure. */
    readonly ambiguous: boolean = false,
    /** Diagnostic only. Zero when no answer arrived. */
    readonly httpStatus: number = 0,
  ) {
    super(`CMS provider failed: ${code}`);
    this.name = "CmsProviderError";
  }
}

export type DiscoveredCapability = {
  capability: CmsCapability;
  entityType: CmsEntityType | null;
  granted: boolean;
  /** How it was established. Never "assumed". */
  source: string;
};

export type ConnectionTestResult = {
  /** Who the CMS says we are. Display only. */
  accountName: string | null;
  capabilities: DiscoveredCapability[];
};

/** A candidate the CMS holds that might be the draft an ambiguous attempt created. */
export type ReconcileCandidate = {
  entity: CmsEntity;
};

export interface CmsProvider {
  /** Identifies the implementation on a step summary, and marks the simulated one. */
  readonly name: string;
  readonly simulated: boolean;

  /** Proves the site answers, the credentials are accepted, and the shape is WordPress. */
  testConnection(context: ProviderContext): Promise<ConnectionTestResult>;

  /** What the credentials are known to permit. Never inferred from authentication alone. */
  discoverCapabilities(context: ProviderContext): Promise<DiscoveredCapability[]>;

  /** Creates exactly one draft. Never retried by anything below this line. */
  createDraft(context: ProviderContext, input: CreateDraftInput): Promise<CmsEntity>;

  /** Reads one entity back, independently of whatever the create call said. */
  getEntity(
    context: ProviderContext,
    entityType: CmsEntityType,
    externalId: string,
  ): Promise<CmsEntity>;

  /**
   * Looks for a draft an ambiguous attempt may have created.
   *
   * Returns every plausible candidate rather than a choice. Deciding is the
   * caller's, and the rule there is that exactly one strong match may be
   * attached and anything else stays ambiguous.
   */
  reconcileCreate(
    context: ProviderContext,
    input: CreateDraftInput,
    window: { after: Date; before: Date },
  ): Promise<ReconcileCandidate[]>;
}
