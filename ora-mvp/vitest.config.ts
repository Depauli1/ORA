import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/test/**/*.test.ts"],
    testTimeout: 30000,
    // Big bounty: never retry — flakes must be fixed, not hidden.
    retry: 0,
    // Coverage: backend (server.js + server-lib.js) and frontend (app/src)
    // are measured together; thresholds are set in scripts/js-coverage-gate.js
    // (ratchets — raise, never lower).
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "html"],
      include: ["app/src/**/*.ts", "server.js", "server-lib.js"],
      exclude: ["app/src/styles.css", "app/src/vite-env.d.ts"],
    },
  },
});
