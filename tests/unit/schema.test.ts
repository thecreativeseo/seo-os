import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Schema integrity checks that need no database connection.
 *
 * These assert the P0 invariants that are cheapest to break silently: the provider
 * registry, the approved-context immutability trigger, domain uniqueness, and the
 * rule that Connection rows hold a credential reference and never a credential.
 */

const root = join(__dirname, "..", "..");
const schema = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
const initSql = readFileSync(
  join(root, "prisma", "migrations", "20260831000000_p0_init", "migration.sql"),
  "utf8",
);
const triggerSql = readFileSync(
  join(root, "prisma", "migrations", "20260831000100_business_context_immutability", "migration.sql"),
  "utf8",
);

describe("tenant hierarchy", () => {
  it("resolves Website -> Workspace -> Organization", () => {
    expect(schema).toMatch(/model Workspace \{[\s\S]*?organizationId\s+String/);
    expect(schema).toMatch(/model Website \{[\s\S]*?workspaceId\s+String/);
  });

  it("makes OrganizationMembership unique per user and organization", () => {
    expect(schema).toContain("@@unique([organizationId, userId])");
  });

  it("keys User on the auth provider id, never on email", () => {
    expect(schema).toMatch(/authUserId\s+String\s+@unique/);
  });
});

describe("website domain", () => {
  it("enforces one normalized domain per workspace", () => {
    expect(schema).toContain("@@unique([workspaceId, normalizedDomain])");
    expect(initSql).toContain(
      'CREATE UNIQUE INDEX "website_workspace_id_normalized_domain_key"',
    );
  });
});

describe("approved business context is immutable", () => {
  it("rejects UPDATE and DELETE on approved rows at the database level", () => {
    expect(triggerSql).toContain("BEFORE UPDATE OR DELETE");
    expect(triggerSql).toContain("OLD.status = 'APPROVED'");
    expect(triggerSql).toContain("RAISE EXCEPTION");
  });

  it("still permits the DRAFT -> APPROVED transition", () => {
    // The guard reads OLD.status, which is still DRAFT during approval.
    expect(triggerSql).not.toContain("NEW.status = 'APPROVED'");
  });
});

describe("connections", () => {
  const providers = [
    "GOOGLE_SEARCH_CONSOLE",
    "GOOGLE_ANALYTICS",
    "HUBSPOT",
    "SEMRUSH",
    "SIMILARWEB",
    "SCREAMING_FROG",
    "WORDPRESS",
  ];

  it("registers exactly the seven P0 providers", () => {
    const block = schema.match(/enum ConnectionProvider \{([\s\S]*?)\}/)?.[1] ?? "";
    const found = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(found.sort()).toEqual([...providers].sort());
  });

  it("stores a credential reference and no credential columns", () => {
    const model = schema.match(/model Connection \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(model).toContain("credentialReference");
    for (const forbidden of ["token", "password", "secret", "apiKey", "privateKey"]) {
      expect(model.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("data truth", () => {
  it("leaves an unknown goal baseline null rather than defaulting it", () => {
    const model = schema.match(/model BusinessGoal \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(model).toMatch(/baseline\s+Decimal\?/);
    expect(model).not.toMatch(/baseline\s+Decimal\?[^\n]*@default/);
  });

  it("does not auto-classify competitors", () => {
    const model = schema.match(/model Competitor \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(model).toMatch(/type\s+CompetitorType\s+@default\(UNKNOWN\)/);
    expect(model).toMatch(/source\s+Provenance\s+@default\(USER_PROVIDED\)/);
  });

  it("carries the full provenance vocabulary", () => {
    for (const value of ["USER_PROVIDED", "SYSTEM_DERIVED", "INFERRED", "UNKNOWN"]) {
      expect(schema).toContain(value);
    }
  });
});

describe("prisma 7 conventions", () => {
  it("keeps connection urls out of the schema file", () => {
    const datasource = schema.match(/datasource db \{([\s\S]*?)\}/)?.[1] ?? "";
    expect(datasource).not.toContain("url");
  });
});

/**
 * P2 identity rules.
 *
 * Each of these is a constraint that fails silently if it regresses: a duplicate
 * keyword, a second PRIMARY owner, an opportunity queue that grows a copy of
 * itself on every detection run. The database enforces them; these assert the
 * database was actually asked to.
 */
const ownershipIndexSql = readFileSync(
  join(root, "prisma", "migrations", "20260902110000_p2_ownership_primary_index", "migration.sql"),
  "utf8",
);
const opportunityIndexSql = readFileSync(
  join(root, "prisma", "migrations", "20260902110100_p2_opportunity_identity_index", "migration.sql"),
  "utf8",
);

/**
 * These files are heavily commented, and the comments name the very things the
 * assertions look for absent. Strip them so a test checks the code rather than
 * the prose explaining it.
 */
function withoutSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

function withoutPrismaDocComments(block: string): string {
  return block
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("///"))
    .join("\n");
}

describe("keyword identity", () => {
  it("is unique per market, not globally", () => {
    // "payroll software" in PH and US are different keywords with different
    // volumes and different money behind them.
    expect(schema).toContain(
      "@@unique([websiteId, normalizedKeyword, locale, language, market])",
    );
  });

  it("never leaves a locale column nullable", () => {
    // A NULL does not compare equal to another NULL in a unique index, so a
    // nullable locale would quietly permit duplicate keywords.
    const model = schema.match(/model Keyword \{([\s\S]*?)\n\}/)?.[1] ?? "";

    for (const field of ["locale", "language", "market"]) {
      expect(model).toMatch(new RegExp(String.raw`${field}\s+String\s+@default`));
      expect(model).not.toMatch(new RegExp(String.raw`${field}\s+String\?`));
    }
  });
});

describe("keyword ownership", () => {
  it("enforces one active primary owner in the database", () => {
    expect(ownershipIndexSql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(ownershipIndexSql).toMatch(/WHERE status = 'ACTIVE' AND ownership_type = 'PRIMARY'/i);
  });

  it("leaves secondary and retired ownerships unconstrained", () => {
    // A team may legitimately have several supporting pages, and reassigning an
    // owner must not have to delete its own history. Read the statement rather
    // than the file: the comments above it discuss the cases it excludes.
    const statement = withoutSqlComments(ownershipIndexSql);

    expect(statement).not.toMatch(/SECONDARY/);
    expect(statement).not.toMatch(/RETIRED/);
  });

  it("uses an index name short enough to survive Postgres", () => {
    // Postgres truncates identifiers at 63 characters, which in P1 produced a
    // second index nobody asked for.
    const name = /CREATE UNIQUE INDEX (\w+)/.exec(ownershipIndexSql)?.[1] ?? "";
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThan(63);
  });
});

describe("opportunity identity", () => {
  it("treats nulls as equal so re-detection updates rather than duplicates", () => {
    expect(opportunityIndexSql).toMatch(/NULLS NOT DISTINCT/i);
    expect(opportunityIndexSql).toMatch(
      /website_id, type, page_id, keyword_id, topic_id, competitor_id/i,
    );
  });

  it("uses an index name short enough to survive Postgres", () => {
    const name = /CREATE UNIQUE INDEX (\w+)/.exec(opportunityIndexSql)?.[1] ?? "";
    expect(name.length).toBeLessThan(63);
  });

  it("retains the inputs a score was computed from", () => {
    // Untraceable priority scoring is a P2 FAIL. The score alone is not enough:
    // it has to be reproducible months later from what was stored.
    const model = schema.match(/model Opportunity \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(model).toContain("scoreInputsJson");
    expect(model).toMatch(/scoringModelVersion\s+String\s+@default/);
  });

  it("has no column for a numeric traffic or revenue forecast", () => {
    // Descriptive only. A fabricated forecast is forbidden outright, and the
    // cheapest way to keep that true is to give it nowhere to live.
    //
    // Fields only: the doc comments explain why the forecast is absent, and a
    // test that reads them would fail on its own explanation.
    const model = schema.match(/model Opportunity \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const fields = withoutPrismaDocComments(model);

    expect(fields).toContain("expectedEffectDescription");

    for (const forbidden of ["forecast", "projectedTraffic", "estimatedRevenue", "expectedVisits"]) {
      expect(fields.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("third-party market data", () => {
  it("records which provider every market observation came from", () => {
    for (const model of [
      "KeywordMetricsSnapshot",
      "RankingSnapshot",
      "CompetitorKeywordSnapshot",
    ]) {
      const block =
        schema.match(new RegExp(String.raw`model ${model} \{([\s\S]*?)\n\}`))?.[1] ?? "";
      expect(block).toMatch(/sourceProvider\s+ConnectionProvider/);
      expect(block).toMatch(/capturedAt\s+DateTime/);
    }
  });

  it("keeps difficulty attached to its provider", () => {
    // A Semrush KD of 40 and an Ahrefs KD of 40 are not the same claim, so the
    // two are never comparable without knowing which said it.
    const block = schema.match(/model KeywordMetricsSnapshot \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(block).toMatch(/keywordDifficulty\s+Decimal\?/);
    expect(block).toMatch(/sourceProvider\s+ConnectionProvider/);
  });

  it("leaves unavailable market metrics null rather than zero", () => {
    const block = schema.match(/model KeywordMetricsSnapshot \{([\s\S]*?)\n\}/)?.[1] ?? "";
    for (const field of ["searchVolume", "keywordDifficulty", "cpc"]) {
      expect(block).toMatch(new RegExp(String.raw`${field}\s+\w+\?`));
      expect(block).not.toMatch(new RegExp(String.raw`${field}[^\n]*@default\(0\)`));
    }
  });

  it("preserves a ranking URL that resolves to no known page", () => {
    // The null pageId is information: Google is ranking something not in our
    // inventory, which is worth surfacing rather than inventing a Page for.
    const block = schema.match(/model RankingSnapshot \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(block).toMatch(/pageId\s+String\?/);
    expect(block).toMatch(/rankingUrl\s+String\?/);
  });
});

describe("imports", () => {
  it("makes the same file twice the same import", () => {
    expect(schema).toContain("@@unique([websiteId, checksum])");
  });

  it("stages rows so invalid ones can be shown rather than logged", () => {
    const block = schema.match(/model ImportRow \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(block).toMatch(/isValid\s+Boolean/);
    expect(block).toMatch(/errorReason\s+String\?/);
  });

  it("holds no credential columns", () => {
    const block = schema.match(/model Import \{([\s\S]*?)\n\}/)?.[1] ?? "";
    for (const forbidden of ["token", "password", "secret", "apiKey", "privateKey"]) {
      expect(block.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("intent provenance is its own vocabulary", () => {
  it("does not alter the canonical Provenance enum", () => {
    // CLAUDE.md fixes the data-provenance vocabulary. Intent provenance answers a
    // different question and gets its own enum rather than diluting that one.
    const block = schema.match(/enum Provenance \{([\s\S]*?)\}/)?.[1] ?? "";
    const values = block.split("\n").map((line) => line.trim()).filter(Boolean);

    expect(values.sort()).toEqual(
      ["INFERRED", "SYSTEM_DERIVED", "UNKNOWN", "USER_PROVIDED"].sort(),
    );
  });

  it("carries the intent vocabulary the spec names", () => {
    const block = schema.match(/enum IntentProvenance \{([\s\S]*?)\}/)?.[1] ?? "";
    for (const value of ["USER_PROVIDED", "PROVIDER_PROVIDED", "SYSTEM_CLASSIFIED", "UNKNOWN"]) {
      expect(block).toContain(value);
    }
  });
});
