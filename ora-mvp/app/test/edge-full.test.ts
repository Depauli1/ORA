// @vitest-environment jsdom
// Residual edge coverage across the wired UI: mid-review state drift, failed
// sub-transactions, per-branch render fallbacks, the markets-directory failure
// matrix, contract wiring variants, and the WalletConnect button path through
// the real (vitest-mocked) dynamic import.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ethers } from "ethers";

const { wcFake } = vi.hoisted(() => {
  const wcFake = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return ["0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_getBalance") return "0x" + (10n * 10n ** 18n).toString(16);
      if (method === "eth_call") return "0x";
      if (method === "eth_gasPrice") return "0x7";
      return null;
    }),
    on: vi.fn(),
    connect: vi.fn(async () => {}),
  };
  return { wcFake };
});
vi.mock("@walletconnect/ethereum-provider", () => ({
  // the real package exposes EthereumProvider as a named export
  EthereumProvider: { init: vi.fn(async () => wcFake) },
}));

import {
  bootApp, makeFakeC, installC, click, setInput, settle, E, logs, stubWalletSends, txLike,
  html, setServedHtml,
} from "./full-harness";
import { reviewPrice } from "../src/actions";
import { state } from "../src/state";
import { refresh, refreshMarketsTable, setBranch, updateOpenPreview, updateDataFreshness } from "../src/views";
import { connectContracts } from "../src/contracts";
import { connectWallet, pickedEip1193 } from "../src/wallet";

let restore: () => void = () => {};

beforeEach(async () => {
  const app = await bootApp();
  restore = app.restore;
});
afterEach(() => {
  restore();
  delete (window as { ethereum?: unknown }).ethereum;
});

const txt = (id: string) => document.getElementById(id)!.textContent || "";
const recent = () => state.activity[0];
const Z = "0x" + "00".repeat(20);

/** installC + prime the market-data state the boot's failed refresh left empty
 *  (mirrors what a successful refresh over the fakes would have produced). */
function ready(C: Record<string, unknown>, branch = "ETH"): void {
  installC(C, branch);
  state.price = 3000;
  state.lastRefreshAt = Date.now();
  state.lastRefreshError = null;
  state.oracleLive = true;
  state.navShock = false;
  state.collateralBalance = E("100");
  state.nativeBalance = E("100");
  state.orUsdBalance = E("2500");
  state.borrowingRate = 5n * 10n ** 15n; // matches the fake feed so re-quotes are stable
}

/** Drive the review dialog, optionally mutating app state while it is open. */
async function driveReviewMutate(accept: boolean, mutate?: () => void) {
  const dialog = document.getElementById("txReviewDialog") as HTMLElement;
  for (let i = 0; i < 200 && dialog.hidden; i++) await new Promise((r) => setTimeout(r, 5));
  if (dialog.hidden) throw new Error("review dialog never opened");
  mutate?.();
  (document.getElementById(accept ? "reviewConfirm" : "reviewCancel") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 40));
}

describe("wallet discovery + connection edges", () => {
  it("keeps the wallet picker hidden while the connect button is hidden", () => {
    ready(makeFakeC({ native: true }), "ETH");
    const sel = document.getElementById("walletSelect") as HTMLSelectElement;
    expect(document.getElementById("btnConnect")!.hidden).toBe(true); // local demo mode
    const announce = (uuid: string, name: string) =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: { info: { uuid, name }, provider: { request: async () => null } },
      }));
    announce("u1", "MetaMask");
    announce("u2", "Rabby");
    expect(sel.querySelectorAll("option")).toHaveLength(2);
    expect(sel.hidden).toBe(true); // two wallets, but the connect button is hidden
  });

  it("falls back to the first discovered wallet for an out-of-range picker value", () => {
    ready(makeFakeC({ native: true }), "ETH");
    const first = { request: async () => null };
    const second = { request: async () => null };
    state.discoveredWallets = [
      { info: { uuid: "u1", name: "A" }, provider: first },
      { info: { uuid: "u2", name: "B" }, provider: second },
    ] as unknown as typeof state.discoveredWallets;
    const sel = document.getElementById("walletSelect") as HTMLSelectElement;
    sel.innerHTML = '<option value="0">A</option><option value="1">B</option><option value="9">B</option>';
    sel.value = "9"; // no matching wallet index
    expect(pickedEip1193()).toBe(first);
    state.discoveredWallets = [];
  });

  it("connectWallet uses an injected window.ethereum when present", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    (window as { ethereum?: unknown }).ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "eth_requestAccounts" || method === "eth_accounts")
          return ["0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"];
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_getBalance") return "0x" + (10n * 10n ** 18n).toString(16);
        if (method === "eth_call") return "0x";
        return null;
      },
    };
    await connectWallet();
    expect(state.wallet).toBeTruthy();
    expect(txt("btnConnect")).toContain("0xAb58");
    expect(txt("toast")).toContain("Wallet connected");
  });

  it("the WalletConnect button connects through the real dynamic import", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.appConfig.walletConnectProjectId = "test-project";
    click("btnWC");
    await settle(120);
    expect(wcFake.connect).toHaveBeenCalled();
    expect(state.wallet).toBeTruthy();
    expect(txt("toast")).toContain("via WalletConnect");
  });

  it("btnWC without a configured project id is a no-op", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.appConfig.walletConnectProjectId = null;
    wcFake.connect.mockClear();
    click("btnWC");
    await settle(60);
    expect(wcFake.connect).not.toHaveBeenCalled(); // wcProvider() returned null
  });

  it("btnWC on a network with a published chain id passes it to WalletConnect", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.appConfig.walletConnectProjectId = "test-project";
    state.netMode = "baseSepolia"; // chainIdHex 0x14a34
    click("btnWC");
    await settle(120);
    expect(wcFake.connect).toHaveBeenCalled();
    expect(txt("toast")).toContain("via WalletConnect");
  });

  it("tx() tolerates a response without a hash, and an externally reset active id", async () => {
    const C = makeFakeC({ native: true });
    C.borrowerOps!.repayLUSD = async () => ({ wait: async () => ({ status: 1 }) }); // no hash
    ready(C, "ETH");
    setInput("adjDebtAmount", "100");
    click("btnRepay");
    await settle(80);
    expect(recent().label).toBe("Repay orUSD");
    expect(recent().hash).toBeUndefined();
    expect(recent().status).toBe("confirmed");

    // a second tx whose activeActivityId is reset externally must not throw
    const C2 = makeFakeC({ native: true });
    let release!: (r: { status: number }) => void;
    C2.borrowerOps!.repayLUSD = async () => ({
      wait: () => new Promise<{ status: number }>((res) => { release = res; }),
    });
    ready(C2, "ETH");
    setInput("adjDebtAmount", "50");
    click("btnRepay");
    await settle(30);
    state.activeActivityId = "some-other-id"; // e.g. another flow took over
    release({ status: 1 });
    await settle(150);
    expect(state.activeActivityId).toBe("some-other-id"); // finally-clause left it alone
  });
});

describe("open trove: mid-review drift and approval failures", () => {
  it("re-prompts when the market price moved during the review", async () => {
    ready(makeFakeC({ native: true, position: null }), "ETH");
    setInput("openColl", "5");
    setInput("openDebt", "2500");
    click("btnOpen");
    await driveReviewMutate(true, () => { state.price = 100; });
    expect(txt("toast")).toContain("Market price changed during review");
  });

  it("re-prompts when the wallet collateral balance shrank during the review", async () => {
    ready(makeFakeC({ native: true, position: null }), "ETH");
    setInput("openColl", "5");
    setInput("openDebt", "2500");
    click("btnOpen");
    await driveReviewMutate(true, () => { state.collateralBalance = 0n; });
    expect(txt("toast")).toContain("Wallet collateral balance changed");
  });

  it("aborts after the review when risk-increasing actions became blocked", async () => {
    ready(makeFakeC({ native: true, position: null }), "ETH");
    setInput("openColl", "5");
    setInput("openDebt", "2500");
    click("btnOpen");
    await driveReviewMutate(true, () => { state.lastRefreshError = "rpc down"; });
    expect(txt("toast")).toContain("Opening a Trove is paused");
  });

  it("stops when the collateral approval sub-transaction fails (ERC-20 branch)", async () => {
    const C = makeFakeC({ native: false, position: null });
    C.collToken!.approve = async () => { throw new Error("user rejected"); };
    ready(C, "wstETH");
    stubWalletSends();
    setInput("openColl", "12");
    setInput("openDebt", "2500");
    click("btnOpen");
    await driveReviewMutate(true);
    expect(logs(C.borrowerOps, "openTrove")).toHaveLength(0);
    expect(txt("toast")).not.toBe(""); // the failed approval surfaced somewhere
  });

  it("re-prompts when market conditions drift during the collateral approval", async () => {
    const C = makeFakeC({ native: false, position: null });
    let releaseApprove!: (v: unknown) => void;
    C.collToken!.approve = () => new Promise((res) => { releaseApprove = res; });
    ready(C, "wstETH");
    stubWalletSends();
    setInput("openColl", "12");
    setInput("openDebt", "2500");
    click("btnOpen");
    // confirm the review; the handler is now suspended inside the approval tx
    const dialog = document.getElementById("txReviewDialog") as HTMLElement;
    for (let i = 0; i < 200 && dialog.hidden; i++) await new Promise((r) => setTimeout(r, 5));
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(30);
    // raise the branch MCR above the quoted ratio: the pre-review checks ran
    // with the old value, but the post-approval re-quote now falls under it
    // (state the reconcile refresh does not overwrite)
    (state.dep as NonNullable<typeof state.dep>).branches.wstETH!.mcr = 14;
    releaseApprove(txLike());
    await settle(80);
    expect(txt("toast")).toContain("Market conditions changed during collateral approval");
    expect(logs(C.borrowerOps, "openTrove")).toHaveLength(0);
  });
});

describe("adjustments: guards, drift and declines", () => {
  it("rejects junk amounts on add-collateral, borrow-more and repay without side effects", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    setInput("adjCollAmount", "abc");
    click("btnAddColl");
    expect(txt("toast")).toContain("Enter a collateral amount greater than zero");
    setInput("adjDebtAmount", "abc");
    click("btnBorrowMore");
    await settle(20);
    expect(txt("toast")).not.toBe("");
    click("btnRepay");
    await settle(20);
    expect(state.activity).toHaveLength(0);
  });

  it("re-prompts when the position disappears mid-review (concurrent close)", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.position = { collateral: E("5"), debt: E("2500") };
    setInput("adjCollAmount", "1");
    click("btnWithdrawColl");
    await driveReviewMutate(true, () => { state.position = null; });
    expect(txt("toast")).toContain("Market conditions changed during review");
  });

  it("aborts a withdrawal when risk-increasing actions became blocked mid-review", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.position = { collateral: E("5"), debt: E("2500") };
    setInput("adjCollAmount", "1");
    click("btnWithdrawColl");
    await driveReviewMutate(true, () => { state.lastRefreshError = "rpc down"; });
    expect(txt("toast")).toContain("Withdrawing collateral is paused");
  });

  it("borrow-more: decline cancels; a post-review block aborts; rates branch skips the fee quote", async () => {
    const C = makeFakeC({ native: true, rates: true });
    ready(C, "ETHv2");
    state.position = { collateral: E("5"), debt: E("2500") };
    stubWalletSends();
    setInput("adjDebtAmount", "100");
    click("btnBorrowMore");
    await driveReviewMutate(false);
    expect(logs(C.borrowerOps, "withdrawLUSD")).toHaveLength(0);

    setInput("adjDebtAmount", "100");
    click("btnBorrowMore");
    await driveReviewMutate(true, () => { state.lastRefreshError = "rpc down"; });
    expect(txt("toast")).toContain("Borrowing orUSD is paused");
    expect(logs(C.borrowerOps, "withdrawLUSD")).toHaveLength(0);

    setInput("adjDebtAmount", "100");
    state.lastRefreshError = null; // a successful refresh arrived
    click("btnBorrowMore");
    await driveReviewMutate(true);
    expect(logs(C.borrowerOps, "withdrawLUSD")).toHaveLength(1);
  });

  it("close proceeds when the wallet holds enough orUSD to settle the debt", async () => {
    const C = makeFakeC({ native: true });
    ready(C, "ETH");
    stubWalletSends();
    click("btnClose");
    await settle(80);
    expect(logs(C.borrowerOps, "closeTrove")).toHaveLength(1);
    expect(recent().label).toBe("Close Trove");
  });

  it("rate change validates its input against the allowed band", () => {
    ready(makeFakeC({ native: true, rates: true }), "ETHv2");
    setInput("newRate", "");
    click("btnRate");
    expect(txt("toast")).toContain("Interest rate must be between 0.5 and 100 %/yr");
  });
});

describe("savings, staking and faucet edges", () => {
  it("surfaces non-Error throws from the savings allowance check", async () => {
    const C = makeFakeC({ native: true, rates: true });
    C.orUSD!.allowance = async () => { throw "allowance rpc exploded"; };
    ready(C, "ETHv2");
    setInput("svAmount", "10");
    click("btnSvDeposit");
    await settle(40);
    expect(txt("toast")).toContain("Could not prepare the savings deposit: allowance rpc exploded");
  });

  it("aborts the ORA stake when the approval sub-transaction fails", async () => {
    const C = makeFakeC({ native: true, stakingMode: true });
    C.ora!.approve = async () => { throw new Error("rejected"); };
    ready(C, "ETH");
    stubWalletSends();
    click("btnStake"); // stkInput defaults to 50
    await settle(60);
    expect(logs(C.staking, "stake")).toHaveLength(0);
  });

  it("surfaces non-Error throws from the staking allowance check", async () => {
    const C = makeFakeC({ native: true, stakingMode: true });
    C.ora!.allowance = async () => { throw "staking rpc exploded"; };
    ready(C, "ETH");
    click("btnStake");
    await settle(40);
    expect(txt("toast")).toContain("Could not prepare the ORA stake: staking rpc exploded");
  });

  it("faucet: no provider keeps the record at submitted; a null receipt never confirms", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    const provider = state.provider as unknown as { waitForTransaction: unknown };
    provider.waitForTransaction = async () => null;
    click("btnFaucet");
    await settle(60);
    expect(recent().label).toBe("Claim test ORA");
    expect(recent().status).toBe("submitted"); // null receipt → stays pending

    state.provider = null;
    click("btnFaucet");
    await settle(60);
    expect(recent().status).toBe("submitted"); // no provider → no confirmation watcher
  });
});

describe("market simulator edges", () => {
  it("sets ETH/USD directly when no fallback aggregator is wired", async () => {
    const C = makeFakeC({ aggEthFb: null });
    ready(C, "ETH");
    stubWalletSends();
    setInput("simInput", "2500");
    click("btnSetPrice");
    await settle(80);
    expect(logs(C.aggEth, "setAnswer")).toHaveLength(1);
    expect(logs(C.aggEth, "setAnswer")[0][0]).toBe(250000000000n);
  });

  it("skips the primary set when the fallback set fails", async () => {
    const C = makeFakeC();
    C.aggEthFb!.setAnswer = async () => { throw new Error("fallback write rejected"); };
    ready(C, "ETH");
    setInput("simInput", "2500");
    click("btnSetPrice");
    await settle(80);
    expect(logs(C.aggEth, "setAnswer")).toHaveLength(0); // the primary was never reached
    expect(txt("toast")).not.toBe("");
  });

  it("refuses bumps on a read-only (live) ETH/USD feed", () => {
    ready(makeFakeC({ aggEth: null }), "ETH");
    const bump = document.querySelector<HTMLButtonElement>("button[data-bump='-10']")!;
    bump.click();
    expect(txt("toast")).toContain("Live Chainlink feed — not settable");
  });

  it("skips the circuit breaker when the stETH/ETH rate set fails", async () => {
    const C = makeFakeC({ native: false });
    C.aggRate!.setAnswer = async () => { throw new Error("rate write rejected"); };
    ready(C, "wstETH");
    (document.querySelector("button[data-rate]") as HTMLButtonElement).click();
    await settle(80);
    expect(logs(C.priceFeed, "fetchPrice")).toHaveLength(0); // breaker skipped
    expect(txt("toast")).not.toBe("");
  });
});

describe("leverage zap edges", () => {
  function leverForm(): void {
    setInput("lvColl", "2");
    setInput("lvRate", "3");
    setInput("lvSlip", "5");
  }

  it("refuses to open when the personal zap already holds a position", async () => {
    ready(makeFakeC({ native: true, rates: true }), "ETHv2");
    leverForm();
    click("btnLvOpen");
    await settle(60);
    expect(txt("toast")).toContain("A leveraged position is already open in your Zap");
  });

  it("treats a failing zap position read as no zap and proceeds to the review", async () => {
    const zapAddr = "0x" + "77".repeat(20);
    const C = makeFakeC({ native: true, rates: true, zapOf: zapAddr });
    ready(C, "ETHv2");
    // the real zap contract call goes through the provider — make it reject
    const selPosition = ethers.id("position()").slice(0, 10);
    const p = state.provider as unknown as { call: (t: unknown) => Promise<string> };
    const orig = p.call.bind(p);
    p.call = (async (t: { to?: string; data?: string }) => {
      if (String(t?.to || "").toLowerCase() === zapAddr && String(t?.data || "").startsWith(selPosition)) {
        throw new Error("zap read failed");
      }
      return orig(t);
    }) as typeof p.call;
    leverForm();
    click("btnLvOpen");
    await driveReviewMutate(false); // review opened → needsZap path
    expect(logs(C.zapFactory, "createZap")).toHaveLength(0);
  });

  it("labels the leveraged review with the raw netMode when the network is unknown", async () => {
    ready(makeFakeC({ native: true, rates: true, zapOf: Z }), "ETHv2");
    state.netMode = "bogus";
    leverForm();
    click("btnLvOpen");
    await driveReviewMutate(false);
    expect(document.getElementById("reviewNetwork")!.textContent).toBe("bogus");
  });

  it("declined review aborts; a post-review risk block aborts too", async () => {
    const C = makeFakeC({ native: true, rates: true, zapOf: Z });
    ready(C, "ETHv2");
    leverForm();
    click("btnLvOpen");
    await driveReviewMutate(false);
    expect(logs(C.zapFactory, "createZap")).toHaveLength(0);

    leverForm();
    click("btnLvOpen");
    await driveReviewMutate(true, () => { state.lastRefreshError = "rpc down"; });
    expect(txt("toast")).toContain("Opening a leveraged position is paused");
    expect(logs(C.zapFactory, "createZap")).toHaveLength(0);
  });

  it("aborts when the zap-creation sub-transaction fails or yields no zap", async () => {
    // (a) the creation tx itself fails
    const C = makeFakeC({ native: true, rates: true, zapOf: Z });
    C.zapFactory!.createZap = async () => { throw new Error("create rejected"); };
    ready(C, "ETHv2");
    stubWalletSends();
    leverForm();
    click("btnLvOpen");
    await driveReviewMutate(true);
    expect(logs(C.borrowerOps, "openTroveWithRate")).toHaveLength(0);
    expect(txt("toast")).not.toBe("");

    // (b) creation "succeeds" but the wallet still has no zap → give up cleanly
    const C2 = makeFakeC({ native: true, rates: true, zapOf: Z });
    ready(C2, "ETHv2");
    stubWalletSends();
    leverForm();
    click("btnLvOpen");
    await driveReviewMutate(true);
    expect(logs(C2.zapFactory, "createZap")).toHaveLength(1);
    expect(logs(C2.borrowerOps, "openTroveWithRate")).toHaveLength(0);
  });

  it("re-checks risk and price after the zap-creation sub-transaction", async () => {
    const zapAddr = "0x" + "99".repeat(20);

    // (a) the post-creation state refresh fails → risk-increasing stays blocked
    const C = makeFakeC({ native: true, rates: true, zapOf: Z });
    let created = false;
    C.zapFactory!.zapOf = async () => (created ? zapAddr : Z);
    C.zapFactory!.createZap = async () => { created = true; return { hash: "0xz", wait: async () => ({ status: 1 }) }; };
    C.troveManager!.getTCR = async () => { throw new Error("tcr down"); }; // reconciling refresh fails
    ready(C, "ETHv2");
    stubWalletSends();
    leverForm();
    click("btnLvOpen");
    await driveReviewMutate(true);
    expect(txt("toast")).toContain("Opening a leveraged position is paused");
    expect(logs(C.borrowerOps, "openTroveWithRate")).toHaveLength(0);

    // (b) the reconciling refresh succeeds but reports a drifted price
    const C2 = makeFakeC({ native: true, rates: true, zapOf: Z });
    let created2 = false;
    C2.zapFactory!.zapOf = async () => (created2 ? zapAddr : Z);
    C2.zapFactory!.createZap = async () => { created2 = true; return { hash: "0xz", wait: async () => ({ status: 1 }) }; };
    ready(C2, "ETHv2");
    stubWalletSends();
    leverForm();
    click("btnLvOpen");
    await driveReviewMutate(true, () => {
      // the refresh that runs after zap creation will see this price
      C2.priceFeed!.getPrice = async () => E("2900"); // −3.3% vs the 3000 quote
    });
    expect(txt("toast")).toContain("Market conditions changed during Zap setup");
    expect(logs(C2.borrowerOps, "openTroveWithRate")).toHaveLength(0);
  });
});

describe("render fallbacks", () => {
  it("shows a read-only state when no wallet is connected", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.wallet = null;
    await refresh();
    expect(txt("balEth")).toBe("—");
    expect(txt("openCollBalance")).toBe("Connect wallet");
    expect(txt("adjCollBalance")).toBe("Connect wallet");
    expect(txt("adjDebtBalance")).toBe("Connect wallet");
  });

  it("renders an em-dash TCR with zero troves and flags recovery mode", async () => {
    const C = makeFakeC({ native: true });
    C.troveManager!.getTroveOwnersCount = async () => 0n;
    C.troveManager!.checkRecoveryMode = async () => true;
    ready(C, "ETH");
    await refresh();
    expect(txt("stTcr")).toBe("—");
    expect(txt("stMode")).toBe("RECOVERY");
    expect(document.getElementById("stMode")!.className).toBe("bad");
  });

  it("renders the collateral symbol on a read-only ETH/USD simulator (ERC-20 branch)", async () => {
    ready(makeFakeC({ native: false, aggEth: null }), "wstETH");
    await refresh();
    expect(txt("simPrice")).toContain("(wstETH)");
  });

  it("handles a missing NAV aggregator without failing the refresh", async () => {
    ready(makeFakeC({ native: true, aggNav: null }), "ETH");
    await refresh();
    expect(state.lastRefreshError).toBeNull();
  });

  it("renders guarded copy for a zero-debt position, blocked data and zero-collateral", async () => {
    ready(makeFakeC({ native: true, position: { collateral: E("5"), debt: 0n } }), "ETH");
    await refresh();
    expect(txt("tvIcr")).toBe("—"); // icr is not finite
    expect(document.getElementById("positionHealthMeter")!.getAttribute("aria-valuenow")).toBe("—");

    state.lastRefreshError = "rpc down";
    updateDataFreshness();
    expect(txt("positionRiskMessage")).toContain("Current ratio unavailable");

    state.lastRefreshError = null;
    ready(makeFakeC({ native: true, position: { collateral: 0n, debt: E("100") } }), "ETH");
    await refresh();
    expect(txt("tvLiq")).toBe("—"); // no collateral → no liquidation price
  });

  it("renders 0% pool share and savings APY at zero totals", async () => {
    const C = makeFakeC({ native: true, rates: true });
    C.stabilityPool!.getTotalLUSDDeposits = async () => 0n;
    C.vault!.totalAssets = async () => 0n;
    C.troveManager!.getEntireSystemDebt = async () => 0n;
    ready(C, "ETHv2");
    await refresh();
    expect(txt("spShare")).toContain("0");
    expect(txt("svApy")).toBe("No TVL");
    expect(txt("stFee")).toContain("0");
  });

  it("falls back to the default borrowing fee when none is known", () => {
    ready(makeFakeC({ native: true }), "ETH");
    (state as { borrowingRate: bigint | null }).borrowingRate = null; // simulate an unknown fee
    setInput("openColl", "5");
    setInput("openDebt", "2500");
    expect(() => updateOpenPreview()).not.toThrow();
    expect(txt("openFee")).toContain("orUSD");
  });

  it("marks unknown collateral symbols without a dedicated label element", () => {
    ready(makeFakeC({ native: true }), "ETH");
    document.getElementById("openCollSymbol")!.remove();
    expect(() => setBranch("wstETH")).not.toThrow();
    expect(txt("borrowTokenMark")).toBe("w");
  });

  it("switches branch visibility between testnet and mainnet modes", () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.netMode = "baseSepolia";
    setBranch("ETH");
    expect(txt("riskSub")).toContain("simulator is testnet-only");
    state.netMode = "local"; // the local demo is also flagged as a testnet environment
    setBranch("ETH");
    expect(txt("riskSub")).toContain("simulator is testnet-only");
    state.netMode = "base"; // mainnet gets the production copy
    setBranch("ETH");
    expect(txt("riskSub")).toContain("Troves nearest liquidation");
  });

  it("mentions recovery mode in adjustment risk copy", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.position = { collateral: E("5"), debt: E("2500") };
    state.recoveryMode = true;
    setInput("adjCollAmount", "1");
    click("btnWithdrawColl");
    await driveReviewMutate(false);
    expect(document.getElementById("reviewRiskMessage")!.textContent).toContain("Recovery Mode is active");
  });
});

describe("markets directory failures", () => {
  it("falls back to the base trove-manager ABI when no V2 ABI is published", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    delete (state.dep as { abis: { troveManagerV2?: unknown } }).abis.troveManagerV2;
    await refreshMarketsTable();
    expect(document.querySelectorAll("#marketTable tbody tr")).toHaveLength(4);
    expect(txt("marketDirectoryStatus")).toBe("4 markets · on-chain data");
  });

  it("counts a single failing data source and flags a degraded oracle", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    const pad = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
    const selLive = ethers.id("oracleLive()").slice(0, 10);
    const p = state.provider as unknown as { call: (t: unknown) => Promise<string> };
    const orig = p.call.bind(p);
    const branches = (state.dep as NonNullable<typeof state.dep>).branches;
    const failing = branches.tBILL!.priceFeed.toLowerCase();
    const degraded = branches.wstETH!.priceFeed.toLowerCase();
    p.call = (async (t: { to?: string; data?: string }) => {
      const to = String(t?.to || "").toLowerCase();
      const data = String(t?.data || "");
      if (to === failing && data.startsWith(selLive)) throw new Error("feed down");
      if (to === degraded && data.startsWith(selLive)) return pad(0n); // oracle reports down
      return orig(t);
    }) as typeof p.call;
    await refreshMarketsTable();
    expect(txt("marketDirectoryStatus")).toBe("4 markets · 1 data source unavailable");
    const pills = Array.from(document.querySelectorAll("#marketTable .market-status"));
    expect(pills.map((el) => el.textContent)).toContain("Degraded");
    expect(pills.map((el) => el.textContent)).toContain("Unavailable");
    expect(pills.filter((el) => el.textContent === "Live").length).toBe(2);
  });

  it("falls back to the default MCR for branches with an unparseable value", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    ((state.dep as NonNullable<typeof state.dep>).branches.wstETH as { mcr?: string }).mcr = "not-a-number";
    await refreshMarketsTable();
    const row = Array.from(document.querySelectorAll("#marketTable tbody tr"))
      .find((tr) => tr.querySelector("span")?.textContent?.toLowerCase().includes("wst"));
    expect(row!.textContent).toContain("110%"); // 1.1 default
  });
});

describe("contract wiring variants", () => {
  it("omits optional aggregators when the deployment does not wire them", () => {
    ready(makeFakeC({ native: true }), "ETH");
    const dep = JSON.parse(JSON.stringify(state.dep));
    dep.shared.sequencerSettable = false;
    dep.shared.ethUsdFallbackSettable = false;
    state.dep = dep;
    connectContracts();
    expect(state.C.aggSeq).toBeNull();
    expect(state.C.aggEthFb).toBeNull();
    expect(state.C.troveManager).toBeTruthy();
  });

  it("falls back to the base trove-manager ABI for V1-style ERC-20 branches", () => {
    ready(makeFakeC({ native: false }), "wstETH");
    const dep = JSON.parse(JSON.stringify(state.dep));
    delete dep.abis.troveManagerV2;
    state.dep = dep;
    connectContracts();
    const expected = new ethers.Interface((state.dep as NonNullable<typeof state.dep>).abis.troveManager);
    expect(state.C.troveManager.interface.format().join("|")).toBe(expected.format().join("|"));
  });
});

describe("gate leftovers: allowances, faucet defaults, labels and guards", () => {
  it("skips the approval when the tracked allowance already covers the collateral", async () => {
    const C = makeFakeC({ native: false, position: null });
    C.collToken!.allowance = async () => E("1000000");
    ready(C, "wstETH");
    setInput("openColl", "12");
    setInput("openDebt", "2500");
    click("btnOpen");
    await driveReviewMutate(true);
    expect(logs(C.collToken, "approve")).toHaveLength(0);
    expect(logs(C.borrowerOps, "openTrove")).toHaveLength(1);
  });

  it("surfaces non-Error throws from the allowance check", async () => {
    const C = makeFakeC({ native: false, position: null });
    C.collToken!.allowance = async () => { throw "allowance feed down"; };
    ready(C, "wstETH");
    setInput("openColl", "12");
    setInput("openDebt", "2500");
    click("btnOpen");
    await driveReviewMutate(true);
    expect(txt("toast")).toContain("Could not approve wstETH: allowance feed down");
    expect(logs(C.borrowerOps, "openTrove")).toHaveLength(0);
  });

  it("re-checks the risk gate after the collateral approval", async () => {
    const C = makeFakeC({ native: false, position: null });
    // the reconciling refresh inside the approval tx fails → risk stays blocked
    C.troveManager!.getTCR = async () => { throw new Error("tcr down"); };
    ready(C, "wstETH");
    setInput("openColl", "12");
    setInput("openDebt", "2500");
    click("btnOpen");
    await driveReviewMutate(true);
    expect(logs(C.collToken, "approve")).toHaveLength(1);
    expect(txt("toast")).toContain("Opening a Trove is paused");
    expect(logs(C.borrowerOps, "openTrove")).toHaveLength(0);
  });

  it("falls back to a 10-token faucet amount when the branch does not set one", async () => {
    const C = makeFakeC({ native: false });
    ready(C, "wstETH");
    delete (state.dep as NonNullable<typeof state.dep>).branches.wstETH!.faucetAmount;
    click("btnWstFaucet");
    await settle(80);
    expect(logs(C.collToken, "faucet").at(-1)).toEqual([E("10")]);
    expect(txt("toast")).toContain("faucet confirmed");
  });

  it("treats an empty interest-rate input as 0 and rejects it", async () => {
    ready(makeFakeC({ native: true, rates: true, position: null }), "ETHv2");
    setInput("openColl", "5");
    setInput("openDebt", "2500");
    setInput("openRate", "");
    click("btnOpen");
    await settle(40);
    expect(txt("toast")).toContain("Interest rate must be between 0.5 and 100 %/yr");
  });

  it("labels the open review with the raw netMode when the network is unknown", async () => {
    ready(makeFakeC({ native: true, position: null }), "ETH");
    state.netMode = "bogus";
    setInput("openColl", "5");
    setInput("openDebt", "2500");
    click("btnOpen");
    await driveReviewMutate(false);
    expect(document.getElementById("reviewNetwork")!.textContent).toBe("bogus");
  });

  it("mentions recovery mode in the open review copy", async () => {
    ready(makeFakeC({ native: true, position: null }), "ETH");
    state.recoveryMode = true;
    setInput("openColl", "5");
    setInput("openDebt", "2500");
    click("btnOpen");
    await driveReviewMutate(false);
    expect(document.getElementById("reviewRiskMessage")!.textContent).toContain("Recovery Mode is active");
  });

  it("borrow-more: a position that vanishes mid-quote aborts with the fallback reason", async () => {
    const C = makeFakeC({ native: true });
    ready(C, "ETH");
    state.position = { collateral: E("5"), debt: E("2500") };
    let releaseRate!: (v: bigint) => void;
    C.troveManager!.getBorrowingRateWithDecay = () => new Promise<bigint>((r) => { releaseRate = r; });
    setInput("adjDebtAmount", "100");
    click("btnBorrowMore");
    await settle(20);
    state.position = null; // the Trove closes while the fee quote is in flight
    releaseRate(5n * 10n ** 15n);
    await settle(60);
    expect(txt("toast")).toBe("Could not calculate the projected position.");
    expect(logs(C.borrowerOps, "withdrawLUSD")).toHaveLength(0);
  });

  it("shows the Safe health badge and a suffix-free feed label on the native branch", async () => {
    ready(makeFakeC({ native: true, aggEth: null }), "ETH");
    await refresh();
    updateDataFreshness();
    expect(txt("positionHealthBadge")).toBe("Safe");
    expect(txt("simPrice")).not.toContain("(");
  });

  it("reviewPrice renders unavailable for missing or non-positive quotes", () => {
    expect(reviewPrice(0)).toBe("Unavailable");
    expect(reviewPrice(Number.NaN)).toBe("Unavailable");
    expect(reviewPrice(-1)).toBe("Unavailable");
    expect(reviewPrice(3000)).toBe("$3,000");
  });

  it("shows Caution and Critical health badges for risky positions", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.position = { collateral: E("1"), debt: E("2500") }; // 120% ratio at $3,000
    updateDataFreshness();
    expect(txt("positionHealthBadge")).toBe("Caution");
    state.position = { collateral: E("0.5"), debt: E("2500") }; // 60% ratio
    updateDataFreshness();
    expect(txt("positionHealthBadge")).toBe("Critical");
  });

  it("labels withdrawal and borrowing reviews with the raw netMode and recovery copy", async () => {
    ready(makeFakeC({ native: true }), "ETH");
    state.position = { collateral: E("5"), debt: E("2500") };
    state.netMode = "bogus";
    state.recoveryMode = true;
    setInput("adjCollAmount", "1");
    click("btnWithdrawColl");
    await driveReviewMutate(false);
    expect(document.getElementById("reviewNetwork")!.textContent).toBe("bogus");

    setInput("adjDebtAmount", "100");
    click("btnBorrowMore");
    await driveReviewMutate(false);
    expect(document.getElementById("reviewNetwork")!.textContent).toBe("bogus");
    expect(document.getElementById("reviewRiskMessage")!.textContent).toContain("Recovery Mode is active");
  });

  it("an empty data-view attribute falls back to the borrow view", async () => {
    const original = html;
    setServedHtml(original.replace('data-view="borrow"', 'data-view=""'));
    const app = await bootApp();
    restore = app.restore; // hand cleanup to the shared afterEach
    setServedHtml(original);
    (document.querySelector('button[data-view=""]') as HTMLButtonElement).click();
    const panel = document.getElementById("viewBorrow") as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(panel.classList.contains("is-active")).toBe(true);
  });
});
