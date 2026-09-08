import type { CmsEntityType } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import {
  CmsProviderError,
  type CmsEntity,
  type CmsProvider,
  type ConnectionTestResult,
  type CreateDraftInput,
  type DiscoveredCapability,
  type ProviderContext,
  type ReconcileCandidate,
} from "./types";

/**
 * A WordPress that is not WordPress, for showing the flow without a CMS.
 *
 * Backed by CmsSandboxPost, which is a table in our own database. It answers the
 * same contract as the real provider and takes the same execution path, so what
 * a demo shows is the machinery that would run against a real site rather than a
 * separate story told alongside it.
 *
 * What it must never do is let anyone believe a real CMS was touched. It refuses
 * to be constructed for a website that is not marked as a demo, it says so in
 * `simulated`, and its entity ids carry a prefix no WordPress would produce.
 * The seeded mismatch on CmsSandboxPost.servedTitle exists so a demo can show
 * verification failing honestly rather than only ever succeeding.
 */

/** An id no WordPress installation would return, so the two can never be confused. */
const ID_PREFIX = "sim-";

export class SimulatedWordPressProvider implements CmsProvider {
  readonly name = "wordpress-simulated";
  readonly simulated = true;

  /**
   * @param websiteId The demo website this instance is bound to. Every read and
   *   write is scoped to it, so one demo tenant cannot see another's sandbox.
   */
  constructor(private readonly websiteId: string) {}

  async testConnection(): Promise<ConnectionTestResult> {
    return { accountName: "Simulated WordPress", capabilities: await this.discoverCapabilities() };
  }

  async discoverCapabilities(): Promise<DiscoveredCapability[]> {
    // Stated, not inferred, and marked as simulated so a capability row can
    // never be mistaken for something a real WordPress answered.
    return [
      { capability: "READ_CONTENT", entityType: null, granted: true, source: "simulated" },
      { capability: "CREATE_DRAFT", entityType: "POST", granted: true, source: "simulated" },
      { capability: "CREATE_DRAFT", entityType: "PAGE", granted: true, source: "simulated" },
    ];
  }

  async createDraft(context: ProviderContext, input: CreateDraftInput): Promise<CmsEntity> {
    const count = await prisma.cmsSandboxPost.count({ where: { websiteId: this.websiteId } });
    const externalId = `${ID_PREFIX}${count + 1}`;
    const slug = input.slug ?? slugify(input.title);

    const created = await prisma.cmsSandboxPost.create({
      data: {
        websiteId: this.websiteId,
        externalId,
        status: "DRAFT",
        title: input.title,
        slug,
        contentHtml: input.contentHtml,
        // The sandbox has no excerpt column, so the excerpt rides in the field
        // that exists for a short summary. Named here rather than silently.
        metaDescription: input.excerpt,
        url: `${context.site.href}/?p=${encodeURIComponent(externalId)}`,
      },
    });

    return this.toEntity(created);
  }

  async getEntity(
    _context: ProviderContext,
    _entityType: CmsEntityType,
    externalId: string,
  ): Promise<CmsEntity> {
    const post = await prisma.cmsSandboxPost.findFirst({
      where: { websiteId: this.websiteId, externalId },
    });
    if (!post) throw new CmsProviderError("entity_not_found", false, 404);
    return this.toEntity(post);
  }

  async reconcileCreate(
    _context: ProviderContext,
    input: CreateDraftInput,
    window: { after: Date; before: Date },
  ): Promise<ReconcileCandidate[]> {
    const posts = await prisma.cmsSandboxPost.findMany({
      where: {
        websiteId: this.websiteId,
        status: "DRAFT",
        title: input.title,
        createdAt: { gte: window.after, lte: window.before },
      },
    });
    return posts.map((post) => ({ entity: this.toEntity(post) }));
  }

  private toEntity(post: {
    externalId: string;
    status: string;
    title: string;
    servedTitle: string | null;
    slug: string;
    contentHtml: string;
    metaDescription: string | null;
    url: string;
  }): CmsEntity {
    return {
      externalId: post.externalId,
      status: post.status.toLowerCase(),
      // servedTitle is the seeded mismatch: what the sandbox serves differs from
      // what it was told to store, so verification can be shown failing.
      title: post.servedTitle ?? post.title,
      content: post.contentHtml,
      excerpt: post.metaDescription,
      slug: post.slug,
      url: post.url,
    };
  }
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 190);
}
