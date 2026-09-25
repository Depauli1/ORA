import { test, expect } from "@playwright/test";

// TEMPORARY diagnostic spec — pinpoints the CI-only faucet failure.
// One bit decides the fix: does /config say faucet:false from the CI
// browser (server-side: FAUCET_KEY missing) while the row is hidden —
// or faucet:true while the row is still hidden (app-side race)?
test("diagnose faucet row visibility", async ({ page }) => {
  const events: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/config")) events.push(`boot /config -> ${r.status()}`); });
  page.on("requestfailed", (r) => { if (r.url().includes("/config")) events.push(`boot /config FAILED ${r.failure()?.errorText}`); });

  await page.goto("/");
  await expect(page.locator("#addr")).toContainText("0x7099", { timeout: 30_000 });
  events.push(`visibilityState=${await page.evaluate(() => document.visibilityState)}`);

  // The app's own boot fetch result is already in `events` above; now the
  // browser's view of /config AFTER boot, twice (cache + no-store):
  const probe = await page.evaluate(async () => {
    const a = await fetch("/config").then(async (r) => `${r.status}:${await r.text()}`);
    const b = await fetch("/config", { cache: "no-store" }).then(async (r) => `${r.status}:${await r.text()}`);
    const row = document.getElementById("faucetRow");
    return { a, b, hidden: row?.hidden, html: row?.outerHTML.slice(0, 120) };
  });
  events.push(`post-boot /config = ${probe.a}`);
  events.push(`post-boot /config(no-store) = ${probe.b}`);
  events.push(`faucetRow.hidden = ${probe.hidden}, html = ${probe.html}`);

  // Does a RELOAD (second boot) change anything? (timing race signature)
  page.on("response", (r) => { if (r.url().includes("/config")) events.push(`reload /config -> ${r.status()}`); });
  await page.reload();
  await expect(page.locator("#addr")).toContainText("0x7099", { timeout: 30_000 });
  const after = await page.evaluate(() => ({
    hidden: document.getElementById("faucetRow")?.hidden,
    badge: document.getElementById("networkBadge")?.textContent,
  }));
  events.push(`after reload: faucetRow.hidden = ${after.hidden}, badge = ${after.badge}`);

  // Surface server-side rate-limit state indirectly: 130 rapid /config hits.
  const burst = await page.evaluate(async () => {
    const codes: Record<string, number> = {};
    for (let i = 0; i < 130; i++) {
      const r = await fetch("/config", { cache: "no-store" });
      codes[r.status] = (codes[r.status] || 0) + 1;
    }
    return codes;
  });
  events.push(`burst of 130 /config -> ${JSON.stringify(burst)}`);

  console.log("DIAG\n" + events.map((e) => "  " + e).join("\n") + "\nEND DIAG");
  expect(events.length).toBeGreaterThan(0);
});
