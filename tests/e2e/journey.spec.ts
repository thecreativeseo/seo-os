import { expect, test } from "@playwright/test";

/**
 * End-to-end coverage of the browser-to-server boundary.
 *
 * Scope note, stated plainly: these tests do NOT sign in. Google OAuth requires a
 * real consent screen, and the alternative — minting sessions with the Supabase
 * service-role key — would mean wiring a credential into the app that no
 * application code needs. The authenticated journey is verified by the manual
 * checklist in docs/P0_MANUAL_VERIFICATION.md instead.
 *
 * What is covered here is the layer the 229 unit and integration tests cannot
 * reach, and where every bug that escaped them actually lived: route resolution,
 * redirects, HTTP methods, and error pages.
 */

const PROTECTED_ROUTES = [
  "/",
  "/onboarding",
  "/onboarding/organization",
  "/onboarding/00000000-0000-0000-0000-000000000000/website",
  "/websites/00000000-0000-0000-0000-000000000000",
  "/websites/00000000-0000-0000-0000-000000000000/overview",
  "/websites/00000000-0000-0000-0000-000000000000/goals",
  "/websites/00000000-0000-0000-0000-000000000000/context",
  "/websites/00000000-0000-0000-0000-000000000000/brand-facts",
  "/websites/00000000-0000-0000-0000-000000000000/competitors",
  "/websites/00000000-0000-0000-0000-000000000000/seo-rules",
  "/websites/00000000-0000-0000-0000-000000000000/connections",
  "/workspaces/00000000-0000-0000-0000-000000000000/team",
  "/workspaces/00000000-0000-0000-0000-000000000000/audit",
  "/workspaces/00000000-0000-0000-0000-000000000000/settings",
];

test.describe("unauthenticated access", () => {
  for (const route of PROTECTED_ROUTES) {
    test(`${route} redirects to the login page`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login$/);
    });
  }

  test("a valid-looking website id does not leak tenant structure", async ({ page }) => {
    // Whether the id exists or not, an unauthenticated visitor sees the same thing.
    await page.goto("/websites/00000000-0000-0000-0000-000000000000/goals");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("body")).not.toContainText("Not found");
  });
});

test.describe("login page", () => {
  test("offers Continue with Google", async ({ page }) => {
    await page.goto("/login");

    const button = page.getByRole("button", { name: /continue with google/i });
    await expect(button).toBeVisible();
  });

  test("states that signing in does not grant workspace access", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("body")).toContainText(/access to a workspace is granted/i);
  });

  test("skip to content is the first stop in the tab order", async ({ page }) => {
    await page.goto("/login");
    await page.keyboard.press("Tab");

    const focused = page.locator(":focus");
    await expect(focused).toHaveRole("link");
    await expect(focused).toContainText(/skip to content/i);
  });

  test("the sign-in control is reachable by keyboard", async ({ page }) => {
    await page.goto("/login");
    // Past the skip link, then to the only control on the page.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");

    const focused = page.locator(":focus");
    await expect(focused).toHaveRole("button");
    await expect(focused).toContainText(/continue with google/i);
  });

  test("has exactly one h1", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("h1")).toHaveCount(1);
  });
});

test.describe("sign out", () => {
  test("rejects GET", async ({ request }) => {
    // A GET sign-out could be triggered by a link prefetch or a third-party page.
    const response = await request.get("/auth/signout");
    expect(response.status()).toBe(405);
  });

  test("accepts POST and returns to the login page", async ({ request }) => {
    const response = await request.post("/auth/signout", { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()["location"]).toMatch(/\/login$/);
  });
});

test.describe("oauth failure handling", () => {
  test("a missing code shows a generic message", async ({ page }) => {
    await page.goto("/auth/callback");
    await expect(page).toHaveURL(/auth-error\?reason=missing_code/);
    await expect(page.locator("body")).toContainText(/sign-in response was incomplete/i);
  });

  test("a denied consent shows a generic message", async ({ page }) => {
    await page.goto("/auth/callback?error=access_denied&error_description=user+refused");
    await expect(page).toHaveURL(/auth-error\?reason=access_denied/);
    // The provider's own error text must never be rendered.
    await expect(page.locator("body")).not.toContainText("user refused");
  });

  test("an unrecognised reason falls back to a generic message", async ({ page }) => {
    await page.goto("/auth/auth-error?reason=<script>alert(1)</script>");
    await expect(page.locator("body")).toContainText(/could not be completed/i);
    await expect(page.locator("body")).not.toContainText("alert(1)");
  });

  test("offers a way back", async ({ page }) => {
    await page.goto("/auth/auth-error?reason=exchange_failed");
    await expect(page.getByRole("link", { name: /try again/i })).toBeVisible();
  });
});

test.describe("health", () => {
  test("reports the phase without requiring auth", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { status: string; phase: string };
    expect(body.status).toBe("ok");
    expect(body.phase).toBe("P0");
  });
});
