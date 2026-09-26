import { test, expect } from "@playwright/test";

// Additional user flows beyond the boot/open loop in app.spec.ts:
//  - network switching mid-session (safe unavailable state, and back)
//  - redemption through the full on-chain hint pipeline
//
// The stack (chain + deploy + bootstrap warp + server) is booted by
// scripts/e2e-up.sh via playwright.config.ts webServer. CI only — browser
// binaries are uninstallable in the dev sandbox.

test("network switch mid-session: unpublished testnet degrades safely, switch back restores the demo", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await expect(page.locator("#networkBadge")).toHaveText("Local demo", { timeout: 30_000 });
  await expect(page.locator("#appContent")).toBeVisible();

  // Switch to Base Sepolia: no deployment-baseSepolia.json is published in
  // this build, so the app must land in the explicit unavailable state —
  // never stale local data, never demo accounts on a public network.
  await page.selectOption("#networkSelect", "baseSepolia");
  await expect(page.locator("#networkBadge")).toHaveText("Base Sepolia · unavailable", { timeout: 15_000 });
  await expect(page.locator("#networkNotice")).toContainText(
    "does not have a published ORA deployment", { timeout: 15_000 });
  await expect(page.locator("#appContent")).toBeHidden();

  // Switching back rehydrates the local demo end-to-end.
  await page.selectOption("#networkSelect", "local");
  await expect(page.locator("#networkBadge")).toHaveText("Local demo", { timeout: 30_000 });
  await expect(page.locator("#appContent")).toBeVisible();
  await expect(page.locator("#addr")).toHaveText(
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", { timeout: 30_000 });
  await expect(page.locator("#stEthPrice")).not.toHaveText("—", { timeout: 30_000 });

  expect(errors).toEqual([]);
});

test("redemption flow burns orUSD through the hint pipeline", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await expect(page.locator("#addr")).toContainText("0x7099", { timeout: 30_000 });

  // A funded trove is needed so there is debt to redeem against and orUSD in
  // the wallet (the bootstrap warp in e2e-up.sh clears the 14-day redemption
  // gate for the whole chain). app.spec's open flow runs first on the same
  // chain and account, so a trove may already be active — and the open form
  // hides once it is. Wait for the first refresh to settle before deciding:
  // isVisible() is instant, and the position is not loaded until the refresh
  // completes (an early check would wrongly try to open an existing trove).
  const troveActive = page.locator("#troveActive");
  const openBtn = page.locator("#btnOpen");
  await expect(troveActive.or(openBtn)).toBeVisible({ timeout: 30_000 });
  if (!(await troveActive.isVisible())) {
    await page.click("#btnOpen");
    await expect(page.locator("#txReviewDialog")).toBeVisible();
    await page.click("#reviewConfirm");
    await expect(page.locator("#toast")).toContainText("Open Trove confirmed", { timeout: 60_000 });
  }
  await expect(troveActive).toBeVisible({ timeout: 30_000 });

  // Markets view → redeem 100 orUSD (goes through getRedemptionHints →
  // getApproxHint → findInsertPosition before redeemCollateral).
  await page.getByRole("button", { name: "Markets & risk" }).click();
  await expect(page.locator("#viewMarkets")).toBeVisible();
  await page.fill("#redeemAmount", "100");
  await page.click("#btnRedeem");
  await expect(page.locator("#toast")).toContainText("Redeem orUSD confirmed", { timeout: 60_000 });

  // The activity log records the flow with its final state.
  await expect(page.locator("#activityList")).toContainText("Redeem orUSD");
  await expect(page.locator(".activity-item").first().locator(".activity-badge")).toHaveText("Confirmed");

  expect(errors).toEqual([]);
});
