import { describe, expect, it } from "vitest";

import { relativeRedirect } from "@/lib/http/relative-redirect";

describe("relative redirects", () => {
  it("answers with a site-relative Location the browser resolves itself", () => {
    const response = relativeRedirect("/auth/auth-error?reason=exchange_failed");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/auth/auth-error?reason=exchange_failed");
  });

  it("supports the 303 used after a POST", () => {
    expect(relativeRedirect("/login", 303).status).toBe(303);
  });

  it("refuses anything that could leave the site", () => {
    expect(() => relativeRedirect("//evil.example/")).toThrow(/site-relative/);
    expect(() => relativeRedirect("https://evil.example/")).toThrow(/site-relative/);
    expect(() => relativeRedirect("login")).toThrow(/site-relative/);
  });
});
