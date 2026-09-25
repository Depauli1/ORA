import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/test/**/*.test.ts"],
    testTimeout: 30000,
    // Big bounty: never retry — flakes must be fixed, not hidden.
    retry: 0,
  },
});
