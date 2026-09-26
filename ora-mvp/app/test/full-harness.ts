// Shared jsdom harness for the full-app coverage suites: boots the real app
// against a fetch stub that answers JSON-RPC for the provider (balances,
// markets-table eth_calls), then lets each suite inject fake contracts into
// state.C and drive the real UI.
import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { boot } from "../src/main";
import { state, myAddr } from "../src/state";
import { setBranch } from "../src/views";

const APP = path.join(__dirname, "..");
export let html = fs.readFileSync(path.join(APP, "index.html"), "utf8");

/** Swap the index.html served by subsequent bootApp() calls (restore after!). */
export function setServedHtml(next: string): void {
  html = next;
}
export const deployment = JSON.parse(fs.readFileSync(path.join(APP, "deployment.json"), "utf8"));
export const E = ethers.parseEther;

/** RPC answers by 4-byte selector, so real ethers Contracts work for
 *  provider.getBalance and the markets table's direct Contract calls. */
const SEL = {
  balance: ethers.id("getEntireSystemDebt()").slice(0, 10),
  live: ethers.id("oracleLive()").slice(0, 10),
  price: ethers.id("getPrice()").slice(0, 10),
};
const pad = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

export interface BootOpts {
  hostname?: string;
  config?: Record<string, unknown>;
}

export async function bootApp(opts: BootOpts = {}) {
  document.documentElement.innerHTML = html;
  try { localStorage.clear(); } catch { /* fresh jsdom */ }
  const cfg = opts.config ?? { faucet: true, walletConnectProjectId: null };
  const calls: { url: string; init?: { body?: unknown } }[] = [];
  const stubFetch = async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith("/log")) return { ok: true, json: async () => ({}) };
    if (u.includes("/faucet")) {
      const fr = (cfg as { faucetResponse?: unknown }).faucetResponse;
      if (fr) return fr as { ok: boolean; json: () => Promise<unknown> };
      return { ok: true, json: async () => ({ txHash: "0x" + "fa".repeat(32) }) };
    }
    if (u.startsWith("/config")) return { ok: true, json: async () => ({ ...cfg }) };
    if (u.startsWith("deployment")) return { ok: true, json: async () => JSON.parse(JSON.stringify(deployment)) };
    if (u.endsWith("/rpc")) {
      let method = "", id: unknown = 1, params: unknown[] = [];
      try {
        const body = JSON.parse(String(init?.body || "{}"));
        if (Array.isArray(body)) {
          // ethers batches: answer each with the same per-method router
          return {
            ok: true,
            json: async () => body.map((b: { id?: unknown; method?: string; params?: unknown[] }) =>
              ({ jsonrpc: "2.0", id: b.id, result: rpcResult(b) })),
          };
        }
        method = body.method || ""; id = body.id ?? 1; params = body.params || [];
      } catch { /* ignore */ }
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id, result: rpcResult({ method, params }) }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const rpcResult = (b: { method?: string; params?: unknown[] }): unknown => {
    switch (b.method) {
      case "eth_chainId": return "0x7a69";
      case "eth_blockNumber": return "0x1";
      case "eth_getBalance": return pad(E("10"));
      case "eth_call": {
        const data = String((b.params?.[0] as { data?: string })?.data || "");
        if (data.startsWith(SEL.balance)) return pad(E("250000"));
        if (data.startsWith(SEL.live)) return pad(1n);
        if (data.startsWith(SEL.price)) return pad(E("3000"));
        return "0x";
      }
      case "eth_gasPrice": return "0x7";
      case "eth_getTransactionCount": return "0x0";
      case "eth_estimateGas": return "0x186a0";
      default: return "0x";
    }
  };
  vi.stubGlobal("fetch", stubFetch);
  const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await boot(opts.hostname ?? "localhost");
  await new Promise((r) => setTimeout(r, 60));
  return {
    calls,
    restore: () => {
      vi.unstubAllGlobals();
      consoleErr.mockRestore();
      consoleWarn.mockRestore();
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    },
  };
}

// --- fake contracts -----------------------------------------------------------

export interface FakeContract {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

/** Build a fake ethers-ish contract: every method records its calls. */
export function fake(name: string, methods: Record<string, unknown>): FakeContract {
  const c: FakeContract = { __name: name, __logs: {} as Record<string, unknown[][]> };
  for (const [m, impl] of Object.entries(methods)) {
    c.__logs[m] = [];
    c[m] = (...a: unknown[]) => {
      c.__logs[m].push(a);
      const r = typeof impl === "function" ? (impl as (...x: unknown[]) => unknown)(...a) : impl;
      return r instanceof Promise ? r : Promise.resolve(r);
    };
  }
  return c;
}

export const txLike = (hash = "0x" + "c0".repeat(32)) => ({ hash, wait: async () => ({ status: 1 }) });

export const OTHER = "0x" + "77".repeat(20);
export const ZADDR = "0x" + "00".repeat(20);

export interface FakeCOpts {
  me?: string;
  troveStatus?: bigint; // 1n active, 2n closed...
  price?: bigint;
  native?: boolean; // ETH branch (collToken null)
  rates?: boolean; // ETHv2 extras
  rwa?: boolean;
  zapOf?: string | null; // address, ZADDR = none, null = no zapFactory
  swapSpot?: bigint | null;
  troves?: Array<[string, bigint, bigint]>;
  position?: { collateral: bigint; debt: bigint } | null;
  aggEth?: FakeContract | null;
  aggSeq?: FakeContract | null;
  aggNav?: FakeContract | null;
  aggRate?: FakeContract | null;
  aggEthFb?: FakeContract | null;
  stakingMode?: boolean;
}

/** Array with named tuple members, like an ethers Result. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function named(arr: bigint[], names: string[]): any {
  for (let i = 0; i < names.length; i++) (arr as unknown as Record<string, bigint>)[names[i]] = arr[i];
  return arr;
}

/** A complete, successful state.C for refresh() + the action handlers. */
export function makeFakeC(o: FakeCOpts = {}): Record<string, FakeContract | null> {
  const me = () => (o.me ?? myAddr());
  const E_ = E;
  const price = o.price ?? E_("3000");
  const troves = o.troves ?? [
    [OTHER, E_("2200"), E("1")], // icr 3000/2200 = 136% → liquidatable band?
    [me(), E_("3000"), E("2")], // 200% (you)
    [OTHER, E_("1000"), E("0.2")], // 600% safe
  ] as Array<[string, bigint, bigint]>;
  const position = "position" in o ? o.position : { collateral: E_("5"), debt: E_("2500") };
  const C: Record<string, unknown> = {
    priceFeed: fake("priceFeed", {
      getPrice: async () => price,
      oracleLive: true,
      navShock: false,
      getStEthEthRate: [E_("1.05"), false],
      sequencerUp: true,
      fetchPrice: txLike(),
    }),
    aggEth: o.aggEth === undefined ? fake("aggEth", {
      latestRoundData: [1n, 3000n * 10n ** 8n, 0n, 0n, 1n],
      setAnswer: txLike(),
    }) : o.aggEth,
    aggEthFb: o.aggEthFb === undefined ? fake("aggEthFb", { setAnswer: txLike() }) : o.aggEthFb,
    aggSeq: o.aggSeq === undefined ? fake("aggSeq", {
      latestRoundData: [1n, 0n, 0n, 0n, 1n],
      setAnswer: txLike(),
      makeStale: txLike(),
    }) : o.aggSeq,
    aggNav: o.aggNav === undefined ? fake("aggNav", {
      latestRoundData: [1n, 105000000n, 0n, 0n, 1n],
      setAnswer: txLike(),
    }) : o.aggNav,
    aggRate: o.aggRate === undefined ? fake("aggRate", { setAnswer: txLike() }) : o.aggRate,
    troveManager: fake("troveManager", {
      getTCR: 2n * 10n ** 18n,
      checkRecoveryMode: false,
      getTroveOwnersCount: 5n,
      getBorrowingRateWithDecay: 5n * 10n ** 15n,
      Troves: (who: string) => named(
        who === me() ? [o.troveStatus ?? 1n, E_("5"), E_("2500"), E_("5")] : [2n, 0n, 0n, 0n],
        ["status", "coll", "debt", "stake"],
      ),
      getEntireDebtAndColl: position ? [position.debt, position.collateral] : [0n, 0n],
      getEntireSystemDebt: E_("250000"),
      troveAnnualRate: 3n * 10n ** 16n,
      aggWeightedDebt: E_("90000"),
      liquidate: txLike(),
      liquidatePartial: txLike(),
      redeemCollateral: txLike(),
      adjustTroveRate: txLike(),
    }),
    borrowerOps: fake("borrowerOps", {
      openTrove: txLike(), openTroveWithRate: txLike(), addColl: txLike(),
      withdrawColl: txLike(), withdrawLUSD: txLike(), repayLUSD: txLike(),
      closeTrove: txLike(), adjustTroveRate: txLike(),
    }),
    stabilityPool: fake("stabilityPool", {
      getTotalLUSDDeposits: E_("50000"),
      getCompoundedLUSDDeposit: E_("100"),
      getDepositorETHGain: E_("0.5"),
      getDepositorLQTYGain: E_("2"),
      provideToSP: txLike(), withdrawFromSP: txLike(),
    }),
    multiGetter: fake("multiGetter", {
      getMultipleSortedTroves: async () => troves,
    }),
    sortedTroves: fake("sortedTroves", {
      getSize: 10n,
      findInsertPosition: [OTHER, OTHER],
    }),
    hintHelpers: fake("hintHelpers", {
      getApproxHint: [OTHER, 0n, 0n],
      getRedemptionHints: [OTHER, 2n * 10n ** 20n, E_("100")],
    }),
    vault: o.rates ? fake("vault", {
      sharePrice: E_("1.02"), totalAssets: E_("80000"), balanceOf: E_("50"),
      deposit: txLike(), redeem: txLike(),
    }) : null,
    router: o.rates ? fake("router", { pending: E_("12"), distribute: txLike() }) : null,
    zapFactory: (o.rates || (o.zapOf !== undefined && o.zapOf !== null)) ? fake("zapFactory", {
      zapOf: o.zapOf ?? "0x" + "99".repeat(20),
      createZap: txLike(),
    }) : null,
    swapPool: o.swapSpot === null ? null : fake("swapPool", { spotPrice: o.swapSpot ?? E("3010") }),
    collToken: o.native ? null : fake("collToken", {
      balanceOf: E_("12"),
      allowance: 0n,
      approve: txLike(),
      faucet: txLike(),
    }),
    orUSD: fake("orUSD", {
      totalSupply: E_("1000000"), balanceOf: (who: string) => (who === me() ? E_("2500") : E_("0")),
      allowance: 0n, approve: txLike(),
    }),
    ora: fake("ora", {
      balanceOf: (who: string) => (who === me() ? E_("100") : E_("0")),
      allowance: 0n, approve: txLike(),
    }),
    staking: fake("staking", {
      stakes: E_("30"), totalLQTYStaked: E_("1000"),
      getPendingETHGain: E_("0.1"), getPendingLUSDGain: E_("3"),
      stake: txLike(), unstake: txLike(), target: "0x" + "88".repeat(20),
    }),
    branchStakingMode: !!o.stakingMode,
  };
  if (o.rates && C.zapFactory) {
    // myZap(): zapFactory.zapOf(me) → a Contract whose position() we control
    const zapAddr = o.zapOf ?? "0x" + "99".repeat(20);
    void zapAddr;
    (C.zapFactory as FakeContract).zapOf = async () => zapAddr;
    (C as Record<string, unknown>).__zap = fake("zap", {
      position: [E_("2000"), E_("1.5"), 3n * 10n ** 16n, 1n],
      leverOpen: txLike(), leverClose: txLike(),
    });
  }
  return C as Record<string, FakeContract | null>;
}

/** Inject fakes + a successful refresh, mirroring what setNetwork does. */
export function installC(C: Record<string, unknown>, branch = "ETH") {
  state.branch = branch;
  state.networkReady = true;
  state.dep = JSON.parse(JSON.stringify(deployment));
  // Keep the boot-time provider but answer its reads locally (ethers uses
  // node http, not the stubbed global fetch, so we intercept at the instance).
  const SEL = {
    balance: ethers.id("getEntireSystemDebt()").slice(0, 10),
    live: ethers.id("oracleLive()").slice(0, 10),
    price: ethers.id("getPrice()").slice(0, 10),
    position: ethers.id("position()").slice(0, 10),
    spotPrice: ethers.id("spotPrice()").slice(0, 10),
  };
  const pad = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  const p = state.provider as unknown as {
    getBalance: (a: string) => Promise<bigint>;
    call: (t: { data?: string }) => Promise<string>;
    estimateGas: (t: unknown) => Promise<bigint>;
    getTransactionReceipt: (h: string) => Promise<Record<string, unknown> | null>;
    getFeeData: () => Promise<{ gasPrice: bigint; maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null }>;
    broadcastTransaction: (t: string) => Promise<string>;
  };
  p.getBalance = async () => E("10");
  // real contract sends (lever zaps) estimate gas + fees before signing
  p.estimateGas = async () => 100000n;
  // ethers wraps contract sends in a real ContractTransactionResponse whose
  // wait() polls the receipt — answer it directly instead of hitting /rpc
  p.getTransactionReceipt = async () => ({
    status: 1, blockNumber: 1, blockHash: "0x" + "b1".repeat(32), index: 0,
    hash: "0x" + "c0".repeat(32), transactionHash: "0x" + "c0".repeat(32),
    from: myAddr(), to: "0x" + "99".repeat(20), logs: [], gasUsed: 100000n,
    cumulativeGasUsed: 100000n, gasPrice: 7n, type: 2, contractAddress: null,
    confirmations: async () => 2,
  });
  p.getFeeData = async () => ({ gasPrice: 7n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
  p.broadcastTransaction = async () => "0x" + "c0".repeat(32);
  p.call = async (t) => {
    const d = String(t?.data || "");
    if (d.startsWith(SEL.balance)) return pad(E("250000"));
    if (d.startsWith(SEL.live)) return pad(1n);
    if (d.startsWith(SEL.price)) return pad(E("3000"));
    if (d.startsWith(SEL.position)) return pad(E("2000")) + pad(E("1.5")).slice(2) + pad(3n * 10n ** 16n).slice(2) + pad(1n).slice(2);
    if (d.startsWith(SEL.spotPrice)) return pad(E("3010"));
    return "0x";
  };
  setBranch(branch); // mutates state.C in place with real contracts — then:
  state.C = C as typeof state.C; // swap in the fakes connectContracts never touches
}

/** Route every wallet send straight to a confirmed tx response. */
export function stubWalletSends() {
  if (!state.wallet) throw new Error("no wallet connected");
  state.wallet.sendTransaction = (async () => txLike()) as unknown as typeof state.wallet.sendTransaction;
  // NonceManager.populateTransaction would hit the real RPC for a nonce.
  const w = state.wallet as unknown as { populateTransaction?: (t: unknown) => Promise<unknown> };
  w.populateTransaction = async (t) => t;
}

/** Wait for the review dialog, then click confirm (or cancel). */
export async function driveReview(accept = true) {
  const dialog = document.getElementById("txReviewDialog") as HTMLElement;
  for (let i = 0; i < 200 && dialog.hidden; i++) await new Promise((r) => setTimeout(r, 5));
  if (dialog.hidden) throw new Error("review dialog never opened");
  (document.getElementById(accept ? "reviewConfirm" : "reviewCancel") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 15));
}

export const toastText = () => document.getElementById("toast")!.textContent || "";
export const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
export const click = (id: string) => {
  const el = document.getElementById(id) as HTMLButtonElement;
  // jsdom (like real browsers) swallows clicks on disabled controls; the
  // handlers re-validate everything anyway, so force them on for testing.
  if (el && el.disabled) el.disabled = false;
  el.click();
};
export const setInput = (id: string, v: string) => { (document.getElementById(id) as HTMLInputElement).value = v; };
export const logs = (c: FakeContract | null, m: string) => (c ? ((c.__logs || {})[m] || []) : []) as unknown[][];
