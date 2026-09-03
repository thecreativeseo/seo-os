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

  it("still registers every P0 provider", () => {
    // The registry may grow — AHREFS arrived in P2 — but a P0 provider
    // disappearing would silently orphan any connection pointing at it.
    const block = schema.match(/enum ConnectionProvider \{([\s\S]*?)\}/)?.[1] ?? "";
    const found = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//"));

    for (const provider of providers) {
      expect(found).toContain(provider);
    }
  });

  it("keeps the schema registry and CLAUDE.md in step", () => {
    // The registry is documented in two places, and a provider the code knows
    // about but the rules do not is how a documented constraint quietly rots.
    const block = schema.match(/enum ConnectionProvider \{([\s\S]*?)\}/)?.[1] ?? "";
    const inSchema = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//"));

    const claudeMd = readFileSync(join(root, "CLAUDE.md"), "utf8");
    const documented = claudeMd.match(/Initial provider registry:\s*```text\n([\s\S]*?)```/)?.[1] ?? "";

    expect(documented.trim().split("\n").map((line) => line.trim()).sort()).toEqual(
      [...inSchema].sort(),
    );
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

/**
 * P3 schema invariants.
 *
 * Each of these would fail silently if it regressed: an approval attributed to a
 * model, a diagnosis that overwrote its predecessor, a package that could be
 * edited after the run that used it. The database is where they hold.
 */
describe("AI cannot approve its own work", () => {
  it("makes a Decision's actor a User, with no column an AiRun could occupy", () => {
    const model = schema.match(/model Decision \{([\s\S]*?)\n\}/)?.[1] ?? "";

    // Non-null and a User foreign key. The rule holds in the schema rather than
    // in a check somebody could forget to write.
    expect(model).toMatch(/decidedByUserId\s+String\s+@map/);
    expect(model).not.toMatch(/decidedByUserId\s+String\?/);
    expect(model).toMatch(/decidedBy\s+User\s+@relation\("DecisionMaker"/);

    for (const forbidden of ["aiRunId", "createdByAiRun", "decidedByAiRun"]) {
      expect(model).not.toContain(forbidden);
    }
  });

  it("restricts deleting a user who has decided something", () => {
    // A decision with no decider is an unattributed approval, which is worse
    // than no record at all.
    const model = schema.match(/model Decision \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(model).toMatch(/DecisionMaker[^\n]*onDelete: Restrict/);
  });
});

describe("diagnosis history", () => {
  it("supersedes rather than overwrites", () => {
    const model = schema.match(/model Diagnosis \{([\s\S]*?)\n\}/)?.[1] ?? "";

    // What was believed at the time is part of the record — the same rule as
    // approved Business Context in P0.
    expect(model).toMatch(/supersedesId\s+String\?\s+@unique/);
    expect(model).toMatch(/supersededBy\s+Diagnosis\?/);

    // The status the superseded row moves to lives in the enum, not the model.
    const status = schema.match(/enum DiagnosisStatus \{([\s\S]*?)\}/)?.[1] ?? "";
    expect(status).toContain("SUPERSEDED");
  });

  it("keeps a finding's downgrade visible", () => {
    // When the server lowers a model's verdict, the reader sees that it was
    // changed and why, not just the result.
    const model = schema.match(/model DiagnosisFinding \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(model).toMatch(/downgradedFrom\s+FindingVerdict\?/);
    expect(model).toMatch(/downgradeReason\s+String\?/);
  });

  it("allows one finding per category per diagnosis", () => {
    expect(schema).toContain("@@unique([diagnosisId, category])");
  });
});

describe("evidence packages", () => {
  it("carries a content hash and a seal", () => {
    const model = schema.match(/model EvidencePackage \{([\s\S]*?)\n\}/)?.[1] ?? "";

    // The hash is what lets a package be shown to be the same package later,
    // which is what makes a diagnosis reproducible rather than merely recorded.
    expect(model).toMatch(/contentHash\s+String\s+@map/);
    expect(model).toMatch(/sealedAt\s+DateTime\?/);
  });

  it("records the retrieval policy version it used", () => {
    const model = schema.match(/model EvidencePackage \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(model).toContain("retrievalPolicyId");
    expect(model).toContain("retrievalPolicyVersion");
    expect(model).toContain("retrievalManifestJson");
  });

  it("records which approved context version it reasoned from", () => {
    const model = schema.match(/model EvidencePackage \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(model).toMatch(/contextVersionId\s+String\?/);
  });

  it("holds each evidence id once", () => {
    expect(schema).toContain("@@unique([packageId, evidenceId])");
  });
});

describe("prompts and runs keep their provenance", () => {
  it("versions a prompt per agent and task", () => {
    // A change creates a version. The alternative is a diagnosis whose prompt no
    // longer exists.
    expect(schema).toContain("@@unique([agentType, taskType, version])");
  });

  it("records provider, model and both versions on every run", () => {
    const model = schema.match(/model AiRun \{([\s\S]*?)\n\}/)?.[1] ?? "";

    for (const field of [
      "provider",
      "model",
      "promptTemplateVersion",
      "outputSchemaVersion",
      "evidencePackageId",
    ]) {
      expect(model).toContain(field);
    }
  });

  it("holds no credential columns", () => {
    const model = withoutPrismaDocComments(
      schema.match(/model AiRun \{([\s\S]*?)\n\}/)?.[1] ?? "",
    );

    // Credential-shaped names, not the bare word "token": inputTokens and
    // outputTokens are counts, and forbidding the substring would fail on an
    // honest field while catching nothing real.
    for (const forbidden of [
      "apiKey",
      "api_key",
      "accessToken",
      "refreshToken",
      "bearer",
      "secret",
      "password",
      "privateKey",
    ]) {
      expect(model.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    // The counts that are legitimately there.
    expect(model).toContain("inputTokens");
    expect(model).toContain("outputTokens");
  });
});

describe("recommendations", () => {
  it("has no column for a numeric forecast", () => {
    // Same rule as P2's opportunities: the cheapest way to keep a forbidden
    // fabrication out is to give it nowhere to live.
    const model = withoutPrismaDocComments(
      schema.match(/model Recommendation \{([\s\S]*?)\n\}/)?.[1] ?? "",
    );

    expect(model).toContain("expectedEffectDescription");
    for (const forbidden of ["forecast", "projectedTraffic", "estimatedRevenue"]) {
      expect(model.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("records the blocking rule rather than only the fact of blocking", () => {
    const model = schema.match(/model Recommendation \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(model).toMatch(/blockedByRuleId\s+String\?/);
    expect(model).toContain("blockedReason");
  });

  it("records which rule an approval overrode", () => {
    const model = schema.match(/model Decision \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(model).toContain("overriddenRuleId");
    expect(model).toContain("overrideReason");
  });

  it("starts awaiting review", () => {
    const model = schema.match(/model Recommendation \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(model).toMatch(/status\s+RecommendationStatus\s+@default\(AWAITING_REVIEW\)/);
  });
});

describe("the vocabularies P3 must not weaken", () => {
  it("keeps UNKNOWN a first-class verdict", () => {
    const block = schema.match(/enum FindingVerdict \{([\s\S]*?)\}/)?.[1] ?? "";

    // A valid, expected result rather than a failure to answer.
    expect(block).toContain("UNKNOWN");
    expect(block).toContain("CONFIRMED");
  });

  it("distinguishes AI-inferred evidence from measured evidence", () => {
    const block = schema.match(/enum EvidenceReliability \{([\s\S]*?)\}/)?.[1] ?? "";

    for (const value of ["DIRECT_FIRST_PARTY", "DIRECT_PROVIDER", "AI_INFERRED"]) {
      expect(block).toContain(value);
    }
  });

  it("names the technical categories it cannot answer", () => {
    // They stay in the taxonomy so the agent can return UNKNOWN against a named
    // category rather than omitting the question.
    const block = schema.match(/enum DiagnosticCategory \{([\s\S]*?)\}/)?.[1] ?? "";

    for (const value of [
      "TECHNICAL_INDEXATION",
      "TECHNICAL_RENDERING",
      "TECHNICAL_CANONICALIZATION",
      "INSUFFICIENT_EVIDENCE",
    ]) {
      expect(block).toContain(value);
    }
  });
});
