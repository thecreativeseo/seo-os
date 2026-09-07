import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/security/**/*.test.ts",
    ],
    globals: true,
    setupFiles: ["tests/setup/env.ts"],
    // Sweeps the teardown ledger of exact tenant ids before and after the run.
    globalSetup: ["tests/setup/global.ts"],
    // The integration suites talk to a Supabase instance in another region, so
    // a test is hundreds of round trips rather than hundreds of local queries.
    // The heaviest of them - a full content pipeline, a QA run over ten checks -
    // legitimately take half a minute of that even with the suite to themselves:
    // the slowest brief-version test measures 28s in isolation. At 30s they were
    // failing on latency rather than on anything being wrong. Nothing here can
    // hang - it is straight-line async database work - so a generous ceiling
    // costs nothing on a passing run and still fails a genuinely stuck test.
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
