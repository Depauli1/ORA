// @vitest-environment jsdom
// Network-switch edge coverage: deployment-file failure modes, branch-option
// rendering fallbacks, and the non-local (testnet/mainnet) provider path.
// refresh() is mocked away so no real RPC leaves the process; setBranch and
// everything downstream runs for real.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/views", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/views")>();
  return { ...actual, refresh: vi.fn(async () => true) };
});

import { setNetwork } from "../src/network";
import { state } from "../src/state";
import { NETWORKS } from "../src/config";
import type { Deployment } from "../src/config";

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const baseDeployment: Deployment = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployment.json"), "utf8"),
);

// Per-test URL → {status, body} map the global fetch stub serves.
let serve: Record<string, { ok: boolean; status?: number; body: unknown; throws?: unknown }> = {};

beforeEach(() => {
  document.documentElement.innerHTML = html;
  try { localStorage.clear(); } catch { /* fresh jsdom */ }
  serve = {
    "/config": { ok: true, body: { faucet: true, walletConnectProjectId: null } },
    // local deployment (default) — deep copy so per-test mutations don't leak
    "deployment.json": { ok: true, body: JSON.parse(JSON.stringify(baseDeployment)) },
  };
  vi.stubGlobal("fetch", (async (url: unknown) => {
    const u = String(url).split("?")[0];
    const hit = serve![u] ?? serve![u.replace(/^.*\//, "/")];
    if (hit) return {
      ok: hit.ok, status: hit.status ?? 200,
      json: async () => { if (hit.throws !== undefined) throw hit.throws; return hit.body; },
    };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  state.reset("localhost");
});

const txt = (id: string) => document.getElementById(id)!.textContent || "";
const badge = () => document.getElementById("networkBadge")!;
const notice = () => document.getElementById("networkNotice")!;

function mainnetDeployment(): Deployment {
  const d: Deployment = JSON.parse(JSON.stringify(baseDeployment));
  d.chainId = 8453; // NETWORKS.base
  return d;
}

describe("setNetwork failure modes", () => {
  it("unwraps non-Error failures while loading a deployment", async () => {
    serve!["deployment-base.json"] = { ok: true, body: {}, throws: "corrupt payload" };
    await setNetwork("base");
    expect(state.networkReady).toBe(false);
    expect(notice().textContent).toContain("Could not load Base: corrupt payload");
  });

  it("reports a missing published deployment and stays unavailable (mainnet badge)", async () => {
    await setNetwork("base"); // no deployment-base.json served → 404
    expect(state.networkReady).toBe(false);
    expect(state.provider).toBeNull();
    expect(badge().dataset.status).toBe("unavailable");
    expect(badge().dataset.environment).toBe("mainnet");
    expect(txt("networkBadge")).toBe("Base · unavailable");
    expect(notice().dataset.kind).toBe("error");
    expect(notice().textContent).toContain("does not have a published ORA deployment");
    expect(document.getElementById("appContent")!.hidden).toBe(true);
  });

  it("rejects an incomplete deployment file", async () => {
    const d = mainnetDeployment();
    delete (d as { abis?: unknown }).abis;
    serve["deployment-base.json"] = { ok: true, body: d };
    await setNetwork("base");
    expect(state.networkReady).toBe(false);
    expect(notice().textContent).toContain("published deployment file is incomplete");
  });

  it("rejects a chain-ID mismatch against the selected network", async () => {
    const d = mainnetDeployment();
    d.chainId = 31337; // local chain id on a mainnet entry
    serve["deployment-base.json"] = { ok: true, body: d };
    await setNetwork("base");
    expect(state.networkReady).toBe(false);
    expect(notice().textContent).toContain("Deployment chain ID does not match Base");
  });

  it("rejects a deployment with no collateral markets", async () => {
    const d = mainnetDeployment();
    d.branches = {};
    serve["deployment-base.json"] = { ok: true, body: d };
    await setNetwork("base");
    expect(state.networkReady).toBe(false);
    expect(notice().textContent).toContain("no collateral markets configured");
  });
});

describe("setNetwork non-local success path", () => {
  it("goes ready on Base with a mainnet badge, read-only wallet row and a remote provider", async () => {
    serve["deployment-base.json"] = { ok: true, body: mainnetDeployment() };
    await setNetwork("base");
    expect(state.networkReady).toBe(true);
    expect(state.netMode).toBe("base");
    expect(state.provider).not.toBeNull();
    expect(badge().dataset.status).toBe("ready");
    expect(badge().dataset.environment).toBe("mainnet");
    expect(txt("networkBadge")).toBe("Base · mainnet");
    expect(notice().hidden).toBe(true);
    expect(document.getElementById("appContent")!.hidden).toBe(false);
    expect(txt("addr")).toBe("Read-only · connect a wallet to transact");
    expect(document.getElementById("btnConnect")!.hidden).toBe(false);
    expect(document.getElementById("accountSelect")!.hidden).toBe(true);
    expect(document.getElementById("walletSelect")!.hidden).toBe(true);
  });

  it("goes ready on Base Sepolia with a testnet badge", async () => {
    const d: Deployment = JSON.parse(JSON.stringify(baseDeployment));
    d.chainId = 84532;
    serve["deployment-baseSepolia.json"] = { ok: true, body: d };
    await setNetwork("baseSepolia");
    expect(state.networkReady).toBe(true);
    expect(badge().dataset.environment).toBe("testnet");
    expect(txt("networkBadge")).toBe("Base Sepolia · testnet");
  });
});

describe("branch option rendering", () => {
  beforeEach(() => {
    serve["deployment-base.json"] = { ok: true, body: mainnetDeployment() };
  });

  it("falls back to the first branch when ETH is absent", async () => {
    const d = mainnetDeployment();
    d.branches = { wstETH: d.branches.wstETH! };
    serve["deployment-base.json"] = { ok: true, body: d };
    await setNetwork("base");
    expect(state.branch).toBe("wstETH");
    const options = Array.from(document.querySelectorAll<HTMLSelectElement>("#branchSelect option"));
    expect(options.map((o) => o.value)).toEqual(["wstETH"]);
    expect(document.getElementById("branchPicker")!.hidden).toBe(true);
  });

  it("labels unknown branch keys by their collateral symbol, or the key itself", async () => {
    const d = mainnetDeployment();
    const custom = JSON.parse(JSON.stringify(d.branches.ETH!));
    custom.collSymbol = "FOO-C";
    d.branches = { FOO: custom };
    serve["deployment-base.json"] = { ok: true, body: d };
    await setNetwork("base");
    expect(state.branch).toBe("FOO");
    const option = document.querySelector<HTMLSelectElement>("#branchSelect option")!;
    expect(option.textContent).toBe("FOO-C");

    // …and when the branch has no collateral symbol either, the key is the label.
    const bare = mainnetDeployment();
    const keyOnly = JSON.parse(JSON.stringify(bare.branches.ETH!));
    keyOnly.collSymbol = "";
    bare.branches = { KEYED: keyOnly };
    serve["deployment-base.json"] = { ok: true, body: bare };
    await setNetwork("base");
    expect(state.branch).toBe("KEYED");
    expect(document.querySelector<HTMLSelectElement>("#branchSelect option")!.textContent).toBe("KEYED");
  });
});

describe("mode selection", () => {
  it("falls back to the local demo chain for unknown modes", async () => {
    await setNetwork("bogus-network");
    expect(state.netMode).toBe("local");
    expect(state.networkReady).toBe(true);
    expect(txt("networkBadge")).toBe("Local demo");
    expect(document.getElementById("accountSelect")!.hidden).toBe(false);
  });
});
