import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { encryptCredential } from "@/server/crypto/credentials";
import { renderMarkdown } from "@/lib/content/markdown";
import type { TenantContext } from "@/server/auth/guards";
import { systemContextFor } from "@/server/jobs/system-context";
import { STALE_EXECUTION_MINUTES } from "@/server/services/cms-execution";
import {
  CREATE_WORDPRESS_DRAFT,
  requestCreateWordPressDraft,
  requestReconcileWordPressDraft,
  requestReverifyWordPressDraft,
  type CmsDraftActionResult,
} from "@/server/services/cms-draft-request";
import type {
  CmsRequest,
  CmsTransport,
  CmsTransportResult,
} from "@/server/connectors/wordpress/types";
import type { ContentRevision, Execution } from "@/generated/prisma/client";
import { CmsFixtures, type CmsFixture } from "../helpers/cms-fixture";

/**
 * The three acts a person may take about a WordPress draft (M6.3).
 *
 * Everything below is about the boundary between a person and the machinery
 * M6.1 and M6.2 already built: who may ask, whether they said so explicitly,
 * what they are allowed to ask for given what has already happened, and what
 * they are told afterwards.
 *
 * One rule runs through all of it and is asserted almost everywhere: the number
 * of POSTs sent to WordPress. A create sends exactly one. Reconcile and
 * re-verify send none, ever. Everything else sends none at all.
 *
 * No network: the transport is injected.
 */

const fixtures = new CmsFixtures();
let base: CmsFixture;
let admin: TenantContext;
let member: TenantContext;
let viewer: TenantContext;

const APP_PASSWORD = "m63-secret-application-password-4f21";

beforeAll(async () => {
  base = await fixtures.approvedForCms("m63");
  admin = await fixtures.qa.colleague(base.tenant, "ADMIN");
  member = await fixtures.qa.colleague(base.tenant, "MEMBER");
  viewer = await fixtures.qa.colleague(base.tenant, "VIEWER");
  await storeCredential();
}, 120_000);

afterEach(async () => {
  await clearExecutions();
  await prisma.$transaction([
    prisma.contentWorkItem.update({
      where: { id: base.item.id },
      data: { status: "APPROVED_FOR_CMS" },
    }),

    prisma.connection.update({
      where: { id: base.connection.id },
      data: { status: "CONNECTED", authType: "APPLICATION_PASSWORD" },
    }),
    prisma.publishingPolicy.updateMany({
      where: { connectionId: base.connection.id },
      data: { mode: "DRAFT_ONLY" },
    }),
    prisma.connectionCapability.updateMany({
      where: { connectionId: base.connection.id },
      data: { granted: true },
    }),
  ]);
});

afterAll(async () => {
  resetProvider();
  vi.unstubAllEnvs();
  await fixtures.teardown();
  await prisma.$disconnect();
}, 90_000);

async function storeCredential(): Promise<void> {
  const encryptedPayload = encryptCredential(
    JSON.stringify({ username: "editor", applicationPassword: APP_PASSWORD }),
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
  });
}

// ---------------------------------------------------------------------------
// A WordPress that records everything asked of it
// ---------------------------------------------------------------------------

type Cms = {
  transport: CmsTransport;
  sent: CmsRequest[];
  posts: () => CmsRequest[];
  gets: () => CmsRequest[];
};

function cmsThat(script: (request: CmsRequest) => CmsTransportResult): Cms {
  const sent: CmsRequest[] = [];
  return {
    sent,
    posts: () => sent.filter((request) => request.method === "POST"),
    gets: () => sent.filter((request) => request.method === "GET"),
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

/** The draft WordPress would hold after storing what it was sent. */
function draftFrom(request: CmsRequest, over: Record<string, unknown> = {}) {
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
function faithfulCms(readBackOver: Record<string, unknown> = {}): Cms {
  let stored: Record<string, unknown> | null = null;
  return cmsThat((request) => {
    if (request.method === "POST") {
      stored = draftFrom(request);
      return json(stored);
    }
    return json({ ...(stored ?? {}), ...readBackOver });
  });
}

/** A CMS that never answers a create, so the outcome is unknowable. */
const silentCms = () => cmsThat(() => ({ ok: false, sent: true, code: "create_ambiguous" }));

const noCms = () =>
  cmsThat(() => {
    throw new Error("no CMS call was expected here");
  });

// ---------------------------------------------------------------------------
// Shorthands
// ---------------------------------------------------------------------------

const create = (
  context: TenantContext,
  cms: Cms,
  over: Partial<{ confirmation: string; targetEntityType: "POST" | "PAGE" }> = {},
): Promise<CmsDraftActionResult> =>
  requestCreateWordPressDraft(
    context,
    {
      contentWorkItemId: base.item.id,
      targetEntityType: over.targetEntityType ?? "POST",
      confirmation: over.confirmation ?? CREATE_WORDPRESS_DRAFT,
    },
    { transport: cms.transport },
  );

const reconcile = (context: TenantContext, cms: Cms, now?: () => Date) =>
  requestReconcileWordPressDraft(
    context,
    { contentWorkItemId: base.item.id },
    { transport: cms.transport, ...(now ? { now } : {}) },
  );

const reverify = (context: TenantContext, cms: Cms) =>
  requestReverifyWordPressDraft(
    context,
    { contentWorkItemId: base.item.id },
    { transport: cms.transport },
  );

async function executionRow(): Promise<Execution | null> {
  return prisma.execution.findFirst({ where: { websiteId: base.tenant.website.id } });
}

async function approvedRevision(): Promise<ContentRevision> {
  const execution = await prisma.execution.findFirstOrThrow({
    where: { websiteId: base.tenant.website.id },
  });
  return prisma.contentRevision.findUniqueOrThrow({
    where: { id: execution.contentRevisionId },
  });
}

/** Leaves the work item with a draft that exists and verifies. */
async function createdAndVerified(): Promise<Execution> {
  const result = await create(base.lead, faithfulCms());
  expect(result.outcome).toBe("VERIFIED");
  return prisma.execution.findFirstOrThrow({ where: { websiteId: base.tenant.website.id } });
}

/** Leaves the work item with an attempt whose outcome nobody can state. */
async function leftAmbiguous(): Promise<Execution> {
  const result = await create(base.lead, silentCms());
  expect(result.outcome).toBe("AMBIGUOUS_RECONCILIATION_REQUIRED");
  return prisma.execution.findFirstOrThrow({ where: { websiteId: base.tenant.website.id } });
}

/** Leaves an execution abandoned mid-flight, as a dead process would. */
async function leftExecuting(minutesAgo = STALE_EXECUTION_MINUTES + 5): Promise<Execution> {
  const execution = await leftAmbiguous();
  return prisma.execution.update({
    where: { id: execution.id },
    data: {
      status: "EXECUTING",
      errorCode: null,
      errorSummary: null,
      startedAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
}

/** A candidate draft in the CMS that is exactly the approved revision. */
async function matchingCandidate(id: number, over: Record<string, unknown> = {}) {
  const revision = await approvedRevision();
  return {
    id,
    status: "draft",
    title: { raw: revision.title },
    content: { raw: renderMarkdown(revision.bodyMarkdown) },
    excerpt: { raw: revision.excerpt ?? "" },
    slug: revision.slug ?? "a-slug",
    link: "https://cms.example.com/a-slug",
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("creating a draft, when everything is in order", () => {
  it("sends exactly one create, verifies it, and records who asked", async () => {
    const cms = faithfulCms();

    const result = await create(base.lead, cms);

    expect(result.outcome).toBe("VERIFIED");
    expect(result.executionId).not.toBeNull();
    expect(result.code).toBeNull();
    expect(cms.posts()).toHaveLength(1);
    expect(cms.gets()).toHaveLength(1);

    const execution = await prisma.execution.findUniqueOrThrow({
      where: { id: result.executionId! },
    });
    expect(execution.status).toBe("VERIFIED");
    expect(execution.externalEntityId).toBe("41");
    // Who approved it, who asked for the execution, and who ran it.
    expect(execution.requestedByUserId).toBe(base.lead.user.id);
    expect(execution.executedByUserId).toBe(base.lead.user.id);
    expect(execution.approvedByUserId).not.toBeNull();
    expect(execution.contentCmsApprovalId).not.toBeNull();

    const audits = await prisma.auditEvent.findMany({
      where: { entityType: "Execution", entityId: execution.id },
      select: { action: true, actorUserId: true },
    });
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining(["CREATE", "COMPLETE", "VERIFY"]),
    );
    expect(audits.every((row) => row.actorUserId === base.lead.user.id)).toBe(true);
  }, 90_000);

  it("creates a page when that is the chosen target, and freezes the choice", async () => {
    const cms = faithfulCms();

    const result = await create(base.lead, cms, { targetEntityType: "PAGE" });

    expect(result.outcome).toBe("VERIFIED");
    expect(new URL(cms.posts()[0]!.url).pathname).toBe("/wp-json/wp/v2/pages");

    // The target cannot be changed afterwards, by anybody.
    await expect(
      prisma.execution.update({
        where: { id: result.executionId! },
        data: { targetEntityType: "POST" },
      }),
    ).rejects.toThrow(/bindings cannot change/);
  }, 90_000);
});

describe("saying so explicitly", () => {
  const wrong = ["", "true", "yes", "create", "create_wordpress_draft", "CREATE_WORDPRESS_DRAFTS"];

  for (const confirmation of wrong) {
    it(`refuses ${confirmation === "" ? "an empty confirmation" : `"${confirmation}"`}`, async () => {
      const cms = noCms();

      const result = await create(base.lead, cms, { confirmation });

      expect(result.outcome).toBe("REFUSED");
      expect(cms.sent).toHaveLength(0);
      // Nothing was even planned: no execution row was written.
      expect(await executionRow()).toBeNull();
    }, 60_000);
  }
});

describe("who may ask", () => {
  const allowed: [string, () => TenantContext][] = [
    ["the owner", () => base.tenant],
    ["an admin", () => admin],
    ["an SEO lead", () => base.lead],
  ];

  for (const [label, who] of allowed) {
    it(`admits ${label}`, async () => {
      const cms = faithfulCms();
      const result = await create(who(), cms);

      expect(result.outcome).toBe("VERIFIED");
      expect(cms.posts()).toHaveLength(1);
    }, 90_000);
  }

  const refused: [string, () => TenantContext][] = [
    ["a member", () => member],
    ["a viewer", () => viewer],
  ];

  for (const [label, who] of refused) {
    it(`refuses ${label}, for all three acts, without touching the CMS`, async () => {
      const cms = noCms();

      expect((await create(who(), cms)).outcome).toBe("REFUSED");
      expect((await reconcile(who(), cms)).outcome).toBe("REFUSED");
      expect((await reverify(who(), cms)).outcome).toBe("REFUSED");
      expect(cms.sent).toHaveLength(0);
      expect(await executionRow()).toBeNull();
    }, 60_000);
  }

  it("refuses the scheduled-jobs actor, which is not a person", async () => {
    const system = await systemContextFor(base.tenant.website.id);
    const cms = noCms();

    expect((await create(system, cms)).outcome).toBe("REFUSED");
    expect((await reconcile(system, cms)).outcome).toBe("REFUSED");
    expect((await reverify(system, cms)).outcome).toBe("REFUSED");
    expect(cms.sent).toHaveLength(0);
    expect(await executionRow()).toBeNull();
  }, 60_000);

  it("refuses somebody whose access was revoked after the page was drawn", async () => {
    const revoked = await fixtures.qa.colleague(base.tenant, "SEO_LEAD");
    const cms = noCms();

    // The context still says SEO_LEAD; the membership no longer exists.
    await prisma.organizationMembership.delete({ where: { id: revoked.membership.id } });

    const result = await create(revoked, cms);

    expect(result.outcome).toBe("REFUSED");
    expect(result.code).toBe("forbidden");
    expect(cms.sent).toHaveLength(0);
  }, 60_000);

  it("refuses somebody whose membership was suspended", async () => {
    const suspended = await fixtures.qa.colleague(base.tenant, "SEO_LEAD");
    const cms = noCms();

    await prisma.organizationMembership.update({
      where: { id: suspended.membership.id },
      data: { status: "SUSPENDED" },
    });

    expect((await create(suspended, cms)).outcome).toBe("REFUSED");
    expect(cms.sent).toHaveLength(0);
  }, 60_000);
});

describe("conditions that must still hold when the button is pressed", () => {
  const cases: [string, () => Promise<void>][] = [
    [
      "the work item is no longer approved for the CMS",
      async () => {
        await prisma.contentWorkItem.update({
          where: { id: base.item.id },
          data: { status: "DRAFTING" },
        });
      },
    ],
    [
      "the connection is no longer connected",
      async () => {
        await prisma.connection.update({
          where: { id: base.connection.id },
          data: { status: "ERROR" },
        });
      },
    ],
    [
      "the policy no longer permits a draft",
      async () => {
        await prisma.publishingPolicy.updateMany({
          where: { connectionId: base.connection.id },
          data: { mode: "READ_ONLY" },
        });
      },
    ],
    [
      "the capability to create that kind of draft was withdrawn",
      async () => {
        await prisma.connectionCapability.updateMany({
          where: {
            connectionId: base.connection.id,
            capability: "CREATE_DRAFT",
            entityType: "POST",
          },
          data: { granted: false },
        });
      },
    ],
  ];

  for (const [label, arrange] of cases) {
    it(`refuses when ${label}, and sends nothing`, async () => {
      await arrange();
      const cms = noCms();

      const result = await create(base.lead, cms);

      expect(result.outcome).toBe("REFUSED");
      expect(cms.sent).toHaveLength(0);
      const execution = await executionRow();
      expect(execution?.externalEntityId ?? null).toBeNull();
    }, 90_000);
  }
});

describe("asking twice", () => {
  it("two simultaneous requests produce one execution and one create", async () => {
    const cms = faithfulCms();

    const [first, second] = await Promise.all([create(base.lead, cms), create(base.lead, cms)]);

    expect(cms.posts()).toHaveLength(1);
    expect(await prisma.execution.count({ where: { websiteId: base.tenant.website.id } })).toBe(1);

    const outcomes = [first.outcome, second.outcome].sort();
    // One did the work; the other found it already under way or already done.
    expect(outcomes).toContain("VERIFIED");
    expect(
      outcomes.some((outcome) =>
        ["ALREADY_IN_PROGRESS", "ALREADY_CREATED", "VERIFIED"].includes(outcome),
      ),
    ).toBe(true);
  }, 90_000);

  it("a second request after a verified draft sends nothing and says it exists", async () => {
    await createdAndVerified();
    const cms = noCms();

    const result = await create(base.lead, cms);

    expect(result.outcome).toBe("VERIFIED");
    expect(cms.sent).toHaveLength(0);
  }, 90_000);

  it("a second request after an unverified draft still sends nothing", async () => {
    const first = await create(base.lead, faithfulCms({ title: { raw: "Edited in WordPress" } }));
    expect(first.outcome).toBe("CREATED_VERIFICATION_FAILED");

    const cms = noCms();
    const result = await create(base.lead, cms);

    expect(result.outcome).toBe("ALREADY_CREATED");
    expect(cms.sent).toHaveLength(0);
  }, 90_000);

  it("a request after an unresolved attempt asks for reconciliation instead", async () => {
    await leftAmbiguous();
    const cms = noCms();

    const result = await create(base.lead, cms);

    expect(result.outcome).toBe("AMBIGUOUS_RECONCILIATION_REQUIRED");
    expect(cms.sent).toHaveLength(0);
  }, 90_000);

  it("a request while an attempt is genuinely running says so and sends nothing", async () => {
    await leftExecuting(1);
    const cms = noCms();

    const result = await create(base.lead, cms);

    expect(result.outcome).toBe("ALREADY_IN_PROGRESS");
    expect(cms.sent).toHaveLength(0);
  }, 90_000);
});

describe("recovering an attempt nobody could observe", () => {
  it("attaches the one complete match, then verifies it independently", async () => {
    const execution = await leftAmbiguous();
    const candidate = await matchingCandidate(77);
    const cms = cmsThat((request) =>
      request.url.includes("/77") ? json(candidate) : json([candidate]),
    );

    const result = await reconcile(base.lead, cms);

    expect(result.outcome).toBe("VERIFIED");
    // Never a create, and the read-back is a second, separate call.
    expect(cms.posts()).toHaveLength(0);
    expect(cms.gets().length).toBeGreaterThanOrEqual(2);

    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.externalEntityId).toBe("77");
    expect(reloaded.status).toBe("VERIFIED");

    // The sequence is on the trail: found, then checked.
    const steps = await prisma.executionStep.findMany({
      where: { executionId: execution.id },
      orderBy: { startedAt: "asc" },
      select: { stepType: true, status: true },
    });
    const types = steps.map((step) => step.stepType);
    expect(types).toContain("RECONCILE");
    expect(types).toContain("VERIFY_STATE");
    expect(types.indexOf("RECONCILE")).toBeLessThan(types.lastIndexOf("VERIFY_STATE"));
  }, 90_000);

  it("keeps the id but refuses to call it verified when the match does not check out", async () => {
    const execution = await leftAmbiguous();
    const candidate = await matchingCandidate(77);
    const cms = cmsThat((request) =>
      request.url.includes("/77")
        ? // Between the search and the read-back, the draft says something else.
          json({ ...candidate, content: { raw: "<p>Something else entirely</p>" } })
        : json([candidate]),
    );

    const result = await reconcile(base.lead, cms);

    expect(result.outcome).toBe("CREATED_VERIFICATION_FAILED");
    expect(cms.posts()).toHaveLength(0);

    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.externalEntityId).toBe("77");
    expect(reloaded.status).not.toBe("VERIFIED");
  }, 90_000);

  it("stays blocked when two drafts both match", async () => {
    const execution = await leftAmbiguous();
    const cms = cmsThat(() => json([]));
    const both = [await matchingCandidate(77), await matchingCandidate(78)];
    const searching = cmsThat(() => json(both));

    const result = await reconcile(base.lead, searching);

    expect(result.outcome).toBe("AMBIGUOUS_RECONCILIATION_REQUIRED");
    expect(searching.posts()).toHaveLength(0);
    expect(cms.sent).toHaveLength(0);

    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.externalEntityId).toBeNull();
  }, 90_000);

  it("stays blocked when the search itself could not be made", async () => {
    const execution = await leftAmbiguous();
    const cms = cmsThat(() => ({ ok: false, sent: false, code: "cms_unreachable" }));

    const result = await reconcile(base.lead, cms);

    expect(result.outcome).toBe("AMBIGUOUS_RECONCILIATION_REQUIRED");
    expect(cms.posts()).toHaveLength(0);

    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    // A question we could not ask makes nothing safe.
    expect(reloaded.errorCode).not.toBe("reconciled_absent");
    expect(reloaded.externalEntityId).toBeNull();
  }, 90_000);

  it("records absence only after a complete search, and still sends nothing", async () => {
    const execution = await leftAmbiguous();
    const cms = cmsThat(() => json([]));

    const result = await reconcile(base.lead, cms);

    expect(result.outcome).toBe("RETRY_SAFE_FAILURE");
    expect(result.code).toBe("reconciled_absent");
    expect(cms.posts()).toHaveLength(0);

    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("FAILED");
    expect(reloaded.errorCode).toBe("reconciled_absent");
  }, 90_000);

  it("leaves the next attempt to a person, who must ask again explicitly", async () => {
    await leftAmbiguous();
    await reconcile(
      base.lead,
      cmsThat(() => json([])),
    );

    // Nothing has re-sent anything on its own.
    const between = await prisma.execution.findFirstOrThrow({
      where: { websiteId: base.tenant.website.id },
    });
    expect(between.externalEntityId).toBeNull();

    // Only now, and only because somebody asked again.
    const cms = faithfulCms();
    const result = await create(base.lead, cms);

    expect(result.outcome).toBe("VERIFIED");
    expect(cms.posts()).toHaveLength(1);
  }, 120_000);

  it("refuses to reconcile while an attempt is genuinely still running", async () => {
    await leftExecuting(1);
    const cms = noCms();

    const result = await reconcile(base.lead, cms);

    expect(result.outcome).toBe("ALREADY_IN_PROGRESS");
    expect(cms.sent).toHaveLength(0);
  }, 90_000);

  it("refuses when there is nothing unresolved to reconcile", async () => {
    const cms = noCms();
    expect((await reconcile(base.lead, cms)).outcome).toBe("REFUSED");
    expect(cms.sent).toHaveLength(0);
  }, 60_000);
});

describe("an execution abandoned by a dead process", () => {
  it("is never reset to READY and never re-sent", async () => {
    const execution = await leftExecuting();

    // The create path will not touch it.
    const blocked = await create(base.lead, noCms());
    expect(blocked.outcome).toBe("AMBIGUOUS_RECONCILIATION_REQUIRED");

    const untouched = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(untouched.status).toBe("EXECUTING");
  }, 90_000);

  it("is reconciled onto its draft when exactly one matches", async () => {
    const execution = await leftExecuting();
    const candidate = await matchingCandidate(77);
    const cms = cmsThat((request) =>
      request.url.includes("/77") ? json(candidate) : json([candidate]),
    );

    const result = await reconcile(base.lead, cms);

    expect(result.outcome).toBe("VERIFIED");
    expect(cms.posts()).toHaveLength(0);
    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.externalEntityId).toBe("77");
  }, 90_000);

  it("stays blocked when more than one matches", async () => {
    const execution = await leftExecuting();
    const both = [await matchingCandidate(77), await matchingCandidate(78)];
    const cms = cmsThat(() => json(both));

    expect((await reconcile(base.lead, cms)).outcome).toBe("AMBIGUOUS_RECONCILIATION_REQUIRED");
    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(reloaded.status).toBe("EXECUTING");
    expect(reloaded.externalEntityId).toBeNull();
  }, 90_000);

  it("becomes retry-safe once a complete search proves nothing was created", async () => {
    const execution = await leftExecuting();
    const cms = cmsThat(() => json([]));

    const result = await reconcile(base.lead, cms);

    expect(result.outcome).toBe("RETRY_SAFE_FAILURE");
    const reloaded = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    // It has to leave EXECUTING, or it would keep blocking the retry it just earned.
    expect(reloaded.status).toBe("FAILED");
    expect(reloaded.errorCode).toBe("reconciled_absent");
    expect(cms.posts()).toHaveLength(0);
  }, 90_000);
});

describe("re-checking a draft that exists", () => {
  it("reads it back and confirms it still matches", async () => {
    await createdAndVerified();
    const cms = faithfulCms();
    // The CMS still holds what it was given.
    const revision = await approvedRevision();
    const holding = cmsThat(() =>
      json({
        id: 41,
        status: "draft",
        title: { raw: revision.title },
        content: { raw: renderMarkdown(revision.bodyMarkdown) },
        excerpt: { raw: revision.excerpt ?? "" },
        slug: revision.slug ?? "a-slug",
        link: "https://cms.example.com/a-slug",
      }),
    );

    const result = await reverify(base.lead, holding);

    expect(result.outcome).toBe("VERIFIED");
    expect(holding.posts()).toHaveLength(0);
    expect(holding.gets()).toHaveLength(1);
    expect(cms.sent).toHaveLength(0);
  }, 120_000);

  const mismatches: [string, (revision: ContentRevision) => Record<string, unknown>][] = [
    [
      "the body was edited",
      (r) => ({ content: { raw: `${renderMarkdown(r.bodyMarkdown)}<p>Added later.</p>` } }),
    ],
    ["the title was changed", () => ({ title: { raw: "A title somebody else chose" } })],
    ["it is no longer a draft", () => ({ status: "publish" })],
    ["the excerpt was changed", () => ({ excerpt: { raw: "A different summary entirely" } })],
  ];

  for (const [label, mutate] of mismatches) {
    it(`records a mismatch when ${label}, and changes nothing in WordPress`, async () => {
      await createdAndVerified();
      const revision = await approvedRevision();
      const cms = cmsThat(() =>
        json({
          id: 41,
          status: "draft",
          title: { raw: revision.title },
          content: { raw: renderMarkdown(revision.bodyMarkdown) },
          excerpt: { raw: revision.excerpt ?? "" },
          slug: revision.slug ?? "a-slug",
          link: "https://cms.example.com/a-slug",
          ...mutate(revision),
        }),
      );

      const result = await reverify(base.lead, cms);

      expect(result.outcome).toBe("CREATED_VERIFICATION_FAILED");
      // Read only: nothing was sent to correct it.
      expect(cms.posts()).toHaveLength(0);

      const reloaded = await prisma.execution.findFirstOrThrow({
        where: { websiteId: base.tenant.website.id },
      });
      expect(reloaded.externalEntityId).toBe("41");
      expect(reloaded.status).not.toBe("VERIFIED");

      // The approved revision is untouched: it remains what was authorized.
      const stored = await prisma.contentRevision.findUniqueOrThrow({
        where: { id: revision.id },
      });
      expect(stored.bodyMarkdown).toBe(revision.bodyMarkdown);
      expect(stored.title).toBe(revision.title);
    }, 120_000);
  }

  it("passes when only the slug differs, which WordPress is entitled to change", async () => {
    await createdAndVerified();
    const revision = await approvedRevision();
    const cms = cmsThat(() =>
      json({
        id: 41,
        status: "draft",
        title: { raw: revision.title },
        content: { raw: renderMarkdown(revision.bodyMarkdown) },
        excerpt: { raw: revision.excerpt ?? "" },
        slug: "a-slug-2",
        link: "https://cms.example.com/a-slug-2",
      }),
    );

    const result = await reverify(base.lead, cms);

    expect(result.outcome).toBe("VERIFIED");
    expect(result.verifications.find((row) => row.type === "SLUG_MATCH")?.status).toBe("FAIL");
  }, 120_000);

  it("says so plainly when the CMS no longer holds it", async () => {
    await createdAndVerified();
    const cms = cmsThat(() => ({ ok: true, status: 404, body: "{}" }));

    const result = await reverify(base.lead, cms);

    expect(result.outcome).toBe("CREATED_VERIFICATION_FAILED");
    expect(result.code).toBe("entity_not_found");
    expect(cms.posts()).toHaveLength(0);
  }, 120_000);

  it("says so plainly when the CMS cannot be reached", async () => {
    await createdAndVerified();
    const cms = cmsThat(() => ({ ok: false, sent: false, code: "cms_unreachable" }));

    const result = await reverify(base.lead, cms);

    expect(result.outcome).toBe("CREATED_VERIFICATION_FAILED");
    expect(result.code).toBe("cms_unreachable");
    expect(cms.posts()).toHaveLength(0);
  }, 120_000);

  it("refuses when no draft exists to re-check", async () => {
    const cms = noCms();
    expect((await reverify(base.lead, cms)).outcome).toBe("REFUSED");
    expect(cms.sent).toHaveLength(0);
  }, 60_000);

  it("needs the connection to be readable, and does not assume it from history", async () => {
    await createdAndVerified();
    await prisma.connectionCapability.updateMany({
      where: { connectionId: base.connection.id, capability: "READ_CONTENT" },
      data: { granted: false },
    });
    const cms = noCms();

    const result = await reverify(base.lead, cms);

    expect(result.outcome).toBe("REFUSED");
    expect(result.code).toBe("capability_missing");
    expect(cms.sent).toHaveLength(0);
  }, 120_000);
});

describe("nothing anywhere publishes", () => {
  it("never sends a publish, a schedule, or a plugin's field, across every act", async () => {
    const everything: CmsRequest[] = [];
    const collect = (cms: Cms) => everything.push(...cms.sent);

    const created = faithfulCms();
    await create(base.lead, created);
    collect(created);

    const rechecked = faithfulCms();
    await reverify(base.lead, rechecked);
    collect(rechecked);

    await clearExecutions();
    await leftAmbiguous();
    const searched = cmsThat(() => json([]));
    await reconcile(base.lead, searched);
    collect(searched);

    expect(everything.length).toBeGreaterThan(0);

    for (const request of everything) {
      expect(["GET", "POST"]).toContain(request.method);
      if (request.method !== "POST") continue;

      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      expect(body.status).toBe("draft");
      for (const forbidden of [
        "date",
        "date_gmt",
        "future",
        "categories",
        "tags",
        "featured_media",
        "meta",
        "yoast_head",
        "rank_math_title",
        "acf",
      ]) {
        expect(body).not.toHaveProperty(forbidden);
      }
    }

    // Exactly one create in the whole sequence: the one a person asked for.
    expect(everything.filter((request) => request.method === "POST")).toHaveLength(1);
  }, 180_000);

  it("keeps the credential out of every result it returns", async () => {
    const created = await create(base.lead, faithfulCms());
    const rechecked = await reverify(base.lead, faithfulCms());

    const shown = JSON.stringify([created, rechecked]);
    expect(shown).not.toContain(APP_PASSWORD);
    expect(shown).not.toContain("Basic ");
    expect(shown).not.toContain("applicationPassword");
    expect(shown).not.toContain("Authorization");
  }, 120_000);
});

/**
 * Placed last on purpose. A CMS approval may only ever be invalidated, once,
 * and every test above needs it to still stand.
 */
describe("once the approval a person gave is withdrawn", () => {
  it("refuses, because approving and creating are two separate acts", async () => {
    await prisma.contentCmsApproval.updateMany({
      where: { contentWorkItemId: base.item.id },
      data: { status: "INVALIDATED", invalidatedReason: "withdrawn for this test" },
    });
    const cms = noCms();

    const result = await create(base.lead, cms);

    expect(result.outcome).toBe("REFUSED");
    expect(cms.sent).toHaveLength(0);

    // And the action did not quietly mint a fresh approval to get past it.
    const approvals = await prisma.contentCmsApproval.findMany({
      where: { contentWorkItemId: base.item.id },
      select: { status: true },
    });
    expect(approvals.every((row) => row.status === "INVALIDATED")).toBe(true);
  }, 90_000);
});
