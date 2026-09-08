import { describe, expect, it } from "vitest";

import { parseCmsBaseUrl, type CanonicalSiteUrl } from "@/lib/cms/url";
import { basicAuthHeader, createTransport } from "@/server/connectors/wordpress/transport";
import type { CmsRequest } from "@/server/connectors/wordpress/types";

/**
 * The only way a CMS request leaves this process (M6.2 §4, §9, §10, §26).
 *
 * Two guarantees are tested here and both are release blocking. A request only
 * ever goes to an address the SSRF policy has approved, including after a
 * redirect. And a failed create is never reported as a clean failure unless the
 * transport can prove nothing was transmitted — because the caller's next
 * decision, whether to send again, turns entirely on that flag.
 *
 * No network: fetch and the DNS resolver are both injected.
 */

const site = ((): CanonicalSiteUrl => {
  const parsed = parseCmsBaseUrl("https://cms.example.com");
  if (!parsed.ok) throw new Error("fixture base URL should parse");
  return parsed.value;
})();

const PUBLIC_IP = "93.184.216.34";
const PRIVATE_IP = "10.0.0.7";
const METADATA_IP = "169.254.169.254";

const publicDns = async () => [PUBLIC_IP];

/** A resolver that answers differently each time it is called. */
function dnsSequence(...answers: string[][]) {
  let call = 0;
  return async () => answers[Math.min(call++, answers.length - 1)]!;
}

function get(url = `${site.href}/wp-json/wp/v2/posts/1`): CmsRequest {
  return { method: "GET", url, headers: {}, mutating: false };
}

function post(url = `${site.href}/wp-json/wp/v2/posts`): CmsRequest {
  return { method: "POST", url, headers: {}, body: "{}", mutating: true };
}

function ok(body = "{}", status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function redirect(location: string, status = 301): Response {
  return new Response("", { status, headers: { location } });
}

/** An error carrying a node error code, the way undici reports a socket failure. */
function nodeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("where a request is allowed to go", () => {
  it("resolves the host and refuses a private answer before opening a socket", async () => {
    let dialled = false;
    const transport = createTransport({
      site,
      resolve: async () => [PRIVATE_IP],
      fetchImpl: (async () => {
        dialled = true;
        return ok();
      }) as unknown as typeof fetch,
    });

    const result = await transport(post());

    expect(result).toEqual({ ok: false, sent: false, code: "cms_unreachable" });
    // Nothing was transmitted, so this is provably safe to try again.
    expect(dialled).toBe(false);
  });

  it("refuses a cloud metadata address the same way", async () => {
    const transport = createTransport({
      site,
      resolve: async () => [METADATA_IP],
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
    });

    expect(await transport(get())).toMatchObject({ ok: false, sent: false });
  });

  it("refuses when any one of several answers is private", async () => {
    const transport = createTransport({
      site,
      // A name that resolves to both cannot be dialled safely: we do not choose
      // which address the socket uses.
      resolve: async () => [PUBLIC_IP, PRIVATE_IP],
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
    });

    expect(await transport(get())).toMatchObject({ ok: false, sent: false });
  });

  it("passes a public destination through and returns the body", async () => {
    const transport = createTransport({
      site,
      resolve: publicDns,
      fetchImpl: (async () => ok('{"id":7}')) as unknown as typeof fetch,
    });

    expect(await transport(get())).toEqual({ ok: true, status: 200, body: '{"id":7}' });
  });
});

describe("redirects", () => {
  it("follows one to the same host, re-checking the destination", async () => {
    const seen: string[] = [];
    const transport = createTransport({
      site,
      resolve: publicDns,
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return seen.length === 1 ? redirect(`${site.href}/wp-json/wp/v2/posts/2`) : ok('{"id":2}');
      }) as unknown as typeof fetch,
    });

    const result = await transport(get());

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(seen).toEqual([
      `${site.href}/wp-json/wp/v2/posts/1`,
      `${site.href}/wp-json/wp/v2/posts/2`,
    ]);
  });

  it("refuses one to another host, and calls a create ambiguous", async () => {
    let calls = 0;
    const transport = createTransport({
      site,
      resolve: publicDns,
      fetchImpl: (async () => {
        calls += 1;
        return redirect("https://elsewhere.example.org/wp-json/wp/v2/posts");
      }) as unknown as typeof fetch,
    });

    // The POST reached something that answered. What it did with it is unknown.
    expect(await transport(post())).toEqual({
      ok: false,
      sent: true,
      code: "create_ambiguous",
    });
    expect(calls).toBe(1);
  });

  it("refuses a same-host redirect whose address has become private", async () => {
    const transport = createTransport({
      site,
      // Public on the first check, private on the second: a rebind between the
      // original request and the redirect.
      resolve: dnsSequence([PUBLIC_IP], [PRIVATE_IP]),
      fetchImpl: (async () =>
        redirect(`${site.href}/wp-json/wp/v2/posts/9`)) as unknown as typeof fetch,
    });

    expect(await transport(get())).toEqual({ ok: false, sent: false, code: "cms_unreachable" });
  });

  it("stops after the ceiling rather than following a loop", async () => {
    let calls = 0;
    const transport = createTransport({
      site,
      resolve: publicDns,
      fetchImpl: (async () => {
        calls += 1;
        return redirect(`${site.href}/wp-json/wp/v2/posts/${calls}`);
      }) as unknown as typeof fetch,
    });

    expect(await transport(get())).toMatchObject({ ok: false, code: "cms_unreachable" });
    expect(calls).toBeLessThanOrEqual(4);
  });
});

describe("whether a failed request may have been transmitted", () => {
  const cases: [string, boolean][] = [
    // Connection never established: nothing could have arrived.
    ["ENOTFOUND", false],
    ["EAI_AGAIN", false],
    ["ECONNREFUSED", false],
    ["EHOSTUNREACH", false],
    ["ENETUNREACH", false],
    // The socket was open. Anything after that may have been received.
    ["ECONNRESET", true],
    ["ETIMEDOUT", true],
    ["EPIPE", true],
  ];

  for (const [code, mayHaveSent] of cases) {
    it(`${code} on a create is ${mayHaveSent ? "ambiguous" : "provably unsent"}`, async () => {
      const transport = createTransport({
        site,
        resolve: publicDns,
        fetchImpl: (async () => {
          throw nodeError(code);
        }) as unknown as typeof fetch,
      });

      expect(await transport(post())).toEqual({
        ok: false,
        sent: mayHaveSent,
        code: mayHaveSent ? "create_ambiguous" : "cms_unreachable",
      });
    });
  }

  it("reads a node code carried on the error's cause, as undici reports it", async () => {
    const transport = createTransport({
      site,
      resolve: publicDns,
      fetchImpl: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: nodeError("ECONNREFUSED") });
      }) as unknown as typeof fetch,
    });

    expect(await transport(post())).toMatchObject({ sent: false, code: "cms_unreachable" });
  });

  it("treats an unrecognised failure as possibly sent, which is the safe direction", async () => {
    const transport = createTransport({
      site,
      resolve: publicDns,
      fetchImpl: (async () => {
        throw new Error("something nobody has seen before");
      }) as unknown as typeof fetch,
    });

    expect(await transport(post())).toMatchObject({ sent: true, code: "create_ambiguous" });
  });

  it("times out an unanswered create as ambiguous rather than failed", async () => {
    const transport = createTransport({
      site,
      resolve: publicDns,
      timeoutMs: 10,
      fetchImpl: ((_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        })) as unknown as typeof fetch,
    });

    expect(await transport(post())).toMatchObject({ sent: true, code: "create_ambiguous" });
  });

  it("times out a read as a plain failure: a GET changes nothing", async () => {
    const transport = createTransport({
      site,
      resolve: publicDns,
      timeoutMs: 10,
      fetchImpl: ((_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        })) as unknown as typeof fetch,
    });

    expect(await transport(get())).toMatchObject({ sent: false, code: "cms_unreachable" });
  });

  it("never retries anything by itself", async () => {
    let calls = 0;
    const transport = createTransport({
      site,
      resolve: publicDns,
      fetchImpl: (async () => {
        calls += 1;
        throw nodeError("ECONNRESET");
      }) as unknown as typeof fetch,
    });

    await transport(post());
    expect(calls).toBe(1);
  });
});

describe("the Basic header", () => {
  it("is built from the credential at the moment of use", () => {
    const header = basicAuthHeader("editor", "abcd EFGH ijkl");
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.slice(6), "base64").toString("utf8")).toBe("editor:abcd EFGH ijkl");
  });

  it("is carried on the request and nowhere else", async () => {
    let received: Record<string, string> | undefined;
    const transport = createTransport({
      site,
      resolve: publicDns,
      fetchImpl: (async (_url: string, init: { headers?: Record<string, string> }) => {
        received = init.headers;
        return ok();
      }) as unknown as typeof fetch,
    });

    const result = await transport({
      ...get(),
      headers: { Authorization: basicAuthHeader("editor", "s3cret") },
    });

    expect(received?.Authorization).toMatch(/^Basic /);
    // Whatever comes back holds the body and the status, and no header at all.
    expect(JSON.stringify(result)).not.toContain("Basic ");
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });
});
