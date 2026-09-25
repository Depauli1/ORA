import { test, expect } from "@playwright/test";

// Full user loop on a fresh local chain: boot -> live data -> faucet drip
// -> open trove. The stack (chain + deploy + server) is booted by
// scripts/e2e-up.sh via playwright.config.ts webServer.
test("boot, live data, faucet drip, open trove", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");

  // boot: demo account wired (alice = hardhat key #1)
  await expect(page.locator("#addr")).toHaveText(
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", { timeout: 30_000 });

  // live chain data rendered
  await expect(page.locator("#stEthPrice")).not.toHaveText("—", { timeout: 30_000 });
  expect(await page.locator("#stEthPrice").textContent()).toMatch(/\$/);

  // server faucet drip via the UI (100 ORA from the treasury key)
  await expect(page.locator("#faucetRow")).toBeVisible();
  await page.click("#btnFaucet");
  await expect(page.locator("#toast")).toContainText("on the way", { timeout: 30_000 });
  await expect(page.locator("#balOra")).toContainText("100", { timeout: 30_000 });

  // open a trove with the UI defaults (5 ETH / 4000 orUSD): the review
  // dialog interposes before the wallet (pre-flight + review step)
  await page.click("#btnOpen");
  await expect(page.locator("#txReviewDialog")).toBeVisible();
  await expect(page.locator("#reviewRows")).toContainText("Projected total debt");
  await page.click("#reviewConfirm");
  await expect(page.locator("#toast")).toContainText("Open Trove confirmed", { timeout: 60_000 });
  await expect(page.locator("#troveActive")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#tvDebt")).toContainText("orUSD", { timeout: 30_000 });
  await expect(page.locator("#activityList")).toContainText("Open Trove");
  await expect(page.locator(".activity-item").first().locator(".activity-badge")).toHaveText("Confirmed");

  expect(errors).toEqual([]);
});

test("mobile navigation stays within the viewport and switches focused sections", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.locator("#networkBadge")).toHaveText("Local demo", { timeout: 30_000 });
  await expect(page.locator("#appContent")).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);

  await page.getByRole("button", { name: "Earn" }).click();
  await expect(page.locator("#viewEarn")).toBeVisible();
  await expect(page.locator("#viewBorrow")).toBeHidden();
});
