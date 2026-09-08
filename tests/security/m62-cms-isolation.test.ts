import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { websiteScope } from "@/server/auth/guards";
import { encryptCredential } from "@/server/crypto/credentials";
import { getExecution, requestCmsDraftExecution } from "@/server/services/execution";
import { executeCmsDraft, reconcileCmsDraft } from "@/server/services/cms-execution";
import { testCmsConnection } from "@/server/services/cms-connection";
import {
  CREATE_WORDPRESS_DRAFT,
  requestCreateWordPressDraft,
  requestReconcileWordPressDraft,
  requestReverifyWordPressDraft,
} from "@/server/services/cms-draft-request";
import type {
  CmsRequest,
  CmsTransport,
  CmsTransportResult,
} from "@/server/connectors/wordpress/types";
import type { Connection, Execution } from "@/generated/prisma/client";
import { CmsFixtures, type CmsFixture } from "../helpers/cms-fixture";
import type { QaFixture } from "../helpers/qa-fixture";

/**
 * M6.2 tenant isolation and credential secrecy (§27, §29) — release blocking.
 *
 * One tenant with a draft approved for its WordPress, and one attacker with a
 * WordPress of its own. Every id that reaches a service from a browser is tried
 * across the boundary: an execution, a connection, an external entity, a
 * sandbox post. None may be a way in, and the answer is always "not yours"
 * rather than a hint about what exists.
 *
 * The second half is about the one secret here. An application password is
 * decrypted for the length of a single HTTP call; it must appear in no row, no
 * step, no audit event and no error anybody can read.
 */

const fixtures = new CmsFixtures();
let owner: CmsFixture;
let attacker: QaFixture;
let attackerConnection: Connection;

/** Distinct, searchable, and never real credentials. */
const OWNER_PASSWORD = "owner-QQQQ-secret-9f2a-application-password";
const ATTACKER_PASSWORD = "attacker-ZZZZ-secret-4c8d-application-password";

beforeAll(async () => {
  owner = await fixtures.approvedForCms("m62iso");
  attacker = await fixtures.qa.tenant("m62iso-b");
  attackerConnection = await fixtures.connect(attacker);

  await credential(owner.connection.id, OWNER_PASSWORD);
  await credential(attackerConnection.id, ATTACKER_PASSWORD);
}, 120_000);

afterAll(async () => {
  resetProvider();
  vi.unstubAllEnvs();
  await fixtures.teardown();
  await prisma.$disconnect();
}, 90_000);

async function credential(connectionId: string, applicationPassword: string): Promise<void> {
  const encryptedPayload = encryptCredential(
    JSON.stringify({ username: "editor", applicationPassword }),
  ).ciphertext;

  await prisma.credential.upsert({
    where: { connectionId },
    create: { connectionId, provider: "WORDPRESS", encryptedPayload, scopes: [] },
    update: { encryptedPayload, provider: "WORDPRESS" },
  });
}

type Recorder = { transport: CmsTransport; sent: CmsRequest[] };

function recording(script: (request: CmsRequest) => CmsTransportResult): Recorder {
  const sent: CmsRequest[] = [];
  return {
    sent,
    transport: async (request) => {
      sent.push(request);
      return script(request);
    },
  };
}

const json = (body: unknown, status = 200): CmsTransportResult => ({
  ok: true,
  status,
  body: JSON.stringify(body),
});

/** A CMS that stores what it is sent and hands it back unchanged. */
function faithfulCms(): Recorder {
  let created: Record<string, unknown> | null = null;
  return recording((request) => {
    if (request.method === "POST") {
      const body = JSON.parse(request.body ?? "{}") as Record<string, string>;
      created = {
        id: 41,
        status: "draft",
        title: { raw: body.title ?? "" },
        content: { raw: body.content ?? "" },
        excerpt: { raw: body.excerpt ?? "" },
        slug: body.slug ?? "a-slug",
        link: "https://cms.example.com/a-slug",
      };
      return json(created);
    }
    return json(created ?? {});
  });
}

/**
 * A fresh attempt for the owner.
 *
 * M6.1 allows one CMS draft per work item, which is the point of it; each test
 * that wants its own attempt clears the previous history rather than bending
 * the rule.
 */
async function freshExecution(): Promise<Execution> {
  const websiteId = owner.tenant.website.id;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
    await tx.executionStep.deleteMany({ where: { websiteId } });
    await tx.executionVerification.deleteMany({ where: { websiteId } });
    await tx.execution.deleteMany({ where: { websiteId } });
  });

  const { execution } = await requestCmsDraftExecution(owner.lead, owner.item.id, {
    targetEntityType: "POST",
  });
  return execution;
}

describe("another tenant's execution", () => {
  let execution: Execution;

  beforeAll(async () => {
    execution = await freshExecution();
  }, 60_000);

  it("cannot be executed, and nothing is sent while finding that out", async () => {
    const cms = recording(() => json({}));

    await expect(
      executeCmsDraft(attacker, execution.id, { transport: cms.transport }),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(cms.sent).toHaveLength(0);
    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("READY");
    expect(reloaded.attempt).toBe(0);
  }, 60_000);

  it("cannot be reconciled", async () => {
    const cms = recording(() => json([]));

    await expect(
      reconcileCmsDraft(attacker, execution.id, { transport: cms.transport }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(cms.sent).toHaveLength(0);
  }, 60_000);

  it("reads as absent rather than forbidden", async () => {
    expect(await getExecution(attacker, execution.id)).toBeNull();
    expect(
      await prisma.execution.findFirst({
        where: { id: execution.id, ...websiteScope(attacker) },
      }),
    ).toBeNull();
  }, 60_000);

  it("shows neither its steps nor its verification history", async () => {
    const [steps, checks] = await Promise.all([
      prisma.executionStep.findMany({
        where: { executionId: execution.id, ...websiteScope(attacker) },
      }),
      prisma.executionVerification.findMany({
        where: { executionId: execution.id, ...websiteScope(attacker) },
      }),
    ]);

    expect(steps).toHaveLength(0);
    expect(checks).toHaveLength(0);
  }, 60_000);
});

describe("another tenant's CMS", () => {
  it("cannot be tested by naming its connection id", async () => {
    const cms = recording(() => json({ name: "Ed", capabilities: { read: true } }));

    await expect(
      testCmsConnection(attacker, {
        connectionId: owner.connection.id,
        transport: cms.transport,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });

    // The owner's site was never contacted, with anyone's credentials.
    expect(cms.sent).toHaveLength(0);
  }, 60_000);

  it("lends its credential to nobody: a test carries only the caller's own", async () => {
    const cms = recording(() =>
      json({ name: "Ed", capabilities: { read: true, edit_posts: true, edit_pages: true } }),
    );

    await testCmsConnection(attacker, { transport: cms.transport });

    const decoded = cms.sent
      .map((request) => request.headers.Authorization ?? "")
      .map((header) => (header.startsWith("Basic ") ? atob(header.slice(6)) : ""))
      .join("|");

    expect(decoded).toContain(ATTACKER_PASSWORD);
    expect(decoded).not.toContain(OWNER_PASSWORD);

    // And the rows it wrote belong to the attacker's own connection.
    const rows = await prisma.connectionCapability.findMany({
      where: { connectionId: attackerConnection.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.websiteId === attacker.website.id)).toBe(true);
  }, 60_000);

  it("keeps its sandbox posts out of view", async () => {
    await prisma.cmsSandboxPost.upsert({
      where: {
        websiteId_externalId: { websiteId: owner.tenant.website.id, externalId: "sim-iso-1" },
      },
      create: {
        websiteId: owner.tenant.website.id,
        externalId: "sim-iso-1",
        status: "DRAFT",
        title: "The owner's sandbox draft",
        slug: "owner-sandbox",
        contentHtml: "<p>Owner</p>",
        url: "https://cms.example.com/?p=sim-iso-1",
      },
      update: {},
    });

    const visible = await prisma.cmsSandboxPost.findMany({ where: { ...websiteScope(attacker) } });
    expect(visible.map((post) => post.externalId)).not.toContain("sim-iso-1");

    expect(
      await prisma.cmsSandboxPost.findFirst({
        where: { externalId: "sim-iso-1", ...websiteScope(attacker) },
      }),
    ).toBeNull();
  }, 60_000);
});

describe("an external entity, once it exists", () => {
  it("is frozen to the execution that created it, and invisible to anyone else", async () => {
    const execution = await freshExecution();
    const result = await executeCmsDraft(owner.lead, execution.id, {
      transport: faithfulCms().transport,
    });
    expect(result.execution.externalEntityId).toBe("41");

    // §13: once set, never replaced, cleared or reassigned. The database says so.
    for (const data of [
      { externalEntityId: "42" },
      { externalEntityId: null },
      { connectionId: attackerConnection.id },
    ]) {
      await expect(
        prisma.execution.update({ where: { id: execution.id }, data }),
      ).rejects.toThrow();
    }

    const unchanged = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(unchanged.externalEntityId).toBe("41");
    expect(unchanged.connectionId).toBe(owner.connection.id);

    // And the attacker cannot find it by the id, which is the only handle it has.
    expect(
      await prisma.execution.findFirst({
        where: { externalEntityId: "41", ...websiteScope(attacker) },
      }),
    ).toBeNull();
  }, 120_000);
});

describe("the application password", () => {
  it("is used once and written nowhere readable", async () => {
    const execution = await freshExecution();
    const cms = faithfulCms();

    const result = await executeCmsDraft(owner.lead, execution.id, { transport: cms.transport });
    expect(result.verified).toBe(true);

    // It was used: a header built for that one call.
    expect(atob(cms.sent[0]!.headers.Authorization!.slice(6))).toBe(`editor:${OWNER_PASSWORD}`);

    const websiteId = owner.tenant.website.id;
    const [steps, checks, executions, audits, connection] = await Promise.all([
      prisma.executionStep.findMany({ where: { websiteId } }),
      prisma.executionVerification.findMany({ where: { websiteId } }),
      prisma.execution.findMany({ where: { websiteId } }),
      prisma.auditEvent.findMany({ where: { websiteId } }),
      prisma.connection.findUniqueOrThrow({ where: { id: owner.connection.id } }),
    ]);

    const stored = JSON.stringify({ steps, checks, executions, audits, connection });

    expect(stored).not.toContain(OWNER_PASSWORD);
    expect(stored).not.toContain("applicationPassword");
    expect(stored).not.toContain("Authorization");
    expect(stored).not.toContain("Basic ");
    // Nor the base64 of it, which is a credential in its own right.
    expect(stored).not.toContain(btoa(`editor:${OWNER_PASSWORD}`));
  }, 120_000);

  it("stays out of the error a refused connection produces", async () => {
    const execution = await freshExecution();
    const cms = recording(() => ({ ok: true, status: 401, body: '{"code":"incorrect_password"}' }));

    const result = await executeCmsDraft(owner.lead, execution.id, { transport: cms.transport });

    expect(result.execution.errorCode).toBe("auth_required");
    const summary = result.execution.errorSummary ?? "";
    expect(summary).not.toContain(OWNER_PASSWORD);
    // Our own sentence, never WordPress's body.
    expect(summary).not.toContain("incorrect_password");

    const recorded = JSON.stringify(
      await prisma.executionStep.findMany({ where: { executionId: execution.id } }),
    );
    expect(recorded).not.toContain(OWNER_PASSWORD);
    expect(recorded).not.toContain("incorrect_password");
  }, 120_000);
});

describe("the three human actions, aimed at another tenant's work", () => {
  /** A transport that fails loudly: none of these may reach a CMS at all. */
  const forbidden = () =>
    recording(() => {
      throw new Error("no CMS call may be made for another tenant");
    });

  it("refuse to create against the owner's work item", async () => {
    const cms = forbidden();
    const before = await prisma.execution.count({
      where: { contentWorkItemId: owner.item.id },
    });

    const result = await requestCreateWordPressDraft(
      attacker,
      {
        contentWorkItemId: owner.item.id,
        targetEntityType: "POST",
        confirmation: CREATE_WORDPRESS_DRAFT,
      },
      { transport: cms.transport },
    );

    expect(result.outcome).toBe("REFUSED");
    expect(result.code).toBe("not_found");
    expect(result.executionId).toBeNull();
    expect(cms.sent).toHaveLength(0);

    // Nothing was written for either tenant: the owner's history is exactly as
    // it was, and the attacker gained no execution of its own.
    expect(await prisma.execution.count({ where: { contentWorkItemId: owner.item.id } })).toBe(
      before,
    );
    expect(await prisma.execution.count({ where: { websiteId: attacker.website.id } })).toBe(0);
  }, 60_000);

  it("refuse to reconcile and to re-verify against it", async () => {
    const cms = forbidden();
    const aimed = { contentWorkItemId: owner.item.id };

    const reconciled = await requestReconcileWordPressDraft(attacker, aimed, {
      transport: cms.transport,
    });
    const rechecked = await requestReverifyWordPressDraft(attacker, aimed, {
      transport: cms.transport,
    });

    expect(reconciled.outcome).toBe("REFUSED");
    expect(rechecked.outcome).toBe("REFUSED");
    expect(cms.sent).toHaveLength(0);
  }, 60_000);

  it("tell an attacker nothing about what exists", async () => {
    const cms = forbidden();
    const invented = "00000000-0000-4000-8000-0000000000ff";

    const real = await requestReverifyWordPressDraft(
      attacker,
      { contentWorkItemId: owner.item.id },
      { transport: cms.transport },
    );
    const imaginary = await requestReverifyWordPressDraft(
      attacker,
      { contentWorkItemId: invented },
      { transport: cms.transport },
    );

    // A work item that exists and one that never did answer identically, so
    // the refusal cannot be used to enumerate another tenant's work.
    expect(real).toEqual(imaginary);
    expect(cms.sent).toHaveLength(0);
  }, 60_000);

  it("cannot reach a draft the owner really has", async () => {
    const execution = await freshExecution();
    const created = await executeCmsDraft(owner.lead, execution.id, {
      transport: faithfulCms().transport,
    });
    expect(created.execution.externalEntityId).toBe("41");

    const cms = forbidden();
    const result = await requestReverifyWordPressDraft(
      attacker,
      { contentWorkItemId: owner.item.id },
      { transport: cms.transport },
    );

    expect(result.outcome).toBe("REFUSED");
    expect(result.executionId).toBeNull();
    expect(cms.sent).toHaveLength(0);
  }, 120_000);
});
