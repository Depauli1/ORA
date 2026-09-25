// @vitest-environment jsdom
// Frontend suite (vitest): static id cross-check, boot against stub fetch
// with real ethers, wallet-less connect, missing-deployment, localhost gate,
// WalletConnect button visibility. Replaces the old mocha/jsdom suite.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { boot } from "../src/main";
import { state } from "../src/state";
import { setNetwork } from "../src/network";
import { connectWallet } from "../src/wallet";

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
  config?: { faucet: boolean; walletConnectProjectId: string | null };
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
      return { ok: true, json: async () => JSON.parse(JSON.stringify(deployment)) };
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

  it("static structure: networks, tabs, module script, WC button, toast", () => {
    document.documentElement.innerHTML = html;
    const opts = [...(document.getElementById("networkSelect") as HTMLSelectElement).options].map((o) => o.value);
    expect(opts).toEqual(["local", "baseSepolia", "base"]);
    expect(document.querySelectorAll(".tab").length).toBeGreaterThanOrEqual(4);
    const scripts = [...document.querySelectorAll("script")];
    expect(scripts.some((s) => s.getAttribute("src") === "/src/main.ts")).toBe(true);
    expect(scripts.some((s) => (s.getAttribute("src") || "").includes("vendor"))).toBe(false);
    expect(document.getElementById("btnWC")).not.toBeNull();
    expect(document.getElementById("toast")!.getAttribute("aria-live")).toBe("polite");
    expect(document.title).toMatch(/ORA/i);
  });

  it("boots on localhost: demo account wired, tabs rendered, no errors", async () => {
    const app = await bootOnce();
    try {
      expect(app.errors).toEqual([]);
      // alice = hardhat key #1, derived by real ethers Wallet
      expect(document.getElementById("addr")!.textContent).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
      const tabs = [...document.querySelectorAll<HTMLElement>(".tab")];
      expect(tabs.length).toBeGreaterThanOrEqual(4);
      expect(tabs.every((t) => t.style.display === "")).toBe(true);
      expect((document.getElementById("accountSelect") as HTMLElement).style.display).not.toBe("none");
    } finally { app.cleanup(); }
  });

  it("refuses demo mode off localhost (keys never render)", async () => {
    const app = await bootOnce({ hostname: "example.com" });
    try {
      expect(app.errors).toEqual([]);
      expect(app.toast()).toMatch(/localhost only/);
      expect(document.getElementById("addr")!.textContent).toBe("—");
      // picker left hidden (its static default has no inline style, but no
      // demo wallet was constructed — the security property)
      expect(state.wallet).toBeNull();
      expect(state.dep).toBeNull();
    } finally { app.cleanup(); }
  });

  it("faucet row follows the server /config flag", async () => {
    const off = await bootOnce({ config: { faucet: false, walletConnectProjectId: null } });
    try {
      expect(document.getElementById("faucetRow")!.style.display).toBe("none");
    } finally { off.cleanup(); }
    const on = await bootOnce({ config: { faucet: true, walletConnectProjectId: null } });
    try {
      expect(document.getElementById("faucetRow")!.style.display).toBe("");
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

  it("missing testnet deployment degrades to the runbook toast", async () => {
    const app = await bootOnce();
    try {
      const sel = document.getElementById("networkSelect") as HTMLSelectElement;
      sel.value = "baseSepolia";
      sel.dispatchEvent(new window.Event("change"));
      const deadline = Date.now() + 5000;
      while (app.toast() === "" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(app.toast()).toMatch(/not deployed yet/);
      expect(app.errors).toEqual([]);
      expect(sel.value).toBe("local");
    } finally { app.cleanup(); }
  });

  it("public net with WC project id shows the mobile button, hides demo picker", async () => {
    const app = await bootOnce({
      config: { faucet: false, walletConnectProjectId: "test-pid" },
      sepoliaFile: true,
    });
    try {
      await setNetwork("baseSepolia");
      await new Promise((r) => setTimeout(r, 150));
      expect(document.getElementById("btnWC")!.style.display).toBe("inline-block");
      expect(document.getElementById("btnConnect")!.style.display).toBe("inline-block");
      expect(document.getElementById("accountSelect")!.style.display).toBe("none");
      expect(document.getElementById("faucetRow")!.style.display).toBe("none");
      expect(app.errors).toEqual([]);
    } finally { app.cleanup(); }
  });
});
