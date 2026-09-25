// ORA frontend suite (jsdom, runs in CI as part of `hardhat test`):
//  1. static cross-check — every element id the JS touches exists in the HTML
//  2. boot test — the app initializes against stubbed ethers/fetch with no
//     uncaught errors and renders branch tabs from the real deployment file
//  3. interaction tests — wallet-less connect and missing-deployment paths
//     degrade to the documented toasts (never a blank crash)
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const APP = path.join(__dirname, "..", "app");
const html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(APP, "app.js"), "utf8");
const deployment = JSON.parse(fs.readFileSync(path.join(APP, "deployment.json"), "utf8"));

// ids the JS reads that are intentionally absent from the HTML (conditional
// UI rendered only on some branches) — each needs a reason, reviewed on touch
const ABSENT_OK = new Set([
  // (none yet — every current $("...") has a matching element)
]);

function referencedIds() {
  const ids = new Set();
  // $("id") and $('id') direct references
  for (const m of appJs.matchAll(/\$\(\s*["']([\w-]+)["']\s*\)/g)) ids.add(m[1]);
  return [...ids].sort();
}

// Boot the full app in jsdom with a stub chain. Returns { window, document,
// errors, toastText() } once boot settles (tabs rendered or a toast shown).
async function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e));
  const dom = new JSDOM(html, {
    url: "http://localhost:3000/",
    runScripts: "outside-only",
    virtualConsole: vc,
  });
  const { window } = dom;
  const timers = [];
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = (...a) => { const id = realSetInterval(...a); timers.push(id); return id; };

  // --- stub fetch: serve the real deployment file, swallow /log, 404 rest ---
  window.fetch = async (url) => {
    if (String(url).startsWith("/log")) return { ok: true, json: async () => ({}) };
    if (String(url).startsWith("deployment.json")) {
      return { ok: true, json: async () => JSON.parse(JSON.stringify(deployment)) };
    }
    return { ok: false, status: 404, json: async () => ({}) }; // e.g. deployment-baseSepolia.json: absent
  };

  // --- stub ethers: construct everything, answer trivially, fail calls loudly ---
  const chainless = () => { throw new Error("no chain in jsdom"); };
  class StubProvider {
    async getNetwork() { return { chainId: 31337n }; }
    async getBalance() { return 0n; }
    async call() { return "0x"; }
  }
  class StubWallet {
    constructor(key, provider) { this.key = key; this.provider = provider; this.address = "0x0000000000000000000000000000000000000001"; }
    async getAddress() { return this.address; }
    async sendTransaction() { return { hash: "0x00", wait: async () => ({}) }; }
    connect() { return this; }
  }
  window.ethers = {
    JsonRpcProvider: StubProvider,
    Wallet: StubWallet,
    NonceManager: class extends StubWallet {},
    Contract: class {
      constructor(addr, abi, runner) { this.target = addr; return new Proxy(this, { get: (t, p) => (p in t ? t[p] : chainless) }); }
    },
    Interface: class { constructor() {} parseError() { return null; } },
    ZeroAddress: "0x0000000000000000000000000000000000000000",
    parseEther: (s) => BigInt(Math.round(Number(s || 0) * 1e18)),
    formatEther: (v) => String(Number(v) / 1e18),
    isAddress: (s) => /^0x[0-9a-fA-F]{40}$/.test(s || ""),
  };

  window.eval(appJs);
  // wait for boot to settle: tabs visible, addr set, or a toast shown
  const doc = window.document;
  const deadline = Date.now() + 5000;
  for (;;) {
    const toast = doc.getElementById("toast").textContent;
    const tabSet = [...doc.querySelectorAll(".tab")].some((t) => t.style.display !== "");
    const addrSet = doc.getElementById("addr").textContent !== "";
    if (toast || tabSet || addrSet || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  // let any straggler rejection surface, then freeze timers
  await new Promise((r) => setTimeout(r, 100));
  timers.forEach((t) => window.clearInterval(t));
  return {
    window, document: doc, errors,
    toastText: () => doc.getElementById("toast").textContent,
    close: () => { timers.forEach((t) => { try { window.clearInterval(t); } catch {} }); try { window.close(); } catch {} },
  };
}

describe("frontend (jsdom)", () => {
  it("every element id the JS touches exists in the HTML", () => {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const missing = referencedIds().filter(
      (id) => !doc.getElementById(id) && !ABSENT_OK.has(id));
    expect(missing, `JS references missing ids: ${missing.join(", ")}`).to.deep.equal([]);
    // reverse check is advisory: log unreferenced ids for dead-markup spotting
    const inHtml = [...dom.window.document.querySelectorAll("[id]")].map((e) => e.id);
    const refs = new Set(referencedIds());
    const dead = inHtml.filter((id) => !refs.has(id));
    if (dead.length) console.log(`  [ui] advisory — ${dead.length} unreferenced ids: ${dead.slice(0, 10).join(", ")}`);
  });

  it("static structure: networks, tabs, vendor script, toast", () => {
    const doc = new JSDOM(html).window.document;
    const opts = [...doc.getElementById("networkSelect").options].map((o) => o.value);
    expect(opts).to.deep.equal(["local", "baseSepolia", "base"]);
    expect(doc.querySelectorAll(".tab").length).to.be.greaterThanOrEqual(4);
    expect([...doc.querySelectorAll("script")].some((s) => (s.src || "").includes("ethers"))).to.equal(true);
    expect(doc.getElementById("toast")).to.not.equal(null);
    expect(doc.title).to.match(/ORA/i);
  });

  it("boots against a stub chain with no uncaught errors and renders tabs", async () => {
    const app = await boot();
    try {
      expect(app.errors, `uncaught: ${app.errors.map(String).join(" | ").slice(0, 400)}`).to.deep.equal([]);
      // local account wires up and all four branch tabs render visible
      expect(app.document.getElementById("addr").textContent).to.match(/^0x[0-9a-fA-F]{40}$/);
      const tabs = [...app.document.querySelectorAll(".tab")];
      expect(tabs.length).to.be.greaterThanOrEqual(4);
      expect(tabs.every((t) => t.style.display === "")).to.equal(true);
    } finally { app.close(); }
  });

  it("network registry gates testnet tooling (mainnet is wallet-only)", async () => {
    const app = await boot();
    try {
      const N = app.window.__ora.NETWORKS;
      expect(N.local).to.include({ testnet: true, local: true });
      expect(N.baseSepolia).to.include({ testnet: true, local: false });
      expect(N.base).to.include({ testnet: false, local: false });
      expect(parseInt(N.baseSepolia.chainIdHex, 16)).to.equal(84532);
      expect(parseInt(N.base.chainIdHex, 16)).to.equal(8453);
      expect(N.local.file).to.equal("deployment.json");
    } finally { app.close(); }
  });

  it("wallet-less connect degrades to the documented toast", async () => {
    const app = await boot();
    try {
      app.document.getElementById("btnConnect").click();
      await new Promise((r) => setTimeout(r, 100));
      expect(app.toastText()).to.match(/No wallet extension found/);
      expect(app.errors).to.deep.equal([]);
    } finally { app.close(); }
  });

  it("missing testnet deployment degrades to the runbook toast", async () => {
    const app = await boot();
    try {
      const sel = app.document.getElementById("networkSelect");
      sel.value = "baseSepolia"; // deployment-baseSepolia.json absent in this checkout
      sel.dispatchEvent(new app.window.Event("change"));
      const deadline = Date.now() + 5000;
      while (app.toastText() === "" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(app.toastText()).to.match(/not deployed yet/);
      expect(app.errors).to.deep.equal([]);
      // failed switch restores the previous selection instead of stranding UI
      expect(sel.value).to.equal("local");
    } finally { app.close(); }
  });
});
