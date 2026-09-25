import { test, expect } from "@playwright/test";

// Full user loop on a fresh local chain: boot -> live data -> faucet drip
// -> open trove. The stack (chain + deploy + server) is booted by
// scripts/e2e-up.sh via playwright.config.ts webServer.
//
// TEMPORARILY INSTRUMENTED (faucet-row CI failure forensics): observer on
// the faucet row + network badge, perf-entry dump of the boot's /config,
// and a pre-assertion state dump. Remove once the cause is fixed.
test("boot, live data, faucet drip, open trove", async ({ page }) => {
  const errors: string[] = [];
  const events: string[] = [];
  page.on("pageerror", (e) => { errors.push(String(e)); events.push(`[pageerror] ${String(e).slice(0, 120)}`); });
  page.on("response", (r) => { if (r.url().includes("/config")) events.push(`[net] /config -> ${r.status()}`); });
  page.on("requestfailed", (r) => { if (r.url().includes("/config")) events.push(`[net] /config FAILED ${r.failure()?.errorText}`); });
  page.on("console", (m) => { if (m.type() === "error") events.push(`[console] ${m.text().slice(0, 120)}`); });

  await page.addInitScript(() => {
    (window as unknown as { __obs: unknown[] }).__obs = [];
    window.addEventListener("DOMContentLoaded", () => {
      const row = document.getElementById("faucetRow");
      const badge = document.getElementById("networkBadge");
      const push = (what: string) => (window as unknown as { __obs: unknown[] }).__obs.push({
        what,
        hidden: row?.hidden, badge: badge?.textContent, t: Math.round(performance.now()),
      });
      if (row) new MutationObserver(() => push("row")).observe(row, { attributes: true, attributeFilter: ["hidden"] });
      if (badge) new MutationObserver(() => push("badge")).observe(badge, { childList: true, characterData: true, subtree: true });
    });
  });

  await page.goto("/");

  // boot: demo account wired (alice = hardhat key #1)
  await expect(page.locator("#addr")).toHaveText(
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", { timeout: 30_000 });

  // live chain data rendered
  await expect(page.locator("#stEthPrice")).not.toHaveText("—", { timeout: 30_000 });
  expect(await page.locator("#stEthPrice").textContent()).toMatch(/\$/);

  // FORENSICS: state at the exact moment the next assertion would run.
  const dump = await page.evaluate(async () => {
    const w = window as unknown as { __obs: unknown[] };
    const res = performance.getEntriesByType("resource")
      .filter((r) => r.name.includes("/config") || r.name.includes("/rpc"))
      .slice(0, 10)
      .map((r) => `${r.name.split("/").pop()}=${(r as PerformanceResourceTiming).responseStatus}`);
    const cfg = await fetch("/config", { cache: "no-store" }).then(async (r) => `${r.status}:${await r.text()}`).catch((e) => `ERR ${e}`);
    return {
      obs: w.__obs, res, cfg,
      hidden: document.getElementById("faucetRow")?.hidden,
      badge: document.getElementById("networkBadge")?.textContent,
      addr: document.getElementById("addr")?.textContent?.slice(0, 12),
      select: (document.getElementById("networkSelect") as HTMLSelectElement)?.value,
      ls: Object.keys(localStorage),
    };
  });
  events.push(`[obs] ${JSON.stringify(dump.obs)}`);
  events.push(`[perf] ${JSON.stringify(dump.res)}`);
  events.push(`[cfg] ${dump.cfg}`);
  events.push(`[dom] hidden=${dump.hidden} badge=${dump.badge} addr=${dump.addr} select=${dump.select} ls=${JSON.stringify(dump.ls)}`);
  console.log("FORENSICS\n" + events.map((e) => "  " + e).join("\n") + "\nEND FORENSICS");

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
