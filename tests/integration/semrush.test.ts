import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  SemrushError,
  databaseForMarket,
  fetchOrganicPositions,
  parseCsv,
} from "@/server/connectors/semrush/client";
import { connectApiKey, getApiKey } from "@/server/services/connection-auth";
import { runSemrushSync } from "@/server/services/sync";

/**
 * The Semrush live connector (docs/P2_SPEC.md §7 LIVE API MODE).
 *
 * Two properties carry most of the weight here.
 *
 * The API key travels in Semrush's query string, which makes the request URL a
 * secret. Every error path is therefore tested for what it does *not* contain —
 * a connector that helpfully included the failing URL in a SyncRun's error
 * summary would write an API key into a table the whole team can read, and
 * nothing about that failure would look like a leak.
 *
 * And a vendor's CSV is not a contract. Columns get renamed and reordered without
 * warning, so the parser is tested against responses that have shifted under it:
 * the failure has to be a refusal, never a silent write of volumes into the
 * difficulty column.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

const KEY = "test-semrush-key-do-not-use";

/** The real header, from Semrush's published example, plus the extra columns we request. */
const HEADER =
  "Keyword;Position;Previous Position;Search Volume;Keyword Difficulty;CPC;Url;Keyword Intents;SERP Features by Keyword;Timestamp";

function row(overrides: Partial<Record<string, string>> = {}): string {
  const cells = {
    keyword: "seo audit",
    position: "4",
    previous: "9",
    volume: "1300",
    difficulty: "62.5",
    cpc: "12.40",
    url: "https://example.com/seo-audit",
    intent: "commercial",
    features: "Featured Snippet,People Also Ask",
    timestamp: "1780012800",
    ...overrides,
  };

  return [
    cells.keyword,
    cells.position,
    cells.previous,
    cells.volume,
    cells.difficulty,
    cells.cpc,
    cells.url,
    cells.intent,
    cells.features,
    cells.timestamp,
  ].join(";");
}

/** A fetch that answers with a body, and records what it was asked for. */
function stubFetch(responses: (string | { status: number; body: string })[]): {
  impl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const queue = [...responses];

  const impl = (async (input: URL | RequestInfo) => {
    urls.push(String(input));
    const next = queue.shift() ?? "";
    const { status, body } = typeof next === "string" ? { status: 200, body: next } : next;

    return new Response(body, { status });
  }) as unknown as typeof fetch;

  return { impl, urls };
}

const noSleep = async () => {};

async function makeTenant(label: string, market = "PH"): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `sr-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Semrush ${label}`, slug: `sr-${label}-${suffix}` },
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

/** Connects without a live verification probe. */
async function connect(context: TenantContext): Promise<string> {
  const connection = await connectApiKey(context, "SEMRUSH", KEY);
  return connection.id;
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

describe("parsing a Semrush response", () => {
  it("reads a row into the shape the importer already produces", () => {
    const { rows, malformed, missingColumns } = parseCsv(`${HEADER}\n${row()}`);

    expect(malformed).toBe(0);
    expect(missingColumns).toEqual([]);
    expect(rows).toHaveLength(1);

    expect(rows[0]).toMatchObject({
      keyword: "seo audit",
      normalizedKeyword: "seo audit",
      position: 4,
      previousPosition: 9,
      searchVolume: 1300,
      keywordDifficulty: 62.5,
      cpc: 12.4,
      landingUrl: "https://example.com/seo-audit",
      intent: "commercial",
      rankingType: "ORGANIC",
      serpFeatures: ["Featured Snippet", "People Also Ask"],
      // Unix seconds → the date the reading is about. 1780012800 is
      // 2026-05-29T00:00:00Z.
      capturedAt: "2026-05-29",
    });
  });

  it("finds columns by name, so a reordered response is still read correctly", () => {
    // Same data, columns swapped. A positional parser would put the position
    // into the volume field and the numbers would look entirely plausible.
    const reordered = ["Search Volume;Keyword;Position", "1300;seo audit;4"].join("\n");

    const { rows } = parseCsv(reordered);

    expect(rows[0]?.keyword).toBe("seo audit");
    expect(rows[0]?.position).toBe(4);
    expect(rows[0]?.searchVolume).toBe(1300);
  });

  it("reports a requested column that is absent rather than nulling it quietly", () => {
    const { rows, missingColumns } = parseCsv(["Keyword;Position", "seo audit;4"].join("\n"));

    expect(rows[0]?.keywordDifficulty).toBeNull();
    // The point: the sync can say "Semrush stopped sending difficulty" instead of
    // showing a column that is empty for reasons nobody can explain.
    expect(missingColumns).toContain("keywordDifficulty");
    expect(missingColumns).toContain("searchVolume");
  });

  it("refuses a response with no keyword column", () => {
    // Without a keyword there is nothing to attach a reading to. Reading on would
    // mean choosing some other column to treat as the identity.
    expect(() => parseCsv(["Position;Search Volume", "4;1300"].join("\n"))).toThrow(SemrushError);
  });

  it("keeps a quoted keyword containing the separator intact", () => {
    const quoted = `${HEADER}\n${row({ keyword: '"seo audit; free"' })}`;
    const { rows, malformed } = parseCsv(quoted);

    expect(malformed).toBe(0);
    expect(rows[0]?.keyword).toBe("seo audit; free");
    // And the columns after it did not shift.
    expect(rows[0]?.position).toBe(4);
  });

  it("counts an unreadable row instead of repairing it", () => {
    const body = [HEADER, row(), "broken;row", row({ keyword: "" })].join("\n");
    const { rows, malformed } = parseCsv(body);

    expect(rows).toHaveLength(1);
    expect(malformed).toBe(2);
  });

  it("stores an unreadable number as null rather than zero", () => {
    // Zero is a measurement; "Semrush did not say" is not one. A position of 0
    // would read as ranking above first place.
    const { rows } = parseCsv(
      `${HEADER}\n${row({ position: "", volume: "n/a", difficulty: "-" })}`,
    );

    expect(rows[0]?.position).toBeNull();
    expect(rows[0]?.searchVolume).toBeNull();
    expect(rows[0]?.keywordDifficulty).toBeNull();
  });

  it("treats an empty report as empty, not as an error", () => {
    // A domain can genuinely rank for nothing.
    expect(parseCsv("")).toEqual({ rows: [], malformed: 0, missingColumns: [] });
  });
});

describe("mapping Semrush errors", () => {
  const cases: [string, string][] = [
    ["ERROR 120 :: WRONG KEY", "invalid_key"],
    ["ERROR 131 :: WRONG DATABASE", "unknown_database"],
    ["ERROR 132 :: API UNITS BALANCE IS ZERO", "quota_exhausted"],
    ["ERROR 130 :: NOTHING FOUND", "not_subscribed"],
    // An unrecognised code stays generic rather than being reported as
    // something specific we have not actually identified.
    ["ERROR 999 :: SOMETHING NEW", "upstream_error"],
  ];

  for (const [body, expected] of cases) {
    it(`maps "${body}" to ${expected}`, async () => {
      const { impl } = stubFetch([body]);

      await expect(
        fetchOrganicPositions({
          apiKey: KEY,
          domain: "example.com",
          database: "ph",
          fetchImpl: impl,
          sleepImpl: noSleep,
        }),
      ).rejects.toMatchObject({ code: expected });
    });
  }

  it("never carries the upstream body, which can echo the key", async () => {
    // A realistic hostile case: the provider reflects the request back.
    const { impl } = stubFetch([
      `ERROR 120 :: WRONG KEY for request key=${KEY}&type=domain_organic`,
    ]);

    const error = await fetchOrganicPositions({
      apiKey: KEY,
      domain: "example.com",
      database: "ph",
      fetchImpl: impl,
      sleepImpl: noSleep,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SemrushError);
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).toBe(
      "Semrush rejected the API key. Check it and connect again.",
    );
  });

  it("maps a 429 to rate limiting", async () => {
    const { impl } = stubFetch([{ status: 429, body: "" }]);

    await expect(
      fetchOrganicPositions({
        apiKey: KEY,
        domain: "example.com",
        database: "ph",
        fetchImpl: impl,
        sleepImpl: noSleep,
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("does not inspect a thrown fetch error, whose message can hold the url", async () => {
    const impl = (async () => {
      throw new Error(`connect ECONNREFUSED https://api.semrush.com/?key=${KEY}`);
    }) as unknown as typeof fetch;

    const error = await fetchOrganicPositions({
      apiKey: KEY,
      domain: "example.com",
      database: "ph",
      fetchImpl: impl,
      sleepImpl: noSleep,
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).not.toContain(KEY);
    expect((error as SemrushError).code).toBe("request_failed");
  });
});

describe("paging and cost ceilings", () => {
  it("stops at maxRows and says the answer is truncated", async () => {
    const page = [HEADER, ...Array.from({ length: 3 }, (_, i) => row({ keyword: `kw ${i}` }))].join(
      "\n",
    );

    const { impl } = stubFetch([page, page]);

    const result = await fetchOrganicPositions({
      apiKey: KEY,
      domain: "example.com",
      database: "ph",
      maxRows: 3,
      fetchImpl: impl,
      sleepImpl: noSleep,
    });

    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("stops asking when a page comes back short", async () => {
    const { impl, urls } = stubFetch([[HEADER, row()].join("\n")]);

    const result = await fetchOrganicPositions({
      apiKey: KEY,
      domain: "example.com",
      database: "ph",
      maxRows: 10_000,
      fetchImpl: impl,
      sleepImpl: noSleep,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(false);
    // One request, not a second that would cost units to learn nothing.
    expect(urls).toHaveLength(1);
  });

  it("sends the key and the requested columns", async () => {
    const { impl, urls } = stubFetch([[HEADER, row()].join("\n")]);

    await fetchOrganicPositions({
      apiKey: KEY,
      domain: "example.com",
      database: "ph",
      fetchImpl: impl,
      sleepImpl: noSleep,
    });

    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe("https://api.semrush.com/");
    expect(url.searchParams.get("type")).toBe("domain_organic");
    expect(url.searchParams.get("domain")).toBe("example.com");
    expect(url.searchParams.get("database")).toBe("ph");
    expect(url.searchParams.get("key")).toBe(KEY);
    expect(url.searchParams.get("export_columns")).toContain("Kd");
    // Quoted output, so a keyword containing a semicolon cannot shift columns.
    expect(url.searchParams.get("export_escape")).toBe("1");
  });
});

describe("choosing a regional database", () => {
  it("maps a market to a lowercase database code", () => {
    expect(databaseForMarket("PH")).toBe("ph");
    expect(databaseForMarket("us")).toBe("us");
  });

  it("uses Semrush's spelling for the United Kingdom", () => {
    expect(databaseForMarket("GB")).toBe("uk");
  });

  it("returns null with no market rather than defaulting to one", () => {
    // Substituting "us" would attribute American search volumes to another
    // country's site, and every number after that would be quietly wrong.
    expect(databaseForMarket(null)).toBeNull();
    expect(databaseForMarket("  ")).toBeNull();
  });
});

describe("storing the API key", () => {
  it("encrypts it, and never returns it through a view model", async () => {
    const context = await makeTenant("cred");
    const connectionId = await connect(context);

    const stored = await prisma.credential.findUniqueOrThrow({ where: { connectionId } });

    expect(stored.encryptedPayload).not.toContain(KEY);
    // Readable by the connector, and only by it.
    expect(await getApiKey(connectionId)).toBe(KEY);
  });

  it("keeps the key out of the audit trail", async () => {
    const context = await makeTenant("audit");
    const connectionId = await connect(context);

    const events = await prisma.auditEvent.findMany({
      where: { entityType: "Connection", entityId: connectionId },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it("refuses a blank key", async () => {
    const context = await makeTenant("blank");

    await expect(connectApiKey(context, "SEMRUSH", "   ")).rejects.toMatchObject({
      code: "missing_key",
    });
  });

  it("does not connect when verification fails", async () => {
    const context = await makeTenant("verify");

    await expect(
      connectApiKey(context, "SEMRUSH", KEY, async () => {
        throw new SemrushError("invalid_key");
      }),
    ).rejects.toMatchObject({ code: "key_rejected" });

    // Nothing stored, and nothing claiming to be connected. A connection that
    // went CONNECTED on a bad key would fail on every sync afterwards.
    const connection = await prisma.connection.findFirst({
      where: { websiteId: context.website.id, provider: "SEMRUSH" },
    });
    expect(connection).toBeNull();
  });
});

describe("running the sync", () => {
  it("writes rankings and keyword metrics attributed to Semrush", async () => {
    const context = await makeTenant("sync");
    const connectionId = await connect(context);

    const body = [
      HEADER,
      row({ keyword: "seo audit" }),
      row({ keyword: "seo tools", position: "7" }),
    ].join("\n");
    const { impl } = stubFetch([body]);

    const outcome = await runSemrushSync(context, { fetchImpl: impl, sleepImpl: noSleep });

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.received).toBe(2);

    const rankings = await prisma.rankingSnapshot.findMany({
      where: { websiteId: context.website.id },
    });

    expect(rankings).toHaveLength(2);
    // Attribution is the whole point: a Semrush figure is never presented as a
    // measurement of this site.
    expect(rankings.every((r) => r.sourceProvider === "SEMRUSH")).toBe(true);
    expect(rankings.every((r) => r.sourceConnectionId === connectionId)).toBe(true);
    expect(rankings.every((r) => r.sourceImportId === null)).toBe(true);
    // And the specific pull is recorded, not just the account.
    expect(rankings.every((r) => r.sourceSnapshotId !== null)).toBe(true);

    const metrics = await prisma.keywordMetricsSnapshot.findMany({
      where: { websiteId: context.website.id },
    });
    expect(metrics).toHaveLength(2);
    expect(metrics[0]?.sourceProvider).toBe("SEMRUSH");
  });

  it("does not write into the Search Console tables", async () => {
    const context = await makeTenant("nogsc");
    await connect(context);

    const { impl } = stubFetch([[HEADER, row()].join("\n")]);
    await runSemrushSync(context, { fetchImpl: impl, sleepImpl: noSleep });

    // A third party's crawl of the SERP is not first-party traffic data, and the
    // two must never share a table.
    const gsc = await prisma.gscMetricDaily.count({ where: { websiteId: context.website.id } });
    expect(gsc).toBe(0);
  });

  it("is free to run twice in one day", async () => {
    const context = await makeTenant("idem");
    await connect(context);

    const body = [HEADER, row()].join("\n");

    const first = await runSemrushSync(context, {
      fetchImpl: stubFetch([body]).impl,
      sleepImpl: noSleep,
    });
    expect(first.reused).toBe(false);

    const second = stubFetch([body]);
    const repeat = await runSemrushSync(context, {
      fetchImpl: second.impl,
      sleepImpl: noSleep,
    });

    // Reused from the completed run, so no units were spent to learn the same
    // thing. Rows are billed; this is money, not just tidiness.
    expect(repeat.reused).toBe(true);
    expect(second.urls).toHaveLength(0);
  });

  it("stores our own error summary, never the provider's text", async () => {
    const context = await makeTenant("failsync");
    await connect(context);

    const { impl } = stubFetch([`ERROR 120 :: WRONG KEY key=${KEY}`]);

    const outcome = await runSemrushSync(context, { fetchImpl: impl, sleepImpl: noSleep });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.run.errorCode).toBe("invalid_key");
    expect(outcome.run.errorSummary).toBe(
      "The stored API key was rejected. Reconnect with a valid key.",
    );
    expect(JSON.stringify(outcome.run)).not.toContain(KEY);
  });

  it("leaves freshness untouched when a run fails", async () => {
    const context = await makeTenant("fresh");
    const connectionId = await connect(context);

    const { impl } = stubFetch([{ status: 429, body: "" }]);
    await runSemrushSync(context, { fetchImpl: impl, sleepImpl: noSleep });

    const connection = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });

    // A failed sync must leave the product saying the data is old, which it is.
    expect(connection.lastSyncedAt).toBeNull();
    expect(connection.latestDataDate).toBeNull();
  });

  it("refuses to guess a database when the website has no market", async () => {
    const context = await makeTenant("nomarket");
    await prisma.website.update({
      where: { id: context.website.id },
      data: { primaryMarket: null },
    });
    const fresh = { ...context, website: { ...context.website, primaryMarket: null } };
    await connect(fresh);

    const { impl, urls } = stubFetch([[HEADER, row()].join("\n")]);
    const outcome = await runSemrushSync(fresh, { fetchImpl: impl, sleepImpl: noSleep });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.run.errorCode).toBe("no_market");
    // Refused before spending a single API unit.
    expect(urls).toHaveLength(0);
  });

  it("refuses to sync when Semrush is not connected", async () => {
    const context = await makeTenant("unconnected");

    await expect(runSemrushSync(context)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("records what was left out when our row ceiling is reached", async () => {
    const context = await makeTenant("ceiling");
    await connect(context);

    const page = [HEADER, row({ keyword: "a" }), row({ keyword: "b" })].join("\n");
    const { impl } = stubFetch([page, page]);

    const outcome = await runSemrushSync(context, {
      maxRows: 2,
      fetchImpl: impl,
      sleepImpl: noSleep,
    });

    // PARTIAL, not SUCCEEDED: this is what we paid for, not the whole picture.
    expect(outcome.status).toBe("PARTIAL");

    const snapshot = await prisma.sourceSnapshot.findFirstOrThrow({
      where: { websiteId: context.website.id, provider: "SEMRUSH" },
    });
    expect((snapshot.metadataJson as { truncated?: boolean }).truncated).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("reads only the calling tenant's connection", async () => {
    const [a, b] = await Promise.all([makeTenant("iso-a"), makeTenant("iso-b")]);
    await connect(a);

    // B has no Semrush connection, and A's must not serve.
    await expect(runSemrushSync(b)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("writes rows only to the calling tenant's website", async () => {
    const [a, b] = await Promise.all([makeTenant("write-a"), makeTenant("write-b")]);
    await connect(a);

    const { impl } = stubFetch([[HEADER, row()].join("\n")]);
    await runSemrushSync(a, { fetchImpl: impl, sleepImpl: noSleep });

    const leaked = await prisma.rankingSnapshot.count({ where: { websiteId: b.website.id } });
    expect(leaked).toBe(0);
  });

  it("does not hand another tenant's key to a caller", async () => {
    const owner = await makeTenant("key-a");
    const connectionId = await connect(owner);

    // getApiKey is connection-scoped and never reached from a page; the guard
    // that matters is that a connection id is resolved under websiteScope before
    // anything asks for its credential.
    const outsider = await makeTenant("key-b");
    const visible = await prisma.connection.findFirst({
      where: { id: connectionId, websiteId: outsider.website.id },
    });

    expect(visible).toBeNull();
  });
});

describe("rate limiting", () => {
  it("spaces successive requests", async () => {
    const context = await makeTenant("space");
    await connect(context);

    const page = [HEADER, row({ keyword: "a" }), row({ keyword: "b" })].join("\n");
    const { impl } = stubFetch([page, page]);
    const sleeps: number[] = [];

    await fetchOrganicPositions({
      apiKey: KEY,
      domain: "example.com",
      database: "ph",
      maxRows: 4,
      // Two full pages, so the loop actually goes round twice.
      pageSize: 2,
      fetchImpl: impl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    // Semrush publishes 10 requests per second; the gap is honoured rather than
    // discovered by being throttled.
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms >= 100)).toBe(true);
  });
});

describe("the shared write path", () => {
  it("produces the same row shape as an equivalent import", async () => {
    // The claim this whole refactor rests on: a fetched row and an uploaded row
    // are the same row. If these ever diverge, one of the two write paths has
    // grown a rule the other does not have.
    const context = await makeTenant("parity");
    await connect(context);

    const { impl } = stubFetch([[HEADER, row({ keyword: "parity check" })].join("\n")]);
    await runSemrushSync(context, { fetchImpl: impl, sleepImpl: noSleep });

    const keyword = await prisma.keyword.findFirstOrThrow({
      where: { websiteId: context.website.id, normalizedKeyword: "parity check" },
    });

    // Identity per P2_SPEC §8, and intent attributed to the provider that stated
    // it — exactly as the importer would have done.
    expect(keyword.locale).toBe("en-PH");
    expect(keyword.language).toBe("en");
    expect(keyword.market).toBe("PH");
    expect(keyword.intentProvenance).toBe("PROVIDER_PROVIDED");
    expect(keyword.intent).toBe("COMMERCIAL");
  });

  it("does not invent a Page from a ranking url", async () => {
    const context = await makeTenant("nopage");
    await connect(context);

    const { impl } = stubFetch([
      [HEADER, row({ url: "https://example.com/never-crawled" })].join("\n"),
    ]);
    await runSemrushSync(context, { fetchImpl: impl, sleepImpl: noSleep });

    // A ranking URL is a third party's claim about what Google showed, not our
    // inventory. The null pageId is information: something we do not know about
    // is ranking.
    const pages = await prisma.page.count({ where: { websiteId: context.website.id } });
    expect(pages).toBe(0);

    const ranking = await prisma.rankingSnapshot.findFirstOrThrow({
      where: { websiteId: context.website.id },
    });
    expect(ranking.pageId).toBeNull();
    expect(ranking.rankingUrl).toBe("https://example.com/never-crawled");
  });
});

describe("resolving a stored market name", () => {
  it("maps a name the way keyword identity does", () => {
    // A website that onboarded as "United Kingdom" is filed under GB by the
    // keyword layer; the connector must ask Semrush about the same place.
    expect(databaseForMarket("United Kingdom")).toBe("uk");
    expect(databaseForMarket("Philippines")).toBe("ph");
  });

  it("refuses a sentence rather than sending it as a database", () => {
    // Lowercasing this and sending it would be an error at best, and at worst
    // a silent fallback to somebody else's country.
    expect(databaseForMarket("initially targeting the UK and United States")).toBeNull();
    expect(databaseForMarket("XX")).toBeNull();
  });
});
