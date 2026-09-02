import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import {
  ImportError,
  commitImport,
  listImports,
  uploadImport,
  validateImport,
} from "@/server/services/import";

/**
 * The import pipeline end to end.
 *
 * The property under test throughout is that nothing reaches a live table before a
 * person has seen a preview, and that what does reach one is exactly what the file
 * said — no repaired rows, no invented numbers, no other tenant's data.
 */

const organizationIds: string[] = [];
const userIds: string[] = [];

async function makeContext(label: string): Promise<TenantContext> {
  const suffix = crypto.randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { authUserId: crypto.randomUUID(), email: `imp-${label}-${suffix}@example.com` },
  });
  userIds.push(user.id);

  const organization = await prisma.organization.create({
    data: { name: `Import ${label}`, slug: `imp-${label}-${suffix}` },
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

function positionsCsv(host: string): string {
  return [
    "Keyword,Position,Previous position,Search Volume,Keyword Difficulty,CPC,URL,Keyword Intents,Timestamp",
    `payroll software philippines,11,14,2400,43,3.20,https://${host}/payroll-guide/,Commercial,2026-08-30`,
    `hr software,4,4,1900,51,2.10,https://${host}/hr-software/,Commercial,2026-08-30`,
    `what is payroll,28,31,5400,22,0.80,https://${host}/blog/what-is-payroll/,Informational,2026-08-30`,
  ].join("\n");
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

describe("upload and preview", () => {
  it("stages rows without writing anything live", async () => {
    const context = await makeContext("stage");
    const host = context.website.normalizedDomain;

    const upload = await uploadImport(context, {
      fileName: "positions.csv",
      content: positionsCsv(host),
    });

    expect(upload.detected?.source).toBe("SEMRUSH_POSITIONS");
    expect(upload.record.rowCount).toBe(3);
    expect(upload.duplicate).toBe(false);

    // The point of the preview: nothing exists yet.
    expect(await prisma.keyword.count({ where: { websiteId: context.website.id } })).toBe(0);
    expect(await prisma.rankingSnapshot.count({ where: { websiteId: context.website.id } })).toBe(0);

    const preview = await validateImport(context, upload.record.id);

    expect(preview.totals).toMatchObject({ rows: 3, valid: 3, invalid: 0, distinctKeywords: 3 });
    expect(preview.record.status).toBe("PREVIEWED");
    expect(await prisma.keyword.count({ where: { websiteId: context.website.id } })).toBe(0);
  });

  it("lists every invalid row with a reason rather than failing the file", async () => {
    const context = await makeContext("invalid");
    const host = context.website.normalizedDomain;

    const content = [
      "Keyword,Position,Search Volume,URL",
      `payroll software,11,2400,https://${host}/a/`,
      `,4,100,https://${host}/b/`,
      `broken position,0,100,https://${host}/c/`,
      `bad url,7,100,not a url`,
    ].join("\n");

    const upload = await uploadImport(context, { fileName: "mixed.csv", content });
    const preview = await validateImport(context, upload.record.id);

    expect(preview.totals.valid).toBe(1);
    expect(preview.totals.invalid).toBe(3);

    // Every invalid row, not a sample: a person has to see all of what was
    // rejected and why.
    expect(preview.invalid).toHaveLength(3);
    expect(preview.invalid.map((row) => row.reason)).toEqual([
      "keyword_empty",
      "position_out_of_range",
      "url_invalid",
    ]);

    const stored = await prisma.importRow.findMany({
      where: { importId: upload.record.id, isValid: false },
    });
    expect(stored).toHaveLength(3);
  });

  it("treats the same file twice as the same import", async () => {
    const context = await makeContext("dupe");
    const content = positionsCsv(context.website.normalizedDomain);

    const first = await uploadImport(context, { fileName: "positions.csv", content });
    const second = await uploadImport(context, { fileName: "positions-copy.csv", content });

    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(await listImports(context)).toHaveLength(1);
    expect(await prisma.importRow.count({ where: { importId: first.record.id } })).toBe(3);
  });

  it("refuses a file that is not a keyword export", async () => {
    const context = await makeContext("shape");

    await expect(
      uploadImport(context, {
        fileName: "analytics.csv",
        content: "Date,Sessions,Users\n2026-08-30,120,90\n",
      }),
    ).rejects.toBeInstanceOf(ImportError);
  });

  it("refuses a file by extension", async () => {
    const context = await makeContext("ext");

    await expect(
      uploadImport(context, { fileName: "payload.xlsx", content: "Keyword\npayroll\n" }),
    ).rejects.toBeInstanceOf(ImportError);
  });
});

describe("commit", () => {
  it("writes keywords, metrics and rankings", async () => {
    const context = await makeContext("commit");
    const host = context.website.normalizedDomain;

    // One of the three URLs is already in the Page inventory.
    await prisma.page.create({
      data: {
        websiteId: context.website.id,
        url: `https://${host}/hr-software/`,
        normalizedUrl: `https://${host}/hr-software`,
        path: "/hr-software",
        hostname: host,
        protocol: "https",
        sourceFirstSeen: "GOOGLE_SEARCH_CONSOLE",
      },
    });

    const upload = await uploadImport(context, {
      fileName: "positions.csv",
      content: positionsCsv(host),
    });
    await validateImport(context, upload.record.id);
    const result = await commitImport(context, upload.record.id);

    expect(result.record.status).toBe("COMMITTED");
    expect(result.keywordsCreated).toBe(3);
    expect(result.metricsWritten).toBe(3);
    expect(result.rankingsWritten).toBe(3);

    const keyword = await prisma.keyword.findFirstOrThrow({
      where: { websiteId: context.website.id, normalizedKeyword: "payroll software philippines" },
    });
    expect(keyword.intent).toBe("COMMERCIAL");
    expect(keyword.intentProvenance).toBe("PROVIDER_PROVIDED");
    expect(keyword.locale).toBe("en-PH");

    const metrics = await prisma.keywordMetricsSnapshot.findFirstOrThrow({
      where: { keywordId: keyword.id },
    });
    expect(metrics.searchVolume).toBe(2400);
    expect(metrics.sourceProvider).toBe("SEMRUSH");
    expect(metrics.capturedAt.toISOString().slice(0, 10)).toBe("2026-08-30");

    const rankings = await prisma.rankingSnapshot.findMany({
      where: { websiteId: context.website.id },
      orderBy: { position: "asc" },
    });

    // The known page resolves; the two unknown URLs are retained raw rather than
    // inventing Pages, because a ranking URL is a third party's claim about what
    // Google showed, not our inventory.
    expect(rankings.filter((row) => row.pageId !== null)).toHaveLength(1);
    expect(rankings.filter((row) => row.pageId === null)).toHaveLength(2);
    expect(rankings.every((row) => row.rankingUrl !== null)).toBe(true);

    // No Pages were created by the import.
    expect(await prisma.page.count({ where: { websiteId: context.website.id } })).toBe(1);
  });

  it("committing the same period twice updates rather than duplicates", async () => {
    const context = await makeContext("recommit");
    const host = context.website.normalizedDomain;

    const upload = await uploadImport(context, {
      fileName: "positions.csv",
      content: positionsCsv(host),
    });
    await validateImport(context, upload.record.id);
    await commitImport(context, upload.record.id);

    const before = await prisma.rankingSnapshot.count({
      where: { websiteId: context.website.id },
    });

    // A retry after a partial failure looks exactly like this.
    await prisma.import.update({
      where: { id: upload.record.id },
      data: { status: "PREVIEWED" },
    });
    const second = await commitImport(context, upload.record.id);

    expect(second.keywordsCreated).toBe(0);
    expect(await prisma.rankingSnapshot.count({ where: { websiteId: context.website.id } })).toBe(
      before,
    );
    expect(await prisma.keyword.count({ where: { websiteId: context.website.id } })).toBe(3);
  });

  it("refuses to commit an already committed import", async () => {
    const context = await makeContext("twice");
    const upload = await uploadImport(context, {
      fileName: "positions.csv",
      content: positionsCsv(context.website.normalizedDomain),
    });
    await validateImport(context, upload.record.id);
    await commitImport(context, upload.record.id);

    await expect(commitImport(context, upload.record.id)).rejects.toBeInstanceOf(ImportError);
  });

  it("stores a formula payload as inert text", async () => {
    const context = await makeContext("formula");

    const upload = await uploadImport(context, {
      fileName: "payload.csv",
      content: 'Keyword,Position\n"=cmd|\'/c calc\'!A1",5\n',
      source: "SEMRUSH_POSITIONS",
    });
    await validateImport(context, upload.record.id);
    await commitImport(context, upload.record.id);

    const keyword = await prisma.keyword.findFirstOrThrow({
      where: { websiteId: context.website.id },
    });

    // Stored exactly as the file said — nothing evaluated it, and nothing
    // silently rewrote it either.
    expect(keyword.keyword).toBe("=cmd|'/c calc'!A1");
  });

  it("creates keywords but no provider metrics from a hand-written list", async () => {
    const context = await makeContext("manual");

    const upload = await uploadImport(context, {
      fileName: "list.csv",
      content: "Keyword\npayroll software\nhr software\n",
    });

    expect(upload.detected?.source).toBe("MANUAL_CSV");

    await validateImport(context, upload.record.id);
    const result = await commitImport(context, upload.record.id);

    expect(result.keywordsCreated).toBe(2);
    // There is no provider value that honestly describes a CSV somebody typed,
    // so the metrics wait for a source that can be named.
    expect(result.metricsWritten).toBe(0);
    expect(result.rankingsWritten).toBe(0);
  });

  it("only accepts competitor rows for competitors somebody added", async () => {
    const context = await makeContext("competitor");

    const competitor = await prisma.competitor.create({
      data: {
        websiteId: context.website.id,
        name: "Rival",
        domain: "rival.example.com",
        normalizedDomain: "rival.example.com",
      },
    });

    const content = [
      "Keyword,Position,URL,Domain",
      "payroll software,3,https://rival.example.com/payroll/,rival.example.com",
      "payroll software,5,https://stranger.example.net/payroll/,stranger.example.net",
    ].join("\n");

    const upload = await uploadImport(context, {
      fileName: "competitors.csv",
      content,
      source: "SEMRUSH_COMPETITORS",
    });
    expect(upload.detected?.source).toBe("SEMRUSH_COMPETITORS");

    await validateImport(context, upload.record.id);
    const result = await commitImport(context, upload.record.id);

    expect(result.competitorRowsWritten).toBe(1);
    // Competitors are a deliberate P0 list, not something an import adds to.
    expect(result.skipped).toBe(1);

    const snapshot = await prisma.competitorKeywordSnapshot.findFirstOrThrow({
      where: { websiteId: context.website.id },
    });
    expect(snapshot.competitorId).toBe(competitor.id);
    expect(await prisma.competitor.count({ where: { websiteId: context.website.id } })).toBe(1);
  });
});

/**
 * Import targeting. The website an import writes to comes from the resolved tenant
 * context and nothing else — not the form, not the file.
 */
describe("an import cannot be aimed at another tenant", () => {
  it("refuses to preview or commit another tenant's import", async () => {
    const attacker = await makeContext("attacker");
    const victim = await makeContext("victim");

    const upload = await uploadImport(victim, {
      fileName: "positions.csv",
      content: positionsCsv(victim.website.normalizedDomain),
    });

    // The id is valid and exists. It just is not theirs.
    await expect(validateImport(attacker, upload.record.id)).rejects.toBeInstanceOf(ImportError);
    await expect(commitImport(attacker, upload.record.id)).rejects.toBeInstanceOf(ImportError);

    expect(await listImports(attacker)).toHaveLength(0);
    expect(await prisma.importRow.count({ where: { importId: upload.record.id } })).toBe(3);
  });

  it("writes committed rows only to the uploading tenant's website", async () => {
    const one = await makeContext("one");
    const two = await makeContext("two");

    const upload = await uploadImport(one, {
      fileName: "positions.csv",
      content: positionsCsv(one.website.normalizedDomain),
    });
    await validateImport(one, upload.record.id);
    await commitImport(one, upload.record.id);

    expect(await prisma.keyword.count({ where: { websiteId: two.website.id } })).toBe(0);
    expect(await prisma.keyword.count({ where: { websiteId: one.website.id } })).toBe(3);
  });

  it("lets two tenants import the identical file independently", async () => {
    // Checksum identity is scoped to the website: the same Semrush export used by
    // two customers must not collide.
    const one = await makeContext("shared-one");
    const two = await makeContext("shared-two");
    const content = "Keyword,Position,Search Volume\npayroll software,4,2400\n";

    const first = await uploadImport(one, { fileName: "same.csv", content });
    const second = await uploadImport(two, { fileName: "same.csv", content });

    expect(second.duplicate).toBe(false);
    expect(second.record.id).not.toBe(first.record.id);
  });
});

/**
 * Two providers, kept apart end to end.
 *
 * The failure that matters is not a rejected file — it is one vendor's numbers
 * quietly filed as the other's, which corrupts the data rather than refusing it.
 */
describe("Semrush and Ahrefs", () => {
  it("refuses a file whose vendor it cannot identify", async () => {
    const context = await makeContext("novendor");

    // Volume and difficulty, but nothing naming who measured them.
    await expect(
      uploadImport(context, {
        fileName: "unknown.csv",
        content: "Keyword,Volume,KD\npayroll software,2400,43\n",
      }),
    ).rejects.toBeInstanceOf(ImportError);

    // And nothing was staged: refusing means refusing.
    expect(await listImports(context)).toHaveLength(0);
  });

  it("imports the same numbers under the vendor that supplied them", async () => {
    const context = await makeContext("ahrefs");
    const host = context.website.normalizedDomain;

    const upload = await uploadImport(context, {
      fileName: "ahrefs.csv",
      content: [
        "Keyword,Current position,Previous position,Volume,KD,CPC,Current URL,Last Update",
        `payroll software philippines,9,12,2400,38,3.10,https://${host}/payroll/,2026-08-30`,
      ].join("\n"),
    });

    expect(upload.detected?.source).toBe("AHREFS_POSITIONS");

    await validateImport(context, upload.record.id);
    await commitImport(context, upload.record.id);

    const metrics = await prisma.keywordMetricsSnapshot.findFirstOrThrow({
      where: { websiteId: context.website.id },
    });
    const ranking = await prisma.rankingSnapshot.findFirstOrThrow({
      where: { websiteId: context.website.id },
    });

    expect(metrics.sourceProvider).toBe("AHREFS");
    expect(ranking.sourceProvider).toBe("AHREFS");
    // 38 here is an Ahrefs KD. Stored with its provider so nothing ever compares
    // it to a Semrush 38, which is a different measurement wearing the same label.
    expect(Number(metrics.keywordDifficulty)).toBe(38);
  });

  it("keeps both vendors' readings of one keyword side by side", async () => {
    const context = await makeContext("both");
    const host = context.website.normalizedDomain;

    await uploadImport(context, {
      fileName: "semrush.csv",
      content: [
        "Keyword,Position,Search Volume,Keyword Difficulty,URL,Timestamp",
        `payroll software,4,2400,51,https://${host}/payroll/,2026-08-30`,
      ].join("\n"),
    }).then(async (upload) => {
      await validateImport(context, upload.record.id);
      await commitImport(context, upload.record.id);
    });

    await uploadImport(context, {
      fileName: "ahrefs.csv",
      content: [
        "Keyword,Current position,Volume,KD,Current URL,Last Update",
        `payroll software,5,1900,38,https://${host}/payroll/,2026-08-30`,
      ].join("\n"),
    }).then(async (upload) => {
      await validateImport(context, upload.record.id);
      await commitImport(context, upload.record.id);
    });

    // One keyword — identity does not depend on who reported it.
    expect(await prisma.keyword.count({ where: { websiteId: context.website.id } })).toBe(1);

    // Two readings of the same day, neither overwriting the other, because the
    // snapshot key includes the provider. They disagree, and that disagreement is
    // a fact worth keeping rather than a conflict to resolve.
    const metrics = await prisma.keywordMetricsSnapshot.findMany({
      where: { websiteId: context.website.id },
      orderBy: { sourceProvider: "asc" },
    });

    expect(metrics).toHaveLength(2);
    expect(metrics.map((row) => row.sourceProvider)).toEqual(["SEMRUSH", "AHREFS"]);
    expect(metrics.map((row) => row.searchVolume)).toEqual([2400, 1900]);
  });
});
