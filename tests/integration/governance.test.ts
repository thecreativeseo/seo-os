import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import {
  GovernanceError,
  addCompetitor,
  archiveBrandFact,
  archiveCompetitor,
  createGoal,
  createSeoRule,
  decideBrandFact,
  getTechnicalContext,
  listBrandFacts,
  listCanonicalBrandFacts,
  listCompetitors,
  listGoals,
  listSeoRules,
  proposeBrandFact,
  retireGoal,
  saveTechnicalContext,
  setSeoRuleActive,
  updateGoal,
} from "@/server/services/governance";
import type { TenantContext } from "@/server/auth/guards";
import type { Role } from "@/generated/prisma/client";

/**
 * Governance entities (P0_ACCEPTANCE_CRITERIA: Business Goals, Brand Facts,
 * Competitors, SEO Rules, Technical Context).
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string, role: Role = "OWNER"): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `gov-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Gov ${label}`, slug: `gov-${label}-${suffix}` },
  });
  organizationIds.push(organization.id);

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role,
      status: "ACTIVE",
      joinedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.create({
    data: { organizationId: organization.id, name: "Team", slug: `team-${suffix}` },
  });

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: `${label}-${suffix}.example.com`,
      normalizedDomain: `${label}-${suffix}.example.com`,
    },
  });

  return { user, membership, organization, workspace, website };
}

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
      await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
    });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("business goals", () => {
  it("creates, activates, and retires", async () => {
    const context = await makeContext("goal");

    const goal = await createGoal(context, { title: "Generate qualified leads" });
    expect(goal.status).toBe("DRAFT");

    const active = await updateGoal(context, goal.id, { status: "ACTIVE" });
    expect(active.status).toBe("ACTIVE");

    const retired = await retireGoal(context, goal.id);
    expect(retired.status).toBe("RETIRED");
    expect(retired.archivedAt).not.toBeNull();

    // Retired goals leave the active list but remain in the database.
    expect(await listGoals(context)).toHaveLength(0);
    expect(await prisma.businessGoal.count({ where: { id: goal.id } })).toBe(1);
  });

  it("keeps a missing baseline null rather than zero", async () => {
    const context = await makeContext("baseline");
    const goal = await createGoal(context, { title: "Grow pipeline", baseline: null });

    expect(goal.baseline).toBeNull();
    expect(goal.baselineSource).toBeNull();
    expect(goal.baselineDate).toBeNull();
  });

  it("records a baseline when one is genuinely known", async () => {
    const context = await makeContext("known");
    const goal = await createGoal(context, {
      title: "Increase demos",
      baseline: "42",
      baselineSource: "CRM export",
    });

    expect(goal.baseline?.toString()).toBe("42");
    expect(goal.baselineSource).toBe("CRM export");
  });

  it("rejects an owner from another organization", async () => {
    const a = await makeContext("owner-a");
    const b = await makeContext("owner-b");

    await expect(
      createGoal(a, { title: "Cross-tenant owner", ownerUserId: b.user.id }),
    ).rejects.toThrow();
  });

  it("does not update another tenant's goal", async () => {
    const a = await makeContext("upd-a");
    const b = await makeContext("upd-b");
    const goalB = await createGoal(b, { title: "B's goal" });

    await expect(updateGoal(a, goalB.id, { title: "hijacked" })).rejects.toBeInstanceOf(
      GovernanceError,
    );

    const unchanged = await prisma.businessGoal.findUnique({ where: { id: goalB.id } });
    expect(unchanged?.title).toBe("B's goal");
  });

  it("writes an audit event for each change", async () => {
    const context = await makeContext("goalaudit");
    const goal = await createGoal(context, { title: "Audited goal" });
    await updateGoal(context, goal.id, { status: "ACTIVE" });

    const events = await prisma.auditEvent.findMany({
      where: { entityId: goal.id },
      orderBy: { createdAt: "asc" },
    });

    expect(events.map((event) => event.action)).toEqual(["CREATE", "UPDATE"]);
    expect(events[1]?.beforeSnapshotJson).toMatchObject({ status: "DRAFT" });
    expect(events[1]?.afterSnapshotJson).toMatchObject({ status: "ACTIVE" });
  });
});

describe("brand facts", () => {
  it("starts as PROPOSED and is not canonical", async () => {
    const context = await makeContext("fact");
    const fact = await proposeBrandFact(context, {
      category: "Company",
      factKey: "Year founded",
      value: "2018",
    });

    expect(fact.approvalStatus).toBe("PROPOSED");
    expect(fact.verifiedAt).toBeNull();
    expect(await listCanonicalBrandFacts(context)).toHaveLength(0);
  });

  it("becomes canonical only once approved", async () => {
    const context = await makeContext("factapprove");
    const fact = await proposeBrandFact(context, {
      category: "Company",
      factKey: "Headcount",
      value: "24",
    });

    const approved = await decideBrandFact(context, fact.id, "APPROVED");

    expect(approved.approvalStatus).toBe("APPROVED");
    expect(approved.verifiedAt).not.toBeNull();
    expect((await listCanonicalBrandFacts(context)).map((f) => f.id)).toEqual([fact.id]);
  });

  it("never invents a source URL", async () => {
    const context = await makeContext("factsource");
    const fact = await proposeBrandFact(context, {
      category: "Company",
      factKey: "Founded",
      value: "2018",
      sourceUrl: null,
    });

    expect(fact.sourceUrl).toBeNull();
    expect(fact.source).toBe("USER_PROVIDED");
  });

  it("removes a rejected fact from canonical", async () => {
    const context = await makeContext("factreject");
    const fact = await proposeBrandFact(context, {
      category: "Company",
      factKey: "Claim",
      value: "Unverified",
    });

    const rejected = await decideBrandFact(context, fact.id, "REJECTED");

    expect(rejected.approvalStatus).toBe("REJECTED");
    expect(rejected.verifiedAt).toBeNull();
    expect(await listCanonicalBrandFacts(context)).toHaveLength(0);
  });

  it("denies approval to a MEMBER", async () => {
    const context = await makeContext("factmember", "MEMBER");
    const fact = await proposeBrandFact(context, {
      category: "Company",
      factKey: "x",
      value: "y",
    });

    await expect(decideBrandFact(context, fact.id, "APPROVED")).rejects.toThrow(
      /permission/i,
    );
    expect(await listCanonicalBrandFacts(context)).toHaveLength(0);
  });

  it("archives a fact without deleting it", async () => {
    const context = await makeContext("factarchive");
    const fact = await proposeBrandFact(context, {
      category: "Company",
      factKey: "Old",
      value: "Value",
    });
    await decideBrandFact(context, fact.id, "APPROVED");

    const archived = await archiveBrandFact(context, fact.id);

    expect(archived.approvalStatus).toBe("ARCHIVED");
    expect(await listBrandFacts(context)).toHaveLength(0);
    expect(await prisma.brandFact.count({ where: { id: fact.id } })).toBe(1);
  });

  it("does not reach another tenant's fact", async () => {
    const a = await makeContext("fact-a");
    const b = await makeContext("fact-b");
    const factB = await proposeBrandFact(b, {
      category: "Company",
      factKey: "Secret",
      value: "B only",
    });

    await expect(decideBrandFact(a, factB.id, "APPROVED")).rejects.toBeInstanceOf(
      GovernanceError,
    );
    expect(await listBrandFacts(a)).toHaveLength(0);
  });
});

describe("competitors", () => {
  it("adds without classifying", async () => {
    const context = await makeContext("comp");
    const competitor = await addCompetitor(context, {
      name: "Rival Co",
      domain: "https://www.Rival.com/",
    });

    expect(competitor.type).toBe("UNKNOWN");
    expect(competitor.providedByUser).toBe(true);
    expect(competitor.source).toBe("USER_PROVIDED");
    expect(competitor.normalizedDomain).toBe("rival.com");
  });

  it("accepts a type only when a human chooses one", async () => {
    const context = await makeContext("comptype");
    const competitor = await addCompetitor(context, { name: "Rival", type: "DIRECT" });

    expect(competitor.type).toBe("DIRECT");
    expect(competitor.source).toBe("USER_PROVIDED");
  });

  it("leaves the domain null when none is given", async () => {
    const context = await makeContext("compnodomain");
    const competitor = await addCompetitor(context, { name: "Unknown Rival" });

    expect(competitor.domain).toBeNull();
    expect(competitor.normalizedDomain).toBeNull();
  });

  it("archives rather than deletes", async () => {
    const context = await makeContext("comparchive");
    const competitor = await addCompetitor(context, { name: "Gone" });

    await archiveCompetitor(context, competitor.id);

    expect(await listCompetitors(context)).toHaveLength(0);
    expect(await prisma.competitor.count({ where: { id: competitor.id } })).toBe(1);
  });

  it("does not reach another tenant's competitor", async () => {
    const a = await makeContext("comp-a");
    const b = await makeContext("comp-b");
    const competitorB = await addCompetitor(b, { name: "B's rival" });

    await expect(archiveCompetitor(a, competitorB.id)).rejects.toBeInstanceOf(
      GovernanceError,
    );
  });
});

describe("seo rules", () => {
  it("creates an active rule with a controlled severity", async () => {
    const context = await makeContext("rule");
    const rule = await createSeoRule(context, {
      category: "Content",
      rule: "Never publish pricing without finance approval.",
      severity: "BLOCKING",
    });

    expect(rule.active).toBe(true);
    expect(rule.severity).toBe("BLOCKING");
    expect(rule.ownerUserId).toBe(context.user.id);
  });

  it("deactivates and reactivates without deleting", async () => {
    const context = await makeContext("ruletoggle");
    const rule = await createSeoRule(context, {
      category: "Brand",
      rule: "Use the registered company name in titles.",
      severity: "WARNING",
    });

    expect((await setSeoRuleActive(context, rule.id, false)).active).toBe(false);
    expect((await setSeoRuleActive(context, rule.id, true)).active).toBe(true);
    expect(await listSeoRules(context)).toHaveLength(1);
  });

  it("does not reach another tenant's rule", async () => {
    const a = await makeContext("rule-a");
    const b = await makeContext("rule-b");
    const ruleB = await createSeoRule(b, {
      category: "Legal",
      rule: "B only",
      severity: "INFO",
    });

    await expect(setSeoRuleActive(a, ruleB.id, false)).rejects.toBeInstanceOf(
      GovernanceError,
    );
  });
});

describe("technical context", () => {
  it("persists shell fields", async () => {
    const context = await makeContext("tech");

    const saved = await saveTechnicalContext(context, {
      hostingNotes: "Vercel",
      developerContact: "dev@example.com",
      stagingAvailable: true,
    });

    expect(saved.hostingNotes).toBe("Vercel");
    expect(saved.stagingAvailable).toBe(true);
    expect((await getTechnicalContext(context))?.developerContact).toBe("dev@example.com");
  });

  it("keeps an unanswered staging question unknown rather than false", async () => {
    const context = await makeContext("technull");
    const saved = await saveTechnicalContext(context, { stagingAvailable: null });

    expect(saved.stagingAvailable).toBeNull();
  });

  it("makes no technical health claim", async () => {
    const context = await makeContext("techclaim");
    const saved = await saveTechnicalContext(context, { hostingNotes: "Shared host" });

    // Nothing is inferred about crawl, indexation, or health.
    expect(saved.knownConstraints).toBeNull();
    expect(saved.knownMigrations).toBeNull();
    expect(saved.technicalNotes).toBeNull();
  });

  it("is scoped to one website", async () => {
    const a = await makeContext("tech-a");
    const b = await makeContext("tech-b");

    await saveTechnicalContext(a, { hostingNotes: "A only" });

    expect(await getTechnicalContext(b)).toBeNull();
  });
});

describe("audit trail", () => {
  it("never records a secret", async () => {
    const context = await makeContext("nosecret");
    await proposeBrandFact(context, {
      category: "Company",
      factKey: "access_token",
      value: "ya29.should-not-persist-in-audit",
    });

    const events = await prisma.auditEvent.findMany({
      where: { organizationId: context.organization.id },
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("ya29.should-not-persist-in-audit");
  });

  it("scopes events to the acting tenant", async () => {
    const a = await makeContext("audit-a");
    const b = await makeContext("audit-b");

    await createGoal(a, { title: "A goal" });

    const bEvents = await prisma.auditEvent.findMany({
      where: { organizationId: b.organization.id },
    });

    expect(bEvents).toHaveLength(0);
  });
});
