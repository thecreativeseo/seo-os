import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { publicOrigin } from "@/lib/url/public-origin";

const original = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = original;
});

function request(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers });
}

describe("the origin redirects are built from", () => {
  it("is the configured app URL, not the address the server is bound to", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://seo-os.example/";
    // What a route handler sees behind Railway's proxy.
    expect(publicOrigin(request("https://localhost:8080/auth/callback?code=x"))).toBe(
      "https://seo-os.example",
    );
  });

  it("falls back to the forwarded host and protocol when nothing is configured", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      publicOrigin(
        request("http://localhost:8080/auth/callback", {
          "x-forwarded-host": "app.example, proxy.internal",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://app.example");
  });

  it("uses the request itself only as a last resort, which is right on a laptop", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(publicOrigin(request("http://localhost:3000/auth/callback"))).toBe(
      "http://localhost:3000",
    );
  });

  it("ignores a malformed setting rather than redirecting to garbage", () => {
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    expect(publicOrigin(request("http://localhost:3000/x", { host: "localhost:3000" }))).toBe(
      "https://localhost:3000",
    );
  });
});
