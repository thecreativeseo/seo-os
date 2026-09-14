import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/prisma";
import { resetProvider } from "@/server/ai/registry";
import { decryptCredential } from "@/server/crypto/credentials";
import type { TenantContext } from "@/server/auth/guards";
import { systemContextFor } from "@/server/jobs/system-context";
import {
  configureWordPressConnection,
  loadWordPressConnection,
  markConnectionTested,
  requestWordPressConnectionTest,
  testCmsConnection,
} from "@/server/services/cms-connection";
import { getCmsConnectionReadiness } from "@/server/services/cms-drafts";
import { CmsProviderError } from "@/server/connectors/wordpress/types";
import type {
  CmsRequest,
  CmsTransport,
  CmsTransportResult,
} from "@/server/connectors/wordpress/types";
import { CmsFixtures } from "../helpers/cms-fixture";
import type { QaFixture } from "../helpers/qa-fixture";

/**
 * The screens behind M6's one external side effect (M6.4).
 *
 * Three things are proved here. The application password goes in and never
 * comes back — not through a reader, not into an audit event, not onto a page.
 * What the connection may do is what WordPress said, never what a successful
 * login implied. And nowhere in the rendered UI or its actions is there a way
 * to publish, schedule, update or delete anything.
 *
 * The pages are asserted as source, which is how this repository already checks
 * copy that must not drift. No network: the transport is injected.
 */

const fixtures = new CmsFixtures();
let owner: QaFixture;
let admin: TenantContext;
let lead: TenantContext;
let member: TenantContext;
let viewer: TenantContext;

const SITE = "https://cms.example.com";
const USERNAME = "editor";
const APP_PASSWORD = "m64-QQQQ-application-password-3d71";

beforeAll(async () => {
  owner = await fixtures.qa.tenant("m64");
  admin = await fixtures.qa.colleague(owner, "ADMIN");
  lead = await fixtures.qa.colleague(owner, "SEO_LEAD");
  member = await fixtures.qa.colleague(owner, "MEMBER");
  viewer = await fixtures.qa.colleague(owner, "VIEWER");
}, 120_000);

afterAll(async () => {
  resetProvider();
  vi.unstubAllEnvs();
  await fixtures.teardown();
  await prisma.$disconnect();
}, 90_000);

function transportThat(script: (request: CmsRequest) => CmsTransportResult): {
  transport: CmsTransport;
  sent: CmsRequest[];
} {
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

const usersMe = (capabilities: unknown) => json({ name: "Ed Editor", capabilities });

async function configure(context: TenantContext = admin) {
  return configureWordPressConnection(context, {
    baseUrl: SITE,
    username: USERNAME,
    applicationPassword: APP_PASSWORD,
  });
}

async function caught(promise: Promise<unknown>): Promise<CmsProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CmsProviderError) return error;
    throw error;
  }
  throw new Error("expected a CmsProviderError");
}

describe("configuring the WordPress connection", () => {
  it("fixes the provider, the auth type and the policy on the server", async () => {
    const saved = await configure();

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: saved.connectionId },
    });
    expect(connection.provider).toBe("WORDPRESS");
    expect(connection.authType).toBe("APPLICATION_PASSWORD");
    expect(connection.baseUrl).toBe(SITE);
    // Saving is not connecting: only a test can prove the site answers.
    expect(connection.status).toBe("CONNECTING");

    const policy = await prisma.publishingPolicy.findFirstOrThrow({
      where: { connectionId: connection.id },
    });
    expect(policy.mode).toBe("DRAFT_ONLY");
  }, 90_000);

  it("refuses an address the SSRF policy will not allow", async () => {
    const refused = [
      "http://cms.example.com",
      // A REST endpoint is not a site address, however well formed.
      "https://cms.example.com/wp-json/wp/v2",
      "https://cms.example.com/WP-JSON",
      "https://127.0.0.1",
      "https://localhost",
      "https://user:pass@cms.example.com",
      "https://169.254.169.254",
      "not a url",
    ];

    for (const baseUrl of refused) {
      const error = await caught(
        configureWordPressConnection(admin, {
          baseUrl,
          username: USERNAME,
          applicationPassword: APP_PASSWORD,
        }),
      );
      expect(error.code).toBe("invalid_site_url");
    }
  }, 90_000);

  it("needs both a username and an application password", async () => {
    for (const input of [
      { username: "", applicationPassword: APP_PASSWORD },
      { username: USERNAME, applicationPassword: "" },
      { username: "   ", applicationPassword: APP_PASSWORD },
    ]) {
      const error = await caught(configureWordPressConnection(admin, { baseUrl: SITE, ...input }));
      expect(error.code).toBe("auth_required");
    }
  }, 90_000);

  it("forgets what the previous credential was permitted to do", async () => {
    await configure();
    const connection = await prisma.connection.findFirstOrThrow({
      where: { websiteId: owner.website.id, provider: "WORDPRESS" },
    });
    await prisma.connectionCapability.create({
      data: {
        websiteId: owner.website.id,
        connectionId: connection.id,
        capability: "CREATE_DRAFT",
        entityType: "POST",
        granted: true,
        source: "wp_users_me",
        checkedAt: new Date(),
      },
    });

    // A new site or a new password means the old permissions prove nothing.
    await configure();

    expect(
      await prisma.connectionCapability.count({ where: { connectionId: connection.id } }),
    ).toBe(0);
  }, 90_000);
});

describe("who may change CMS credentials", () => {
  it("admits an owner and an admin", async () => {
    await expect(configure(owner)).resolves.toBeDefined();
    await expect(configure(admin)).resolves.toBeDefined();
  }, 90_000);

  it("refuses an SEO lead, who may execute but not re-credential", async () => {
    // Deliberately distinct permissions: being allowed to create a draft
    // somebody already approved is not being allowed to point the connection at
    // a different site.
    expect((await caught(configure(lead))).code).toBe("forbidden");
  }, 90_000);

  it("refuses a member, a viewer and the scheduled-jobs actor", async () => {
    const system = await systemContextFor(owner.website.id);
    for (const who of [member, viewer, system]) {
      expect((await caught(configure(who))).code).toBe("forbidden");
    }
  }, 90_000);
});

describe("the application password", () => {
  it("is stored encrypted and never read back by anything that renders", async () => {
    await configure();

    const credential = await prisma.credential.findFirstOrThrow({
      where: { connection: { websiteId: owner.website.id, provider: "WORDPRESS" } },
    });

    // At rest it is ciphertext, and the plaintext is only reachable by decrypting.
    expect(credential.encryptedPayload).not.toContain(APP_PASSWORD);
    expect(JSON.parse(decryptCredential(credential.encryptedPayload))).toMatchObject({
      username: USERNAME,
      applicationPassword: APP_PASSWORD,
    });

    // The reader the pages use exposes neither the secret nor the username.
    const readiness = await getCmsConnectionReadiness(admin);
    const shown = JSON.stringify(readiness);
    expect(readiness.credentialConfigured).toBe(true);
    expect(shown).not.toContain(APP_PASSWORD);
    expect(shown).not.toContain(USERNAME);
    expect(shown).not.toContain(credential.encryptedPayload);
  }, 90_000);

  it("never reaches the audit trail", async () => {
    await configure();

    const audits = await prisma.auditEvent.findMany({
      where: { websiteId: owner.website.id, entityType: "Connection" },
    });
    const recorded = JSON.stringify(audits);

    expect(audits.length).toBeGreaterThan(0);
    expect(recorded).not.toContain(APP_PASSWORD);
    expect(recorded).not.toContain(USERNAME);
    expect(recorded).not.toContain("applicationPassword");
    // The host is not a secret and is worth recording.
    expect(recorded).toContain("cms.example.com");
  }, 90_000);

  it("is a password field that is never given a value", async () => {
    const form = await readFile("src/components/connections/wordpress-controls.tsx", "utf8");
    const field = form.slice(form.indexOf('name="applicationPassword"'));

    expect(field).toContain('type="password"');
    expect(field).toContain('autoComplete="new-password"');
    // A defaultValue or value on this input would put the secret in the HTML.
    const upToClose = field.slice(0, field.indexOf("/>"));
    expect(upToClose).not.toContain("defaultValue");
    expect(upToClose).not.toContain("value=");
    expect(form).toContain("Stored — enter a new one to replace it");
  });

  it("is not echoed back by the action that receives it", async () => {
    const action = await readFile("src/server/actions/cms-drafts.ts", "utf8");

    // The field is read once, passed straight to the service, and never placed
    // into any returned state.
    expect(action).toContain('formData.get("applicationPassword")');
    expect(action).not.toMatch(/return[sS]*?applicationPassword/);
    expect(action).not.toContain("console.");
  });
});

describe("what the connection is permitted to do", () => {
  it("records exactly what WordPress reported, and connects only after a test", async () => {
    const saved = await configure();
    const cms = transportThat(() => usersMe({ read: true, edit_posts: true, edit_pages: false }));

    const outcome = await testCmsConnection(admin, { transport: cms.transport });
    await markConnectionTested(admin, saved.connectionId, { ok: true });

    // Read-only: nothing was created to find out.
    expect(cms.sent.every((request) => request.method === "GET")).toBe(true);
    expect(cms.sent.every((request) => !request.mutating)).toBe(true);
    expect(outcome.accountName).toBe("Ed Editor");

    const readiness = await getCmsConnectionReadiness(admin);
    expect(readiness.status).toBe("CONNECTED");
    expect(readiness.capabilities).toEqual({
      readContent: true,
      createPost: true,
      createPage: false,
    });
    // Only what was granted may be chosen.
    expect(readiness.selectableTargets).toEqual(["POST"]);
    expect(readiness.publishingMode).toBe("DRAFT_ONLY");
    expect(readiness.ready).toBe(true);
  }, 90_000);

  it("leaves a permission WordPress will not confirm as unknown, and unusable", async () => {
    const saved = await configure();
    const cms = transportThat(() => usersMe(undefined));

    await testCmsConnection(admin, { transport: cms.transport });
    await markConnectionTested(admin, saved.connectionId, { ok: true });

    const readiness = await getCmsConnectionReadiness(admin);
    // Asked and not answered is recorded as not granted — never as unknown-so-fine.
    expect(readiness.capabilities.createPost).toBe(false);
    expect(readiness.capabilities.createPage).toBe(false);
    expect(readiness.selectableTargets).toEqual([]);
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain("has not confirmed");
  }, 90_000);

  it("reads as unknown before anything has been asked at all", async () => {
    await configure();

    const readiness = await getCmsConnectionReadiness(admin);
    expect(readiness.capabilities).toEqual({
      readContent: null,
      createPost: null,
      createPage: null,
    });
    expect(readiness.selectableTargets).toEqual([]);
    expect(readiness.ready).toBe(false);
  }, 90_000);

  it("records a failed test as an error rather than a connection", async () => {
    const saved = await configure();
    const cms = transportThat(() => ({ ok: true, status: 401, body: "{}" }));

    await expect(testCmsConnection(admin, { transport: cms.transport })).rejects.toBeInstanceOf(
      CmsProviderError,
    );
    await markConnectionTested(admin, saved.connectionId, {
      ok: false,
      errorCode: "auth_required",
    });

    const readiness = await getCmsConnectionReadiness(admin);
    expect(readiness.status).toBe("ERROR");
    expect(readiness.ready).toBe(false);
  }, 90_000);
});

/**
 * Testing a connection that is not yet connected (M6.4 inline fix).
 *
 * In production a freshly saved connection — CONNECTING, never tested — was
 * answered "This connection is not currently connected" the moment Test was
 * pressed, before WordPress was asked anything. The button's own lookup of
 * the connection used the execution path's rule, which admits only CONNECTED,
 * although the test path's rule admits CONNECTING as well; the test that
 * would have made it CONNECTED could therefore never run. The test path now
 * lives in one service function that finds the connection by its own rule —
 * CONNECTING, ERROR or CONNECTED — and draft creation keeps the strict one.
 */
describe("testing a connection that is not yet connected", () => {
  const status = async (context: TenantContext) =>
    (await getCmsConnectionReadiness(context)).status;

  it("tests a freshly saved CONNECTING connection instead of refusing it", async () => {
    const saved = await configure();
    expect(await status(admin)).toBe("CONNECTING");
    const cms = transportThat(() => usersMe({ read: true, edit_posts: true, edit_pages: true }));

    const result = await requestWordPressConnectionTest(admin, { transport: cms.transport });

    // The production defect: refused before the transport was ever asked.
    expect(result.ok || result.code).not.toBe("connection_disabled");
    expect(cms.sent.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: true, connectionId: saved.connectionId });
    expect(await status(admin)).toBe("CONNECTED");

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: saved.connectionId },
    });
    expect(connection.connectedAt).not.toBeNull();
    expect(connection.lastError).toBeNull();
    const readiness = await getCmsConnectionReadiness(admin);
    expect(readiness.capabilities).toEqual({ readContent: true, createPost: true, createPage: true });
  }, 90_000);

  it("records a failed test as ERROR, with our own code, and never leaves it CONNECTING", async () => {
    const saved = await configure();
    const cms = transportThat(() => ({ ok: true, status: 401, body: "{}" }));

    const result = await requestWordPressConnectionTest(admin, { transport: cms.transport });

    expect(cms.sent.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: false, connectionId: saved.connectionId, code: "auth_required" });
    expect(await status(admin)).toBe("ERROR");
    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: saved.connectionId },
    });
    expect(connection.lastError).toBe("auth_required");
    expect(JSON.stringify(result)).not.toContain(APP_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(USERNAME);
  }, 90_000);

  it("can be tested again from ERROR, and from CONNECTED", async () => {
    const saved = await configure();
    const failing = transportThat(() => ({ ok: true, status: 401, body: "{}" }));
    await requestWordPressConnectionTest(admin, { transport: failing.transport });
    expect(await status(admin)).toBe("ERROR");

    // The password is corrected in WordPress; the next test succeeds.
    const working = transportThat(() => usersMe({ read: true, edit_posts: true, edit_pages: false }));
    const recovered = await requestWordPressConnectionTest(admin, { transport: working.transport });
    expect(recovered.ok).toBe(true);
    expect(await status(admin)).toBe("CONNECTED");

    // Already connected: a re-test still runs, and replaces what was reported.
    const narrower = transportThat(() => usersMe({ read: true, edit_posts: false, edit_pages: false }));
    const again = await requestWordPressConnectionTest(admin, { transport: narrower.transport });
    expect(again).toMatchObject({ ok: true, connectionId: saved.connectionId });
    expect(narrower.sent.length).toBeGreaterThan(0);
    const readiness = await getCmsConnectionReadiness(admin);
    expect(readiness.capabilities).toEqual({ readContent: true, createPost: false, createPage: false });
  }, 90_000);

  it("keeps draft creation on the strict rule: CONNECTING and ERROR are refused, CONNECTED is not", async () => {
    await configure();
    // The lookup the execution path makes, with its default options.
    expect((await caught(loadWordPressConnection(admin))).code).toBe("connection_disabled");

    const failing = transportThat(() => ({ ok: true, status: 401, body: "{}" }));
    await requestWordPressConnectionTest(admin, { transport: failing.transport });
    expect(await status(admin)).toBe("ERROR");
    expect((await caught(loadWordPressConnection(admin))).code).toBe("connection_disabled");

    const working = transportThat(() => usersMe({ read: true, edit_posts: true, edit_pages: true }));
    await requestWordPressConnectionTest(admin, { transport: working.transport });
    await expect(loadWordPressConnection(admin)).resolves.toBeDefined();
  }, 90_000);

  it("fails safely without a configured connection", async () => {
    await prisma.connection.deleteMany({ where: { websiteId: owner.website.id, provider: "WORDPRESS" } });
    const cms = transportThat(() => usersMe({ read: true }));

    const result = await requestWordPressConnectionTest(admin, { transport: cms.transport });

    expect(result).toEqual({ ok: false, connectionId: null, code: "not_configured" });
    expect(cms.sent).toHaveLength(0);
  }, 90_000);

  it("refuses everyone below admin and the scheduled-jobs actor, before any transport", async () => {
    await configure();
    const cms = transportThat(() => usersMe({ read: true }));
    const system = await systemContextFor(owner.website.id);

    for (const who of [lead, member, viewer, system]) {
      const result = await requestWordPressConnectionTest(who, { transport: cms.transport });
      expect(result).toEqual({ ok: false, connectionId: null, code: "forbidden" });
    }
    expect(cms.sent).toHaveLength(0);
    expect(await status(admin)).toBe("CONNECTING");
  }, 90_000);

  it("carries no credential into the result, the log, or the audit trail", async () => {
    const saved = await configure();
    const cms = transportThat(() => usersMe({ read: true, edit_posts: true, edit_pages: true }));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    let result;
    try {
      result = await requestWordPressConnectionTest(admin, { transport: cms.transport });
    } finally {
      spy.mockRestore();
    }

    for (const text of [JSON.stringify(result), lines.join("\n")]) {
      expect(text).not.toContain(APP_PASSWORD);
      expect(text).not.toContain(USERNAME);
    }
    const events = await prisma.auditEvent.findMany({
      where: { entityType: "Connection", entityId: saved.connectionId },
    });
    for (const event of events) {
      const payload = JSON.stringify([event.beforeSnapshotJson, event.afterSnapshotJson]);
      expect(payload).not.toContain(APP_PASSWORD);
      expect(payload).not.toContain(USERNAME);
    }
    // Capabilities are exactly what the transport reported, and nothing more.
    expect((await getCmsConnectionReadiness(admin)).capabilities).toEqual({
      readContent: true,
      createPost: true,
      createPage: true,
    });
  }, 90_000);
});

describe("nothing in the interface publishes", () => {
  const surfaces = [
    "src/app/websites/[websiteId]/cms-drafts/page.tsx",
    "src/app/websites/[websiteId]/connections/page.tsx",
    "src/components/execution/cms-draft-controls.tsx",
    "src/components/connections/wordpress-controls.tsx",
    "src/server/actions/cms-drafts.ts",
  ];

  it("offers no publish, schedule, update or delete control anywhere", async () => {
    for (const path of surfaces) {
      const source = await readFile(path, "utf8");

      // No control that would publish, schedule or destroy anything.
      expect(source).not.toMatch(/name="status"/);
      expect(source).not.toMatch(/value="publish"/);
      expect(source).not.toMatch(/publishAction|schedulePublish|updateLive|deleteEntity/);
      expect(source).not.toMatch(/>\s*Publish\s*</);
      expect(source).not.toMatch(/>\s*Schedule\s*</);
      expect(source).not.toMatch(/>\s*Delete\s*</);
      // Nor a way to write a plugin's SEO field. Naming them in prose is the
      // disclosure §25 asks for; what must not exist is a field or an action.
      expect(source).not.toMatch(/name="(yoast|rank_math)[^"]*"/i);
      expect(source).not.toMatch(/yoast_head|rank_math_title|rank_math_description/i);
    }
  });

  it("keeps Publishing in the navigation as coming next, not as a link", async () => {
    const nav = await readFile("src/components/shell/website-nav.tsx", "utf8");

    expect(nav).toContain('{ slug: "cms-drafts", label: "CMS Drafts" }');
    expect(nav).toContain('{ slug: "publishing", label: "Publishing", comingNext: true }');
    // CMS Drafts sits between QA and Publishing.
    expect(nav.indexOf('"qa"')).toBeLessThan(nav.indexOf('"cms-drafts"'));
    expect(nav.indexOf('"cms-drafts"')).toBeLessThan(nav.indexOf('"publishing"'));
  });

  it("says plainly what it does not do", async () => {
    const page = await readFile("src/app/websites/[websiteId]/cms-drafts/page.tsx", "utf8");

    expect(page).toContain("it does not publish");
    expect(page).toContain("Does not publish, schedule, or change a page that already exists");
    expect(page).toContain("Does not write Yoast, Rank Math or other plugin SEO fields");
    // The distinctions that must not blur.
    expect(page).toContain("SEO plugin metadata: not written in this version");
  });

  it("states DRAFT ONLY and the limits on the connection card", async () => {
    const page = await readFile("src/app/websites/[websiteId]/connections/page.tsx", "utf8");

    expect(page).toContain("DRAFT ONLY");
    expect(page).toContain("Application Password");
    expect(page).toContain("It does not publish the page");
    expect(page).toContain("Publishing is not available in this version");
    // No control that could widen the policy.
    expect(page).not.toContain("DRAFT_AND_UPDATE");
    expect(page).not.toContain("PUBLISH_WITH_APPROVAL");
    expect(page).not.toContain("FULL_PUBLISH");
  });

  it("does not present the confirmation as a generic OK", async () => {
    const controls = await readFile("src/components/execution/cms-draft-controls.tsx", "utf8");

    expect(controls).toContain("This will create a new");
    expect(controls).toContain("SEO OS will not publish it.");
    expect(controls).toContain("CREATE_WORDPRESS_DRAFT");
    expect(controls).toContain("Cancel");
    expect(controls).not.toMatch(/>\s*OK\s*</);
    // The disabled state is comfort, not safety, and the comment says so.
    expect(controls).toContain("It is not the safety mechanism");
  });
});
