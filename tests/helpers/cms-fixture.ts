import { vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { approveForCms, runQa } from "@/server/services/content-qa";
import type { TenantContext } from "@/server/auth/guards";
import type {
  CmsEntityType,
  ContentCmsApproval,
  ContentWorkItem,
  Connection,
  PublishingMode,
} from "@/generated/prisma/client";

import { QaFixtures, type QaFixture } from "./qa-fixture";
import { installQaStub } from "./qa-stub";

/**
 * A tenant standing exactly where M6 begins: one work item approved for the
 * CMS by a person, on one exact revision, with a WordPress connection that has
 * been asked what it may do.
 *
 * Built through the real services rather than by writing rows, so a test that
 * passes here is a statement about the product and not about the fixture.
 * Nothing in this file contacts WordPress; the connection is a local record.
 */

export type CmsFixture = {
  tenant: QaFixture;
  lead: TenantContext;
  item: ContentWorkItem;
  approval: ContentCmsApproval;
  connection: Connection;
};

export const SITE_URL = "https://cms.example.com";

export type ConnectionOptions = {
  baseUrl?: string | null;
  status?: Connection["status"];
  mode?: PublishingMode;
  /** Entity types CREATE_DRAFT is granted for. Empty means asked and refused. */
  createDraftFor?: CmsEntityType[];
  /** Skip the capability rows entirely: never asked, so never assumed. */
  skipCapabilities?: boolean;
  skipPolicy?: boolean;
};

export class CmsFixtures {
  readonly qa = new QaFixtures();

  /** A work item taken through QA and a human CMS approval by an SEO lead. */
  async approvedForCms(label: string): Promise<CmsFixture> {
    const tenant = await this.qa.tenant(label);
    const lead = await this.qa.colleague(tenant, "SEO_LEAD");
    const { item } = await this.qa.readyForQa(tenant, lead);

    installQaStub();
    const outcome = await runQa(tenant, item.id);
    resetProvider();
    vi.unstubAllEnvs();
    if (!outcome.ok) throw new Error(`${label}: the QA run failed`);

    const approved = await approveForCms(lead, item.id, { acknowledgeNotChecked: true });
    const connection = await this.connect(tenant);

    return { tenant, lead, item: approved.workItem, approval: approved.approval, connection };
  }

  /** The local record of a WordPress, with whatever a test needs it to say. */
  async connect(tenant: QaFixture, options: ConnectionOptions = {}): Promise<Connection> {
    const {
      baseUrl = SITE_URL,
      status = "CONNECTED",
      mode = "DRAFT_ONLY",
      createDraftFor = ["POST", "PAGE"],
      skipCapabilities = false,
      skipPolicy = false,
    } = options;

    const connection = await prisma.connection.upsert({
      where: { websiteId_provider: { websiteId: tenant.website.id, provider: "WORDPRESS" } },
      create: {
        workspaceId: tenant.workspace.id,
        websiteId: tenant.website.id,
        provider: "WORDPRESS",
        status,
        authType: "APPLICATION_PASSWORD",
        baseUrl,
        externalAccountName: "Editor",
        connectedAt: new Date(),
        lastCheckedAt: new Date(),
      },
      update: { status, baseUrl, authType: "APPLICATION_PASSWORD", lastCheckedAt: new Date() },
    });

    if (skipPolicy) {
      await prisma.publishingPolicy.deleteMany({ where: { connectionId: connection.id } });
    } else {
      await prisma.publishingPolicy.upsert({
        where: {
          websiteId_connectionId: { websiteId: tenant.website.id, connectionId: connection.id },
        },
        create: { websiteId: tenant.website.id, connectionId: connection.id, mode },
        update: { mode },
      });
    }

    await prisma.connectionCapability.deleteMany({ where: { connectionId: connection.id } });
    if (!skipCapabilities) {
      await prisma.connectionCapability.create({
        data: {
          websiteId: tenant.website.id,
          connectionId: connection.id,
          capability: "READ_CONTENT",
          granted: true,
          source: "test",
          checkedAt: new Date(),
        },
      });
      for (const entityType of ["POST", "PAGE"] as CmsEntityType[]) {
        await prisma.connectionCapability.create({
          data: {
            websiteId: tenant.website.id,
            connectionId: connection.id,
            capability: "CREATE_DRAFT",
            entityType,
            granted: createDraftFor.includes(entityType),
            source: "test",
            checkedAt: new Date(),
          },
        });
      }
    }

    return connection;
  }

  async teardown(): Promise<void> {
    await this.qa.teardown();
  }
}
