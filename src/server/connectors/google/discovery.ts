import type { DiscoveryFailureCode } from "@/lib/connections/discovery";

/**
 * Reading what Google actually said when a property lookup failed.
 *
 * The old code threw one error, `list_failed`, for every non-OK response, so
 * "the API is not enabled on your Cloud project", "this token never got the
 * scope", "the token expired" and "Google is down" were indistinguishable, and
 * the interface guessed the same wrong remedy for all of them.
 *
 * Google does say which. A failed response carries `error.status`, a machine
 * `reason` on each entry in `error.errors`, and on newer APIs another in
 * `error.details`. Those three, plus the HTTP status, are enough to classify,
 * and they are scalars from a fixed vocabulary rather than free text.
 *
 * Nothing else is taken. Not `error.message`, which echoes the request and can
 * therefore carry a URL, an id, or a header; not the body; not the token that
 * was sent. What comes out of here is a code, a status and a reason, and those
 * are the only fields anything downstream is given to log or show.
 */

export type GoogleErrorFacts = {
  /** The HTTP status Google returned. */
  httpStatus: number;
  /** `error.status`, e.g. "PERMISSION_DENIED". Null when Google did not send one. */
  googleStatus: string | null;
  /** The first machine reason, e.g. "accessNotConfigured". Null when absent. */
  googleReason: string | null;
};

export type SafeDiagnostic = GoogleErrorFacts & {
  provider: string;
  operation: string;
  classifiedCode: DiscoveryFailureCode;
};

/** Reasons that mean the API is not turned on for this Cloud project. */
const API_DISABLED_REASONS = [
  "accessnotconfigured",
  "accessnotconfiguredservicedisabled",
  "servicedisabled",
  "service_disabled",
  "api_not_enabled",
];

/**
 * Reasons that mean the token did not carry the permission the call needs.
 * Kept as the record of what INSUFFICIENT_SCOPE is answering, and as the list to
 * consult first if that branch ever needs to narrow.
 */
export const SCOPE_REASONS = [
  "insufficientpermissions",
  "insufficientscope",
  "access_token_scope_insufficient",
  "acl_insufficient",
  "forbidden_scope",
];

const normalise = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * Compares ignoring case and separators, so ACCESS_TOKEN_SCOPE_INSUFFICIENT and
 * accessTokenScopeInsufficient are recognised as the same answer.
 */
const matches = (reason: string | null, table: readonly string[]): boolean => {
  if (reason === null) return false;
  const flat = reason.toLowerCase().replace(/[\s_-]/g, "");
  return table.some((entry) => entry.replace(/[\s_-]/g, "") === flat);
};

/**
 * Pulls the safe scalars out of a parsed Google error body.
 *
 * Tolerates every shape, including none: a body that is not JSON, or is JSON of
 * a form we do not know, yields nulls rather than throwing. A classifier that
 * fell over on an unexpected error body would turn a diagnosable failure into
 * an undiagnosable one.
 */
export function safeGoogleErrorFacts(payload: unknown, httpStatus: number): GoogleErrorFacts {
  const facts: GoogleErrorFacts = { httpStatus, googleStatus: null, googleReason: null };
  if (payload === null || typeof payload !== "object") return facts;

  const error = (payload as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return facts;

  const body = error as {
    status?: unknown;
    errors?: unknown;
    details?: unknown;
  };

  facts.googleStatus = normalise(body.status);

  if (Array.isArray(body.errors)) {
    for (const entry of body.errors) {
      const reason = normalise((entry as { reason?: unknown } | null)?.reason);
      if (reason) {
        facts.googleReason = reason;
        break;
      }
    }
  }

  // Newer APIs carry the machine reason here instead, as an ErrorInfo.
  if (facts.googleReason === null && Array.isArray(body.details)) {
    for (const entry of body.details) {
      const reason = normalise((entry as { reason?: unknown } | null)?.reason);
      if (reason) {
        facts.googleReason = reason;
        break;
      }
    }
  }

  return facts;
}

/**
 * The classification, from the status and the reason.
 *
 * An unrecognised 403 is called INSUFFICIENT_SCOPE rather than a generic
 * failure. A 403 from a list endpoint, with a token Google itself just issued,
 * is Google saying this grant may not read this; and the remedy that state
 * offers, reconnect and approve, is also the remedy when a scope was quietly
 * dropped. The reason Google gave is carried alongside either way, so an
 * administrator sees the real cause even when the label is the general one.
 */
export function classifyDiscoveryFailure(facts: GoogleErrorFacts): DiscoveryFailureCode {
  const { httpStatus, googleStatus, googleReason } = facts;

  if (httpStatus === 401) return "REAUTH_REQUIRED";

  // Google answers 400 UNAUTHENTICATED for a token it will not accept at all.
  if (httpStatus === 400 && googleStatus === "UNAUTHENTICATED") return "REAUTH_REQUIRED";

  if (httpStatus === 403) {
    if (matches(googleReason, API_DISABLED_REASONS)) return "API_NOT_ENABLED";
    return "INSUFFICIENT_SCOPE";
  }

  if (httpStatus === 429) return "RATE_LIMITED";
  if (httpStatus >= 500) return "PROVIDER_UNAVAILABLE";

  return "PROPERTY_DISCOVERY_FAILED";
}

export class GoogleDiscoveryError extends Error {
  constructor(
    readonly code: DiscoveryFailureCode,
    readonly facts: GoogleErrorFacts | null,
  ) {
    super(`Google property discovery failed: ${code}`);
    this.name = "GoogleDiscoveryError";
  }
}

/**
 * Reads a failed response and throws the classified error.
 *
 * The body is parsed defensively: a non-JSON error page still classifies by
 * HTTP status alone.
 */
export async function discoveryFailure(response: Response): Promise<never> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Not JSON. The status still classifies it.
  }

  const facts = safeGoogleErrorFacts(payload, response.status);
  throw new GoogleDiscoveryError(classifyDiscoveryFailure(facts), facts);
}

/**
 * A line for the server log: provider, operation, and the three safe scalars.
 *
 * Deliberately built here rather than at the call site, so there is one place
 * that decides what a Google failure is allowed to say. No token, no header, no
 * body, no URL.
 */
export function safeDiagnostic(
  provider: string,
  operation: string,
  error: GoogleDiscoveryError,
): SafeDiagnostic {
  return {
    provider,
    operation,
    httpStatus: error.facts?.httpStatus ?? 0,
    googleStatus: error.facts?.googleStatus ?? null,
    googleReason: error.facts?.googleReason ?? null,
    classifiedCode: error.code,
  };
}
