// @vitest-environment jsdom
// Frontend suite (vitest): static id cross-check, boot against stub fetch
// with real ethers, wallet-less connect, missing-deployment, localhost gate,
// WalletConnect button visibility. Replaces the old mocha/jsdom suite.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { boot } from "../src/main";
import { MAX_MARKET_DATA_AGE_MS, state } from "../src/state";
import { setNetwork } from "../src/network";
import { connectWallet } from "../src/wallet";
import { setView, updateAdjustmentPreview, updateDataFreshness, updateHealthBanner, updateOpenPreview } from "../src/views";

const APP = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
const deployment = JSON.parse(fs.readFileSync(path.join(APP, "deployment.json"), "utf8"));

function srcIds(): string[] {
  const ids = new Set<string>();
  for (const f of fs.readdirSync(path.join(APP, "src"))) {
    if (!f.endsWith(".ts")) continue;
    const src = fs.readFileSync(path.join(APP, "src", f), "utf8");
    for (const m of src.matchAll(/(?:\$\(|input\(|select\(|button\(|getElementById\()\s*["']([\w-]+)["']/g)) {
      ids.add(m[1]);
    }
  }
  return [...ids].sort();
}

const ABSENT_OK = new Set<string>([
  // wcModal/wcCopy/wcClose are created dynamically by walletconnect.ts
  "wcModal", "wcCopy", "wcClose",
]);

interface BootOpts {
  hostname?: string;
  config?: { faucet: boolean; walletConnectProjectId: string | null; previewDemo?: boolean };
  sepoliaFile?: boolean; // serve deployment.json content for baseSepolia too
}

async function bootOnce(opts: BootOpts = {}) {
  document.documentElement.innerHTML = html;
  const errors: string[] = [];
  const onErr = (e: ErrorEvent) => errors.push(String(e.message || e.error || "error"));
  window.addEventListener("error", onErr);
  const cfg = opts.config ?? { faucet: false, walletConnectProjectId: null };
  const stubFetch = async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.startsWith("/log")) return { ok: true, json: async () => ({}) };
    if (u.startsWith("/config")) return { ok: true, json: async () => ({ ...cfg }) };
    if (u.startsWith("deployment.json")) {
      return { ok: true, json: async () => JSON.parse(JSON.stringify(deployment)) };
    }
    if (opts.sepoliaFile && u.startsWith("deployment-baseSepolia.json")) {
      const publicDeployment = JSON.parse(JSON.stringify(deployment));
      publicDeployment.chainId = 84532;
      return { ok: true, json: async () => publicDeployment };
    }
    if (u.endsWith("/rpc") || u.includes("sepolia.base.org")) {
      // Answer network detection honestly (echoing the request id, which
      // ethers validates) so the provider stops retrying; every real call
      // then fails fast and the app's catch paths handle it.
      let method = "", id: unknown = 1;
      try {
        const body = JSON.parse(String(init?.body || "{}"));
        method = body.method || "";
        id = body.id ?? 1;
      } catch { /* ignore */ }
      if (method === "eth_chainId") {
        const chain = u.includes("sepolia.base.org") ? "0x14a34" : "0x7a69";
        return { ok: true, json: async () => ({ jsonrpc: "2.0", id, result: chain }) };
      }
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id, error: { code: -32603, message: "no chain in jsdom" } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  vi.stubGlobal("fetch", stubFetch);
  const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  await boot(opts.hostname ?? "localhost");
  // let straggler rejections surface
  await new Promise((r) => setTimeout(r, 150));
  window.removeEventListener("error", onErr);
  return {
    errors,
    toast: () => document.getElementById("toast")!.textContent,
    cleanup: () => {
      vi.unstubAllGlobals();
      consoleErr.mockRestore();
      if (state.refreshTimer) clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("frontend (vitest + jsdom)", () => {
  it("every element id the TS touches exists in the HTML", () => {
    document.documentElement.innerHTML = html;
    const missing = srcIds().filter(
      (id) => !document.getElementById(id) && !ABSENT_OK.has(id));
    expect(missing, `TS references missing ids: ${missing.join(", ")}`).toEqual([]);
  });

  it("static structure: focused sections, labelled controls, network identity and activity", () => {
    document.documentElement.innerHTML = html;
    const opts = [...(document.getElementById("networkSelect") as HTMLSelectElement).options].map((o) => o.value);
    expect(opts).toEqual(["local", "baseSepolia", "base"]);
    expect(document.querySelectorAll("button[data-view]")).toHaveLength(3);
    expect(document.querySelectorAll("[data-view-panel]")).toHaveLength(3);
    expect(document.getElementById("networkBadge")).not.toBeNull();
    expect(document.querySelector(".badge")).toBeNull(); // network badge is populated from actual chain state
    for (const control of [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[id], select[id]")]) {
      expect(document.querySelector(`label[for="${control.id}"]`), `missing label for #${control.id}`).not.toBeNull();
    }
    const scripts = [...document.querySelectorAll("script")];
    expect(scripts.some((s) => s.getAttribute("src") === "/src/main.ts")).toBe(true);
    expect(scripts.some((s) => (s.getAttribute("src") || "").includes("vendor"))).toBe(false);
    expect(document.getElementById("btnWC")).not.toBeNull();
    expect(document.getElementById("toast")!.getAttribute("aria-live")).toBe("polite");
    expect(document.getElementById("activityList")).not.toBeNull();
    expect(document.title).toMatch(/ORA/i);
  });

  it("shows oracle, NAV shock, and recovery-mode warnings instead of hiding risk flags", () => {
    document.documentElement.innerHTML = html;
    updateHealthBanner(false, true, true);
    const banner = document.getElementById("healthBanner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.dataset.severity).toBe("critical");
    expect(document.getElementById("healthMessage")!.textContent).toMatch(/Oracle status is not live/);
    expect(document.getElementById("healthMessage")!.textContent).toMatch(/NAV shock guard is active/);
    expect(document.getElementById("healthMessage")!.textContent).toMatch(/Recovery Mode/);
    updateHealthBanner(true, false, false);
    expect(banner.hidden).toBe(true);
  });

  it("pauses risk-increasing actions when oracle health or data freshness is uncertain", async () => {
    const app = await bootOnce();
    try {
      state.price = 2000;
      state.position = { collateral: 5n * 10n ** 18n, debt: 4200n * 10n ** 18n };
      state.borrowingRate = 5n * 10n ** 15n;
      state.lastRefreshError = null;
      state.lastRefreshAt = Date.now();
      state.navShock = false;
      state.oracleLive = false;
      updateDataFreshness();
      expect(document.getElementById("oracleBadge")!.textContent).toBe("Oracle degraded");
      updateOpenPreview(state.borrowingRate);
      updateAdjustmentPreview();
      expect((document.getElementById("btnOpen") as HTMLButtonElement).disabled).toBe(true);
      expect(document.getElementById("openRiskBadge")?.textContent).toBe("Paused");
      expect(document.getElementById("openHealthMeter")?.getAttribute("data-risk")).toBe("unknown");
      expect((document.getElementById("btnWithdrawColl") as HTMLButtonElement).disabled).toBe(true);
      expect((document.getElementById("btnBorrowMore") as HTMLButtonElement).disabled).toBe(true);
      expect((document.getElementById("btnAddColl") as HTMLButtonElement).disabled).toBe(false);
      expect((document.getElementById("btnRepay") as HTMLButtonElement).disabled).toBe(false);

      state.oracleLive = true;
      state.lastRefreshAt = Date.now() - MAX_MARKET_DATA_AGE_MS - 1000;
      updateDataFreshness();
      expect(document.getElementById("dataFreshness")!.textContent).toMatch(/old \(limit 30s\)/);
      expect(document.getElementById("oracleBadge")!.textContent).toMatch(/Oracle status unknown.*data stale/);
      updateOpenPreview(state.borrowingRate);
      updateAdjustmentPreview();
      expect((document.getElementById("btnOpen") as HTMLButtonElement).disabled).toBe(true);
      expect((document.getElementById("btnWithdrawColl") as HTMLButtonElement).disabled).toBe(true);

      state.lastRefreshError = "RPC timeout";
      updateDataFreshness();
      expect(document.getElementById("dataFreshness")!.textContent).toMatch(/RPC timeout/);
      updateOpenPreview(state.borrowingRate);
      updateAdjustmentPreview();
      expect((document.getElementById("btnBorrowMore") as HTMLButtonElement).disabled).toBe(true);
    } finally { app.cleanup(); }
  });

  it("boots on localhost: demo account wired and collateral choices are progressive", async () => {
    const app = await bootOnce();
    try {
      expect(app.errors).toEqual([]);
      expect(document.getElementById("addr")!.textContent).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
      const branches = document.getElementById("branchSelect") as HTMLSelectElement;
      expect(branches.options.length).toBeGreaterThanOrEqual(4);
      expect(document.getElementById("branchPicker")!.hidden).toBe(false);
      expect((document.getElementById("accountSelect") as HTMLElement).hidden).toBe(false);
      expect(document.getElementById("networkBadge")!.textContent).toBe("Local demo");
      expect(document.getElementById("appContent")!.hidden).toBe(false);
      setView("earn");
      expect(document.getElementById("viewEarn")!.hidden).toBe(false);
      expect(document.getElementById("viewBorrow")!.hidden).toBe(true);
      expect(document.querySelector('button[data-view="earn"]')!.getAttribute("aria-pressed")).toBe("true");
      setView("borrow");
    } finally { app.cleanup(); }
  });

  it("off localhost, clearly shows an unpublished Base Sepolia deployment and never wires demo keys", async () => {
    const app = await bootOnce({ hostname: "example.com" });
    try {
      expect(app.errors).toEqual([]);
      expect(document.getElementById("networkNotice")!.textContent).toMatch(/does not have a published ORA deployment/);
      expect(document.getElementById("networkBadge")!.dataset.status).toBe("unavailable");
      expect(document.getElementById("appContent")!.hidden).toBe(true);
      expect(document.getElementById("addr")!.textContent).toBe("—");
      expect(state.wallet).toBeNull();
      expect(state.dep).toBeNull();
    } finally { app.cleanup(); }
  });

  it("enables the Hardhat demo on an Arena preview only with server opt-in", async () => {
    const hostname = "3101-sandbox123.e2b.app";
    const denied = await bootOnce({ hostname });
    try {
      expect(document.getElementById("networkNotice")!.textContent).toMatch(/does not have a published ORA deployment/);
      expect(state.wallet).toBeNull();
      expect(document.getElementById("appContent")!.hidden).toBe(true);
    } finally { denied.cleanup(); }

    const enabled = await bootOnce({
      hostname,
      config: { faucet: false, walletConnectProjectId: null, previewDemo: true },
    });
    try {
      expect(enabled.errors).toEqual([]);
      expect(document.getElementById("networkBadge")!.textContent).toBe("Local demo");
      expect(document.getElementById("appContent")!.hidden).toBe(false);
      expect(document.getElementById("addr")!.textContent).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
      expect(state.wallet).not.toBeNull();
    } finally { enabled.cleanup(); }
  });

  it("local mode stays localhost-gated and explains why when selected directly", async () => {
    const app = await bootOnce({ hostname: "example.com" });
    try {
      await setNetwork("local");
      expect(document.getElementById("networkNotice")!.textContent).toMatch(/only available on localhost/);
      expect(state.wallet).toBeNull();
      expect(state.dep).toBeNull();
      expect(document.getElementById("appContent")!.hidden).toBe(true);
      expect(app.errors).toEqual([]);
    } finally { app.cleanup(); }
  });

  it("faucet row follows the server /config flag", async () => {
    const off = await bootOnce({ config: { faucet: false, walletConnectProjectId: null } });
    try {
      expect(document.getElementById("faucetRow")!.hidden).toBe(true);
    } finally { off.cleanup(); }
    const on = await bootOnce({ config: { faucet: true, walletConnectProjectId: null } });
    try {
      expect(document.getElementById("faucetRow")!.hidden).toBe(false);
      expect((document.getElementById("btnFaucet") as HTMLButtonElement).disabled).toBe(false);
    } finally { on.cleanup(); }
  });

  it("wallet-less connect degrades to the documented toast", async () => {
    const app = await bootOnce();
    try {
      (document.getElementById("btnConnect") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 100));
      expect(app.toast()).toMatch(/No wallet extension found/);
      expect(app.errors).toEqual([]);
    } finally { app.cleanup(); }
  });

  it("connect falls through to WalletConnect when configured", async () => {
    const app = await bootOnce({ config: { faucet: false, walletConnectProjectId: "test-pid" } });
    try {
      let started = false;
      await connectWallet(async () => { started = true; return null; });
      expect(started).toBe(true);
      expect(app.errors).toEqual([]);
    } finally { app.cleanup(); }
  });

  it("missing testnet deployment leaves an explicit unavailable state instead of stale local data", async () => {
    const app = await bootOnce();
    try {
      const sel = document.getElementById("networkSelect") as HTMLSelectElement;
      sel.value = "baseSepolia";
      sel.dispatchEvent(new window.Event("change"));
      const deadline = Date.now() + 5000;
      while (!document.getElementById("networkNotice")!.textContent?.includes("does not have a published") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(document.getElementById("networkNotice")!.textContent).toMatch(/does not have a published/);
      expect(app.errors).toEqual([]);
      expect(sel.value).toBe("baseSepolia");
      expect(state.networkReady).toBe(false);
      expect(state.wallet).toBeNull();
      expect(document.getElementById("appContent")!.hidden).toBe(true);
    } finally { app.cleanup(); }
  });

  it("public testnet with WalletConnect configured shows mobile connect and a testnet identity", async () => {
    const app = await bootOnce({
      config: { faucet: false, walletConnectProjectId: "test-pid" },
      sepoliaFile: true,
    });
    try {
      await setNetwork("baseSepolia");
      await new Promise((r) => setTimeout(r, 150));
      expect(document.getElementById("btnWC")!.hidden).toBe(false);
      expect(document.getElementById("btnConnect")!.hidden).toBe(false);
      expect(document.getElementById("accountSelect")!.hidden).toBe(true);
      expect(document.getElementById("faucetRow")!.hidden).toBe(true);
      expect(document.getElementById("networkBadge")!.textContent).toBe("Base Sepolia · testnet");
      expect(document.getElementById("networkBadge")!.dataset.environment).toBe("testnet");
      expect(app.errors).toEqual([]);
    } finally { app.cleanup(); }
  });
});
