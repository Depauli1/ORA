import { test, expect } from "@playwright/test";

// TEMPORARY diagnostic spec #2 — the faucet row is healthy when this spec
// runs first, but hidden in app.spec's first boot. Capture the row's full
// lifecycle (MutationObserver installed before app scripts run) plus the
// app's own /config fetch status (PerformanceResourceTiming.responseStatus).
test("diagnose faucet row lifecycle", async ({ page }) => {
  const events: string[] = [];
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/config")) events.push(`[net] /config -> ${r.status()} @${Date.now() % 100000}`);
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("/config")) events.push(`[net] /config FAILED ${r.failure()?.errorText}`);
  });

  // Runs before the app's module scripts: watch every `hidden` flip.
  // (Deferred module scripts run before DOMContentLoaded, but boot()'s
  // network flip happens in async fetch callbacks — later than DCL.)
  await page.addInitScript(() => {
    (window as unknown as { __obs: unknown[] }).__obs = [];
    window.addEventListener("DOMContentLoaded", () => {
      const el = document.getElementById("faucetRow");
      if (!el) {
        (window as unknown as { __obs: unknown[] }).__obs.push({ err: "no faucetRow at DCL" });
        return;
      }
      new MutationObserver(() => {
        (window as unknown as { __obs: unknown[] }).__obs.push({
          hidden: el.hidden, t: Math.round(performance.now()),
        });
      }).observe(el, { attributes: true, attributeFilter: ["hidden"] });
    });
  });

  await page.goto("/");
  // Replicate app.spec's exact first two assertions (full address + price).
  await expect(page.locator("#addr")).toHaveText(
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", { timeout: 30_000 });
  await expect(page.locator("#stEthPrice")).not.toHaveText("—", { timeout: 30_000 });

  const dump = await page.evaluate(async () => {
    const w = window as unknown as { __obs: unknown[] };
    const res = performance.getEntriesByType("resource")
      .filter((r) => r.name.includes("/config") || r.name.includes("/rpc"))
      .slice(0, 8)
      .map((r) => `${r.name.split("/").slice(-1)[0] || r.name}=${(r as PerformanceResourceTiming).responseStatus}`);
    const cfg = await fetch("/config").then(async (r) => `${r.status}:${await r.text()}`).catch((e) => `ERR ${e}`);
    return {
      obs: w.__obs,
      res,
      cfg,
      hidden: document.getElementById("faucetRow")?.hidden,
      badge: document.getElementById("networkBadge")?.textContent,
      select: (document.getElementById("networkSelect") as HTMLSelectElement)?.value,
      visibility: document.visibilityState,
    };
  });
  events.push(`[obs] flips = ${JSON.stringify(dump.obs)}`);
  events.push(`[perf] first resources = ${JSON.stringify(dump.res)}`);
  events.push(`[cfg] now = ${dump.cfg}`);
  events.push(`[dom] faucetRow.hidden=${dump.hidden} badge=${dump.badge} select=${dump.select} vis=${dump.visibility}`);

  console.log("DIAG2\n" + events.map((e) => "  " + e).join("\n") + "\nEND DIAG2");
  // No burst, no extra traffic — keep the limiter pristine for later specs.
});
