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
  },
});
