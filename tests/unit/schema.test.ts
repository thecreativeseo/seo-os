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
