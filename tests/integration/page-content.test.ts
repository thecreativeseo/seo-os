import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  PageContentCaptureError,
  capturePageContent,
  latestSnapshot,
  snapshotById,
  snapshotHistory,
} from "@/server/services/page-content";

/**
 * Page content capture (docs/P3_SPEC.md §28).
 *
 * Two properties matter beyond the extraction itself, and neither can be proved
 * without a database: an unchanged page must not become a second snapshot, and a
 * snapshot must not be reachable from another tenant. The fetch path is not
 * exercised here — its guard is unit-tested, and a test that makes real outbound
 * requests would depend on somebody else's server staying up.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `pc-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Content ${label}`, slug: `pc-${label}-${suffix}` },
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

async function makePage(context: TenantContext, path: string) {
  const host = context.website.normalizedDomain;

  return prisma.page.create({
    data: {
      websiteId: context.website.id,
      url: `https://${host}${path}`,
      normalizedUrl: `https://${host}${path}`,
      path,
      hostname: host,
      protocol: "https",
      sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
    },
  });
}

const HTML = `<html><head><title>Wholesale coffee</title>
<meta name="description" content="Beans for cafes."></head>
<body><h1>Wholesale coffee</h1><p>We supply cafes across the country.</p></body></html>`;

afterAll(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("capturing content", () => {
  it("stores the extracted parts and reports the capture as new", async () => {
    const context = await makeContext("store");
    const page = await makePage(context, "/wholesale");

    const result = await capturePageContent(context, {
      pageId: page.id,
      content: HTML,
      source: "MANUAL_PASTE",
    });

    expect(result.changed).toBe(true);
    expect(result.snapshot.title).toBe("Wholesale coffee");
    expect(result.snapshot.metaDescription).toBe("Beans for cafes.");
    expect(result.snapshot.bodyText).toContain("We supply cafes");
    expect(result.snapshot.source).toBe("MANUAL_PASTE");
    expect(result.snapshot.capturedByUserId).toBe(context.user.id);
  });

  it("does not create a second snapshot for unchanged content", async () => {
    // A row per attempt would read as a page that kept changing, which is a
    // fabricated fact.
    const context = await makeContext("same");
    const page = await makePage(context, "/same");

    const first = await capturePageContent(context, {
      pageId: page.id,
      content: HTML,
      source: "MANUAL_PASTE",
    });
    const second = await capturePageContent(context, {
      pageId: page.id,
      content: HTML,
      source: "MANUAL_PASTE",
    });

    expect(second.changed).toBe(false);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(await snapshotHistory(context, page.id)).toHaveLength(1);
  });

  it("creates a new snapshot when the content changes", async () => {
    const context = await makeContext("changed");
    const page = await makePage(context, "/changed");

    await capturePageContent(context, {
      pageId: page.id,
      content: HTML,
      source: "MANUAL_PASTE",
    });
    const edited = await capturePageContent(context, {
      pageId: page.id,
      content: HTML.replace("cafes across the country", "cafes across the region"),
      source: "MANUAL_PASTE",
    });

    expect(edited.changed).toBe(true);

    const history = await snapshotHistory(context, page.id);
    expect(history).toHaveLength(2);
    expect((await latestSnapshot(context, page.id))?.id).toBe(edited.snapshot.id);
  });

  it("refuses content with no readable text", async () => {
    const context = await makeContext("empty");
    const page = await makePage(context, "/empty");

    await expect(
      capturePageContent(context, {
        pageId: page.id,
        content: "<script>var a = 1;</script>",
        source: "MANUAL_PASTE",
      }),
    ).rejects.toBeInstanceOf(PageContentCaptureError);
  });

  it("records an audit event without copying the page body into it", async () => {
    const context = await makeContext("audit");
    const page = await makePage(context, "/audit");

    const result = await capturePageContent(context, {
      pageId: page.id,
      content: HTML,
      source: "MANUAL_PASTE",
    });

    const event = await prisma.auditEvent.findFirst({
      where: { entityType: "PageContentSnapshot", entityId: result.snapshot.id },
    });

    expect(event).not.toBeNull();
    expect(event?.actorUserId).toBe(context.user.id);
    expect(JSON.stringify(event?.afterSnapshotJson)).not.toContain("We supply cafes");
  });
});

describe("tenant isolation", () => {
  it("refuses to capture against another tenant's page", async () => {
    const a = await makeContext("iso-a");
    const b = await makeContext("iso-b");
    const theirPage = await makePage(b, "/theirs");

    await expect(
      capturePageContent(a, {
        pageId: theirPage.id,
        content: HTML,
        source: "MANUAL_PASTE",
      }),
    ).rejects.toBeInstanceOf(PageContentCaptureError);

    expect(await prisma.pageContentSnapshot.count({ where: { pageId: theirPage.id } })).toBe(0);
  });

  it("does not resolve another tenant's snapshot by id", async () => {
    const a = await makeContext("iso-c");
    const b = await makeContext("iso-d");
    const theirPage = await makePage(b, "/theirs");

    const theirs = await capturePageContent(b, {
      pageId: theirPage.id,
      content: HTML,
      source: "MANUAL_PASTE",
    });

    // The id is a string a caller supplies. Re-resolving under tenant scope is
    // the whole reason evidence is not dereferenced directly.
    expect(await snapshotById(a, theirs.snapshot.id)).toBeNull();
    expect(await snapshotById(b, theirs.snapshot.id)).not.toBeNull();
  });

  it("does not list another tenant's snapshots", async () => {
    const a = await makeContext("iso-e");
    const b = await makeContext("iso-f");
    const theirPage = await makePage(b, "/theirs");

    await capturePageContent(b, {
      pageId: theirPage.id,
      content: HTML,
      source: "MANUAL_PASTE",
    });

    expect(await snapshotHistory(a, theirPage.id)).toHaveLength(0);
    expect(await latestSnapshot(a, theirPage.id)).toBeNull();
  });
});
