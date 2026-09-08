import { describe, expect, it } from "vitest";

import { parseCmsBaseUrl, type CanonicalSiteUrl } from "@/lib/cms/url";
import { WordPressProvider, safeLink } from "@/server/connectors/wordpress/client";
import {
  CmsProviderError,
  type CmsRequest,
  type CmsTransportResult,
  type CreateDraftInput,
  type ProviderContext,
} from "@/server/connectors/wordpress/types";

/**
 * The WordPress adapter, driven by controlled responses (M6.2 §6, §12, §23, §26).
 *
 * What it must send: core fields only, a status that is the literal "draft",
 * and an endpoint chosen by the entity type rather than by a caller. What it
 * must never send: a publish, a date, or a field belonging to a plugin nobody
 * has confirmed is installed.
 *
 * What it must make of an answer: an id or it was not a success; a status
 * WordPress reports rather than the one we asked for; and an HTTP code turned
 * into our vocabulary without ever reading the body for meaning.
 */

const site = ((): CanonicalSiteUrl => {
  const parsed = parseCmsBaseUrl("https://cms.example.com");
  if (!parsed.ok) throw new Error("fixture base URL should parse");
  return parsed.value;
})();

const provider = new WordPressProvider();

const APPLICATION_PASSWORD = "abcd EFGH ijkl MNOP";

type Scripted = (request: CmsRequest) => CmsTransportResult;

/** A provider context whose transport answers from a script and records calls. */
function contextWith(script: Scripted): { context: ProviderContext; sent: CmsRequest[] } {
  const sent: CmsRequest[] = [];
  return {
    sent,
    context: {
      site,
      credential: { username: "editor", applicationPassword: APPLICATION_PASSWORD },
      transport: async (request) => {
        sent.push(request);
        return script(request);
      },
    },
  };
}

const json = (body: unknown, status = 200): CmsTransportResult => ({
  ok: true,
  status,
  body: JSON.stringify(body),
});

const draftResponse = (over: Record<string, unknown> = {}) => ({
  id: 41,
  status: "draft",
  title: { raw: "A title", rendered: "A title" },
  content: { raw: "<p>Body</p>", rendered: "<p>Body</p>" },
  excerpt: { raw: "A summary", rendered: "A summary" },
  slug: "a-title",
  link: "https://cms.example.com/a-title",
  ...over,
});

const input: CreateDraftInput = {
  entityType: "POST",
  title: "A title",
  slug: "a-title",
  contentHtml: "<p>Body</p>",
  excerpt: "A summary",
};

async function caught(promise: Promise<unknown>): Promise<CmsProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CmsProviderError) return error;
    throw error;
  }
  throw new Error("expected a CmsProviderError");
}

describe("what a create sends", () => {
  it("posts to the endpoint for the entity type", async () => {
    for (const [entityType, path] of [
      ["POST", "/wp-json/wp/v2/posts"],
      ["PAGE", "/wp-json/wp/v2/pages"],
    ] as const) {
      const { context, sent } = contextWith(() => json(draftResponse()));
      await provider.createDraft(context, { ...input, entityType });

      expect(sent).toHaveLength(1);
      expect(sent[0]!.method).toBe("POST");
      expect(new URL(sent[0]!.url).pathname).toBe(path);
      expect(new URL(sent[0]!.url).origin).toBe(site.href);
      expect(sent[0]!.mutating).toBe(true);
    }
  });

  it("sends core fields only, with the status fixed to draft", async () => {
    const { context, sent } = contextWith(() => json(draftResponse()));
    await provider.createDraft(context, input);

    const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>;
    expect(body).toEqual({
      title: "A title",
      content: "<p>Body</p>",
      status: "draft",
      slug: "a-title",
      excerpt: "A summary",
    });
  });

  it("omits a slug and an excerpt it was not given, rather than sending empties", async () => {
    const { context, sent } = contextWith(() => json(draftResponse()));
    await provider.createDraft(context, { ...input, slug: null, excerpt: null });

    const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["content", "status", "title"]);
  });

  it("never sends a publish, a date, or a plugin's field", async () => {
    const { context, sent } = contextWith(() => json(draftResponse()));
    await provider.createDraft(context, {
      ...input,
      // Even a title that looks like an instruction is only ever a title.
      title: "status: publish",
    });

    const raw = sent[0]!.body!;
    const body = JSON.parse(raw) as Record<string, unknown>;

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
      "yoast_head_json",
      "rank_math_title",
      "rank_math_description",
      "acf",
      "meta_title",
      "meta_description",
      "schema",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    // The literal appears once, as the value of status, and nowhere else.
    expect(raw.match(/"publish"/g)).toBeNull();
  });

  it("carries a Basic header on every request", async () => {
    const { context, sent } = contextWith(() => json(draftResponse()));
    await provider.createDraft(context, input);

    const header = sent[0]!.headers.Authorization!;
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.slice(6), "base64").toString("utf8")).toBe(
      `editor:${APPLICATION_PASSWORD}`,
    );
    expect(sent[0]!.headers["Content-Type"]).toBe("application/json");
  });
});

describe("what a create makes of the answer", () => {
  it("returns the entity WordPress describes", async () => {
    const { context } = contextWith(() => json(draftResponse()));
    const entity = await provider.createDraft(context, input);

    expect(entity).toEqual({
      externalId: "41",
      status: "draft",
      title: "A title",
      content: "<p>Body</p>",
      excerpt: "A summary",
      slug: "a-title",
      url: "https://cms.example.com/a-title",
    });
  });

  it("keeps the id when WordPress answers with a status we did not ask for", async () => {
    // Losing the id here would leave a real post that nothing points at. It is
    // returned, and the caller records the status mismatch against it.
    const { context } = contextWith(() => json(draftResponse({ status: "publish" })));
    const entity = await provider.createDraft(context, input);

    expect(entity.externalId).toBe("41");
    expect(entity.status).toBe("publish");
  });

  it("prefers what WordPress stored over what it rendered", async () => {
    const { context } = contextWith(() =>
      json(
        draftResponse({
          title: { raw: "Stored", rendered: "Ren&#8211;dered" },
          content: { raw: "<p>Stored</p>", rendered: "<p>Ren&#8211;dered</p>" },
        }),
      ),
    );
    const entity = await provider.createDraft(context, input);

    expect(entity.title).toBe("Stored");
    expect(entity.content).toBe("<p>Stored</p>");
  });

  it("refuses an answer with no id: a create that cannot name what it made", async () => {
    const { context } = contextWith(() => json({ status: "draft", title: "A title" }));
    expect((await caught(provider.createDraft(context, input))).code).toBe("cms_invalid_response");
  });

  it("refuses an answer with no status", async () => {
    const { context } = contextWith(() => json({ id: 41, title: "A title" }));
    expect((await caught(provider.createDraft(context, input))).code).toBe("cms_invalid_response");
  });

  it("refuses a body that is not JSON at all", async () => {
    const { context } = contextWith(() => ({ ok: true, status: 200, body: "<html>oops</html>" }));
    expect((await caught(provider.createDraft(context, input))).code).toBe("cms_invalid_response");
  });
});

describe("turning an HTTP status into our vocabulary", () => {
  const cases: [number, string, boolean][] = [
    [401, "auth_required", false],
    [403, "cms_permission_denied", false],
    [429, "rate_limited", false],
    [400, "cms_client_error", false],
    // WordPress may have written the row and failed afterwards.
    [500, "cms_server_error", true],
    [503, "cms_server_error", true],
  ];

  for (const [status, code, ambiguous] of cases) {
    it(`maps ${status} on a create to ${code}${ambiguous ? " and calls it ambiguous" : ""}`, async () => {
      const { context } = contextWith(() => ({ ok: true, status, body: "{}" }));
      const error = await caught(provider.createDraft(context, input));

      expect(error.code).toBe(code);
      expect(error.ambiguous).toBe(ambiguous);
      expect(error.httpStatus).toBe(status);
    });
  }

  it("reads 404 by method: a missing route on a create, a missing entity on a read", async () => {
    const notFound = () => ({ ok: true as const, status: 404, body: "{}" });

    const create = contextWith(notFound);
    expect((await caught(provider.createDraft(create.context, input))).code).toBe(
      "cms_client_error",
    );

    const read = contextWith(notFound);
    expect((await caught(provider.getEntity(read.context, "POST", "41"))).code).toBe(
      "entity_not_found",
    );
  });

  it("passes the transport's own verdict through, including whether it was sent", async () => {
    const unsent = contextWith(() => ({ ok: false, sent: false, code: "cms_unreachable" }));
    const clean = await caught(provider.createDraft(unsent.context, input));
    expect(clean.code).toBe("cms_unreachable");
    expect(clean.ambiguous).toBe(false);

    const maybe = contextWith(() => ({ ok: false, sent: true, code: "create_ambiguous" }));
    const unknown = await caught(provider.createDraft(maybe.context, input));
    expect(unknown.ambiguous).toBe(true);
  });

  it("never treats a failed read as ambiguous: a GET creates nothing", async () => {
    const { context } = contextWith(() => ({ ok: false, sent: true, code: "cms_unreachable" }));
    expect((await caught(provider.getEntity(context, "POST", "41"))).ambiguous).toBe(false);
  });
});

describe("reading an entity back", () => {
  it("asks the endpoint for the type, by id, and does not mutate", async () => {
    const { context, sent } = contextWith(() => json(draftResponse()));
    await provider.getEntity(context, "PAGE", "41");

    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.mutating).toBe(false);
    expect(new URL(sent[0]!.url).pathname).toBe("/wp-json/wp/v2/pages/41");
  });

  it("refuses an id that is not a WordPress id, rather than building a URL from it", async () => {
    const { context, sent } = contextWith(() => json(draftResponse()));

    for (const id of ["../../wp-admin", "41 OR 1=1", "sim-1", ""]) {
      expect((await caught(provider.getEntity(context, "POST", id))).code).toBe("target_invalid");
    }
    expect(sent).toHaveLength(0);
  });
});

describe("the link a draft comes back with", () => {
  it("keeps a plain permalink", () => {
    expect(safeLink("https://cms.example.com/a-title")).toBe("https://cms.example.com/a-title");
  });

  it("refuses one carrying a preview nonce, which is a credential we cannot expire", () => {
    expect(safeLink("https://cms.example.com/?p=41&preview=true&_wpnonce=abc123")).toBeNull();
    expect(safeLink("https://cms.example.com/a#token=abc")).toBeNull();
    expect(safeLink("https://user:pass@cms.example.com/a")).toBeNull();
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
});

describe("what the credentials are known to permit", () => {
  const usersMe = (capabilities: unknown) => json({ name: "Ed Editor", capabilities });

  it("reads the capability map WordPress returns, without writing anything", async () => {
    const { context, sent } = contextWith(() =>
      usersMe({ read: true, edit_posts: true, edit_pages: false }),
    );

    const result = await provider.testConnection(context);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.mutating).toBe(false);
    expect(new URL(sent[0]!.url).pathname).toBe("/wp-json/wp/v2/users/me");
    expect(new URL(sent[0]!.url).searchParams.get("context")).toBe("edit");

    expect(result.accountName).toBe("Ed Editor");
    expect(result.capabilities).toEqual([
      { capability: "READ_CONTENT", entityType: null, granted: true, source: "wp_users_me" },
      { capability: "CREATE_DRAFT", entityType: "POST", granted: true, source: "wp_users_me" },
      { capability: "CREATE_DRAFT", entityType: "PAGE", granted: false, source: "wp_users_me" },
    ]);
  });

  it("grants nothing when WordPress does not say, rather than assuming from a 200", async () => {
    const { context } = contextWith(() => usersMe(undefined));
    const result = await provider.testConnection(context);

    expect(result.capabilities.every((capability) => !capability.granted)).toBe(true);
    // The source records that we asked and got no answer. It is never "assumed".
    expect(new Set(result.capabilities.map((c) => c.source))).toEqual(
      new Set(["wp_users_me_absent"]),
    );
  });

  it("treats a capability of any value other than true as not granted", async () => {
    const { context } = contextWith(() =>
      usersMe({ read: "yes", edit_posts: 1, edit_pages: null }),
    );
    const result = await provider.testConnection(context);
    expect(result.capabilities.every((capability) => !capability.granted)).toBe(true);
  });

  it("never asks for PUBLISH, which M6 does not implement", async () => {
    const { context } = contextWith(() => usersMe({ read: true, publish_posts: true }));
    const result = await provider.testConnection(context);
    expect(result.capabilities.map((c) => c.capability)).not.toContain("PUBLISH");
  });
});

describe("searching for a draft an ambiguous attempt may have left", () => {
  const window = {
    after: new Date("2026-09-08T10:00:00Z"),
    before: new Date("2026-09-08T10:15:00Z"),
  };

  it("searches this connection, this type, drafts only, inside the window", async () => {
    const { context, sent } = contextWith(() => json([draftResponse()]));
    await provider.reconcileCreate(context, input, window);

    const url = new URL(sent[0]!.url);
    expect(sent[0]!.mutating).toBe(false);
    expect(url.pathname).toBe("/wp-json/wp/v2/posts");
    expect(url.searchParams.get("status")).toBe("draft");
    expect(url.searchParams.get("after")).toBe(window.after.toISOString());
    expect(url.searchParams.get("before")).toBe(window.before.toISOString());
    expect(url.searchParams.get("search")).toBe("A title");
  });

  it("returns every candidate rather than choosing one", async () => {
    const { context } = contextWith(() =>
      json([draftResponse(), draftResponse({ id: 42, slug: "a-title-2" })]),
    );
    const candidates = await provider.reconcileCreate(context, input, window);
    expect(candidates.map((candidate) => candidate.entity.externalId)).toEqual(["41", "42"]);
  });

  it("skips a row it cannot read without failing the whole search", async () => {
    // A search that throws would turn an ambiguous create into an unresolvable one.
    const { context } = contextWith(() => json([{ nonsense: true }, draftResponse()]));
    const candidates = await provider.reconcileCreate(context, input, window);
    expect(candidates.map((candidate) => candidate.entity.externalId)).toEqual(["41"]);
  });

  it("refuses an answer that is not a list", async () => {
    const { context } = contextWith(() => json({ id: 41 }));
    expect((await caught(provider.reconcileCreate(context, input, window))).code).toBe(
      "cms_invalid_response",
    );
  });
});
