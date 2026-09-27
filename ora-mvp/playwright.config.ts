import { defineConfig } from "@playwright/test";

// e2e runs in CI only (browser binaries are uninstallable in the dev
// sandbox). Locally, `npx vitest run app/test/` + the documented jsdom
// chain validation cover the same paths without a browser.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.E2E_URL || "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bash scripts/e2e-up.sh",
    // Readiness probe must hit a STATIC path: /config (and every other API
    // route) sits behind the 120 req/min per-IP limiter, and Playwright's
    // startup polling would exhaust that budget — the app's own first
    // /config fetch would then 429, silently degrade to the no-faucet
    // default config, and hide the faucet row (observed in CI). Static
    // files are not rate-limited.
    url: "http://127.0.0.1:3100/",
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: { PORT: "3100" },
  },
});
