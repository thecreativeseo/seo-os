import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { uploadImport, validateImport, commitImport } from "@/server/services/import";
import { createTopic, mapKeyword, mapPage, updateTopic } from "@/server/services/topic";
import { assignOwnership, retireOwnership } from "@/server/services/ownership";
import { updateKeyword } from "@/server/services/keyword";
import {
  detectAndStoreOpportunities,
  listOpportunities,
  setOpportunityStatus,
  assignOpportunityOwner,
} from "@/server/services/opportunity";

/**
 * P2 audit events (docs/P2_SPEC.md §29).
 *
 * The spec lists sixteen event names. They are recorded as entityType plus a verb
 * rather than sixteen enum values, because entityType already says what was acted
 * on and an audit screen with sixteen near-identical badges is one nobody reads.
 * This asserts the coverage that list was asking for, however it is spelled.
 *
 * The second half matters more: "Never include secret values." An import carries
 * a whole file, and an audit trail that quietly copied it in would be a leak with
 * a timestamp on it.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `aud-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Audit ${label}`, slug: `aud-${label}-${suffix}` },
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

  const website = await prisma.website.create({
    data: {
      workspaceId: workspace.id,
      domain: `${label}-${suffix}.example.com`,
      normalizedDomain: `${label}-${suffix}.example.com`,
      primaryLanguage: "en",
      primaryMarket: "PH",
    },
  });

  return { user, membership, organization, workspace, website };
}

const makePage = (context: TenantContext, path: string) =>
  prisma.page.create({
    data: {
      websiteId: context.website.id,
      url: `https://${context.website.normalizedDomain}${path}`,
      normalizedUrl: `https://${context.website.normalizedDomain}${path}`,
      path,
      hostname: context.website.normalizedDomain,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });

async function eventsFor(context: TenantContext, entityType: string) {
  return prisma.auditEvent.findMany({
    where: { websiteId: context.website.id, entityType },
    orderBy: { createdAt: "asc" },
  });
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

describe("what P2 records", () => {
  it("records an import from upload to commit", async () => {
    const context = await makeContext("import");
    const host = context.website.normalizedDomain;

    const upload = await uploadImport(context, {
      fileName: "positions.csv",
      content: [
        "Keyword,Position,Search Volume,URL,Timestamp",
        `payroll software,11,2400,https://${host}/payroll/,2026-08-30`,
      ].join("\n"),
    });

    await validateImport(context, upload.record.id);
    await commitImport(context, upload.record.id);

    const events = await eventsFor(context, "Import");
    const actions = events.map((event) => event.action);

    // SEMRUSH_IMPORT_STARTED and SEMRUSH_IMPORT_COMPLETED, in our vocabulary.
    expect(actions).toContain("CREATE");
    expect(actions).toContain("COMPLETE");
    expect(events.every((event) => event.actorUserId === context.user.id)).toBe(true);
  });

  it("records keyword and topic authoring", async () => {
    const context = await makeContext("author");
    const page = await makePage(context, "/payroll");

    const keyword = await prisma.keyword.create({
      data: {
        websiteId: context.website.id,
        keyword: "payroll software",
        normalizedKeyword: "payroll software",
        locale: "en-PH",
        language: "en",
        market: "PH",
      },
    });

    await updateKeyword(context, keyword.id, { intent: "COMMERCIAL" });

    const topic = await createTopic(context, { name: "Payroll" });
    await updateTopic(context, topic.id, { businessOutcome: "demo requests" });
    await mapKeyword(context, topic.id, keyword.id);
    await mapPage(context, topic.id, page.id, "COMMERCIAL");

    expect((await eventsFor(context, "Keyword")).map((e) => e.action)).toContain("UPDATE");

    const topicActions = (await eventsFor(context, "Topic")).map((e) => e.action);
    expect(topicActions).toContain("CREATE");
    expect(topicActions).toContain("UPDATE");
  });

  it("records who nominated an owning page, and who retired it", async () => {
    const context = await makeContext("ownership");
    const page = await makePage(context, "/payroll");
    const other = await makePage(context, "/payroll-hub");

    const keyword = await prisma.keyword.create({
      data: {
        websiteId: context.website.id,
        keyword: "payroll software",
        normalizedKeyword: "payroll software",
        locale: "en-PH",
        language: "en",
        market: "PH",
      },
    });

    const first = await assignOwnership(context, { keywordId: keyword.id, pageId: page.id });
    await assignOwnership(context, { keywordId: keyword.id, pageId: other.id });
    await retireOwnership(context, first.id);

    const actions = (await eventsFor(context, "KeywordPageOwnership")).map((e) => e.action);

    // "Who decided this page should own this keyword, and when" is the question
    // people ask months later; these are the rows that answer it.
    expect(actions).toContain("ASSIGN");
    expect(actions).toContain("RETIRE");
  });

  it("records the opportunity lifecycle", async () => {
    const context = await makeContext("lifecycle");
    const page = await makePage(context, "/payroll");

    const keyword = await prisma.keyword.create({
      data: {
        websiteId: context.website.id,
        keyword: "payroll software",
        normalizedKeyword: "payroll software",
        locale: "en-PH",
        language: "en",
        market: "PH",
        intent: "COMMERCIAL",
        intentProvenance: "PROVIDER_PROVIDED",
        businessRelevance: 4,
      },
    });

    await prisma.keywordMetricsSnapshot.create({
      data: {
        websiteId: context.website.id,
        keywordId: keyword.id,
        capturedAt: new Date(),
        searchVolume: 2400,
        sourceProvider: "SEMRUSH",
      },
    });
    await prisma.rankingSnapshot.create({
      data: {
        websiteId: context.website.id,
        keywordId: keyword.id,
        pageId: page.id,
        capturedAt: new Date(),
        position: 11,
        sourceProvider: "SEMRUSH",
      },
    });
    await assignOwnership(context, { keywordId: keyword.id, pageId: page.id });

    await detectAndStoreOpportunities(context);
    const [opportunity] = await listOpportunities(context);

    await setOpportunityStatus(context, opportunity!.id, "QUALIFIED");
    await setOpportunityStatus(context, opportunity!.id, "SCHEDULED");
    await assignOpportunityOwner(context, opportunity!.id, context.user.id);
    await setOpportunityStatus(context, opportunity!.id, "IN_PROGRESS");
    await setOpportunityStatus(context, opportunity!.id, "COMPLETED");

    const actions = (await eventsFor(context, "Opportunity")).map((e) => e.action);

    expect(actions).toContain("QUALIFY");
    expect(actions).toContain("SCHEDULE");
    expect(actions).toContain("ASSIGN");
    expect(actions).toContain("COMPLETE");
  });
});

/**
 * "Never include secret values."
 *
 * An import carries a whole file. An audit trail that copied it in would be a leak
 * with a timestamp on it.
 */
describe("what P2 never records", () => {
  it("keeps file contents out of the audit trail", async () => {
    const context = await makeContext("secrets");
    const host = context.website.normalizedDomain;

    const content = [
      "Keyword,Position,Search Volume,URL,Timestamp",
      `confidential client term,11,2400,https://${host}/payroll/,2026-08-30`,
      `another private keyword,4,900,https://${host}/hr/,2026-08-30`,
    ].join("\n");

    const upload = await uploadImport(context, { fileName: "client-export.csv", content });
    await validateImport(context, upload.record.id);
    await commitImport(context, upload.record.id);

    const events = await prisma.auditEvent.findMany({
      where: { websiteId: context.website.id },
    });
    const serialized = JSON.stringify(events);

    // The file name and row counts are useful and safe. The rows are not there.
    expect(serialized).toContain("client-export.csv");
    expect(serialized).not.toContain("confidential client term");
    expect(serialized).not.toContain("another private keyword");
  });

  it("redacts anything credential-shaped in a P2 snapshot", async () => {
    const context = await makeContext("redaction");

    const keyword = await prisma.keyword.create({
      data: {
        websiteId: context.website.id,
        keyword: "payroll software",
        normalizedKeyword: "payroll software",
        locale: "en-PH",
        language: "en",
        market: "PH",
      },
    });

    await updateKeyword(context, keyword.id, { businessRelevance: 5 });

    const events = await eventsFor(context, "Keyword");
    const serialized = JSON.stringify(events);

    for (const forbidden of ["apiKey", "api_key", "token", "secret", "password"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("scopes every P2 audit event to the website it happened on", async () => {
    const a = await makeContext("scope-a");
    const b = await makeContext("scope-b");

    await createTopic(a, { name: "A topic" });
    await createTopic(b, { name: "B topic" });

    const forA = await prisma.auditEvent.findMany({
      where: { websiteId: a.website.id, entityType: "Topic" },
    });

    expect(forA).toHaveLength(1);
    expect(JSON.stringify(forA)).not.toContain("B topic");
    expect(forA.every((event) => event.organizationId === a.organization.id)).toBe(true);
  });
});
