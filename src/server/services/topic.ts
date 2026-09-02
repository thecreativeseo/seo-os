import type {
  Topic,
  TopicAuthority,
  TopicCoverage,
  TopicPageRole,
} from "@/generated/prisma/client";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { computeCoverage, type CoverageResult } from "@/lib/topic/coverage";

/**
 * Topics (docs/P2_SPEC.md §14, §15, §24).
 *
 * Topics are authored, never inferred. P2 has no clustering algorithm and should
 * not pretend to one: a cluster that is 80% right produces a topic map nobody
 * trusts and everybody re-checks by hand, which is worse than no map at all.
 *
 * What makes a topic more than a keyword bucket is the two fields nothing can
 * derive — the words a customer actually uses, and what the business gets when it
 * wins the subject.
 */

export type TopicErrorCode =
  | "not_found"
  | "duplicate_slug"
  | "invalid_name"
  | "cyclic_parent"
  | "page_not_found"
  | "keyword_not_found";

export class TopicError extends Error {
  constructor(
    message: string,
    readonly code: TopicErrorCode,
  ) {
    super(message);
    this.name = "TopicError";
  }
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export type TopicSummary = Topic & {
  keywordCount: number;
  pageCount: number;
  coverage: CoverageResult;
  pillarPath: string | null;
  commercialPath: string | null;
  childCount: number;
};

async function summarise(context: TenantContext, topics: Topic[]): Promise<TopicSummary[]> {
  if (topics.length === 0) return [];

  const ids = topics.map((topic) => topic.id);

  const [keywordCounts, pages, childCounts, referencedPages] = await Promise.all([
    prisma.topicKeyword.groupBy({
      by: ["topicId"],
      where: { topicId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.topicPage.findMany({
      where: { topicId: { in: ids } },
      select: { topicId: true, pageId: true, role: true },
    }),
    prisma.topic.groupBy({
      by: ["parentTopicId"],
      where: { parentTopicId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.page.findMany({
      where: {
        websiteId: context.website.id,
        id: {
          in: topics
            .flatMap((topic) => [topic.pillarPageId, topic.commercialDestinationPageId])
            .filter((id): id is string => id !== null),
        },
      },
      select: { id: true, path: true },
    }),
  ]);

  const keywordsByTopic = new Map(
    keywordCounts.map((row) => [row.topicId, row._count._all]),
  );
  const childrenByTopic = new Map(
    childCounts.map((row) => [row.parentTopicId!, row._count._all]),
  );
  const pathById = new Map(referencedPages.map((page) => [page.id, page.path]));

  const pagesByTopic = new Map<string, { pageId: string; role: TopicPageRole }[]>();
  for (const row of pages) {
    const list = pagesByTopic.get(row.topicId) ?? [];
    list.push({ pageId: row.pageId, role: row.role });
    pagesByTopic.set(row.topicId, list);
  }

  return topics.map((topic) => {
    const topicPages = pagesByTopic.get(topic.id) ?? [];
    const keywordCount = keywordsByTopic.get(topic.id) ?? 0;

    return {
      ...topic,
      keywordCount,
      pageCount: topicPages.length,
      // A person's override wins over the computed status, and the stored
      // provenance is what lets the screen say which is being shown.
      coverage:
        topic.coverageSource === "USER_PROVIDED"
          ? {
              status: topic.coverageStatus,
              reason: "Set by your team.",
              keywordsPerPage:
                topicPages.length === 0 ? null : keywordCount / topicPages.length,
            }
          : computeCoverage({ keywordCount, pages: topicPages }),
      pillarPath: topic.pillarPageId ? (pathById.get(topic.pillarPageId) ?? null) : null,
      commercialPath: topic.commercialDestinationPageId
        ? (pathById.get(topic.commercialDestinationPageId) ?? null)
        : null,
      childCount: childrenByTopic.get(topic.id) ?? 0,
    };
  });
}

export async function listTopics(context: TenantContext): Promise<TopicSummary[]> {
  const topics = await prisma.topic.findMany({
    where: { ...websiteScope(context), status: "ACTIVE" },
    orderBy: [{ priority: "desc" }, { name: "asc" }],
  });

  return summarise(context, topics);
}

export async function getTopic(
  context: TenantContext,
  topicId: string,
): Promise<TopicSummary | null> {
  const topic = await prisma.topic.findFirst({
    where: { id: topicId, ...websiteScope(context) },
  });

  if (!topic) return null;

  const [summary] = await summarise(context, [topic]);
  return summary ?? null;
}

export type TopicInput = {
  name: string;
  description?: string | null;
  customerLanguage?: string | null;
  businessOutcome?: string | null;
  parentTopicId?: string | null;
  pillarPageId?: string | null;
  commercialDestinationPageId?: string | null;
  priority?: number | null;
  authorityStatus?: TopicAuthority;
};

async function assertPageBelongs(
  context: TenantContext,
  pageId: string | null | undefined,
): Promise<void> {
  if (!pageId) return;

  const page = await prisma.page.findFirst({
    where: { id: pageId, ...websiteScope(context) },
    select: { id: true },
  });

  if (!page) {
    throw new TopicError("That page is not available.", "page_not_found");
  }
}

export async function createTopic(
  context: TenantContext,
  input: TopicInput,
): Promise<Topic> {
  const name = input.name.trim();

  if (name.length === 0) {
    throw new TopicError("Give the topic a name.", "invalid_name");
  }

  const slug = slugify(name);

  if (slug.length === 0) {
    throw new TopicError("That name cannot be turned into a slug.", "invalid_name");
  }

  const clash = await prisma.topic.findFirst({
    where: { websiteId: context.website.id, slug },
  });

  if (clash) {
    throw new TopicError("A topic with that name already exists.", "duplicate_slug");
  }

  await Promise.all([
    assertPageBelongs(context, input.pillarPageId),
    assertPageBelongs(context, input.commercialDestinationPageId),
  ]);

  if (input.parentTopicId) {
    const parent = await prisma.topic.findFirst({
      where: { id: input.parentTopicId, ...websiteScope(context) },
    });

    if (!parent) throw new TopicError("That parent topic is not available.", "not_found");
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.topic.create({
      data: {
        websiteId: context.website.id,
        name,
        slug,
        description: input.description ?? null,
        customerLanguage: input.customerLanguage ?? null,
        businessOutcome: input.businessOutcome ?? null,
        parentTopicId: input.parentTopicId ?? null,
        pillarPageId: input.pillarPageId ?? null,
        commercialDestinationPageId: input.commercialDestinationPageId ?? null,
        priority: input.priority ?? null,
        authorityStatus: input.authorityStatus ?? "UNKNOWN",
      },
    });

    await recordAudit(tx, context, {
      entityType: "Topic",
      entityId: created.id,
      action: "CREATE",
      after: { name: created.name, slug: created.slug },
    });

    return created;
  });
}

export type TopicPatch = Partial<TopicInput> & {
  /** Setting this by hand marks the status as a person's judgement. */
  coverageStatus?: TopicCoverage;
};

export async function updateTopic(
  context: TenantContext,
  topicId: string,
  patch: TopicPatch,
): Promise<Topic> {
  const existing = await prisma.topic.findFirst({
    where: { id: topicId, ...websiteScope(context) },
  });

  if (!existing) throw new TopicError("That topic is not available.", "not_found");

  await Promise.all([
    assertPageBelongs(context, patch.pillarPageId),
    assertPageBelongs(context, patch.commercialDestinationPageId),
  ]);

  if (patch.parentTopicId !== undefined && patch.parentTopicId !== null) {
    if (patch.parentTopicId === topicId) {
      throw new TopicError("A topic cannot be its own parent.", "cyclic_parent");
    }

    await assertNoCycle(context, topicId, patch.parentTopicId);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.topic.update({
      where: { id: existing.id },
      data: {
        ...(patch.name !== undefined
          ? { name: patch.name.trim(), slug: slugify(patch.name) }
          : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.customerLanguage !== undefined
          ? { customerLanguage: patch.customerLanguage }
          : {}),
        ...(patch.businessOutcome !== undefined
          ? { businessOutcome: patch.businessOutcome }
          : {}),
        ...(patch.parentTopicId !== undefined ? { parentTopicId: patch.parentTopicId } : {}),
        ...(patch.pillarPageId !== undefined ? { pillarPageId: patch.pillarPageId } : {}),
        ...(patch.commercialDestinationPageId !== undefined
          ? { commercialDestinationPageId: patch.commercialDestinationPageId }
          : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.authorityStatus !== undefined
          ? { authorityStatus: patch.authorityStatus }
          : {}),
        ...(patch.coverageStatus !== undefined
          ? { coverageStatus: patch.coverageStatus, coverageSource: "USER_PROVIDED" }
          : {}),
      },
    });

    await recordAudit(tx, context, {
      entityType: "Topic",
      entityId: updated.id,
      action: "UPDATE",
      before: { name: existing.name, coverageStatus: existing.coverageStatus },
      after: { name: updated.name, coverageStatus: updated.coverageStatus },
    });

    return updated;
  });
}

/**
 * Walks up the proposed parent chain looking for this topic.
 *
 * A cycle would make the hierarchy infinite and every traversal a hang. Cheap to
 * check on write, impossible to recover from on read.
 */
async function assertNoCycle(
  context: TenantContext,
  topicId: string,
  proposedParentId: string,
): Promise<void> {
  let cursor: string | null = proposedParentId;
  let guard = 0;

  while (cursor && guard < 50) {
    if (cursor === topicId) {
      throw new TopicError("That would make the topic its own ancestor.", "cyclic_parent");
    }

    const parent: { parentTopicId: string | null } | null = await prisma.topic.findFirst({
      where: { id: cursor, ...websiteScope(context) },
      select: { parentTopicId: true },
    });

    cursor = parent?.parentTopicId ?? null;
    guard += 1;
  }
}

/** Recomputes and stores coverage from the current mapping. */
export async function recomputeCoverage(
  context: TenantContext,
  topicId: string,
): Promise<CoverageResult> {
  const topic = await prisma.topic.findFirst({
    where: { id: topicId, ...websiteScope(context) },
  });

  if (!topic) throw new TopicError("That topic is not available.", "not_found");

  const [keywordCount, pages] = await Promise.all([
    prisma.topicKeyword.count({ where: { topicId } }),
    prisma.topicPage.findMany({
      where: { topicId },
      select: { pageId: true, role: true },
    }),
  ]);

  const coverage = computeCoverage({ keywordCount, pages });

  await prisma.topic.update({
    where: { id: topic.id },
    data: { coverageStatus: coverage.status, coverageSource: "SYSTEM_DERIVED" },
  });

  return coverage;
}

export async function mapKeyword(
  context: TenantContext,
  topicId: string,
  keywordId: string,
): Promise<void> {
  const [topic, keyword] = await Promise.all([
    prisma.topic.findFirst({ where: { id: topicId, ...websiteScope(context) } }),
    prisma.keyword.findFirst({ where: { id: keywordId, ...websiteScope(context) } }),
  ]);

  if (!topic) throw new TopicError("That topic is not available.", "not_found");
  if (!keyword) throw new TopicError("That keyword is not available.", "keyword_not_found");

  await prisma.topicKeyword.upsert({
    where: { topicId_keywordId: { topicId, keywordId } },
    update: {},
    create: { topicId, keywordId },
  });

  await recomputeCoverageIfDerived(context, topic);
}

export async function unmapKeyword(
  context: TenantContext,
  topicId: string,
  keywordId: string,
): Promise<void> {
  const topic = await prisma.topic.findFirst({
    where: { id: topicId, ...websiteScope(context) },
  });

  if (!topic) throw new TopicError("That topic is not available.", "not_found");

  await prisma.topicKeyword.deleteMany({ where: { topicId, keywordId } });
  await recomputeCoverageIfDerived(context, topic);
}

export async function mapPage(
  context: TenantContext,
  topicId: string,
  pageId: string,
  role: TopicPageRole = "UNKNOWN",
): Promise<void> {
  const [topic, page] = await Promise.all([
    prisma.topic.findFirst({ where: { id: topicId, ...websiteScope(context) } }),
    prisma.page.findFirst({ where: { id: pageId, ...websiteScope(context) } }),
  ]);

  if (!topic) throw new TopicError("That topic is not available.", "not_found");
  if (!page) throw new TopicError("That page is not available.", "page_not_found");

  await prisma.topicPage.upsert({
    where: { topicId_pageId: { topicId, pageId } },
    update: { role },
    create: { topicId, pageId, role },
  });

  await recomputeCoverageIfDerived(context, topic);
}

export async function unmapPage(
  context: TenantContext,
  topicId: string,
  pageId: string,
): Promise<void> {
  const topic = await prisma.topic.findFirst({
    where: { id: topicId, ...websiteScope(context) },
  });

  if (!topic) throw new TopicError("That topic is not available.", "not_found");

  await prisma.topicPage.deleteMany({ where: { topicId, pageId } });
  await recomputeCoverageIfDerived(context, topic);
}

/** Keeps a computed status current without ever overwriting a person's. */
async function recomputeCoverageIfDerived(
  context: TenantContext,
  topic: Topic,
): Promise<void> {
  if (topic.coverageSource === "USER_PROVIDED") return;

  await recomputeCoverage(context, topic.id);
}

export type TopicMapping = {
  keywords: { id: string; keyword: string; intent: string }[];
  pages: { id: string; path: string; role: TopicPageRole }[];
};

export async function getTopicMapping(
  context: TenantContext,
  topicId: string,
): Promise<TopicMapping> {
  const topic = await prisma.topic.findFirst({
    where: { id: topicId, ...websiteScope(context) },
  });

  if (!topic) throw new TopicError("That topic is not available.", "not_found");

  const [keywords, pages] = await Promise.all([
    prisma.topicKeyword.findMany({
      where: { topicId },
      include: { keyword: { select: { id: true, keyword: true, intent: true } } },
    }),
    prisma.topicPage.findMany({
      where: { topicId },
      include: { page: { select: { id: true, path: true } } },
    }),
  ]);

  return {
    keywords: keywords.map((row) => ({
      id: row.keyword.id,
      keyword: row.keyword.keyword,
      intent: row.keyword.intent,
    })),
    pages: pages.map((row) => ({
      id: row.page.id,
      path: row.page.path,
      role: row.role,
    })),
  };
}

export async function archiveTopic(
  context: TenantContext,
  topicId: string,
): Promise<void> {
  const existing = await prisma.topic.findFirst({
    where: { id: topicId, ...websiteScope(context) },
  });

  if (!existing) throw new TopicError("That topic is not available.", "not_found");

  await prisma.$transaction(async (tx) => {
    await tx.topic.update({
      where: { id: existing.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    await recordAudit(tx, context, {
      entityType: "Topic",
      entityId: existing.id,
      action: "ARCHIVE",
      before: { name: existing.name, status: existing.status },
    });
  });
}
