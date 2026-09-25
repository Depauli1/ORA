import { test, expect } from "@playwright/test";

// TEMPORARY diagnostic spec #3 — boot #1 in a run is healthy, boot #2 (3s
// later, fresh page) hides the faucet row. Reproduce with two sequential
// boots in one test and full instrumentation on each.
test("diagnose two sequential boots", async ({ browser }) => {
  const diag = async (label: string) => {
    const page = await browser.newPage();
    const events: string[] = [];
    page.on("response", (r) => { if (r.url().includes("/config")) events.push(`[net] /config -> ${r.status()}`); });
    page.on("requestfailed", (r) => { if (r.url().includes("/config")) events.push(`[net] /config FAILED ${r.failure()?.errorText}`); });
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") events.push(`[console.${m.type()}] ${m.text().slice(0, 140)}`); });
    page.on("pageerror", (e) => events.push(`[pageerror] ${String(e).slice(0, 140)}`));

    await page.addInitScript(() => {
      (window as unknown as { __obs: unknown[] }).__obs = [];
      window.addEventListener("DOMContentLoaded", () => {
        const el = document.getElementById("faucetRow");
        if (!el) { (window as unknown as { __obs: unknown[] }).__obs.push({ err: "no faucetRow at DCL" }); return; }
        new MutationObserver(() => {
          (window as unknown as { __obs: unknown[] }).__obs.push({ hidden: el.hidden, t: Math.round(performance.now()) });
        }).observe(el, { attributes: true, attributeFilter: ["hidden"] });
      });
    });

    await page.goto("/");
    await expect(page.locator("#addr")).toHaveText(
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", { timeout: 30_000 });
    await expect(page.locator("#stEthPrice")).not.toHaveText("—", { timeout: 30_000 });

    const dump = await page.evaluate(async () => {
      const w = window as unknown as { __obs: unknown[] };
      const res = performance.getEntriesByType("resource")
        .filter((r) => r.name.includes("/config") || r.name.includes("/rpc"))
        .slice(0, 10)
        .map((r) => `${r.name.replace(/^.*\/\//, "").slice(0, 30)}=${(r as PerformanceResourceTiming).responseStatus}`);
      const cfg = await fetch("/config", { cache: "no-store" }).then(async (r) => `${r.status}:${await r.text()}`).catch((e) => `ERR ${e}`);
      return { obs: w.__obs, res, cfg };
    });
    events.push(`[obs] flips = ${JSON.stringify(dump.obs)}`);
    events.push(`[perf] = ${JSON.stringify(dump.res)}`);
    events.push(`[cfg] = ${dump.cfg}`);
    events.push(`[dom] hidden=${await page.locator("#faucetRow").evaluate((e) => (e as HTMLElement).hidden)}`);
    console.log(`DIAG3-${label}\n` + events.map((e) => "  " + e).join("\n") + `\nEND DIAG3-${label}`);
    await page.close();
  };

  await diag("boot1");
  await diag("boot2");
});
