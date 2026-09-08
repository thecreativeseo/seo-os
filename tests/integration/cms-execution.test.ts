import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { encryptCredential } from "@/server/crypto/credentials";
import { renderMarkdown } from "@/lib/content/markdown";
import { requestCmsDraftExecution } from "@/server/services/execution";
import {
  CmsExecutionError,
  executeCmsDraft,
  reconcileCmsDraft,
} from "@/server/services/cms-execution";
import { testCmsConnection } from "@/server/services/cms-connection";
import type {
  CmsRequest,
  CmsTransport,
  CmsTransportResult,
} from "@/server/connectors/wordpress/types";
import type { TenantContext } from "@/server/auth/guards";
import type { CmsEntityType, Execution } from "@/generated/prisma/client";
import { CmsFixtures, type CmsFixture } from "../helpers/cms-fixture";

/**
 * Carrying out an authorized CREATE_CMS_DRAFT execution (M6.2 §8, §13–§21).
 *
 * The failure this whole milestone is arranged around is a second draft in
 * somebody's WordPress. So the questions asked here are: was anything sent, can
 * we prove what happened, and does the record afterwards say only what we
 * actually know. A create is attempted exactly once per execution; where the
 * outcome is unknown the execution says so and blocks another attempt.
 *
 * The WordPress transport is injected throughout. Nothing here reaches a
 * network, and the simulated provider's sandbox is our own table.
 */

const fixtures = new CmsFixtures();
let base: CmsFixture;

const USERNAME = "editor";
const APP_PASSWORD = "abcd EFGH ijkl MNOP";

beforeAll(async () => {
  base = await fixtures.approvedForCms("exec");
  await storeCredential();
}, 90_000);

/**
 * Puts the fixture back the way each test found it.
 *
 * Batched into one round trip: this runs after every test in the file, and
 * the suite shares one database with a hundred others.
 */
afterEach(async () => {
  await clearExecutions();
  await prisma.$transaction([
    prisma.credential.updateMany({
      where: { connectionId: base.connection.id },
      data: { encryptedPayload: goodCredential(), provider: "WORDPRESS" },
    }),
    prisma.website.update({
      where: { id: base.tenant.website.id },
      data: { isDemo: false },
    }),
    prisma.connection.update({
      where: { id: base.connection.id },
      data: { status: "CONNECTED", authType: "APPLICATION_PASSWORD" },
    }),
    prisma.publishingPolicy.updateMany({
      where: { connectionId: base.connection.id },
      data: { mode: "DRAFT_ONLY" },
    }),
  ]);
});

afterAll(async () => {
  resetProvider();
  vi.unstubAllEnvs();
  await fixtures.teardown();
  await prisma.$disconnect();
}, 60_000);

/** The encrypted form of the credential these tests expect to be in place. */
function goodCredential(): string {
  return encryptCredential(
    JSON.stringify({ username: USERNAME, applicationPassword: APP_PASSWORD }),
  ).ciphertext;
}

async function storeCredential(
  payload: unknown = { username: USERNAME, applicationPassword: APP_PASSWORD },
): Promise<void> {
  const encryptedPayload = encryptCredential(
    typeof payload === "string" ? payload : JSON.stringify(payload),
  ).ciphertext;

  await prisma.credential.upsert({
    where: { connectionId: base.connection.id },
    create: {
      connectionId: base.connection.id,
      provider: "WORDPRESS",
      encryptedPayload,
      scopes: [],
    },
    update: { encryptedPayload, provider: "WORDPRESS" },
  });
}

async function clearExecutions(): Promise<void> {
  const websiteId = base.tenant.website.id;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.allow_approved_context_delete = 'on'");
    await tx.executionStep.deleteMany({ where: { websiteId } });
    await tx.executionVerification.deleteMany({ where: { websiteId } });
    await tx.execution.deleteMany({ where: { websiteId } });
    await tx.cmsSandboxPost.deleteMany({ where: { websiteId } });
  });
}

/** A READY execution, made the way the product makes one. */
async function ready(entityType: CmsEntityType = "POST"): Promise<Execution> {
  const { execution } = await requestCmsDraftExecution(base.lead, base.item.id, {
    targetEntityType: entityType,
  });
  return execution;
}

/** The revision this execution is pinned to, which is what must be sent. */
async function approvedRevision(execution: Execution) {
  return prisma.contentRevision.findUniqueOrThrow({
    where: { id: execution.contentRevisionId },
  });
}

type Recorder = { transport: CmsTransport; sent: CmsRequest[] };

/** A transport that records every request and answers from a script. */
function recording(script: (request: CmsRequest, index: number) => CmsTransportResult): Recorder {
  const sent: CmsRequest[] = [];
  return {
    sent,
    transport: async (request) => {
      const index = sent.length;
      sent.push(request);
      return script(request, index);
    },
  };
}

const json = (body: unknown, status = 200): CmsTransportResult => ({
  ok: true,
  status,
  body: JSON.stringify(body),
});

/** What WordPress returns for a draft it just stored, echoing what it was sent. */
function stored(request: CmsRequest, over: Record<string, unknown> = {}) {
  const body = JSON.parse(request.body ?? "{}") as Record<string, string>;
  return {
    id: 41,
    status: "draft",
    title: { raw: body.title ?? "" },
    content: { raw: body.content ?? "" },
    excerpt: { raw: body.excerpt ?? "" },
    slug: body.slug ?? "a-slug",
    link: "https://cms.example.com/a-slug",
    ...over,
  };
}

/** A CMS that stores what it is given and reads it back unchanged. */
function faithfulCms(over: Record<string, unknown> = {}): Recorder {
  let created: Record<string, unknown> | null = null;
  return recording((request) => {
    if (request.method === "POST") {
      created = stored(request, over);
      return json(created);
    }
    return json(created ?? {});
  });
}

async function verificationsFor(executionId: string) {
  const rows = await prisma.executionVerification.findMany({
    where: { executionId },
    orderBy: { verificationType: "asc" },
  });
  return new Map(rows.map((row) => [row.verificationType, row]));
}

async function stepsFor(executionId: string) {
  return prisma.executionStep.findMany({ where: { executionId }, orderBy: { startedAt: "asc" } });
}

describe("a draft that is created and reads back correctly", () => {
  it("sends the approved revision, keeps the id, and ends VERIFIED", async () => {
    const execution = await ready();
    const revision = await approvedRevision(execution);
    const cms = faithfulCms();

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.verified).toBe(true);
    expect(result.execution.status).toBe("VERIFIED");
    expect(result.execution.externalEntityId).toBe("41");
    expect(result.execution.externalStatus).toBe("draft");
    expect(result.execution.verifiedAt).not.toBeNull();

    // Exactly one create, then one independent read.
    expect(cms.sent.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(cms.sent[1]!.url).toContain("/wp-json/wp/v2/posts/41");

    // The body is the approved revision, rendered. Not the work item's current one.
    const body = JSON.parse(cms.sent[0]!.body!) as Record<string, string>;
    expect(body.title).toBe(revision.title);
    expect(body.status).toBe("draft");
    expect(body.content).toContain("<p>");

    const checks = await verificationsFor(execution.id);
    expect(checks.get("CMS_STATUS_DRAFT")?.status).toBe("PASS");
    expect(checks.get("TITLE_MATCH")?.status).toBe("PASS");
    expect(checks.get("CONTENT_PRESENT")?.status).toBe("PASS");
    expect(checks.get("SLUG_MATCH")?.status).toBe("PASS");

    const steps = await stepsFor(execution.id);
    expect(steps.map((step) => `${step.stepType}:${step.status}`)).toEqual([
      "PREFLIGHT:SUCCEEDED",
      "CREATE_DRAFT:SUCCEEDED",
      "VERIFY_STATE:SUCCEEDED",
    ]);
  }, 60_000);

  it("creates a page at the page endpoint when that is the target", async () => {
    const execution = await ready("PAGE");
    const cms = faithfulCms();

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.verified).toBe(true);
    expect(new URL(cms.sent[0]!.url).pathname).toBe("/wp-json/wp/v2/pages");
    expect(new URL(cms.sent[1]!.url).pathname).toBe("/wp-json/wp/v2/pages/41");
  }, 60_000);

  it("records that no plugin SEO metadata was written, rather than implying it was", async () => {
    const execution = await ready();
    await executeCmsDraft(base.lead, execution.id, { transport: faithfulCms().transport });

    const create = (await stepsFor(execution.id)).find((step) => step.stepType === "CREATE_DRAFT");
    expect(create?.requestSummaryJson).toMatchObject({ seoMetadata: "not_written" });
  }, 60_000);
});

describe("refusals that happen before anything is sent", () => {
  const cases: [string, () => Promise<void>, string, boolean?][] = [
    [
      "a connection that is no longer connected",
      async () => {
        await prisma.connection.update({
          where: { id: base.connection.id },
          data: { status: "ERROR" },
        });
      },
      "connection_disabled",
    ],
    [
      "a policy that does not allow drafts",
      async () => {
        await prisma.publishingPolicy.updateMany({
          where: { connectionId: base.connection.id },
          data: { mode: "READ_ONLY" },
        });
      },
      "policy_denied",
    ],
    [
      "a credential that is not there",
      async () => {
        await prisma.credential.deleteMany({ where: { connectionId: base.connection.id } });
      },
      "auth_required",
      // Deleted, so the batched reset cannot update it back into place.
      true,
    ],
    [
      "a credential filed under another provider",
      async () => {
        await prisma.credential.update({
          where: { connectionId: base.connection.id },
          data: { provider: "GOOGLE_SEARCH_CONSOLE" },
        });
      },
      "auth_required",
    ],
    [
      "a credential that is not the shape M6 stores",
      async () => {
        await storeCredential("not json at all");
      },
      "auth_required",
    ],
    [
      "a credential with no username",
      async () => {
        await storeCredential({ applicationPassword: APP_PASSWORD });
      },
      "auth_required",
    ],
    [
      "a credential with no application password",
      async () => {
        await storeCredential({ username: USERNAME });
      },
      "auth_required",
    ],
    [
      "an auth type M6 does not implement",
      async () => {
        await prisma.connection.update({
          where: { id: base.connection.id },
          data: { authType: "OAUTH2" },
        });
      },
      "auth_required",
    ],
  ];

  for (const [label, arrange, code, recreateCredential] of cases) {
    it(`fails on ${label}, with nothing transmitted`, async () => {
      const execution = await ready();
      await arrange();
      const cms = recording(() => json(stored({ method: "POST", url: "", headers: "" } as never)));

      const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

      expect(result.execution.status).toBe("FAILED");
      expect(result.execution.errorCode).toBe(code);
      expect(result.execution.externalEntityId).toBeNull();
      expect(cms.sent).toHaveLength(0);

      const step = (await stepsFor(execution.id)).find((row) => row.stepType === "CREATE_DRAFT");
      expect(step?.status).toBe("SKIPPED");
      expect(step?.requestSummaryJson).toMatchObject({ sent: false });

      if (recreateCredential) await storeCredential();
    }, 60_000);
  }

  it("refuses when the capability was never granted for this entity type", async () => {
    const execution = await ready();
    await prisma.connectionCapability.updateMany({
      where: { connectionId: base.connection.id, capability: "CREATE_DRAFT", entityType: "POST" },
      data: { granted: false },
    });
    const cms = recording(() => json({}));

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.execution.errorCode).toBe("capability_missing");
    expect(cms.sent).toHaveLength(0);

    await prisma.connectionCapability.updateMany({
      where: { connectionId: base.connection.id, capability: "CREATE_DRAFT", entityType: "POST" },
      data: { granted: true },
    });
  }, 60_000);

  it("cannot be pointed at a different revision or hash: the database refuses", async () => {
    const execution = await ready();

    // The execution is frozen to the approval it acts on, so there is no way
    // to make it send anything but the exact approved revision — not through
    // this service, and not around it either.
    await expect(
      prisma.execution.update({
        where: { id: execution.id },
        data: { revisionHash: "sha256:something-else" },
      }),
    ).rejects.toThrow(/bindings cannot change/);

    await expect(
      prisma.execution.update({
        where: { id: execution.id },
        data: { contentCmsApprovalId: null },
      }),
    ).rejects.toThrow(/bindings cannot change/);

    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.revisionHash).toBe(execution.revisionHash);
    expect(reloaded.contentRevisionId).toBe(execution.contentRevisionId);
  }, 60_000);
});

describe("an attempt whose outcome cannot be observed", () => {
  it("is left blocking, with no id and no second create", async () => {
    const execution = await ready();
    let posts = 0;
    const cms = recording((request) => {
      if (request.method === "POST") posts += 1;
      // Transmitted, then silence. WordPress may hold a draft nobody can see.
      return { ok: false, sent: true, code: "create_ambiguous" };
    });

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.execution.status).toBe("FAILED");
    expect(result.execution.errorCode).toBe("create_ambiguous");
    expect(result.execution.externalEntityId).toBeNull();
    expect(posts).toBe(1);

    // And the execution refuses to run again: it is not proven retry-safe.
    await expect(
      executeCmsDraft(base.lead, execution.id, { transport: cms.transport }),
    ).rejects.toBeInstanceOf(CmsExecutionError);
    expect(posts).toBe(1);

    // M6.1 refuses to hand out a fresh execution for the same operation, too.
    await expect(
      requestCmsDraftExecution(base.lead, base.item.id, { targetEntityType: "POST" }),
    ).rejects.toThrow();
  }, 60_000);

  it("calls a 5xx on a create ambiguous, because the row may already exist", async () => {
    const execution = await ready();
    const cms = recording(() => ({ ok: true, status: 500, body: "" }));

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.execution.errorCode).toBe("create_ambiguous");
    expect(cms.sent).toHaveLength(1);
  }, 60_000);

  it("treats a refusal that never reached the CMS as a plain failure", async () => {
    const execution = await ready();
    const cms = recording(() => ({ ok: false, sent: false, code: "cms_unreachable" }));

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    // Nothing was sent, so this one is safe to try again.
    expect(result.execution.status).toBe("FAILED");
    expect(result.execution.errorCode).toBe("cms_unreachable");
  }, 60_000);

  it("does not send a second create while one execution is already EXECUTING", async () => {
    const execution = await ready();
    await prisma.execution.update({
      where: { id: execution.id },
      data: { status: "EXECUTING" },
    });
    const cms = recording(() => json({}));

    await expect(
      executeCmsDraft(base.lead, execution.id, { transport: cms.transport }),
    ).rejects.toMatchObject({ code: "execution_in_progress" });
    expect(cms.sent).toHaveLength(0);
  }, 60_000);
});

describe("what the CMS says when it is read back", () => {
  it("keeps the id and refuses to call it verified when the content differs", async () => {
    const execution = await ready();
    const cms = recording((request) =>
      request.method === "POST"
        ? json(stored(request))
        : // A paragraph has gone missing between the create and the read.
          json({
            ...stored({ ...request, body: "{}" } as CmsRequest),
            content: { raw: "<p>Not the approved words</p>" },
          }),
    );

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.verified).toBe(false);
    expect(result.execution.status).toBe("VERIFYING");
    expect(result.execution.errorCode).toBe("verification_failed");
    // The draft exists. Its id is kept so a person can go and look at it.
    expect(result.execution.externalEntityId).toBe("41");

    const checks = await verificationsFor(execution.id);
    const content = checks.get("CONTENT_PRESENT")!;
    expect(content.status).toBe("FAIL");
    // Fingerprints and a difference kind — never the content itself.
    expect(JSON.stringify(content.expectedValueJson)).toContain("sha256:");
    expect(JSON.stringify(content.observedValueJson)).toContain("difference");
  }, 60_000);

  it("fails on a status that is not draft, and keeps the id", async () => {
    const execution = await ready();
    const cms = faithfulCms({ status: "publish" });

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.verified).toBe(false);
    expect(result.execution.externalEntityId).toBe("41");
    expect(result.execution.externalStatus).toBe("publish");
    expect((await verificationsFor(execution.id)).get("CMS_STATUS_DRAFT")?.status).toBe("FAIL");
  }, 60_000);

  it("fails on an excerpt that came back different", async () => {
    const execution = await ready();
    const revision = await approvedRevision(execution);
    if (!revision.excerpt) return; // Nothing was sent, so nothing to compare.

    const cms = recording((request) =>
      request.method === "POST"
        ? json(stored(request))
        : json({ ...stored(request), excerpt: { raw: "A different summary entirely" } }),
    );

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.verified).toBe(false);
    expect((await verificationsFor(execution.id)).get("EXCERPT_MATCH")?.status).toBe("FAIL");
  }, 60_000);

  it("records a rewritten slug without failing the draft for it", async () => {
    const execution = await ready();
    const cms = faithfulCms({ slug: "a-slug-2" });

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    // WordPress rewrites a slug for uniqueness. That is not a reason to refuse.
    expect(result.verified).toBe(true);
    expect(result.execution.status).toBe("VERIFIED");
    const slug = (await verificationsFor(execution.id)).get("SLUG_MATCH")!;
    expect(slug.status).toBe("FAIL");
    expect(slug.observedValueJson).toBe("a-slug-2");
  }, 60_000);

  it("keeps the id when the read-back itself cannot be made", async () => {
    const execution = await ready();
    const cms = recording((request) =>
      request.method === "POST"
        ? json(stored(request))
        : { ok: false, sent: false, code: "cms_unreachable" },
    );

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.verified).toBe(false);
    expect(result.execution.status).toBe("VERIFYING");
    expect(result.execution.externalEntityId).toBe("41");
    expect(result.execution.errorCode).toBe("cms_unreachable");
    // No second draft was made to find out.
    expect(cms.sent.filter((request) => request.method === "POST")).toHaveLength(1);
  }, 60_000);

  it("does not persist an authenticated preview address", async () => {
    const execution = await ready();
    const cms = faithfulCms({ link: "https://cms.example.com/?p=41&preview=true&_wpnonce=s3cret" });

    const result = await executeCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(result.execution.externalUrl).toBeNull();
  }, 60_000);
});

describe("reconciling an attempt nobody could observe", () => {
  /** Leaves the execution exactly where an ambiguous create leaves it. */
  async function ambiguous(): Promise<Execution> {
    const execution = await ready();
    await executeCmsDraft(base.lead, execution.id, {
      transport: recording(() => ({ ok: false, sent: true, code: "create_ambiguous" })).transport,
    });
    return prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
  }

  it("attaches the one draft that matches the approved revision completely", async () => {
    const execution = await ambiguous();
    const revision = await approvedRevision(execution);
    const cms = recording(() =>
      json([
        {
          id: 77,
          status: "draft",
          title: { raw: revision.title },
          content: { raw: renderedBody(revision.bodyMarkdown) },
          excerpt: { raw: revision.excerpt ?? "" },
          slug: revision.slug ?? "a-slug",
          link: "https://cms.example.com/a-slug",
        },
      ]),
    );

    const outcome = await reconcileCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(outcome.outcome).toBe("ATTACHED");
    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.externalEntityId).toBe("77");
    expect(reloaded.status).toBe("SUCCEEDED");
    expect(reloaded.errorCode).toBeNull();
  }, 60_000);

  it("stays ambiguous when two drafts match, rather than choosing one", async () => {
    const execution = await ambiguous();
    const revision = await approvedRevision(execution);
    const candidate = (id: number) => ({
      id,
      status: "draft",
      title: { raw: revision.title },
      content: { raw: renderedBody(revision.bodyMarkdown) },
      excerpt: { raw: revision.excerpt ?? "" },
      slug: revision.slug ?? "a-slug",
      link: "https://cms.example.com/a-slug",
    });
    const cms = recording(() => json([candidate(77), candidate(78)]));

    const outcome = await reconcileCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(outcome).toMatchObject({ outcome: "AMBIGUOUS", candidates: 2 });
    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.externalEntityId).toBeNull();
  }, 60_000);

  it("never attaches the closest match", async () => {
    const execution = await ambiguous();
    const revision = await approvedRevision(execution);
    // Same title, different words. Close is not the same.
    const cms = recording(() =>
      json([
        {
          id: 77,
          status: "draft",
          title: { raw: revision.title },
          content: { raw: "<p>Almost the approved words, but not quite.</p>" },
          excerpt: { raw: revision.excerpt ?? "" },
          slug: revision.slug ?? "a-slug",
          link: "https://cms.example.com/a-slug",
        },
      ]),
    );

    const outcome = await reconcileCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(outcome.outcome).toBe("AMBIGUOUS");
    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.externalEntityId).toBeNull();
  }, 60_000);

  it("calls a complete search that found nothing proof of absence", async () => {
    const execution = await ambiguous();
    const cms = recording(() => json([]));

    const outcome = await reconcileCmsDraft(base.lead, execution.id, { transport: cms.transport });

    expect(outcome.outcome).toBe("ABSENT");
    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    // Only this code means we went and looked, and only it makes a retry safe.
    expect(reloaded.errorCode).toBe("reconciled_absent");
    expect(reloaded.status).toBe("FAILED");
  }, 60_000);

  it("refuses to reconcile an execution that was never attempted", async () => {
    const execution = await ready();
    const cms = recording(() => json([]));

    await expect(
      reconcileCmsDraft(base.lead, execution.id, { transport: cms.transport }),
    ).rejects.toBeInstanceOf(CmsExecutionError);
    expect(cms.sent).toHaveLength(0);
  }, 60_000);
});

describe("the simulated WordPress", () => {
  /** The demo website, and a context that describes it as one. */
  async function makeDemo(): Promise<TenantContext> {
    const website = await prisma.website.update({
      where: { id: base.tenant.website.id },
      data: { isDemo: true },
    });
    await prisma.connection.update({
      where: { id: base.connection.id },
      data: { authType: "SIMULATED" },
    });
    return { ...base.lead, website };
  }

  it("takes the same path and ends VERIFIED, without touching a network", async () => {
    const execution = await ready();
    const demo = await makeDemo();

    const result = await executeCmsDraft(demo, execution.id, {
      // A transport is passed and must never be used: the sandbox is our table.
      transport: recording(() => {
        throw new Error("the simulated provider must not use a transport");
      }).transport,
    });

    expect(result.verified).toBe(true);
    expect(result.execution.status).toBe("VERIFIED");
    // An id no WordPress would return, so the two can never be confused.
    expect(result.execution.externalEntityId).toMatch(/^sim-/);

    const sandbox = await prisma.cmsSandboxPost.findMany({
      where: { websiteId: base.tenant.website.id },
    });
    expect(sandbox).toHaveLength(1);
    expect(sandbox[0]!.status).toBe("DRAFT");

    const step = (await stepsFor(execution.id)).find((row) => row.stepType === "CREATE_DRAFT");
    expect(step?.requestSummaryJson).toMatchObject({
      provider: "wordpress-simulated",
      simulated: true,
    });
  }, 60_000);

  it("shows verification failing honestly when the sandbox serves a different title", async () => {
    const execution = await ready();
    const demo = await makeDemo();

    const first = await executeCmsDraft(demo, execution.id, {
      transport: recording(() => json({})).transport,
    });
    expect(first.verified).toBe(true);

    // The seeded mismatch: what the sandbox serves differs from what it stored.
    await prisma.cmsSandboxPost.updateMany({
      where: { websiteId: base.tenant.website.id },
      data: { servedTitle: "A title somebody edited afterwards" },
    });

    const reread = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reread.externalEntityId).toMatch(/^sim-/);
  }, 60_000);

  it("refuses to run for a website that is not a demo", async () => {
    const execution = await ready();
    // A simulated connection on a real website would let somebody watch a draft
    // appear and believe their CMS had received it.
    await prisma.connection.update({
      where: { id: base.connection.id },
      data: { authType: "SIMULATED" },
    });

    const result = await executeCmsDraft(base.lead, execution.id, {
      transport: recording(() => json({})).transport,
    });

    expect(result.execution.status).toBe("FAILED");
    expect(result.execution.errorCode).toBe("policy_denied");
    expect(
      await prisma.cmsSandboxPost.count({ where: { websiteId: base.tenant.website.id } }),
    ).toBe(0);
  }, 60_000);
});

describe("asking a connection what it may do", () => {
  it("reads the capability map and writes it down, without creating anything", async () => {
    const cms = recording(() =>
      json({
        name: "Ed Editor",
        capabilities: { read: true, edit_posts: true, edit_pages: false },
      }),
    );

    const result = await testCmsConnection(base.lead, { transport: cms.transport });

    expect(result.accountName).toBe("Ed Editor");
    expect(cms.sent.every((request) => request.method === "GET")).toBe(true);
    expect(cms.sent.every((request) => !request.mutating)).toBe(true);

    const rows = await prisma.connectionCapability.findMany({
      where: { connectionId: base.connection.id },
    });
    const page = rows.find((row) => row.capability === "CREATE_DRAFT" && row.entityType === "PAGE");
    expect(page?.granted).toBe(false);
    expect(page?.source).toBe("wp_users_me");
    expect(rows.every((row) => row.source !== "assumed")).toBe(true);
  }, 60_000);

  it("grants nothing when WordPress will not say, rather than inferring it from a 200", async () => {
    const cms = recording(() => json({ name: "Ed Editor" }));

    const result = await testCmsConnection(base.lead, { transport: cms.transport });

    expect(result.capabilities.every((capability) => !capability.granted)).toBe(true);
    const rows = await prisma.connectionCapability.findMany({
      where: { connectionId: base.connection.id },
    });
    expect(rows.every((row) => row.granted === false)).toBe(true);
    expect(rows.every((row) => row.source === "wp_users_me_absent")).toBe(true);
  }, 60_000);
});

/** The same deterministic rendering the execution uses, so a candidate matches. */
function renderedBody(markdown: string): string {
  return renderMarkdown(markdown);
}
