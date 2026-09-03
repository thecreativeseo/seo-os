import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  AhrefsError,
  SELECT_FIELDS,
  centsToCurrency,
  countryForMarket,
  fetchOrganicKeywords,
  parseKeywords,
} from "@/server/connectors/ahrefs/client";
import { connectApiKey } from "@/server/services/connection-auth";
import { runAhrefsSync, runSemrushSync } from "@/server/services/sync";
import { pickPrimary, providersDisagree } from "@/lib/keyword/provider-precedence";

/**
 * The Ahrefs live connector (docs/P2_SPEC.md §7 LIVE API MODE, second provider).
 *
 * The tests that matter most here are not the happy path — that is the same
 * shape as Semrush — but the three places the two vendors differ:
 *
 *   - Ahrefs reports CPC in cents and Semrush in dollars, into one column. A
 *     missed conversion is a hundredfold error that violates no constraint and
 *     looks like a real price.
 *   - The key is a Bearer header, so the test asserts it is sent as one and that
 *     it never appears in an error, a run row, or the audit trail.
 *   - Neither provider's snapshot may overwrite the other's. Their disagreement
 *     is a fact the product stores, not a conflict it resolves.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const KEY = "test-ahrefs-key-do-not-use";

function keyword(overrides: Record<string, unknown> = {}) {
  return {
    keyword: "seo audit",
    best_position: 4,
    best_position_url: "https://example.com/seo-audit",
    volume: 1300,
    keyword_difficulty: 62,
    // Cents, per the documented schema: $12.40.
    cpc: 1240,
    serp_features: ["featured_snippet", "people_also_ask"],
    ...overrides,
  };
}

function body(keywords: unknown[]): string {
  return JSON.stringify({ keywords });
}

/** A fetch that answers with a body, recording url and headers. */
function stubFetch(responses: (string | { status: number; body: string })[]): {
  impl: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const queue = [...responses];

  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }

    calls.push({ url: String(input), headers });

    const next = queue.shift() ?? body([]);
    const { status, body: text } = typeof next === "string" ? { status: 200, body: next } : next;

    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

async function makeTenant(label: string, market = "PH"): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `ah-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Ahrefs ${label}`, slug: `ah-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: "OWNER",
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });

  const host = `${label}-${suffix}.example.com`;

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: host,
      normalizedDomain: host,
      primaryLanguage: "en",
      primaryMarket: market,
    },
  });

  return { user, membership, organization, workspace, website };
}

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("converting Ahrefs CPC", () => {
  it("reads cents as currency units", () => {
    // The single most consequential conversion in the connector: $12.40, not
    // $1,240. Semrush writes dollars into the same column.
    expect(centsToCurrency(1240)).toBe(12.4);
    expect(centsToCurrency(0)).toBe(0);
    expect(centsToCurrency(7)).toBe(0.07);
  });

  it("keeps an absent price null rather than free", () => {
    expect(centsToCurrency(null)).toBeNull();
    expect(centsToCurrency(undefined)).toBeNull();
    expect(centsToCurrency("nonsense")).toBeNull();
  });
});

describe("parsing an Ahrefs response", () => {
  it("reads a keyword into the shape the importer already produces", () => {
    const { rows, malformed, missingFields } = parseKeywords({ keywords: [keyword()] });

    expect(malformed).toBe(0);
    expect(missingFields).toEqual([]);
    expect(rows).toHaveLength(1);

    expect(rows[0]).toMatchObject({
      keyword: "seo audit",
      normalizedKeyword: "seo audit",
      position: 4,
      searchVolume: 1300,
      keywordDifficulty: 62,
      // Converted from 1240 cents.
      cpc: 12.4,
      landingUrl: "https://example.com/seo-audit",
      rankingType: "ORGANIC",
      serpFeatures: ["featured_snippet", "people_also_ask"],
      // Neither field is returned by this endpoint, and neither is invented.
      intent: null,
      previousPosition: null,
      // The report is dated, not each row, so the caller stamps it.
      capturedAt: null,
    });
  });

  it("refuses a payload without the documented keywords array", () => {
    // Reading some other array we happened to find would be inventing a contract.
    expect(() => parseKeywords({ data: [keyword()] })).toThrow(AhrefsError);
    expect(() => parseKeywords({ keywords: "nope" })).toThrow(AhrefsError);
    expect(() => parseKeywords(null)).toThrow(AhrefsError);
  });

  it("counts an unreadable entry instead of repairing it", () => {
    const { rows, malformed } = parseKeywords({
      keywords: [keyword(), null, "text", keyword({ keyword: "   " })],
    });

    expect(rows).toHaveLength(1);
    expect(malformed).toBe(3);
  });

  it("stores a missing metric as null rather than zero", () => {
    const { rows } = parseKeywords({
      keywords: [keyword({ best_position: null, volume: null, keyword_difficulty: null })],
    });

    // A position of 0 would read as ranking above first place.
    expect(rows[0]?.position).toBeNull();
    expect(rows[0]?.searchVolume).toBeNull();
    expect(rows[0]?.keywordDifficulty).toBeNull();
  });

  it("reports a requested field the vendor stopped returning", () => {
    const { rows, missingFields } = parseKeywords({
      keywords: [{ keyword: "seo audit", best_position: 4 }],
    });

    expect(rows).toHaveLength(1);
    expect(missingFields).toContain("keyword_difficulty");
    expect(missingFields).toContain("volume");
  });

  it("treats an empty report as empty, not an error", () => {
    expect(parseKeywords({ keywords: [] })).toEqual({
      rows: [],
      malformed: 0,
      missingFields: [],
    });
  });

  it("ignores a non-array serp_features rather than throwing", () => {
    const { rows } = parseKeywords({ keywords: [keyword({ serp_features: "featured_snippet" })] });
    expect(rows[0]?.serpFeatures).toEqual([]);
  });
});

describe("the request", () => {
  it("sends the key as a Bearer header, never in the url", async () => {
    const { impl, calls } = stubFetch([body([keyword()])]);

    await fetchOrganicKeywords({
      apiKey: KEY,
      target: "example.com",
      country: "ph",
      date: "2026-09-03",
      fetchImpl: impl,
    });

    const call = calls[0]!;

    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    // Unlike Semrush, the URL is not a secret here — and that is only true if
    // the key genuinely is not in it.
    expect(call.url).not.toContain(KEY);
  });

  it("sends the required parameters and the documented select fields", async () => {
    const { impl, calls } = stubFetch([body([keyword()])]);

    await fetchOrganicKeywords({
      apiKey: KEY,
      target: "example.com",
      country: "ph",
      date: "2026-09-03",
      limit: 500,
      fetchImpl: impl,
    });

    const url = new URL(calls[0]!.url);

    expect(url.origin + url.pathname).toBe(
      "https://api.ahrefs.com/v3/site-explorer/organic-keywords",
    );
    expect(url.searchParams.get("target")).toBe("example.com");
    // Required by the API; a missing date is a 400, not a default.
    expect(url.searchParams.get("date")).toBe("2026-09-03");
    expect(url.searchParams.get("country")).toBe("ph");
    expect(url.searchParams.get("limit")).toBe("500");
    expect(url.searchParams.get("mode")).toBe("subdomains");

    const select = url.searchParams.get("select")?.split(",") ?? [];
    for (const field of SELECT_FIELDS) expect(select).toContain(field);
  });

  it("reports truncation when the answer fills the limit", async () => {
    // No offset parameter is documented for this endpoint, so a full page means
    // "there may be more we cannot reach" — which is said rather than hidden.
    const { impl } = stubFetch([body([keyword({ keyword: "a" }), keyword({ keyword: "b" })])]);

    const result = await fetchOrganicKeywords({
      apiKey: KEY,
      target: "example.com",
      country: "ph",
      date: "2026-09-03",
      limit: 2,
      fetchImpl: impl,
    });

    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation on a short answer", async () => {
    const { impl } = stubFetch([body([keyword()])]);

    const result = await fetchOrganicKeywords({
      apiKey: KEY,
      target: "example.com",
      country: "ph",
      date: "2026-09-03",
      limit: 100,
      fetchImpl: impl,
    });

    expect(result.truncated).toBe(false);
  });
});

describe("mapping Ahrefs errors", () => {
  const cases: [number, string][] = [
    [401, "invalid_key"],
    [403, "invalid_key"],
    [402, "quota_exhausted"],
    [429, "rate_limited"],
    [500, "upstream_error"],
    [418, "upstream_error"],
  ];

  for (const [status, expected] of cases) {
    it(`maps HTTP ${status} to ${expected}`, async () => {
      const { impl } = stubFetch([{ status, body: "{}" }]);

      await expect(
        fetchOrganicKeywords({
          apiKey: KEY,
          target: "example.com",
          country: "ph",
          date: "2026-09-03",
          fetchImpl: impl,
        }),
      ).rejects.toMatchObject({ code: expected });
    });
  }

  it("never reads the error body, which can echo request headers", async () => {
    const { impl } = stubFetch([
      { status: 401, body: JSON.stringify({ error: `bad token ${KEY}` }) },
    ]);

    const error = await fetchOrganicKeywords({
      apiKey: KEY,
      target: "example.com",
      country: "ph",
      date: "2026-09-03",
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AhrefsError);
    expect((error as Error).message).not.toContain(KEY);
  });

  it("does not inspect a thrown fetch error", async () => {
    const impl = (async () => {
      throw new Error(`socket hang up while sending Bearer ${KEY}`);
    }) as unknown as typeof fetch;

    const error = await fetchOrganicKeywords({
      apiKey: KEY,
      target: "example.com",
      country: "ph",
      date: "2026-09-03",
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).not.toContain(KEY);
    expect((error as AhrefsError).code).toBe("request_failed");
  });

  it("fails cleanly on a body that is not json", async () => {
    const { impl } = stubFetch(["<html>gateway timeout</html>"]);

    await expect(
      fetchOrganicKeywords({
        apiKey: KEY,
        target: "example.com",
        country: "ph",
        date: "2026-09-03",
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("choosing a country", () => {
  it("maps a market to a two-letter code", () => {
    expect(countryForMarket("PH")).toBe("ph");
    expect(countryForMarket("us")).toBe("us");
  });

  it("returns null with no market rather than defaulting to one", () => {
    expect(countryForMarket(null)).toBeNull();
    expect(countryForMarket("  ")).toBeNull();
  });

  it("does not rewrite GB, unlike the Semrush database code", () => {
    // Semrush calls it "uk"; Ahrefs documents ISO 3166-1 alpha-2, where it is
    // "gb". Sharing one mapping between the two would be wrong for one of them.
    expect(countryForMarket("GB")).toBe("gb");
  });
});

describe("running the sync", () => {
  it("writes rankings and metrics attributed to Ahrefs", async () => {
    const context = await makeTenant("sync");
    const connection = await connectApiKey(context, "AHREFS", KEY);

    const { impl } = stubFetch([
      body([
        keyword({ keyword: "seo audit" }),
        keyword({ keyword: "seo tools", best_position: 7 }),
      ]),
    ]);

    const outcome = await runAhrefsSync(context, { fetchImpl: impl });

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(2);

    const rankings = await prisma.rankingSnapshot.findMany({
      where: { websiteId: context.website.id },
    });

    expect(rankings).toHaveLength(2);
    expect(rankings.every((r) => r.sourceProvider === "AHREFS")).toBe(true);
    expect(rankings.every((r) => r.sourceConnectionId === connection.id)).toBe(true);
    expect(rankings.every((r) => r.sourceSnapshotId !== null)).toBe(true);
    // Not returned by this endpoint and not derived from our own history.
    expect(rankings.every((r) => r.previousPosition === null)).toBe(true);
  });

  it("stores the converted price, not the raw cents", async () => {
    const context = await makeTenant("cpc");
    await connectApiKey(context, "AHREFS", KEY);

    const { impl } = stubFetch([body([keyword({ cpc: 1240 })])]);
    await runAhrefsSync(context, { fetchImpl: impl });

    const metric = await prisma.keywordMetricsSnapshot.findFirstOrThrow({
      where: { websiteId: context.website.id },
    });

    // The end-to-end guard on the conversion: $12.40 in the database, not $1,240.
    expect(Number(metric.cpc)).toBe(12.4);
  });

  it("leaves intent unknown, because Ahrefs does not report it", async () => {
    const context = await makeTenant("intent");
    await connectApiKey(context, "AHREFS", KEY);

    const { impl } = stubFetch([body([keyword({ keyword: "no intent here" })])]);
    await runAhrefsSync(context, { fetchImpl: impl });

    const stored = await prisma.keyword.findFirstOrThrow({
      where: { websiteId: context.website.id, normalizedKeyword: "no intent here" },
    });

    expect(stored.intent).toBe("UNKNOWN");
    expect(stored.intentProvenance).toBe("UNKNOWN");
  });

  it("is free to run twice in one day", async () => {
    const context = await makeTenant("idem");
    await connectApiKey(context, "AHREFS", KEY);

    const first = await runAhrefsSync(context, {
      fetchImpl: stubFetch([body([keyword()])]).impl,
    });
    expect(first.reused).toBe(false);

    const second = stubFetch([body([keyword()])]);
    const repeat = await runAhrefsSync(context, { fetchImpl: second.impl });

    expect(repeat.reused).toBe(true);
    expect(second.calls).toHaveLength(0);
  });

  it("stores our own error summary, never the provider's", async () => {
    const context = await makeTenant("failsync");
    await connectApiKey(context, "AHREFS", KEY);

    const { impl } = stubFetch([
      { status: 401, body: JSON.stringify({ error: `token ${KEY} rejected` }) },
    ]);

    const outcome = await runAhrefsSync(context, { fetchImpl: impl });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.run.errorCode).toBe("invalid_key");
    expect(JSON.stringify(outcome.run)).not.toContain(KEY);
  });

  it("leaves freshness untouched when a run fails", async () => {
    const context = await makeTenant("fresh");
    const connection = await connectApiKey(context, "AHREFS", KEY);

    const { impl } = stubFetch([{ status: 429, body: "{}" }]);
    await runAhrefsSync(context, { fetchImpl: impl });

    const stored = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });

    expect(stored.lastSyncedAt).toBeNull();
    expect(stored.latestDataDate).toBeNull();
  });

  it("refuses to guess a country when the website has no market", async () => {
    const context = await makeTenant("nomarket");
    await prisma.website.update({
      where: { id: context.website.id },
      data: { primaryMarket: null },
    });
    const fresh = { ...context, website: { ...context.website, primaryMarket: null } };
    await connectApiKey(fresh, "AHREFS", KEY);

    const { impl, calls } = stubFetch([body([keyword()])]);
    const outcome = await runAhrefsSync(fresh, { fetchImpl: impl });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.run.errorCode).toBe("no_market");
    // Refused before spending a unit.
    expect(calls).toHaveLength(0);
  });

  it("refuses to sync when Ahrefs is not connected", async () => {
    const context = await makeTenant("unconnected");
    await expect(runAhrefsSync(context)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("keeps the key out of the audit trail", async () => {
    const context = await makeTenant("audit");
    const connection = await connectApiKey(context, "AHREFS", KEY);

    const events = await prisma.auditEvent.findMany({
      where: { entityType: "Connection", entityId: connection.id },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });
});

describe("two providers describing the same keyword", () => {
  it("stores both readings without either overwriting the other", async () => {
    const context = await makeTenant("both");
    await connectApiKey(context, "SEMRUSH", "semrush-key");
    await connectApiKey(context, "AHREFS", "ahrefs-key");

    // Same keyword, different numbers — which is the normal case, not an error.
    const semrushCsv = [
      "Keyword;Position;Previous Position;Search Volume;Keyword Difficulty;CPC;Url;Keyword Intents;SERP Features by Keyword;Timestamp",
      "seo audit;4;9;1300;62.5;12.40;https://example.com/seo-audit;commercial;;1780012800",
    ].join("\n");

    const semrushFetch = (async () =>
      new Response(semrushCsv, { status: 200 })) as unknown as typeof fetch;

    await runSemrushSync(context, { fetchImpl: semrushFetch, sleepImpl: async () => {} });

    const { impl } = stubFetch([
      body([keyword({ keyword: "seo audit", best_position: 6, volume: 900 })]),
    ]);
    await runAhrefsSync(context, { fetchImpl: impl });

    const stored = await prisma.keyword.findFirstOrThrow({
      where: { websiteId: context.website.id, normalizedKeyword: "seo audit" },
    });

    const rankings = await prisma.rankingSnapshot.findMany({
      where: { keywordId: stored.id },
    });

    // One keyword identity, two readings. The snapshot key is
    // (keyword, capturedAt, provider), so neither vendor can clobber the other.
    //
    // Asserted as a set rather than a sequence: Postgres sorts an enum by its
    // declaration order, and AHREFS was appended to ConnectionProvider after
    // SEMRUSH, so "alphabetical" is not what an ORDER BY would give.
    expect(rankings).toHaveLength(2);
    expect(new Set(rankings.map((r) => r.sourceProvider))).toEqual(new Set(["AHREFS", "SEMRUSH"]));
    expect(Number(rankings.find((r) => r.sourceProvider === "AHREFS")?.position)).toBe(6);
    expect(Number(rankings.find((r) => r.sourceProvider === "SEMRUSH")?.position)).toBe(4);

    const metrics = await prisma.keywordMetricsSnapshot.findMany({
      where: { keywordId: stored.id },
    });
    expect(metrics).toHaveLength(2);
  });

  it("hands the disagreement to the precedence rules rather than averaging it", async () => {
    // The existing P2 rule, exercised on the two live-fetched volumes above:
    // same date, so the stable tie-break decides, and the mean of two different
    // estimation models is never taken.
    const captured = new Date("2026-09-03T00:00:00.000Z");

    const readings = [
      { provider: "SEMRUSH" as const, capturedAt: captured, value: 1300 },
      { provider: "AHREFS" as const, capturedAt: captured, value: 900 },
    ];

    const chosen = pickPrimary(readings);

    expect(chosen?.value).toBe(1300);
    expect(chosen?.provider).toBe("SEMRUSH");
    // 1300 vs 900 is a 31% gap — past the threshold, so it is flagged for a
    // person rather than quietly presented as settled.
    expect(providersDisagree(readings)).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("reads only the calling tenant's connection", async () => {
    const [a, b] = await Promise.all([makeTenant("iso-a"), makeTenant("iso-b")]);
    await connectApiKey(a, "AHREFS", KEY);

    await expect(runAhrefsSync(b)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("writes rows only to the calling tenant's website", async () => {
    const [a, b] = await Promise.all([makeTenant("write-a"), makeTenant("write-b")]);
    await connectApiKey(a, "AHREFS", KEY);

    const { impl } = stubFetch([body([keyword()])]);
    await runAhrefsSync(a, { fetchImpl: impl });

    expect(await prisma.rankingSnapshot.count({ where: { websiteId: b.website.id } })).toBe(0);
  });

  it("keeps each provider's key separate", async () => {
    const context = await makeTenant("keys");
    const semrush = await connectApiKey(context, "SEMRUSH", "semrush-only");
    const ahrefs = await connectApiKey(context, "AHREFS", "ahrefs-only");

    expect(semrush.id).not.toBe(ahrefs.id);

    const credentials = await prisma.credential.findMany({
      where: { connectionId: { in: [semrush.id, ahrefs.id] } },
    });

    expect(credentials).toHaveLength(2);
    // Two connections, two credentials, and neither payload readable as plaintext.
    for (const credential of credentials) {
      expect(credential.encryptedPayload).not.toContain("only");
    }
  });
});

describe("resolving a stored market name", () => {
  it("maps a name the way keyword identity does", () => {
    expect(countryForMarket("United Kingdom")).toBe("gb");
    expect(countryForMarket("Philippines")).toBe("ph");
  });

  it("refuses a sentence rather than sending it as a country", () => {
    expect(countryForMarket("initially targeting the UK and United States")).toBeNull();
    expect(countryForMarket("XX")).toBeNull();
  });
});
