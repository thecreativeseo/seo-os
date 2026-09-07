import { describe, expect, it } from "vitest";

import {
  classifyHttpStatus,
  fetchSitemap,
  SITEMAP_ERROR_MESSAGES,
  SitemapError,
  type SitemapFetchError,
} from "@/server/connectors/sitemap/fetch";
import { discoverSitemapsFromRobots } from "@/server/connectors/sitemap/robots";

/**
 * Sitemap fetching over an injected transport.
 *
 * The production symptom that prompted these: a WordPress site served its
 * robots-declared sitemap with an HTTP 404 and a valid XML body, and SEO OS
 * reported a bare "http_error" that told nobody whether the URL was wrong, the
 * server was down, or the body was junk. Every path a real server can take is
 * pinned here without a network, so the classification cannot quietly regress.
 */

const HOST = "example.com";

type FetchInit = { signal?: AbortSignal };

function res(
  body: string,
  init: { status?: number; contentType?: string; contentLength?: string } = {},
): Response {
  const headers: Record<string, string> = {
    "content-type": init.contentType ?? "application/xml; charset=UTF-8",
  };
  if (init.contentLength) headers["content-length"] = init.contentLength;
  return new Response(body, { status: init.status ?? 200, headers });
}

/** A transport that answers known URLs and 404s the rest, ignoring the signal. */
function router(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const make = routes[url];
    return make
      ? make()
      : new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

/** A transport that never resolves until its request is aborted. */
const hangingFetch = ((_input: string | URL, init?: FetchInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
  })) as unknown as typeof fetch;

const urlsetXml = (paths: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `<url><loc>https://${HOST}${p}</loc></url>`).join("\n")}
</urlset>`;

const indexXml = (children: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("\n")}
</sitemapindex>`;

const ROOT = `https://${HOST}/sitemap.xml`;

async function caught(promise: Promise<unknown>): Promise<SitemapError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SitemapError) return error;
    throw error;
  }
  throw new Error("expected the fetch to throw");
}

describe("classifyHttpStatus", () => {
  it("names each family the product can act on", () => {
    expect(classifyHttpStatus(404)).toBe("not_found");
    expect(classifyHttpStatus(410)).toBe("not_found");
    expect(classifyHttpStatus(401)).toBe("forbidden");
    expect(classifyHttpStatus(403)).toBe("forbidden");
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(500)).toBe("server_error");
    expect(classifyHttpStatus(503)).toBe("server_error");
    expect(classifyHttpStatus(301)).toBe("redirect");
    // An unusual status is not force-fit into a family it does not belong to.
    expect(classifyHttpStatus(418)).toBe("http_error");
  });
});

describe("fetching a single sitemap", () => {
  it("reads a valid urlset", async () => {
    const result = await fetchSitemap(ROOT, HOST, {
      fetchImpl: router({ [ROOT]: () => res(urlsetXml(["/", "/pricing"])) }),
    });
    expect(result.urls).toHaveLength(2);
    expect(result.urls.some((u) => u.includes("/pricing"))).toBe(true);
  });

  it("accepts a valid sitemap served under a non-XML content type", async () => {
    // The body is what matters. A server that labels its sitemap text/plain is
    // careless, not wrong, and Google reads it too.
    const result = await fetchSitemap(ROOT, HOST, {
      fetchImpl: router({
        [ROOT]: () => res(urlsetXml(["/a"]), { contentType: "text/plain" }),
      }),
    });
    expect(result.urls).toHaveLength(1);
  });
});

describe("sitemap index traversal", () => {
  const childA = `https://${HOST}/child-a.xml`;
  const childB = `https://${HOST}/child-b.xml`;

  it("follows an index to its children", async () => {
    const result = await fetchSitemap(ROOT, HOST, {
      fetchImpl: router({
        [ROOT]: () => res(indexXml([childA, childB])),
        [childA]: () => res(urlsetXml(["/a1", "/a2"])),
        [childB]: () => res(urlsetXml(["/b1"])),
      }),
    });
    expect(result.nestedSitemaps).toBe(2);
    expect(result.urls).toHaveLength(3);
  });

  it("de-duplicates a URL listed in more than one child", async () => {
    const result = await fetchSitemap(ROOT, HOST, {
      fetchImpl: router({
        [ROOT]: () => res(indexXml([childA, childB])),
        [childA]: () => res(urlsetXml(["/dup", "/a1"])),
        [childB]: () => res(urlsetXml(["/dup", "/b1"])),
      }),
    });
    expect(result.urls).toHaveLength(3);
  });

  it("refuses to descend a second level of index", async () => {
    const nestedIndex = `https://${HOST}/nested-index.xml`;
    const result = await fetchSitemap(ROOT, HOST, {
      fetchImpl: router({
        [ROOT]: () => res(indexXml([nestedIndex])),
        [nestedIndex]: () => res(indexXml([childA])),
      }),
    });
    expect(result.urls).toHaveLength(0);
    expect(result.skipped.some((s) => s.reason === "nested_too_deep")).toBe(true);
  });

  it("skips a child sitemap on another host without fetching it", async () => {
    const foreign = "https://cdn.elsewhere.com/x.xml";
    let foreignFetched = false;
    const result = await fetchSitemap(ROOT, HOST, {
      fetchImpl: (async (input: string | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === foreign) foreignFetched = true;
        if (url === ROOT) return res(indexXml([foreign]));
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch,
    });
    expect(foreignFetched).toBe(false);
    expect(result.urls).toHaveLength(0);
    expect(result.skipped.some((s) => s.url === foreign)).toBe(true);
  });
});

describe("HTTP failure classification", () => {
  const cases: [number, SitemapFetchError][] = [
    [404, "not_found"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [500, "server_error"],
  ];

  for (const [status, code] of cases) {
    it(`classifies HTTP ${status} as ${code} and keeps the status`, async () => {
      const error = await caught(
        fetchSitemap(ROOT, HOST, {
          fetchImpl: router({ [ROOT]: () => res("", { status }) }),
        }),
      );
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    });
  }

  it("refuses a redirect rather than chasing it past the SSRF guard", async () => {
    const error = await caught(
      fetchSitemap(ROOT, HOST, {
        fetchImpl: router({
          [ROOT]: () =>
            new Response("", {
              status: 301,
              headers: { location: "https://example.com/moved.xml" },
            }),
        }),
      }),
    );
    expect(error.code).toBe("redirect");
    expect(error.status).toBe(301);
  });

  it("reports a timeout distinctly from a connection failure", async () => {
    const error = await caught(
      fetchSitemap(ROOT, HOST, { fetchImpl: hangingFetch, timeoutMs: 10 }),
    );
    expect(error.code).toBe("timeout");
  });

  it("reports an unreachable host when the transport rejects", async () => {
    const error = await caught(
      fetchSitemap(ROOT, HOST, {
        fetchImpl: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      }),
    );
    expect(error.code).toBe("unreachable");
  });
});

describe("a 200 that is not a sitemap", () => {
  it("rejects an HTML page as the wrong kind of content", async () => {
    const error = await caught(
      fetchSitemap(ROOT, HOST, {
        fetchImpl: router({
          [ROOT]: () =>
            res("<!doctype html><html><body>Not found</body></html>", {
              contentType: "text/html; charset=UTF-8",
            }),
        }),
      }),
    );
    expect(error.code).toBe("invalid_content_type");
  });

  it("rejects a body that is neither HTML nor a sitemap as invalid XML", async () => {
    const error = await caught(
      fetchSitemap(ROOT, HOST, {
        fetchImpl: router({ [ROOT]: () => res("just some text, not markup") }),
      }),
    );
    expect(error.code).toBe("invalid_xml");
  });

  it("refuses a response that declares itself larger than the ceiling", async () => {
    const error = await caught(
      fetchSitemap(ROOT, HOST, {
        fetchImpl: router({
          [ROOT]: () => res(urlsetXml(["/a"]), { contentLength: "20000000" }),
        }),
      }),
    );
    expect(error.code).toBe("too_large");
  });
});

describe("SSRF: the root URL is guarded before any request", () => {
  it("refuses a sitemap on another domain", async () => {
    let called = false;
    const error = await caught(
      fetchSitemap("https://evil.example.net/sitemap.xml", HOST, {
        fetchImpl: (async () => {
          called = true;
          return res("");
        }) as unknown as typeof fetch,
      }),
    );
    expect(error.code).toBe("host_mismatch");
    expect(called).toBe(false);
  });

  it("refuses a literal IP address", async () => {
    const error = await caught(
      fetchSitemap("http://169.254.169.254/sitemap.xml", HOST, {
        fetchImpl: router({}),
      }),
    );
    expect(error.code).toBe("ip_address_not_allowed");
  });
});

describe("every classified code has a human message", () => {
  it("covers the codes the fetcher can produce", () => {
    const produced: SitemapFetchError[] = [
      "not_found",
      "forbidden",
      "rate_limited",
      "server_error",
      "redirect",
      "timeout",
      "unreachable",
      "invalid_content_type",
      "invalid_xml",
      "too_large",
      "host_mismatch",
      "ip_address_not_allowed",
    ];
    for (const code of produced) {
      expect(SITEMAP_ERROR_MESSAGES[code]).toBeTruthy();
      expect(SITEMAP_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
    }
  });
});

describe("robots.txt sitemap discovery", () => {
  const robots = (body: string, status = 200): typeof fetch =>
    (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;

  it("prefers the sitemap robots.txt declares", async () => {
    const found = await discoverSitemapsFromRobots(HOST, {
      fetchImpl: robots("User-agent: *\nDisallow:\nSitemap: https://example.com/wp-sitemap.xml"),
    });
    expect(found).toEqual(["https://example.com/wp-sitemap.xml"]);
  });

  it("reads several declarations, case-insensitively, de-duplicated", async () => {
    const found = await discoverSitemapsFromRobots(HOST, {
      fetchImpl: robots(
        [
          "sitemap:   https://example.com/a.xml",
          "SITEMAP: https://example.com/b.xml",
          "Sitemap: https://example.com/a.xml",
        ].join("\n"),
      ),
    });
    expect(found).toEqual(["https://example.com/a.xml", "https://example.com/b.xml"]);
  });

  it("refuses a declared sitemap on another host", async () => {
    const found = await discoverSitemapsFromRobots(HOST, {
      fetchImpl: robots("Sitemap: https://cdn.elsewhere.com/sitemap.xml"),
    });
    expect(found).toEqual([]);
  });

  it("returns nothing when robots.txt is absent", async () => {
    const found = await discoverSitemapsFromRobots(HOST, {
      fetchImpl: robots("", 404),
    });
    expect(found).toEqual([]);
  });

  it("returns nothing when robots.txt cannot be reached", async () => {
    const found = await discoverSitemapsFromRobots(HOST, {
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(found).toEqual([]);
  });
});
