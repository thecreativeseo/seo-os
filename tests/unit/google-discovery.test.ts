import { describe, expect, it } from "vitest";

import {
  CONNECTION_STATE_MESSAGES,
  DISCOVERY_FAILURE_CODES,
  canChooseProperty,
  needsReauthorization,
} from "@/lib/connections/discovery";
import {
  classifyDiscoveryFailure,
  safeDiagnostic,
  safeGoogleErrorFacts,
  GoogleDiscoveryError,
} from "@/server/connectors/google/discovery";

/**
 * Reading what Google said (Google connections hotfix).
 *
 * Before this, every one of these produced `list_failed` and the same sentence
 * telling the user to reauthorize, which was the right advice for exactly one
 * of them. Each case below is a real Google response shape.
 */

const facts = (httpStatus: number, payload?: unknown) =>
  safeGoogleErrorFacts(payload ?? null, httpStatus);

const classify = (httpStatus: number, payload?: unknown) =>
  classifyDiscoveryFailure(facts(httpStatus, payload));

describe("what Google said", () => {
  it("takes the status and the machine reason, and nothing else", () => {
    const parsed = facts(403, {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "Search Console API has not been used in project 12345 before or it is disabled.",
        errors: [
          {
            message: "Access Not Configured.",
            domain: "usageLimits",
            reason: "accessNotConfigured",
          },
        ],
      },
    });

    expect(parsed).toEqual({
      httpStatus: 403,
      googleStatus: "PERMISSION_DENIED",
      googleReason: "accessNotConfigured",
    });
    // The message names a project and can echo the request. It is not kept.
    expect(JSON.stringify(parsed)).not.toContain("project 12345");
  });

  it("reads the machine reason newer APIs put in details instead", () => {
    expect(
      facts(403, {
        error: {
          status: "PERMISSION_DENIED",
          details: [
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" },
          ],
        },
      }).googleReason,
    ).toBe("SERVICE_DISABLED");
  });

  it("survives a body that is not the shape we expect", () => {
    for (const payload of [
      null,
      undefined,
      "a string",
      42,
      {},
      { error: null },
      { error: "x" },
      [],
    ]) {
      expect(facts(500, payload)).toEqual({
        httpStatus: 500,
        googleStatus: null,
        googleReason: null,
      });
    }
  });
});

describe("classification", () => {
  it("calls an expired or rejected token a reauthorization", () => {
    expect(
      classify(401, { error: { status: "UNAUTHENTICATED", errors: [{ reason: "authError" }] } }),
    ).toBe("REAUTH_REQUIRED");
    expect(classify(400, { error: { status: "UNAUTHENTICATED" } })).toBe("REAUTH_REQUIRED");
  });

  it("calls a disabled API a disabled API, in either shape Google sends it", () => {
    expect(classify(403, { error: { errors: [{ reason: "accessNotConfigured" }] } })).toBe(
      "API_NOT_ENABLED",
    );
    expect(classify(403, { error: { details: [{ reason: "SERVICE_DISABLED" }] } })).toBe(
      "API_NOT_ENABLED",
    );
    expect(
      classify(403, { error: { errors: [{ reason: "accessNotConfiguredServiceDisabled" }] } }),
    ).toBe("API_NOT_ENABLED");
  });

  it("calls a permission refusal a scope problem", () => {
    expect(classify(403, { error: { errors: [{ reason: "insufficientPermissions" }] } })).toBe(
      "INSUFFICIENT_SCOPE",
    );
    expect(
      classify(403, { error: { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }),
    ).toBe("INSUFFICIENT_SCOPE");
    // An unrecognised 403 is still Google refusing this grant, and reconnecting
    // is the remedy either way. The reason it gave is carried alongside.
    expect(classify(403, { error: { errors: [{ reason: "somethingNew" }] } })).toBe(
      "INSUFFICIENT_SCOPE",
    );
    expect(classify(403)).toBe("INSUFFICIENT_SCOPE");
  });

  it("reuses the existing vocabulary for rate limits and outages", () => {
    expect(classify(429)).toBe("RATE_LIMITED");
    for (const status of [500, 502, 503, 504])
      expect(classify(status)).toBe("PROVIDER_UNAVAILABLE");
  });

  it("falls back to a plain discovery failure, never to a reauthorization guess", () => {
    for (const status of [400, 404, 409, 418]) {
      expect(classify(status)).toBe("PROPERTY_DISCOVERY_FAILED");
    }
  });
});

describe("the safe diagnostic", () => {
  it("carries provider, operation, status, reason and code, and nothing more", () => {
    const error = new GoogleDiscoveryError("API_NOT_ENABLED", {
      httpStatus: 403,
      googleStatus: "PERMISSION_DENIED",
      googleReason: "accessNotConfigured",
    });
    const diagnostic = safeDiagnostic("GOOGLE_SEARCH_CONSOLE", "list_properties", error);

    expect(diagnostic).toEqual({
      provider: "GOOGLE_SEARCH_CONSOLE",
      operation: "list_properties",
      httpStatus: 403,
      googleStatus: "PERMISSION_DENIED",
      googleReason: "accessNotConfigured",
      classifiedCode: "API_NOT_ENABLED",
    });
    expect(Object.keys(diagnostic)).toHaveLength(6);

    const text = JSON.stringify(diagnostic);
    expect(text).not.toMatch(/token|bearer|authorization|secret|refresh|credential/i);
  });

  it("says so plainly when Google sent nothing to go on", () => {
    const diagnostic = safeDiagnostic(
      "GOOGLE_ANALYTICS",
      "list_properties",
      new GoogleDiscoveryError("INVALID_PROVIDER_RESPONSE", null),
    );
    expect(diagnostic.httpStatus).toBe(0);
    expect(diagnostic.googleStatus).toBeNull();
    expect(diagnostic.googleReason).toBeNull();
  });
});

describe("what a person is told", () => {
  it("has a message for every state, and only offers reconnecting where it helps", () => {
    for (const code of DISCOVERY_FAILURE_CODES) {
      expect(CONNECTION_STATE_MESSAGES[code].length, code).toBeGreaterThan(20);
    }

    expect(needsReauthorization("REAUTH_REQUIRED")).toBe(true);
    expect(needsReauthorization("INSUFFICIENT_SCOPE")).toBe(true);
    // These four used to say "the authorization may need to be repeated". None
    // of them is fixed by reconnecting.
    for (const code of [
      "API_NOT_ENABLED",
      "NO_ACCESSIBLE_PROPERTIES",
      "PROPERTY_DISCOVERY_FAILED",
      "RATE_LIMITED",
    ] as const) {
      expect(needsReauthorization(code), code).toBe(false);
      expect(CONNECTION_STATE_MESSAGES[code].toLowerCase(), code).not.toContain("reconnect");
    }
  });

  it("does not present an account with no properties as a failure", () => {
    const message = CONNECTION_STATE_MESSAGES.NO_ACCESSIBLE_PROPERTIES.toLowerCase();
    expect(message).toContain("connected");
    expect(message).not.toMatch(/error|failed|authoriz/);
  });

  it("offers the picker only where there is something to pick", () => {
    expect(canChooseProperty("PROPERTY_SELECTION_REQUIRED")).toBe(true);
    expect(canChooseProperty("READY")).toBe(true);
    expect(canChooseProperty("NO_ACCESSIBLE_PROPERTIES")).toBe(false);
    expect(canChooseProperty("API_NOT_ENABLED")).toBe(false);
    expect(canChooseProperty("REAUTH_REQUIRED")).toBe(false);
  });
});
