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
    url: "http://127.0.0.1:3100/config",
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: { PORT: "3100" },
  },
});
