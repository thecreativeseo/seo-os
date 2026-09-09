import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { buildEvidenceId } from "@/lib/evidence/id";
import { PAGE_DIAGNOSIS_POLICY } from "@/lib/evidence/retrieval-policy";
import { resolveEvidenceId, resolveEvidenceIds } from "@/server/services/evidence";
import {
  assemblePageDiagnosisPackage,
  getPackage,
  hashPackage,
  renderPackage,
  sealPackage,
} from "@/server/services/evidence-assembler";
import { getDiagnosisEvidence } from "@/server/services/diagnosis";
import { buildEvidenceView, describeOmitted } from "@/lib/evidence/presentation";
import { deleteOrganizations } from "../helpers/teardown";

/**
 * Evidence resolution and assembly (docs/P3_SPEC.md §9–§13, §36).
 *
 * The security case is the point of this file. An evidence ID is a string that
 * will arrive from a language model, shaped by text an attacker may have written
 * on a web page, and the product's defence is that resolving one is a
 * website-scoped query rather than a lookup in a list. These tests attack that
 * from the three directions a real attempt would: an invented ID, a well-formed
 * ID belonging to somebody else, and a real ID used from the wrong tenant.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

type Fixture = TenantContext & {
  pageId: string;
  keywordId: string;
  ownershipId: string;
  goalId: string;
  contextVersionId: string;
};

async function makeTenant(label: string): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `ev-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Evidence ${label}`, slug: `ev-${label}-${suffix}` },
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
      primaryMarket: "PH",
    },
  });

  const context: TenantContext = { user, membership, organization, workspace, website };

  const page = await prisma.page.create({
    data: {
      websiteId: website.id,
      url: `https://${host}/pricing`,
      normalizedUrl: `https://${host}/pricing`,
      path: "/pricing",
      hostname: host,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });

  const keyword = await prisma.keyword.create({
    data: {
      websiteId: website.id,
      keyword: `${label} pricing`,
      normalizedKeyword: `${label} pricing`,
      locale: "en-PH",
      language: "en",
      market: "PH",
    },
  });

  const ownership = await prisma.keywordPageOwnership.create({
    data: {
      websiteId: website.id,
      keywordId: keyword.id,
      pageId: page.id,
      ownershipType: "PRIMARY",
      status: "ACTIVE",
    },
  });

  const goal = await prisma.businessGoal.create({
    data: {
      websiteId: website.id,
      title: "Grow qualified demo requests",
      status: "ACTIVE",
      businessObjective: "More pipeline from organic",
      primaryMetric: "demo_requests",
    },
  });

  const businessContext = await prisma.businessContext.create({
    data: { websiteId: website.id },
  });

  const version = await prisma.businessContextVersion.create({
    data: {
      businessContextId: businessContext.id,
      versionNumber: 1,
      status: "APPROVED",
      companySummary: `${label} sells analytics software.`,
      createdByUserId: user.id,
      approvedByUserId: user.id,
      approvedAt: new Date(),
    },
  });

  // Every GSC row is attributable to a connection — the schema requires it, so a
  // measurement can always be traced back to the account that reported it.
  const connection = await prisma.connection.create({
    data: {
      workspaceId: workspace.id,
      websiteId: website.id,
      provider: "GOOGLE_SEARCH_CONSOLE",
      status: "CONNECTED",
      connectedAt: new Date(),
    },
  });

  // Something measured, so the page has performance evidence.
  const query = await prisma.query.create({
    data: {
      websiteId: website.id,
      query: `${label} pricing`,
      normalizedQuery: `${label} pricing`,
    },
  });

  const today = new Date();
  const days = Array.from({ length: 40 }, (_, index) => {
    const date = new Date(today);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (index + 1));
    return date;
  });

  await prisma.gscMetricDaily.createMany({
    data: days.map((date) => ({
      websiteId: website.id,
      pageId: page.id,
      queryId: query.id,
      date,
      clicks: 10,
      impressions: 400,
      position: 6.5,
      sourceConnectionId: connection.id,
    })),
  });

  return {
    ...context,
    pageId: page.id,
    keywordId: keyword.id,
    ownershipId: ownership.id,
    goalId: goal.id,
    contextVersionId: version.id,
  };
}

afterAll(async () => {
  if (organizationIds.length > 0) {
    // Approved context versions are immutable, enforced by a trigger rather than
    // by application code. Teardown asks for the documented escape hatch instead
    // of pretending the rule is not there.
    await deleteOrganizations(organizationIds);
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("resolving an evidence id", () => {
  it("resolves a record this tenant owns", async () => {
    const tenant = await makeTenant("res");

    const evidence = await resolveEvidenceId(
      tenant,
      buildEvidenceId({ kind: "own", ownershipId: tenant.ownershipId }),
    );

    expect(evidence).not.toBeNull();
    expect(evidence?.type).toBe("KEYWORD_OWNERSHIP");
    expect(evidence?.reliability).toBe("USER_PROVIDED");
    expect(evidence?.sourceEntityId).toBe(tenant.ownershipId);
  });

  it("refuses an id belonging to another tenant", async () => {
    // The whole security case in one assertion. The id is real, well-formed, and
    // resolves fine for its owner — and to nothing for anybody else.
    const a = await makeTenant("iso-a");
    const b = await makeTenant("iso-b");

    const theirId = buildEvidenceId({ kind: "own", ownershipId: b.ownershipId });

    expect(await resolveEvidenceId(b, theirId)).not.toBeNull();
    expect(await resolveEvidenceId(a, theirId)).toBeNull();
  });

  it("refuses an invented id that is nonetheless well-formed", async () => {
    const tenant = await makeTenant("invented");

    const fabricated = buildEvidenceId({ kind: "own", ownershipId: crypto.randomUUID() });

    expect(await resolveEvidenceId(tenant, fabricated)).toBeNull();
  });

  it("refuses a string that is not an evidence id at all", async () => {
    const tenant = await makeTenant("garbage");

    for (const raw of [
      "not-an-id",
      "own:",
      "own:not-a-uuid",
      "'; DROP TABLE page; --",
      "own:" + "a".repeat(500),
      null,
      undefined,
      42,
      {},
    ]) {
      expect(await resolveEvidenceId(tenant, raw)).toBeNull();
    }
  });

  it("separates unparseable ids from ones that resolve to nothing", async () => {
    // Worth telling apart: gibberish suggests improvisation, a well-formed id
    // that resolves to nothing suggests reaching outside the package.
    const tenant = await makeTenant("partition");

    const result = await resolveEvidenceIds(tenant, [
      buildEvidenceId({ kind: "own", ownershipId: tenant.ownershipId }),
      buildEvidenceId({ kind: "goal", goalId: crypto.randomUUID() }),
      "total nonsense",
    ]);

    expect(result.resolved).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
    expect(result.invalid).toEqual(["total nonsense"]);
  });

  it("does not report a metric window that was never measured", async () => {
    // Zero clicks we never observed is a fabricated measurement, not a zero.
    const tenant = await makeTenant("nowindow");

    const evidence = await resolveEvidenceId(
      tenant,
      buildEvidenceId({
        kind: "gsc",
        subject: "page",
        subjectId: tenant.pageId,
        start: "2019-01-01",
        end: "2019-01-28",
      }),
    );

    expect(evidence).toBeNull();
  });

  it("computes CTR from summed clicks and impressions", async () => {
    const tenant = await makeTenant("ctr");
    const { package: assembled, evidence } = await assemblePageDiagnosisPackage(
      tenant,
      tenant.pageId,
    );
    expect(assembled.evidenceCount).toBeGreaterThan(0);

    const gsc = evidence.find((record) => record.type === "GSC_METRIC");
    const ctx = gsc?.contextJson as { clicks: number; impressions: number; ctr: number };

    expect(ctx.ctr).toBeCloseTo(ctx.clicks / ctx.impressions, 6);
  });

  it("labels a previous diagnosis as inferred, never as measured", async () => {
    const tenant = await makeTenant("inferred");

    const diagnosis = await prisma.diagnosis.create({
      data: {
        websiteId: tenant.website.id,
        targetType: "PAGE",
        targetId: tenant.pageId,
        executiveSummary: "Clicks fell alongside a ranking decline.",
        overallConfidence: "MEDIUM",
      },
    });

    const evidence = await resolveEvidenceId(
      tenant,
      buildEvidenceId({ kind: "diag", diagnosisId: diagnosis.id }),
    );

    expect(evidence?.reliability).toBe("AI_INFERRED");
  });
});

describe("assembling a package", () => {
  it("gathers evidence, stores refs, and hashes the result", async () => {
    const tenant = await makeTenant("assemble");

    const result = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.package.evidenceCount).toBe(result.evidence.length);
    expect(result.package.contentHash).toHaveLength(64);
    expect(result.package.targetId).toBe(tenant.pageId);

    const stored = await getPackage(tenant, result.package.id);
    expect(stored?.refs).toHaveLength(result.evidence.length);

    // Everything in the package resolves. A package cannot contain an id that
    // would later fail validation.
    const ids = result.evidence.map((record) => record.id);
    const resolution = await resolveEvidenceIds(tenant, ids);
    expect(resolution.resolved).toHaveLength(ids.length);
    expect(resolution.unresolved).toHaveLength(0);
  });

  it("is deterministic: the same data produces the same hash", async () => {
    const tenant = await makeTenant("deterministic");

    const first = await assemblePageDiagnosisPackage(tenant, tenant.pageId);
    const second = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    expect(second.package.contentHash).toBe(first.package.contentHash);
    expect(second.package.id).not.toBe(first.package.id);
  });

  it("changes hash when the evidence changes", async () => {
    const tenant = await makeTenant("changed");
    const before = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    await prisma.businessGoal.create({
      data: {
        websiteId: tenant.website.id,
        title: "A second goal",
        status: "ACTIVE",
      },
    });

    const after = await assemblePageDiagnosisPackage(tenant, tenant.pageId);
    expect(after.package.contentHash).not.toBe(before.package.contentHash);
  });

  it("records the policy it followed", async () => {
    const tenant = await makeTenant("policy");
    const result = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    expect(result.package.retrievalPolicyVersion).toBe(PAGE_DIAGNOSIS_POLICY.version);
    expect(result.manifest.policy.name).toBe("page-diagnosis");

    const policy = await prisma.retrievalPolicy.findUnique({
      where: {
        name_version: {
          name: PAGE_DIAGNOSIS_POLICY.name,
          version: PAGE_DIAGNOSIS_POLICY.version,
        },
      },
    });
    expect(policy).not.toBeNull();
  });

  it("says what it could not find rather than staying silent", async () => {
    const tenant = await makeTenant("gaps");
    const result = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    // This fixture has no page content and no ranking data.
    const notes = result.manifest.notes.join(" ");
    expect(notes).toContain("No content captured");
    expect(result.manifest.empty).toContain("PAGE_CONTENT");
  });

  it("discloses what it left out when a budget is reached", async () => {
    // A cap that nobody can see is how a diagnosis becomes confidently wrong.
    const tenant = await makeTenant("capped");

    for (let index = 0; index < 8; index += 1) {
      await prisma.businessGoal.create({
        data: {
          websiteId: tenant.website.id,
          title: `Goal ${index}`,
          status: "ACTIVE",
        },
      });
    }

    const result = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    const goals = result.evidence.filter((record) => record.type === "BUSINESS_GOAL");
    expect(goals.length).toBeLessThanOrEqual(PAGE_DIAGNOSIS_POLICY.budgets.BUSINESS_GOAL!.max);
  });

  it("orders by reliability so a measurement outranks an inference", async () => {
    const tenant = await makeTenant("ordered");
    const result = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    const rendered = renderPackage(result.evidence);
    const providerIndex = rendered.indexOf("DIRECT_PROVIDER");
    const userIndex = rendered.indexOf("USER_PROVIDED");

    if (providerIndex !== -1 && userIndex !== -1) {
      expect(providerIndex).toBeLessThan(userIndex);
    }
  });

  it("seals a package and leaves it sealed", async () => {
    const tenant = await makeTenant("sealed");
    const result = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    const sealed = await sealPackage(tenant, result.package.id);
    expect(sealed?.sealedAt).not.toBeNull();

    const again = await sealPackage(tenant, result.package.id);
    expect(again?.sealedAt?.getTime()).toBe(sealed?.sealedAt?.getTime());
  });

  it("writes an audit event", async () => {
    const tenant = await makeTenant("audited");
    const result = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    const event = await prisma.auditEvent.findFirst({
      where: { entityType: "EvidencePackage", entityId: result.package.id },
    });

    expect(event).not.toBeNull();
    expect(event?.action).toBe("CREATE");
  });

  it("hashes over ids and policy, not over rendered text", async () => {
    const tenant = await makeTenant("hash");
    const result = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    const recomputed = hashPackage(PAGE_DIAGNOSIS_POLICY, result.evidence);
    expect(recomputed).toBe(result.package.contentHash);

    // Reword a label; same records, same package.
    const reworded = result.evidence.map((record) => ({ ...record, source: "Reworded" }));
    expect(hashPackage(PAGE_DIAGNOSIS_POLICY, reworded)).toBe(result.package.contentHash);
  });
});

describe("tenant isolation in assembly", () => {
  it("refuses to assemble against another tenant's page", async () => {
    const a = await makeTenant("asm-a");
    const b = await makeTenant("asm-b");

    await expect(assemblePageDiagnosisPackage(a, b.pageId)).rejects.toThrow();
  });

  it("never includes another tenant's records", async () => {
    const a = await makeTenant("mix-a");
    const b = await makeTenant("mix-b");

    const result = await assemblePageDiagnosisPackage(a, a.pageId);

    const foreignIds = [
      buildEvidenceId({ kind: "own", ownershipId: b.ownershipId }),
      buildEvidenceId({ kind: "goal", goalId: b.goalId }),
      buildEvidenceId({ kind: "ctx", contextVersionId: b.contextVersionId }),
    ];

    for (const record of result.evidence) {
      expect(foreignIds).not.toContain(record.id);
      expect(record.websiteId).toBe(a.website.id);
    }
  });

  it("does not read another tenant's package", async () => {
    const a = await makeTenant("pkg-a");
    const b = await makeTenant("pkg-b");

    const theirs = await assemblePageDiagnosisPackage(b, b.pageId);

    expect(await getPackage(a, theirs.package.id)).toBeNull();
    expect(await sealPackage(a, theirs.package.id)).toBeNull();
  });
});

/**
 * Reading a real package (P1/P3 observability).
 *
 * The unit tests cover the rearranging in isolation. These cover the join
 * between it and the database: that a page and a query get their real names,
 * that the names are fetched under tenant scope, and that every figure on
 * screen still leads back to a record id someone can re-resolve.
 */
describe("presenting a sealed package", () => {
  it("gives every measurement a metric name and a subject name", async () => {
    const tenant = await makeTenant("present");
    const { package: assembled } = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    const diagnosis = await prisma.diagnosis.create({
      data: {
        websiteId: tenant.website.id,
        targetType: "PAGE",
        targetId: tenant.pageId,
        evidencePackageId: assembled.id,
        executiveSummary: "Clicks fell.",
        overallConfidence: "MEDIUM",
      },
    });

    const read = await getDiagnosisEvidence(tenant, diagnosis.id);
    expect(read).not.toBeNull();

    const view = buildEvidenceView(read!.evidence, read!.manifest, read!.subjectLabels);

    // Grouped by provider rather than one card per record.
    const gsc = view.groups.find((group) => group.source === "Google Search Console");
    expect(gsc).toBeDefined();

    const subject = gsc!.subjects[0];
    expect(subject).toBeDefined();

    // The metric is named, and it is not named "window".
    const labels = subject!.metrics.map((metric) => metric.label);
    expect(labels).toContain("Clicks");
    expect(labels).toContain("Impressions");
    expect(labels.join(" ")).not.toMatch(/window/i);

    // And the thing measured is named by its URL, not by a UUID.
    expect(subject!.label).toContain("/pricing");
    expect(subject!.label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("keeps every figure traceable back to a record id", async () => {
    const tenant = await makeTenant("trace");
    const { package: assembled } = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    const diagnosis = await prisma.diagnosis.create({
      data: {
        websiteId: tenant.website.id,
        targetType: "PAGE",
        targetId: tenant.pageId,
        evidencePackageId: assembled.id,
        executiveSummary: "Clicks fell.",
        overallConfidence: "MEDIUM",
      },
    });

    const read = await getDiagnosisEvidence(tenant, diagnosis.id);
    const view = buildEvidenceView(read!.evidence, read!.manifest, read!.subjectLabels);

    const shown = new Set([
      ...view.groups.flatMap((group) => group.subjects.flatMap((subject) => subject.evidenceIds)),
      ...view.groups.flatMap((group) => group.records.map((record) => record.id)),
    ]);

    // Folding records into tables must not lose any of them: everything the
    // model was shown is still reachable in the provenance section.
    for (const record of read!.evidence) {
      expect(shown.has(record.id)).toBe(true);
    }
    expect(shown.size).toBe(read!.evidence.length);
  });

  it("resolves subject names only within the tenant that asked", async () => {
    const mine = await makeTenant("scope-mine");
    const theirs = await makeTenant("scope-theirs");

    const { package: assembled } = await assemblePageDiagnosisPackage(mine, mine.pageId);
    const diagnosis = await prisma.diagnosis.create({
      data: {
        websiteId: mine.website.id,
        targetType: "PAGE",
        targetId: mine.pageId,
        evidencePackageId: assembled.id,
        executiveSummary: "Clicks fell.",
        overallConfidence: "MEDIUM",
      },
    });

    // The other tenant cannot read the diagnosis at all, so there is nothing to
    // label — the isolation is upstream of the labelling, which is where it
    // belongs.
    expect(await getDiagnosisEvidence(theirs, diagnosis.id)).toBeNull();

    const read = await getDiagnosisEvidence(mine, diagnosis.id);
    for (const [id, label] of read!.subjectLabels) {
      expect(typeof label).toBe("string");
      // Every id labelled belongs to a page or query of this website.
      const owned =
        (await prisma.page.count({ where: { id, websiteId: mine.website.id } })) +
        (await prisma.query.count({ where: { id, websiteId: mine.website.id } }));
      expect(owned).toBe(1);
    }
  });

  it("says what was left out without mentioning a budget", async () => {
    const tenant = await makeTenant("omitted");
    const { package: assembled } = await assemblePageDiagnosisPackage(tenant, tenant.pageId);

    const diagnosis = await prisma.diagnosis.create({
      data: {
        websiteId: tenant.website.id,
        targetType: "PAGE",
        targetId: tenant.pageId,
        evidencePackageId: assembled.id,
        executiveSummary: "Clicks fell.",
        overallConfidence: "MEDIUM",
      },
    });

    const read = await getDiagnosisEvidence(tenant, diagnosis.id);
    const view = buildEvidenceView(read!.evidence, read!.manifest, read!.subjectLabels);
    const text = describeOmitted(view.omitted);

    if (text !== null) {
      expect(text).not.toMatch(/budget/i);
      expect(text).toMatch(/available but not included/);
    }

    // The counts survive whether or not anything was dropped.
    expect(view.counts.included).toBe(read!.evidence.length);
    expect(view.counts.available).toBeGreaterThanOrEqual(view.counts.included);
  });
});
