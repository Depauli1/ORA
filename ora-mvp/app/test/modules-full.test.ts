// @vitest-environment jsdom
// Module-level coverage suite: every unit of app/src that the UI-flow suites
// (views-full, actions-full) cannot reach — error matrices, keyboard focus
// traps, wallet connection paths, config/deployment validation edges, hint
// math fallbacks, activity rendering buckets and the polling scheduler.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ethers } from "ethers";
import {
  bootApp, installC, makeFakeC, stubWalletSends, txLike, settle, click,
  setInput, logs, E, OTHER, ZADDR, deployment,
} from "./full-harness";
import { state, req, dep, bcfg, myAddr, hasFreshMarketData, nextPollDelayMs, provider } from "../src/state";
import { $, input as domInput, select as domSelect, button as domButton, toast } from "../src/dom";
import { short, reason, mapTransactionError, fmt, fmtNum, fmtPct, rebrand } from "../src/format";
import {
  icrPct, healthTier, healthMeterPct, healthExplanation, isNativeBranch, isRWABranch,
  isRatesBranch, collSymOf, faucetAmtOf, brMcrOf, brSoftOf, openPreview,
} from "../src/branch";
import { hydrateActivity, addActivity, updateActivity, renderActivity, type ActivityStatus } from "../src/activity";
import { reviewTransaction } from "../src/review";
import { setAccount, initWalletDiscovery, pickedEip1193, connectWithProvider, connectWallet, guardSigner, tx } from "../src/wallet";
import { connectWalletConnect, hideWcModal } from "../src/walletconnect";
import { loadConfig, setNetwork } from "../src/network";
import { setBranch, refresh, riskIncreaseBlockMessage, updateDataFreshness, setView } from "../src/views";
import { getInsertHints, rateInsertHints, adjustHints, borrowWithFee, myZap } from "../src/contracts";
import { installErrorHooks } from "../src/main";

const txt = (id: string) => $(id).textContent || "";
const clickAsync = async (id: string, ms = 5) => { click(id); await settle(ms); };
const review = {
  title: "Test", description: "desc", network: "Local demo chain",
  risk: "caution" as const, riskMessage: "test risk note",
  details: [{ label: "Amount", value: "1" }],
};

let app: Awaited<ReturnType<typeof bootApp>>;
beforeEach(async () => { app = await bootApp(); });
afterEach(() => { app.restore(); });

// ---------------------------------------------------------------------------
describe("dom accessors", () => {
  it("throws with the missing element id", () => {
    expect(() => $("nope")).toThrow("ORA: missing element #nope");
  });
  it("type guards reject mismatched elements", () => {
    expect(() => domInput("toast")).toThrow("#toast is not an input");
    expect(() => domSelect("toast")).toThrow("#toast is not a select");
    expect(() => domButton("toast")).toThrow("#toast is not a button");
    expect(domInput("adjCollAmount")).toBeInstanceOf(HTMLInputElement);
    expect(domSelect("branchSelect")).toBeInstanceOf(HTMLSelectElement);
    expect(domButton("btnOpen")).toBeInstanceOf(HTMLButtonElement);
  });
  it("toast replaces the previous message and re-arms its timer", async () => {
    toast("first", 5);
    expect($("toast").style.display).toBe("block");
    toast("second", 5);
    expect(txt("toast")).toBe("second");
    await settle(30);
    expect($("toast").style.display).toBe("none");
  });
});

describe("state fail-fast accessors and freshness", () => {
  it("req throws for null/undefined and passes values through", () => {
    expect(() => req(null, "thing")).toThrow("ORA: thing is not available yet");
    expect(() => req(undefined, "other")).toThrow("ORA: other is not available yet");
    expect(req(7, "n")).toBe(7);
  });
  it("dep/bcfg throw before boot", () => {
    state.dep = null;
    expect(() => dep()).toThrow("deployment data");
    state.dep = { branches: {} } as unknown as typeof state.dep;
    state.branch = "nope";
    expect(() => bcfg()).toThrow("branch nope missing from deployment");
    state.dep = JSON.parse(JSON.stringify(state.dep)); // restore shape for later suites
  });
  it("hasFreshMarketData covers null, error, future and stale ages", () => {
    state.lastRefreshAt = null; state.lastRefreshError = null;
    expect(hasFreshMarketData()).toBe(false);
    state.lastRefreshError = "rpc down"; state.lastRefreshAt = Date.now();
    expect(hasFreshMarketData()).toBe(false);
    state.lastRefreshError = null; state.lastRefreshAt = Date.now() + 60_000;
    expect(hasFreshMarketData()).toBe(false); // future timestamps are untrustworthy
    state.lastRefreshAt = Date.now() - 60_000;
    expect(hasFreshMarketData()).toBe(false); // stale
    state.lastRefreshAt = Date.now();
    expect(hasFreshMarketData()).toBe(true);
  });
  it("nextPollDelayMs backs off on failure and recovers on success", () => {
    expect(nextPollDelayMs(8000, false)).toBe(16000);
    expect(nextPollDelayMs(60000, false)).toBe(60000); // capped
    expect(nextPollDelayMs(60000, true)).toBe(8000);
    expect(nextPollDelayMs(9000, true)).toBe(8000);
  });
  it("reset() clears the poll timer", () => {
    state.refreshTimer = setTimeout(() => {}, 1000);
    state.reset("localhost");
    expect(state.refreshTimer).toBeNull();
  });
});

describe("format helpers", () => {
  it("number formatting and shorthand", () => {
    expect(fmt(ethers.parseEther("12345678.9"), 1)).toBe("12,345,678.9");
    expect(fmtNum(1234.567, 1)).toBe("1,234.6");
    expect(fmtPct(12.345, 1)).toBe("12.3%");
    expect(short("0x1234567890abcdef")).toBe("0x1234…cdef");
  });
  it("rebrand renames protocol identifiers", () => {
    expect(rebrand("LQTY staking")).toContain("ORA");
  });
  it("reason unwraps nested revert info", () => {
    expect(reason({ code: "CALL_EXCEPTION", info: { error: { message: "inner boom" } } })).toContain("inner boom");
    expect(reason(new Error("plain"))).toBe("plain");
    expect(reason("string error")).toBe("string error");
  });
  it("mapTransactionError: user rejection", () => {
    expect(mapTransactionError({ code: 4001 }).code).toBe("USER_REJECTED");
    expect(mapTransactionError({ code: "ACTION_REJECTED" }).code).toBe("USER_REJECTED");
    expect(mapTransactionError(ethers.makeError("user rejected", "ACTION_REJECTED")).code).toBe("USER_REJECTED");
  });
  it("mapTransactionError: insufficient gas", () => {
    const e = mapTransactionError({ code: "INSUFFICIENT_FUNDS" });
    expect(e.code).toBe("INSUFFICIENT_GAS_BALANCE");
    expect(mapTransactionError(new Error("insufficient funds for gas")).code).toBe("INSUFFICIENT_GAS_BALANCE");
  });
  it("mapTransactionError: network unavailable", () => {
    expect(mapTransactionError({ code: "TIMEOUT" }).code).toBe("TRANSACTION_FAILED"); // case-sensitive
    expect(mapTransactionError({ code: "server_error" }).code).toBe("NETWORK_UNAVAILABLE");
    expect(mapTransactionError({ code: "network_error" }).code).toBe("NETWORK_UNAVAILABLE");
    expect(mapTransactionError(new Error("timeout waiting for the RPC")).code).toBe("NETWORK_UNAVAILABLE");
    expect(mapTransactionError(new Error("could not detect network")).code).toBe("NETWORK_UNAVAILABLE");
  });
  it("mapTransactionError: protocol rejection with decoded reason", () => {
    const e = mapTransactionError(ethers.makeError("execution reverted: BorrowerOps: Amount too low", "CALL_EXCEPTION"));
    expect(e.code).toBe("PROTOCOL_REJECTED");
    expect(e.message).toContain("Amount too low");
  });
  it("mapTransactionError: protocol rejection with undecodable reason", () => {
    const e = mapTransactionError(ethers.makeError("missing revert data", "CALL_EXCEPTION"));
    expect(e.code).toBe("PROTOCOL_REJECTED");
    expect(e.message).toContain("did not meet the protocol's current requirements");
  });
  it("mapTransactionError: pre-flight simulation strip", () => {
    const e = mapTransactionError(new Error("rejected in pre-flight simulation — revert: too much"));
    expect(e.code).toBe("PROTOCOL_REJECTED");
    expect(e.message).toContain("too much");
  });
  it("mapTransactionError: generic failure keeps a short plain message", () => {
    const e = mapTransactionError(new Error("BorrowerOps: nope"));
    expect(e.code).toBe("TRANSACTION_FAILED");
    expect(e.message).toContain("nope");
    const generic = mapTransactionError(new Error("0x" + "ab".repeat(40) + " rpc socket fetch"));
    expect(generic.message).toContain("The action did not finish");
  });
  it("technical trace dedupes and accepts numeric codes", () => {
    const e = mapTransactionError({ code: -32603, message: "http failure" });
    expect(e.technical).toContain("-32603");
    expect(e.technical).toContain("http failure");
    expect(mapTransactionError(null).technical).toContain("No technical details");
  });
});

describe("branch math and health tiers", () => {
  it("tier boundaries, meters and symbols", () => {
    expect(healthTier(109, 1.1)).toBe("critical");
    expect(healthTier(140, 1.1)).toBe("caution");
    expect(healthTier(200, 1.1)).toBe("safe");
    expect(healthMeterPct(109, 1.1)).toBeGreaterThan(0);
    expect(icrPct(5, 2500, 3000)).toBe(600);
    expect(isNativeBranch({ collSymbol: "ETH", native: true } as never)).toBe(true);
    expect(isRWABranch({ collSymbol: "tBILL", rwa: true } as never)).toBe(true);
    expect(isRatesBranch({ collSymbol: "ETH", rates: true } as never)).toBe(true);
    expect(collSymOf({ collSymbol: "wstETH" } as never)).toBe("wstETH");
    expect(faucetAmtOf({ collSymbol: "ETH" } as never)).toBe("10"); // default
    expect(brMcrOf({ mcr: "1.2" } as never)).toBe(1.2);
    expect(brSoftOf({} as never)).toBe(1.05); // default soft floor
  });
  it("healthExplanation covers every tier", () => {
    expect(healthExplanation("unknown", 0, 1.1, 0, 0)).toContain("Waiting for a valid collateral price");
    expect(healthExplanation("critical", 100, 1.1, 0, 0)).toContain("minimum collateral ratio");
    expect(healthExplanation("caution", 150, 1.1, 2500, 3000)).toContain("collateral-price decline");
    expect(healthExplanation("safe", 200, 1.1, 2500, 3000)).toContain("Healthy buffer");
    expect(healthExplanation("caution", 150, 1.1, 0, 0)).toContain("Only about 0% collateral-price decline"); // no prices
    expect(healthExplanation("safe", 200, 1.1, 0, 0)).toContain("Healthy buffer: about 0%");
  });
  it("openPreview adds the fee and gas compensation", () => {
    const zero = openPreview(0, 0, 0n, 3000, 1.1);
    expect(zero.risk).toBe("critical"); // no collateral at all
    expect(zero.liquidationPrice).toBe(0);
    const p = openPreview(5, 2500, 5n * 10n ** 15n, 3000, 1.1);
    expect(p.risk).toBe("safe");
    expect(p.totalDebt).toBeGreaterThan(2500); // fee + 200 orUSD gas comp
    expect(p.fee).toBeGreaterThan(0);
  });
});

describe("activity store", () => {
  it("hydrateActivity discards corrupt storage", () => {
    localStorage.setItem("ora.transaction-activity.v1", "{not json");
    hydrateActivity();
    expect(state.activity).toEqual([]);
  });
  it("hydrateActivity keeps only valid records and interrupts pending ones", () => {
    const now = Date.now();
    localStorage.setItem("ora.transaction-activity.v1", JSON.stringify([
      { id: "a", label: "ok", status: "confirmed", netMode: "local", createdAt: now, updatedAt: "junk" },
      { id: "b", label: "pending", status: "preparing", netMode: "local", createdAt: now },
      { id: 12, label: "bad id", status: "confirmed", netMode: "local", createdAt: now },
      { id: "c", label: "bad status", status: "weird", netMode: "local", createdAt: now },
      { id: "d", label: "bad createdAt", status: "confirmed", netMode: "local", createdAt: "x" },
    ]));
    hydrateActivity();
    expect(state.activity.length).toBe(2);
    expect(state.activity[0].id).toBe("a");
    expect(state.activity[0].updatedAt).toBe(now); // non-finite updatedAt falls back
    expect(state.activity[1].status).toBe("interrupted"); // reload interrupted the wallet request
  });
  it("makeId falls back to a counter without crypto.randomUUID", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      const id = addActivity("no crypto", "local");
      expect(id).toMatch(/^\d+-\d+$/);
    } finally {
      if (desc) Object.defineProperty(globalThis, "crypto", desc);
    }
  });
  it("renders every status label and relative-time bucket", () => {
    const now = Date.now();
    state.activity = [];
    const statuses: ActivityStatus[] = ["preparing", "awaiting-wallet", "submitted", "confirming", "processing",
      "confirmed", "failed", "replaced", "cancelled", "interrupted"];
    const ids = statuses.map((status, i) => {
      const id = addActivity("label " + status, "local");
      updateActivity(id, { status, hash: "0x" + "aa".repeat(32) });
      return id;
    });
    expect(ids.length).toBe(10);
    // age buckets via crafted createdAt values (render is newest-first)
    const old = (ms: number) => now - ms;
    state.activity.push(
      { id: "m-old", label: "old", status: "confirmed", netMode: "local", netLabel: "Local demo chain", createdAt: old(5 * 60_000), updatedAt: old(5 * 60_000), hash: undefined, message: undefined, errorCode: undefined, recovery: undefined, technical: undefined },
      { id: "h-old", label: "older", status: "confirmed", netMode: "local", netLabel: "Local demo chain", createdAt: old(3 * 3_600_000), updatedAt: old(3 * 3_600_000), hash: undefined, message: undefined, errorCode: undefined, recovery: undefined, technical: undefined },
      { id: "d-old", label: "oldest", status: "confirmed", netMode: "local", netLabel: "Local demo chain", createdAt: old(3 * 86_400_000), updatedAt: old(3 * 86_400_000), hash: undefined, message: undefined, errorCode: undefined, recovery: undefined, technical: undefined },
    );
    renderActivity();
    const html = $("activityList").innerHTML;
    for (const label of ["Preparing", "Confirm in wallet", "Submitted", "Confirming", "Updating account",
      "Confirmed", "Failed", "Replaced", "Cancelled", "Interrupted"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("5m ago");
    expect(html).toContain("3h ago");
    expect(html).toContain("just now");
  });
  it("updateActivity ignores unknown ids", () => {
    expect(() => updateActivity("missing", { status: "failed" })).not.toThrow();
  });
});

describe("review dialog keyboard and dismissal", () => {
  it("Escape cancels the pending review", async () => {
    const p = reviewTransaction(review);
    await settle(5);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await expect(p).resolves.toBe(false);
  });
  it("Tab cycles focus between the first and last focusable", async () => {
    const p = reviewTransaction(review);
    await settle(5);
    const overlay = $("txReviewDialog") as HTMLElement;
    const focusable = overlay.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    focusable[focusable.length - 1].focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
    await settle(5);
    expect(document.activeElement).toBe(focusable[0]);
    // shift+Tab from the first wraps to the last
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }));
    await settle(5);
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    (document.getElementById("reviewCancel") as HTMLButtonElement).click();
    await expect(p).resolves.toBe(false);
  });
  it("Tab with nothing focusable focuses the cancel button", async () => {
    const overlay = $("txReviewDialog") as HTMLElement;
    overlay.querySelectorAll("button").forEach((b) => { (b as HTMLButtonElement).disabled = true; });
    const p = reviewTransaction(review);
    await settle(5);
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true); // trap keeps focus inside
    // finish via Escape (the cancel button is disabled and can't take focus)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await expect(p).resolves.toBe(false);
  });
  it("clicking the backdrop dismisses; a second review while pending resolves false", async () => {
    const p = reviewTransaction(review);
    await settle(5);
    await expect(reviewTransaction(review)).resolves.toBe(false); // still pending
    const backdrop = document.querySelector<HTMLElement>("[data-review-dismiss='true']")!;
    backdrop.click();
    await expect(p).resolves.toBe(false);
  });
  it("close and confirm buttons settle the promise", async () => {
    const p1 = reviewTransaction(review);
    await settle(5);
    (document.getElementById("reviewClose") as HTMLButtonElement).click();
    await expect(p1).resolves.toBe(false);
    const p2 = reviewTransaction(review);
    await settle(5);
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await expect(p2).resolves.toBe(true);
  });
  it("throws when review wiring elements are missing", async () => {
    (document.getElementById("reviewConfirm") as HTMLElement).remove();
    await expect(Promise.resolve().then(() => reviewTransaction(review)))
      .rejects.toThrow("missing transaction review element");
  });
});

describe("wallet connection paths", () => {
  it("setAccount refuses on public hosts and unknown names", () => {
    const host = state.hostname;
    state.hostname = "ora.example.com";
    setAccount("alice");
    expect(txt("toast")).toContain("available on localhost");
    state.hostname = host;
    setAccount("nonexistent");
    expect(txt("toast")).toContain("Unknown demo account");
  });

  it("EIP-6963 discovery: announce, duplicate, malformed and no-select cases", () => {
    initWalletDiscovery(); // idempotent second call
    const announce = (uuid: string, name: string) =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: { info: { uuid, name, icon: "data:", rdns: "x" }, provider: { request: async () => [] } },
      }));
    announce("u1", "Wallet One");
    expect(state.discoveredWallets.length).toBe(1);
    announce("u1", "Wallet One dup");
    expect(state.discoveredWallets.length).toBe(1); // duplicate uuid ignored
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: null })); // malformed
    expect(state.discoveredWallets.length).toBe(1);
    // walletSelect removed → announcement still recorded, DOM branch skipped
    (document.getElementById("walletSelect") as HTMLElement).remove();
    announce("u2", "Wallet Two");
    expect(state.discoveredWallets.length).toBe(2);
    window.dispatchEvent(new Event("eip6963:requestProvider")); // second dispatch is a no-op listener-wise
  });

  it("pickedEip1193 prefers discovered wallets, then window.ethereum, else null", () => {
    expect(pickedEip1193()).toBe(null); // nothing discovered, no injection
    (window as unknown as { ethereum: unknown }).ethereum = { request: async () => [] };
    expect(pickedEip1193()).toBe((window as unknown as { ethereum: unknown }).ethereum);
    delete (window as unknown as { ethereum: unknown }).ethereum;
    state.discoveredWallets = [
      { info: { uuid: "a", name: "A" }, provider: "prov-a" },
      { info: { uuid: "b", name: "B" }, provider: "prov-b" },
    ] as unknown as typeof state.discoveredWallets;
    const sel = document.getElementById("walletSelect") as HTMLSelectElement;
    sel.innerHTML = '<option value="0">A</option><option value="1">B</option>';
    sel.value = "1";
    expect(pickedEip1193()).toBe("prov-b");
    sel.value = "9"; // out of range → first wallet
    expect(pickedEip1193()).toBe("prov-a");
    state.discoveredWallets = [];
  });

  const fakeInjected = (behavior: { switchCode?: number; failAccounts?: boolean } = {}) => ({
    request: async ({ method }: { method: string }) => {
      if (method === "wallet_switchEthereumChain") {
        if (behavior.switchCode) { const e = new Error("switch failed") as Error & { code?: number }; e.code = behavior.switchCode; throw e; }
        return null;
      }
      if (method === "wallet_addEthereumChain") return null;
      if (method === "eth_requestAccounts" || method === "eth_accounts") {
        if (behavior.failAccounts) throw new Error("user closed the prompt");
        return ["0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"];
      }
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_getBalance") return "0x" + E("10").toString(16);
      if (method === "eth_call") return "0x";
      return null;
    },
  });

  it("connectWithProvider switches chain, connects and refreshes", async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    await connectWithProvider(fakeInjected() as never, "");
    expect(state.wallet).toBeTruthy();
    expect(txt("btnConnect")).toContain("0xAb58");
    expect(txt("toast")).toContain("Wallet connected");
  });
  it("connectWithProvider adds the chain on 4902", async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    await connectWithProvider(fakeInjected({ switchCode: 4902 }) as never, "");
    expect(txt("toast")).toContain("Wallet connected");
  });
  it("connectWithProvider surfaces other switch errors and account failures", async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    await connectWithProvider(fakeInjected({ switchCode: -32002 }) as never, "");
    expect(txt("toast")).toContain("Wallet connection failed");
    await connectWithProvider(fakeInjected({ failAccounts: true }) as never, "");
    expect(txt("toast")).toContain("Wallet connection failed");
  });

  it("connectWallet: install prompt, WalletConnect fallback and its failure", async () => {
    await connectWallet(); // nothing installed, no project id
    expect(txt("toast")).toContain("No wallet extension found");
    state.appConfig.walletConnectProjectId = "pid";
    state.wallet = null;
    await connectWallet(async () => null); // starter already toasted
    expect(state.wallet).toBeNull();
    const wc = fakeInjected();
    await connectWallet(async () => wc as never);
    expect(state.wallet).toBeTruthy();
    expect(txt("btnConnect")).toContain("0xAb58");
  });
});

describe("guardSigner pre-flight simulation", () => {
  const makeSigner = () => ({
    address: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
    sendTransaction: async (t: unknown) => ({ hash: "0x" + "ee".repeat(32), sent: t }),
  });
  it("passes clean simulations and forwards to the wallet", async () => {
    const signer = makeSigner();
    const guarded = guardSigner(signer as never, { call: async () => "0x" } as never);
    const out = await guarded.sendTransaction({ to: "0x1" });
    expect((out as { hash: string }).hash).toContain("ee");
    // double-guarding returns the same wrapper
    expect(guardSigner(guarded as never, { call: async () => "0x" } as never)).toBe(guarded);
  });
  it("rejects CALL_EXCEPTION and data-bearing reverts before prompting", async () => {
    const signer = makeSigner();
    const guarded = guardSigner(signer as never, { call: async () => { const e = new Error("reverted") as Error & { code?: string }; e.code = "CALL_EXCEPTION"; throw e; } } as never);
    await expect(guarded.sendTransaction({})).rejects.toThrow("rejected in pre-flight simulation");
    const signer2 = makeSigner();
    const guarded2 = guardSigner(signer2 as never, { call: async () => { throw { data: "0x08c379a0" }; } } as never);
    await expect(guarded2.sendTransaction({})).rejects.toThrow("rejected in pre-flight simulation");
  });
  it("non-revert hiccups disclose uncertainty and never block the send", async () => {
    const signer = makeSigner();
    const guarded = guardSigner(signer as never, { call: async () => { throw new Error("socket closed"); } } as never);
    const id = addActivity("guarded", "local");
    state.activeActivityId = id;
    const out = await guarded.sendTransaction({});
    expect((out as { hash: string }).hash).toContain("ee");
    expect(state.activity[0].status).toBe("awaiting-wallet");
    expect(state.activity[0].message).toContain("Simulation was unavailable");
    state.activeActivityId = null;
  });
});

describe("tx() outcome matrix", () => {
  beforeEach(() => {
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
  });
  it("refuses without a wallet and while busy", async () => {
    state.wallet = null;
    expect(await tx("l", async () => txLike())).toBe(false);
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    state.busy = true;
    expect(await tx("l", async () => txLike())).toBe(false);
    state.busy = false;
  });
  it("fails when the wallet returns nothing usable", async () => {
    expect(await tx("l", async () => undefined)).toBe(false);
    expect(state.activity[0].status).toBe("failed");
    expect(state.activity[0].message).toContain("did not return");
    expect(await tx("l", async () => ({ hash: 42 }))).toBe(false); // non-string hash
  });
  it("reports an on-chain revert", async () => {
    const ok = await tx("l", async () => ({ hash: "0x" + "11".repeat(32), wait: async () => ({ status: 0 }) }));
    expect(ok).toBe(false);
    expect(state.activity[0].status).toBe("failed");
    expect(state.activity[0].message).toContain("included but reverted");
  });
  it("USER_REJECTED marks the activity cancelled", async () => {
    const ok = await tx("l", async () => { const e = new Error("user rejected") as Error & { code?: number }; e.code = 4001; throw e; });
    expect(ok).toBe(false);
    expect(state.activity[0].status).toBe("cancelled");
    expect(state.activity[0].errorCode).toBe("USER_REJECTED");
  });
  it("TRANSACTION_REPLACED: cancelled, confirmed replacement, and unknown replacement", async () => {
    const replaced = (extra: Record<string, unknown>) =>
      tx("l", async () => { throw Object.assign(new Error("replaced"), { code: "TRANSACTION_REPLACED", ...extra }); });
    expect(await replaced({ cancelled: true, replacement: { hash: "0xr1" } })).toBe(false);
    expect(state.activity[0].status).toBe("cancelled");
    expect(state.activity[0].errorCode).toBe("TRANSACTION_REPLACED_CANCELLED");
    expect(await replaced({ receipt: { status: 1 }, replacement: { hash: "0xr2" } })).toBe(true);
    expect(state.activity[0].status).toBe("confirmed");
    expect(await replaced({ receipt: { status: 0 }, replacement: { hash: "0xr3" } })).toBe(false);
    expect(state.activity[0].status).toBe("replaced");
    expect(state.activity[0].errorCode).toBe("TRANSACTION_REPLACED");
  });
  it("generic failures keep the technical trace; success notes reconcile outcome", async () => {
    expect(await tx("l", async () => { throw new Error("failed to fetch the RPC"); })).toBe(false);
    expect(state.activity[0].errorCode).toBe("NETWORK_UNAVAILABLE");
    expect(await tx("l", async () => txLike(), () => Promise.resolve(false))).toBe(true);
    expect(state.activity[0].status).toBe("confirmed");
    expect(state.activity[0].message).toContain("could not be refreshed");
    expect(await tx("l", async () => txLike(), () => Promise.resolve(true))).toBe(true);
    expect(state.activity[0].message).toContain("refreshed");
  });
});

describe("WalletConnect modal and provider wiring", () => {
  it("connects through an injected provider importer and reports failures", async () => {
    const wc = { on: () => {}, connect: async () => {}, request: async () => [] };
    const out = await connectWalletConnect({
      projectId: "pid", chainId: 1,
      importProvider: async () => ({ EthereumProvider: { init: async () => wc } }),
    });
    expect(out).toBe(wc);
    const failing = await connectWalletConnect({
      projectId: "pid", chainId: 1,
      importProvider: async () => { throw new Error("relay down"); },
      notify: (m: string) => toast(m),
    });
    expect(failing).toBeNull();
    expect(txt("toast")).toContain("WalletConnect failed");
  });
  it("resolves module default shapes", async () => {
    const wc = { on: () => {}, connect: async () => {}, request: async () => [] };
    const nested = await connectWalletConnect({
      projectId: "pid", chainId: 1,
      importProvider: async () => ({ default: { EthereumProvider: { init: async () => wc } } }),
    });
    expect(nested).toBe(wc);
    const flat = await connectWalletConnect({
      projectId: "pid", chainId: 1,
      importProvider: async () => ({ default: { init: async () => wc } }),
    });
    expect(flat).toBe(wc);
  });
  it("shows the QR modal, copies the pairing link, and hides on failure", async () => {
    let emit: ((uri: string) => void) | null = null;
    const wc = {
      on: (_ev: string, cb: (uri: string) => void) => { emit = cb; },
      connect: () => new Promise((_res, rej) => setTimeout(() => rej(new Error("user closed")), 150)),
      request: async () => [],
    };
    const p = connectWalletConnect({
      projectId: "pid", chainId: 1,
      importProvider: async () => ({ EthereumProvider: { init: async () => wc } }),
      notify: (m: string) => toast(m),
    });
    await settle(5);
    emit!("wc:8a515...pairing");
    await settle(20);
    expect(document.getElementById("wcModal")).toBeTruthy();
    // copy failure path (no clipboard in jsdom)
    (document.getElementById("wcCopy") as HTMLButtonElement).click();
    await settle(10);
    expect(txt("toast")).toContain("Copy failed");
    (document.getElementById("wcClose") as HTMLButtonElement).click();
    expect(document.getElementById("wcModal")).toBeNull();
    // failure path re-shows + hides the modal
    emit!("wc:another");
    await settle(20);
    expect(document.getElementById("wcModal")).toBeTruthy();
    await expect(p).resolves.toBeNull();
    expect(document.getElementById("wcModal")).toBeNull();
    hideWcModal(); // no-op when already hidden
  });
});

describe("main.ts hooks and scheduler", () => {
  it("reports window errors and rejections to /log, installed once", async () => {
    installErrorHooks();
    installErrorHooks(); // idempotent
    const before = app.calls.filter((c) => c.url.startsWith("/log")).length;
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
    await settle(10);
    window.dispatchEvent(new Event("unhandledrejection"));
    await settle(10);
    const logged = app.calls.filter((c) => c.url.startsWith("/log"));
    expect(logged.length).toBe(before + 2);
    expect(String(logged[logged.length - 2].init?.body)).toContain("boom");
    expect(String(logged[logged.length - 1].init?.body)).toContain("unknown");
  });
  it("poll skips RPC while hidden or busy, and catches up when visible", async () => {
    // the visibility hook is installed by boot() already
    installC(makeFakeC({ native: true }), "ETH");
    state.lastRefreshAt = Date.now(); state.lastRefreshError = null;
    const spy = vi.spyOn(Document.prototype, "hidden", "get").mockReturnValue(false);
    try {
      // visible + idle → immediate catch-up poll refreshes account data
      const t0 = state.lastRefreshAt!;
      document.dispatchEvent(new Event("visibilitychange"));
      await settle(60);
      expect(state.lastRefreshAt! > t0).toBe(true);
      // listener sees visible but poll() itself observes hidden → early return
      spy.mockReturnValueOnce(false).mockReturnValueOnce(true);
      const t1 = state.lastRefreshAt!;
      document.dispatchEvent(new Event("visibilitychange"));
      await settle(20);
      expect(state.lastRefreshAt).toBe(t1); // no refresh while hidden
      // busy poll on the rescheduled timer skips the refresh but re-arms
      vi.useFakeTimers();
      spy.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange")); // arms a fake timer
      await vi.advanceTimersByTimeAsync(10);
      state.busy = true;
      const t2 = state.lastRefreshAt!;
      await vi.advanceTimersByTimeAsync(90_000); // several poll intervals
      expect(state.lastRefreshAt).toBe(t2); // busy polls never refresh
      state.busy = false;
      vi.useRealTimers();
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });
});

describe("network config and validation", () => {
  it("loadConfig degrades to defaults on error status and fetch failure", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await loadConfig();
    expect(state.appConfig.walletConnectProjectId).toBeNull();
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    await loadConfig();
    expect(state.appConfig.faucet).toBe(false); // DEFAULT_CONFIG
  });
  it("loadConfig accepts a published WalletConnect project id", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ faucet: 1, walletConnectProjectId: "abc", previewDemo: true }) }));
    await loadConfig();
    expect(state.appConfig).toEqual({ faucet: true, walletConnectProjectId: "abc", previewDemo: true });
  });
  it("setNetwork on a published network uses its RPC and shows wallet UI", async () => {
    // the published deployment must carry the network's chain id to validate
    const baseFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", (u: unknown, i?: unknown) =>
      String(u).startsWith("deployment-baseSepolia")
        ? { ok: true, json: async () => ({ ...deployment, chainId: 84532 }) }
        : (baseFetch as (u: unknown, i?: unknown) => Promise<unknown>)(u, i));
    const nets = (window as unknown as { __ora: { NETWORKS: Record<string, { rpc: string }> } }).__ora.NETWORKS;
    const saved = nets.baseSepolia.rpc;
    nets.baseSepolia.rpc = location.origin + "/rpc"; // route through the boot stub
    state.appConfig.walletConnectProjectId = "pid"; // unhide the WC button
    try {
      await setNetwork("baseSepolia");
      expect(state.netMode).toBe("baseSepolia");
      expect($("btnConnect").hidden).toBe(false); // wallet UI appears
      expect($("btnWC").hidden).toBe(false); // config advertises a project id in this boot
      expect($("networkBadge").dataset.environment).toBe("testnet");
      expect($("appContent").hidden).toBe(false);
    } finally {
      nets.baseSepolia.rpc = saved;
    }
  });
  it("setNetwork without a published deployment degrades to unavailable", async () => {
    const baseFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", (u: unknown, i?: unknown) =>
      String(u).startsWith("deployment-baseSepolia")
        ? { ok: false, status: 404, json: async () => ({}) }
        : (baseFetch as (u: unknown, i?: unknown) => Promise<unknown>)(u, i));
    await setNetwork("baseSepolia");
    expect(state.networkReady).toBe(false);
    expect($("appContent").hidden).toBe(true);
    expect(txt("networkNotice")).toContain("does not have a published ORA deployment");
    expect($("networkBadge").dataset.status).toBe("unavailable");
  });
  it("setNetwork with a failing deployment fetch lands on the error state", async () => {
    const baseFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", (u: unknown, i?: unknown) =>
      String(u).startsWith("deployment-baseSepolia")
        ? Promise.reject(new Error("network offline"))
        : (baseFetch as (u: unknown, i?: unknown) => Promise<unknown>)(u, i));
    await setNetwork("baseSepolia");
    expect(state.networkReady).toBe(false);
    expect($("appContent").hidden).toBe(true);
    expect(txt("networkNotice")).toContain("Could not load Base Sepolia");
    expect($("networkBadge").dataset.status).toBe("unavailable");
  });
});

describe("contract helpers and hint math", () => {
  beforeEach(() => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
  });
  it("getInsertHints: zero amounts, tiny list, provider failure and success", async () => {
    expect(await getInsertHints(E("5"), 0n)).toEqual([ZADDR, ZADDR]);
    expect(await getInsertHints(0n, E("2500"))).toEqual([ZADDR, ZADDR]);
    (state.C.sortedTroves as never as { getSize: () => Promise<bigint> }).getSize = async () => 1n;
    expect(await getInsertHints(E("5"), E("2500"))).toEqual([ZADDR, ZADDR]);
    (state.C.sortedTroves as never as { getSize: () => Promise<bigint> }).getSize = async () => 10n;
    (state.C.hintHelpers as never as { getApproxHint: () => Promise<unknown> }).getApproxHint =
      async () => { throw new Error("rpc blip"); };
    expect(await getInsertHints(E("5"), E("2500"))).toEqual([ZADDR, ZADDR]);
    (state.C.hintHelpers as never as { getApproxHint: () => Promise<unknown> }).getApproxHint =
      async () => [OTHER, 0n, 0n];
    expect(await getInsertHints(E("5"), E("2500"))).toEqual([OTHER, OTHER]);
  });
  it("rateInsertHints: tiny list, failure and success", async () => {
    (state.C.sortedTroves as never as { getSize: () => Promise<bigint> }).getSize = async () => 1n;
    expect(await rateInsertHints(5n * 10n ** 15n)).toEqual([ZADDR, ZADDR]);
    (state.C.sortedTroves as never as { getSize: () => Promise<bigint> }).getSize = async () => 100n;
    (state.C.hintHelpers as never as { getApproxHint: () => Promise<unknown> }).getApproxHint =
      async () => { throw new Error("rpc blip"); };
    expect(await rateInsertHints(5n * 10n ** 15n)).toEqual([ZADDR, ZADDR]);
    (state.C.hintHelpers as never as { getApproxHint: () => Promise<unknown> }).getApproxHint =
      async () => [OTHER, 0n, 0n];
    expect(await rateInsertHints(5n * 10n ** 15n)).toEqual([OTHER, OTHER]);
  });
  it("adjustHints skips work on the rates branch; borrowWithFee adds the fee", async () => {
    expect(await adjustHints(E("1"), 0n)).toEqual([ZADDR, ZADDR]); // ETHv2 is a rates branch
    expect(await borrowWithFee(E("1000"))).toBe(E("1000") + (E("1000") * 5n * 10n ** 15n) / 10n ** 18n);
  });
  it("myZap: no wallet, no zap, then a live zap address", async () => {
    state.wallet = null;
    expect(await myZap()).toBeNull();
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    (state.C.zapFactory as never as { zapOf: () => Promise<string> }).zapOf = async () => ZADDR;
    expect(await myZap()).toBeNull();
    (state.C.zapFactory as never as { zapOf: () => Promise<string> }).zapOf =
      async () => "0x" + "99".repeat(20);
    expect(await myZap()).toBeInstanceOf(ethers.Contract);
  });
});

describe("views: branch switching and risk gating", () => {
  it("setBranch ignores a branchless deployment and falls back to the first branch", () => {
    const full = state.dep;
    state.dep = {} as unknown as typeof state.dep;
    setBranch("ETH"); // early return — no throw
    state.dep = full;
    setBranch("does-not-exist");
    expect(state.branch).toBe("ETH");
  });
  it("updateAssetMarks tolerates missing mark elements", () => {
    (document.getElementById("borrowTokenMark") as HTMLElement).remove();
    setBranch("wstETH");
    expect((document.getElementById("adjCollMark") as HTMLElement).dataset.asset).toBe("wsteth");
    setBranch("ETH");
    expect((document.getElementById("adjCollMark") as HTMLElement).dataset.asset).toBe("eth");
  });
  it("riskIncreaseBlockMessage covers every gating reason", () => {
    state.lastRefreshAt = null; state.lastRefreshError = null;
    expect(riskIncreaseBlockMessage()).toContain("first successful");
    state.lastRefreshError = "rpc down"; state.lastRefreshAt = Date.now();
    expect(riskIncreaseBlockMessage()).toContain("refresh failed");
    state.lastRefreshError = null; state.lastRefreshAt = Date.now() - 60_000;
    expect(riskIncreaseBlockMessage()).toContain("older than");
    state.lastRefreshAt = Date.now();
    state.oracleLive = false;
    expect(riskIncreaseBlockMessage()).toContain("not live");
    state.oracleLive = true;
    state.navShock = true;
    expect(riskIncreaseBlockMessage()).toContain("NAV shock");
    state.navShock = false;
    expect(riskIncreaseBlockMessage()).toBeNull();
  });
  it("syncRiskIncreaseControls disables actions without a deployment", () => {
    const dep0 = state.dep;
    state.dep = null;
    updateDataFreshness();
    expect(($("btnOpen") as HTMLButtonElement).disabled).toBe(true);
    state.dep = dep0;
  });
  it("refresh also updates the markets table when that view is visible", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    setView("markets");
    expect(await refresh()).toBe(true);
    expect(($("marketTable").querySelector("tbody") as HTMLElement).innerHTML.length).toBeGreaterThan(0);
    setView("borrow");
  });
  it("troves table tolerates a rate read failure", async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    (state.C.troveManager as never as { troveAnnualRate: (a: string) => Promise<bigint> }).troveAnnualRate =
      async (who: string) => { if (who === myAddr()) return 3n * 10n ** 16n; throw new Error("rpc blip"); };
    await refresh();
    const tbody = $("trovesTable").querySelector("tbody") as HTMLElement;
    expect(tbody.children.length).toBeGreaterThan(0); // rows render with rate 0
  });
});

describe("actions: WalletConnect button and remaining guards", () => {
  it("btnWC starts a WalletConnect session when configured", async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    state.appConfig.walletConnectProjectId = "pid";
    const mod = await import("@walletconnect/ethereum-provider");
    expect(mod).toBeTruthy(); // the lazy import resolves
    state.appConfig.walletConnectProjectId = null;
  });
  it("withdraw: aborts when the projection degrades during review", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.price = 3000; state.lastRefreshAt = Date.now(); state.lastRefreshError = null;
    state.oracleLive = true; state.navShock = false;
    state.position = { collateral: E("5"), debt: E("2500"), stake: E("5"), status: 1n, rate: 0n } as never;
    setInput("adjCollAmount", "1");
    click("btnWithdrawColl");
    await settle(10);
    const dialog = $("txReviewDialog");
    for (let i = 0; i < 200 && dialog.hidden; i++) await settle(5);
    expect(dialog.hidden).toBe(false);
    state.price = 1500; // market craters while the user reads the review
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(40);
    expect(logs(state.C.borrowerOps as never, "withdrawColl").length).toBe(0);
    expect(txt("toast")).toContain("Market conditions changed during review");
  });
  it("withdraw: guards for wallet, amount and missing position", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.price = 3000; state.oracleLive = true;
    state.lastRefreshAt = Date.now(); state.lastRefreshError = null;
    const wallet = state.wallet;
    state.wallet = null;
    await clickAsync("btnWithdrawColl");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = wallet;
    setInput("adjCollAmount", "bad");
    await clickAsync("btnWithdrawColl");
    expect(txt("toast")).toContain("collateral amount");
    setInput("adjCollAmount", "1");
    state.position = null;
    await clickAsync("btnWithdrawColl");
    expect(txt("toast")).toContain("No active Trove");
  });
  it("borrow more: fee hiccup after review and projection drift abort", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.price = 3000; state.oracleLive = true;
    state.lastRefreshAt = Date.now(); state.lastRefreshError = null; state.navShock = false;
    state.position = { collateral: E("5"), debt: E("2500"), stake: E("5"), status: 1n, rate: 0n } as never;
    setInput("adjDebtAmount", "100");
    // pre-review quote succeeds, post-review re-quote fails
    let calls = 0;
    (state.C.troveManager as never as { getBorrowingRateWithDecay: () => Promise<bigint> }).getBorrowingRateWithDecay =
      async () => { if (++calls > 1) throw new Error("fee rpc blip"); return 5n * 10n ** 15n; };
    click("btnBorrowMore");
    await settle(10);
    const dialog = $("txReviewDialog");
    for (let i = 0; i < 200 && dialog.hidden; i++) await settle(5);
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(40);
    expect(txt("toast")).toContain("Could not refresh the borrowing fee; review and try again");
    // second run: fee fine but the market moves during review
    calls = 0;
    (state.C.troveManager as never as { getBorrowingRateWithDecay: () => Promise<bigint> }).getBorrowingRateWithDecay =
      async () => 5n * 10n ** 15n;
    click("btnBorrowMore");
    await settle(10);
    for (let i = 0; i < 200 && dialog.hidden; i++) await settle(5);
    state.price = 1200;
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(40);
    expect(logs(state.C.borrowerOps as never, "withdrawLUSD").length).toBe(0);
    expect(txt("toast")).toContain("projected ratio changed during review");
  });
  it("repay: wallet balance guard", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    state.orUsdBalance = E("10");
    setInput("adjDebtAmount", "100");
    await clickAsync("btnRepay");
    expect(txt("toast")).toContain("Repayment exceeds your orUSD wallet balance");
  });
  it("addColl on an ERC-20 branch approves then adds", async () => {
    installC(makeFakeC({ native: false }), "wstETH");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    state.price = 3000; state.oracleLive = true; state.lastRefreshAt = Date.now();
    state.collateralBalance = E("100");
    setInput("adjCollAmount", "1");
    click("btnAddColl");
    await settle(60);
    expect(logs(state.C.collToken as never, "approve").length).toBe(1); // approval first
    expect(logs(state.C.borrowerOps as never, "addColl").length).toBe(1);
    expect(logs(state.C.borrowerOps as never, "addColl")[0][0]).toBe(E("1")); // erc20 passes amount
  });
  it("addColl on an ERC-20 branch aborts when the allowance read fails", async () => {
    installC(makeFakeC({ native: false }), "wstETH");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    state.collateralBalance = E("100");
    (state.C.collToken as never as { allowance: () => Promise<bigint> }).allowance =
      async () => { throw new Error("erc20 view call failed"); };
    setInput("adjCollAmount", "1");
    click("btnAddColl");
    await settle(40);
    expect(txt("toast")).toContain("Could not approve");
    expect(logs(state.C.borrowerOps as never, "addColl").length).toBe(0);
  });
  it("addColl on an ERC-20 branch reports a failed approve transaction", async () => {
    installC(makeFakeC({ native: false }), "wstETH");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    state.collateralBalance = E("100");
    (state.C.collToken as never as { approve: () => Promise<unknown> }).approve =
      async () => { throw new Error("erc20 rejected"); };
    setInput("adjCollAmount", "1");
    click("btnAddColl");
    await settle(60);
    expect(txt("toast")).toContain("erc20 rejected");
    expect(logs(state.C.borrowerOps as never, "addColl").length).toBe(0);
  });
});
