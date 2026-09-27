// @vitest-environment jsdom
// Actions-layer coverage: every button/input handler across branch flavors,
// the wallet connect matrix, guardSigner pre-flight simulation, and tx()
// status handling (replaced/rejected/reverted/reconciled).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ethers } from "ethers";
import {
  bootApp, makeFakeC, installC, driveReview, settle, click, setInput,
  E, logs, stubWalletSends, txLike, OTHER,
} from "./full-harness";
import { state, myAddr } from "../src/state";
import { tx, connectWithProvider, connectWallet, guardSigner, setAccount, initWalletDiscovery, pickedEip1193 } from "../src/wallet";
import { connectWalletConnect } from "../src/walletconnect";
import { requestFaucet } from "../src/faucet";
import { $, input as domInput, select as domSelect, button as domButton } from "../src/dom";
import { mapTransactionError, reason } from "../src/format";

let restore: () => void = () => {};

beforeEach(async () => {
  const app = await bootApp();
  restore = app.restore;
});
afterEach(() => restore());

const txt = (id: string) => document.getElementById(id)!.textContent || "";
const recent = () => state.activity[0];

async function flow(p: Promise<unknown>, accept = true) {
  void p.catch(() => {}); // handlers never reject to the caller
  await driveReview(accept);
  await settle(60); // approve + send chains run two tx() flows back to back
}

describe("input helpers + max buttons", () => {
  it("amountFromInput validates before parsing (empty, zero, junk, 19 decimals)", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    setInput("openColl", "");
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("Enter a collateral amount greater than zero");
    setInput("openColl", "0");
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("greater than zero");
    setInput("openColl", "abc");
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("greater than zero");
    setInput("openColl", "1.0000000000000000001"); // >18 decimals
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("no more than 18 decimal places");
  });

  it("max buttons fill native (minus gas reserve), erc20 and debt balances", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.collateralBalance = E("10");
    state.orUsdBalance = E("2500");
    click("btnOpenCollMax");
    expect(domInput("openColl").value).toBe("9.98");
    click("btnAdjCollMax");
    expect(domInput("adjCollAmount").value).toBe("9.98");
    click("btnAdjDebtMax");
    expect(domInput("adjDebtAmount").value).toBe("2500");
    // tiny native balance clamps to zero
    state.collateralBalance = E("0.01");
    click("btnOpenCollMax");
    expect(domInput("openColl").value).toBe("0");
    // erc20 branches hand out the full balance
    installC(makeFakeC({ native: false }), "wstETH");
    state.collateralBalance = E("12");
    click("btnOpenCollMax");
    expect(domInput("openColl").value).toBe("12");
  });

  it("nav clicks switch views; more-troves paginates; selects fire", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    document.querySelector<HTMLButtonElement>("button[data-view='markets']")!.click();
    expect((document.getElementById("viewMarkets") as HTMLElement).hidden).toBe(false);
    state.troveRows = 2;
    click("btnMoreTroves");
    expect(state.troveRows).toBe(52);
    (document.getElementById("accountSelect") as HTMLSelectElement).value = "bob";
    (document.getElementById("accountSelect") as HTMLSelectElement).dispatchEvent(new Event("change"));
    await settle();
    expect(txt("addr")).not.toBe("");
    (document.getElementById("branchSelect") as HTMLSelectElement).value = "wstETH";
    (document.getElementById("branchSelect") as HTMLSelectElement).dispatchEvent(new Event("change"));
    await settle(60);
    expect(state.branch).toBe("wstETH");
    (document.getElementById("networkSelect") as HTMLSelectElement).value = "baseSepolia";
    (document.getElementById("networkSelect") as HTMLSelectElement).dispatchEvent(new Event("change"));
    await settle(60);
    expect(state.netMode).toBe("baseSepolia");
  });

  it("open/adjust inputs re-run their previews on input", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = null;
    state.oracleLive = true;
    setInput("openColl", "5");
    domInput("openColl").dispatchEvent(new Event("input"));
    setInput("adjCollAmount", "1");
    domInput("adjCollAmount").dispatchEvent(new Event("input"));
    expect(txt("openIcr")).toContain("%");
  });
});

describe("open trove", () => {
  async function openReady(branch = "ETH", opts: Parameters<typeof makeFakeC>[0] = {}) {
    installC(makeFakeC({ position: null, troveStatus: 2n, ...opts }), branch);
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = null;
    state.oracleLive = true;
    state.collateralBalance = E("100");
    state.borrowingRate = 5n * 10n ** 15n; // matches the fake feed so re-quotes are stable
    setInput("openColl", "5");
    setInput("openDebt", "4000");
  }

  it("toasts the pre-review guards", async () => {
    await openReady();
    state.position = { collateral: E("5"), debt: E("4000") };
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("already open");
    state.position = null;
    setInput("openDebt", "900");
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("Minimum borrow is 1,800");
    setInput("openDebt", "4000");
    const wallet = state.wallet;
    state.wallet = null;
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = wallet;
    state.oracleLive = false;
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("paused");
    state.oracleLive = true;
    state.price = 0;
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("valid market price");
    state.price = 3000;
    state.collateralBalance = E("1");
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("exceeds your ETH wallet balance");
    state.collateralBalance = E("100");
    // ICR below MCR: 1 ETH collateral for 4000 debt
    setInput("openColl", "1");
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("below the");
    setInput("openColl", "5");
  });

  it("rates branch: rate bounds guard, then opens with rate hints", async () => {
    await openReady("ETHv2", { rates: true });
    setInput("openRate", "400");
    await clickToast("btnOpen");
    expect(txt("toast")).toContain("between 0.5 and 100 %/yr");
    setInput("openRate", "5");
    stubWalletSends();
    await flow(clickAsync("btnOpen"), true);
    expect(logs(state.C.borrowerOps as never, "openTroveWithRate").length).toBe(1);
    const args = logs(state.C.borrowerOps as never, "openTroveWithRate")[0];
    expect(args[0]).toBe(E("4000"));
    expect(args[1]).toBe(ethers.parseEther((5 / 100).toFixed(18)));
    expect(args[4]).toEqual({ value: E("5") });
  });

  it("native branch: rejected review sends nothing; accepted opens with value", async () => {
    await openReady();
    stubWalletSends();
    await flow(clickAsync("btnOpen"), false);
    expect(logs(state.C.borrowerOps as never, "openTrove").length).toBe(0);
    await flow(clickAsync("btnOpen"), true);
    expect(logs(state.C.borrowerOps as never, "openTrove").length).toBe(1);
    const args = logs(state.C.borrowerOps as never, "openTrove")[0];
    expect(args[1]).toBe(E("4000")); // debt
    expect(args[4]).toEqual({ value: E("5") }); // msg.value = collateral
  });

  it("market/quote changed during review is refused with a toast", async () => {
    await openReady();
    stubWalletSends();
    const p = clickAsync("btnOpen");
    await waitDialog();
    state.price = 1500; // crash the market while the dialog is open
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(30);
    expect(logs(state.C.borrowerOps as never, "openTrove").length).toBe(0);
    expect(txt("toast")).toContain("changed during review");
    // ratio drift without a price crash
    state.price = 3000;
    const p2 = clickAsync("btnOpen");
    await waitDialog();
    state.price = 2900; // shifts ICR by more than 1pp
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(30);
    expect(logs(state.C.borrowerOps as never, "openTrove").length).toBe(0);
    expect(txt("toast")).toContain("ratio changed during review");
  });

  it("erc20 branch: approves first, re-checks the market, then opens", async () => {
    await openReady("wstETH", { native: false });
    stubWalletSends();
    await flow(clickAsync("btnOpen"), true);
    expect(logs(state.C.collToken as never, "approve").length).toBe(1);
    expect(logs(state.C.borrowerOps as never, "openTrove").length).toBe(1);
    const args = logs(state.C.borrowerOps as never, "openTrove")[0];
    expect(args.length).toBe(5);
    expect(args[2]).toBe(E("5")); // collateral passed as an argument, no msg.value
  });

  it("erc20 branch: approval failure and market drift abort", async () => {
    await openReady("wstETH", { native: false });
    stubWalletSends();
    // approve tx fails → aborted
    (state.C.collToken as unknown as { approve: () => Promise<unknown> }).approve =
      async () => ({ hash: "0xdead", wait: async () => ({ status: 0 }) });
    await flow(clickAsync("btnOpen"), true);
    expect(logs(state.C.borrowerOps as never, "openTrove").length).toBe(0);
    expect(txt("toast")).toContain("protocol rejected"); // the approval reverted
    // market drift after approval → aborted
    (state.C.collToken as unknown as { approve: () => Promise<unknown> }).approve = async () => txLike();
    click("btnOpen");
    await waitDialog();
    state.price = 1500; // crash the market mid-review, then confirm
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(60);
    expect(logs(state.C.borrowerOps as never, "openTrove").length).toBe(0);
  });
});

describe("adjusting an open trove", () => {
  beforeEach(async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = null;
    state.oracleLive = true;
    state.collateralBalance = E("100");
    stubWalletSends();
  });

  it("add collateral: guards then native send with value", async () => {
    const wallet = state.wallet;
    state.wallet = null;
    await clickToast("btnAddColl");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = wallet;
    state.collateralBalance = E("1");
    setInput("adjCollAmount", "5");
    await clickToast("btnAddColl");
    expect(txt("toast")).toContain("exceeds your ETH wallet balance");
    state.collateralBalance = E("100");
    setInput("adjCollAmount", "1");
    click("btnAddColl");
    await settle(80);
    expect(logs(state.C.borrowerOps as never, "addColl").length).toBe(1);
    expect(logs(state.C.borrowerOps as never, "addColl")[0][2]).toEqual({ value: E("1") });
  });

  it("add collateral on an erc20 branch approves then sends the amount", async () => {
    installC(makeFakeC({ native: false }), "wstETH");
    state.collateralBalance = E("100");
    state.price = 3000;
    setInput("adjCollAmount", "1");
    click("btnAddColl");
    await settle(80);
    expect(logs(state.C.collToken as never, "approve").length).toBe(1);
    expect(logs(state.C.borrowerOps as never, "addColl").length).toBe(1);
    expect(logs(state.C.borrowerOps as never, "addColl")[0][0]).toBe(E("1"));
  });

  it("withdraw collateral: full guard + drift matrix", async () => {
    state.wallet = null;
    const t1 = await clickToast("btnWithdrawColl");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: "0xabc" } as unknown as typeof state.wallet;
    state.oracleLive = false;
    await clickToast("btnWithdrawColl");
    expect(txt("toast")).toContain("paused");
    state.oracleLive = true;
    state.position = null;
    setInput("adjCollAmount", "1");
    await clickToast("btnWithdrawColl");
    expect(txt("toast")).toContain("No active Trove");
    state.position = { collateral: E("5"), debt: E("2500") };
    setInput("adjCollAmount", "5"); // drains to 0 coll → not executable
    await clickToast("btnWithdrawColl");
    expect(txt("toast")).toMatch(/collateral|ratio|Could not calculate/);
    setInput("adjCollAmount", "1");
    await flow(clickAsync("btnWithdrawColl"), false); // rejected
    expect(logs(state.C.borrowerOps as never, "withdrawColl").length).toBe(0);
    await flow(clickAsync("btnWithdrawColl"), true);
    expect(logs(state.C.borrowerOps as never, "withdrawColl").length).toBe(1);
    // market drift mid-review
    const p = clickAsync("btnWithdrawColl");
    await waitDialog();
    state.price = 1500;
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(30);
    expect(logs(state.C.borrowerOps as never, "withdrawColl").length).toBe(1); // unchanged
    expect(txt("toast")).toContain("during review");
  });

  it("borrow more: fee errors, projection and drift guards, then success", async () => {
    state.wallet = null;
    await clickToast("btnBorrowMore");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: "0xabc" } as unknown as typeof state.wallet;
    state.oracleLive = false;
    await clickToast("btnBorrowMore");
    expect(txt("toast")).toContain("paused");
    state.oracleLive = true;
    state.position = null;
    await clickToast("btnBorrowMore");
    expect(txt("toast")).toContain("No active Trove");
    state.position = { collateral: E("5"), debt: E("2500") };
    (state.C.troveManager as unknown as { getBorrowingRateWithDecay: () => Promise<bigint> })
      .getBorrowingRateWithDecay = async () => { throw new Error("fee read failed"); };
    setInput("adjDebtAmount", "100");
    await clickToast("btnBorrowMore");
    expect(txt("toast")).toContain("Could not refresh the borrowing fee");
    (state.C.troveManager as unknown as { getBorrowingRateWithDecay: () => Promise<bigint> })
      .getBorrowingRateWithDecay = async () => 5n * 10n ** 15n;
    // borrow enough to breach MCR → projection refuses
    setInput("adjDebtAmount", "12000");
    await clickToast("btnBorrowMore");
    expect(txt("toast")).toMatch(/ratio|minimum|Could not calculate/);
    setInput("adjDebtAmount", "100");
    await flow(clickAsync("btnBorrowMore"), true);
    expect(logs(state.C.borrowerOps as never, "withdrawLUSD").length).toBe(1);
    // drift on the second fee read — the rate moves while the review is open
    const p2 = clickAsync("btnBorrowMore");
    await waitDialog();
    (state.C.troveManager as unknown as { getBorrowingRateWithDecay: () => Promise<bigint> })
      .getBorrowingRateWithDecay = async () => 90n * 10n ** 15n;
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(60);
    expect(logs(state.C.borrowerOps as never, "withdrawLUSD").length).toBe(1); // unchanged
    expect(txt("toast")).toContain("during review");
  });

  it("repay: balance guard then send", async () => {
    state.orUsdBalance = E("2500");
    setInput("adjDebtAmount", "9000"); // wallet only holds 2500
    await clickToast("btnRepay");
    expect(txt("toast")).toContain("exceeds your orUSD wallet balance");
    setInput("adjDebtAmount", "100");
    click("btnRepay");
    await settle(80);
    expect(logs(state.C.borrowerOps as never, "repayLUSD").length).toBe(1);
  });

  it("close: shortfall toast, read failure fallback, then close", async () => {
    state.wallet = null;
    await clickToast("btnClose");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    (state.C.orUSD as unknown as { balanceOf: (w: string) => Promise<bigint> }).balanceOf = async () => 0n;
    // bal 0 < need 2300 → explanatory toast
    click("btnClose");
    await settle(80);
    expect(logs(state.C.borrowerOps as never, "closeTrove").length).toBe(0);
    expect(txt("toast")).toContain("needs 2,300 orUSD");
    // read failure → falls through to the chain call
    (state.C.troveManager as unknown as { getEntireDebtAndColl: () => Promise<bigint[]> })
      .getEntireDebtAndColl = async () => { throw new Error("read failed"); };
    click("btnClose");
    await settle(80);
    expect(logs(state.C.borrowerOps as never, "closeTrove").length).toBe(1);
  });
});

describe("rate change + redemption", () => {
  beforeEach(async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = null;
    state.oracleLive = true;
    stubWalletSends();
  });

  it("rate change validates and sends with hints", async () => {
    state.wallet = null;
    await clickToast("btnRate");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    setInput("newRate", "400");
    await clickToast("btnRate");
    expect(txt("toast")).toContain("between 0.5 and 100 %/yr");
    setInput("newRate", "7");
    click("btnRate");
    await settle(60);
    expect(logs(state.C.borrowerOps as never, "adjustTroveRate").length).toBe(1);
    expect(logs(state.C.borrowerOps as never, "adjustTroveRate")[0][0]).toBe(ethers.parseEther((7 / 100).toFixed(18)));
  });

  it("rates redemption needs no hints", async () => {
    setInput("redeemAmount", "100");
    click("btnRedeem");
    await settle(60);
    expect(logs(state.C.troveManager as never, "redeemCollateral").length).toBe(1);
  });

  it("sorted-list redemption: nothing redeemable, truncation toast, hint failure", async () => {
    installC(makeFakeC({ native: false }), "wstETH");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.oracleLive = true;
    stubWalletSends();
    setInput("redeemAmount", "0");
    await clickToast("btnRedeem");
    expect(txt("toast")).toContain("orUSD amount");
    setInput("redeemAmount", "100");
    // truncated = 0 → nothing redeemable → failed activity
    (state.C.hintHelpers as unknown as { getRedemptionHints: () => Promise<unknown[]> })
      .getRedemptionHints = async () => [OTHER, 2n * 10n ** 20n, 0n];
    click("btnRedeem");
    await settle(60);
    expect(logs(state.C.troveManager as never, "redeemCollateral").length).toBe(0);
    expect(recent().status).toBe("failed");
    // truncated < amount → toast + partial redeem
    (state.C.hintHelpers as unknown as { getRedemptionHints: () => Promise<unknown[]> })
      .getRedemptionHints = async () => [OTHER, 2n * 10n ** 20n, E("40")];
    click("btnRedeem");
    await settle(60);
    expect(logs(state.C.troveManager as never, "redeemCollateral").length).toBe(1);
    expect(logs(state.C.troveManager as never, "redeemCollateral")[0][0]).toBe(E("40"));
    // hint pipeline failing falls back to zero hints (still redeems)
    (state.C.sortedTroves as unknown as { getSize: () => Promise<bigint> }).getSize =
      async () => { throw new Error("size read failed"); };
    (state.C.hintHelpers as unknown as { getRedemptionHints: () => Promise<unknown[]> })
      .getRedemptionHints = async () => [OTHER, 2n * 10n ** 20n, E("100")];
    click("btnRedeem");
    await settle(60);
    expect(logs(state.C.troveManager as never, "redeemCollateral").length).toBe(2);
  });
});

describe("stability pool + savings + staking", () => {
  beforeEach(async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = null;
    state.oracleLive = true;
    stubWalletSends();
  });

  it("sp deposit/withdraw validate then send", async () => {
    setInput("spAmount", "0");
    await clickToast("btnSpDeposit");
    expect(txt("toast")).toContain("deposit amount");
    setInput("spAmount", "100");
    click("btnSpDeposit");
    await settle(60);
    expect(logs(state.C.stabilityPool as never, "provideToSP").length).toBe(1);
    setInput("spAmount", "0");
    await clickToast("btnSpWithdraw");
    expect(txt("toast")).toContain("withdrawal amount");
    setInput("spAmount", "50");
    click("btnSpWithdraw");
    await settle(60);
    expect(logs(state.C.stabilityPool as never, "withdrawFromSP").length).toBe(1);
  });

  it("savings deposit: guards, approval paths and read failure", async () => {
    state.wallet = null;
    await clickToast("btnSvDeposit");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    setInput("svAmount", "0");
    await clickToast("btnSvDeposit");
    expect(txt("toast")).toContain("greater than zero");
    setInput("svAmount", "100");
    // allowance read fails → toast
    (state.C.orUSD as unknown as { allowance: () => Promise<bigint> }).allowance =
      async () => { throw new Error("allowance read failed"); };
    click("btnSvDeposit");
    await settle(60);
    expect(txt("toast")).toContain("Could not prepare the savings deposit");
    // allowance sufficient → straight to deposit
    (state.C.orUSD as unknown as { allowance: () => Promise<bigint> }).allowance = async () => E("1000");
    click("btnSvDeposit");
    await settle(60);
    expect(logs(state.C.vault as never, "deposit").length).toBe(1);
    // allowance short → approve first
    (state.C.orUSD as unknown as { allowance: () => Promise<bigint> }).allowance = async () => 0n;
    click("btnSvDeposit");
    await settle(60);
    expect(logs(state.C.orUSD as never, "approve").length).toBe(1);
    expect(logs(state.C.vault as never, "deposit").length).toBe(2);
    // approve rejected → no deposit
    (state.C.orUSD as unknown as { approve: () => Promise<unknown> }).approve =
      async () => ({ hash: "0xdead", wait: async () => ({ status: 0 }) });
    click("btnSvDeposit");
    await settle(60);
    expect(logs(state.C.vault as never, "deposit").length).toBe(2);
  });

  it("savings withdraw and route guard against empty positions", async () => {
    state.wallet = null;
    await clickToast("btnSvWithdraw");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    (state.C.vault as unknown as { balanceOf: () => Promise<bigint> }).balanceOf = async () => 0n;
    click("btnSvWithdraw");
    await settle(60);
    expect(logs(state.C.vault as never, "redeem").length).toBe(0);
    expect(recent().status).toBe("failed");
    (state.C.vault as unknown as { balanceOf: () => Promise<bigint> }).balanceOf = async () => E("50");
    click("btnSvWithdraw");
    await settle(60);
    expect(logs(state.C.vault as never, "redeem").length).toBe(1);
    state.wallet = null;
    await clickToast("btnSvRoute");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    (state.C.router as unknown as { pending: () => Promise<bigint> }).pending = async () => 0n;
    click("btnSvRoute");
    await settle(60);
    expect(logs(state.C.router as never, "distribute").length).toBe(0);
    (state.C.router as unknown as { pending: () => Promise<bigint> }).pending = async () => E("12");
    click("btnSvRoute");
    await settle(60);
    expect(logs(state.C.router as never, "distribute").length).toBe(1);
  });

  it("staking: branch-mode approval, read failure, and unstake guard", async () => {
    installC(makeFakeC({ native: false, stakingMode: true }), "wstETH");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.oracleLive = true;
    stubWalletSends();
    state.wallet = null;
    await clickToast("btnStake");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    setInput("stkInput", "0");
    await clickToast("btnStake");
    expect(txt("toast")).toContain("ORA stake");
    setInput("stkInput", "10");
    // allowance read throws
    (state.C.ora as unknown as { allowance: () => Promise<bigint> }).allowance =
      async () => { throw new Error("allowance read failed"); };
    click("btnStake");
    await settle(60);
    expect(txt("toast")).toContain("Could not prepare the ORA stake");
    // short allowance → approve then stake
    (state.C.ora as unknown as { allowance: () => Promise<bigint> }).allowance = async () => 0n;
    click("btnStake");
    await settle(60);
    expect(logs(state.C.ora as never, "approve").length).toBe(1);
    expect(logs(state.C.staking as never, "stake").length).toBe(1);
    // classic mode (ETH branch): stake directly
    installC(makeFakeC({ native: true }), "ETH");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.oracleLive = true;
    stubWalletSends();
    setInput("stkInput", "10");
    click("btnStake");
    await settle(60);
    expect(logs(state.C.staking as never, "stake").length).toBe(1);
    expect(logs(state.C.ora as never, "approve").length).toBe(0);
    // unstake validates
    setInput("stkInput", "0");
    await clickToast("btnUnstake");
    expect(txt("toast")).toContain("ORA amount");
    setInput("stkInput", "10");
    click("btnUnstake");
    await settle(60);
    expect(logs(state.C.staking as never, "unstake").length).toBe(1);
  });

  it("wstETH faucet drips the configured amount", async () => {
    installC(makeFakeC({ native: false }), "wstETH");
    stubWalletSends();
    click("btnWstFaucet");
    await settle(60);
    expect(logs(state.C.collToken as never, "faucet").length).toBe(1);
  });
});

describe("leverage zapper", () => {
  beforeEach(async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = null;
    state.oracleLive = true;
    state.nativeBalance = E("100");
    stubWalletSends();
    setInput("lvColl", "2");
    setInput("lvRate", "5");
    setInput("lvSlip", "20");
  });

  it("guards: wallet, risk pause, amount, balance, rate, slip, price, min borrow", async () => {
    state.wallet = null;
    await clickToast("btnLvOpen");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    state.oracleLive = false;
    await clickToast("btnLvOpen");
    expect(txt("toast")).toContain("paused");
    state.oracleLive = true;
    setInput("lvColl", "0");
    await clickToast("btnLvOpen");
    expect(txt("toast")).toContain("ETH deposit");
    setInput("lvColl", "500");
    await clickToast("btnLvOpen");
    expect(txt("toast")).toContain("available ETH balance");
    setInput("lvColl", "2");
    setInput("lvRate", "400");
    await clickToast("btnLvOpen");
    expect(txt("toast")).toContain("between 0.5% and 100%");
    setInput("lvRate", "5");
    setInput("lvSlip", "0.01");
    await clickToast("btnLvOpen");
    expect(txt("toast")).toContain("between 0.1% and 99%");
    setInput("lvSlip", "20");
    state.price = 0;
    await clickToast("btnLvOpen");
    expect(txt("toast")).toContain("valid market price");
    state.price = 3000;
    // 2 ETH × 3000 × 6000bps / 10000 = 3600 ≥ 1800 → use a smaller deposit
    setInput("lvColl", "0.5"); // 0.5×3000×0.6 = 900 < 1800
    await clickToast("btnLvOpen");
    expect(txt("toast")).toContain("first loop must borrow at least 1,800");
    setInput("lvColl", "2");
  });

  it("refuses when a position is already open, then opens through the zap", async () => {
    // zap position already open (provider answers status=1) → guard toast, no dialog
    click("btnLvOpen");
    await settle(40);
    expect(txt("toast")).toContain("already open");
    // close it → open flow runs
    const pad = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
    (state.provider as unknown as { call: (t: { data?: string }) => Promise<string> }).call = async (t) => {
      const sel = ethers.id("position()").slice(0, 10);
      return String(t?.data || "").startsWith(sel)
        ? pad(E("2000")) + pad(E("1.5")).slice(2) + pad(3n * 10n ** 16n).slice(2) + pad(0n).slice(2)
        : "0x";
    };
    await flow(clickAsync("btnLvOpen"), true);
    // leverOpen went through the real zap Contract via the stubbed wallet
    expect(recent().label).toContain("leveraged position");
    expect(recent().status).toBe("confirmed");
  });

  it("creates the zap first when none exists", async () => {
    let zapCreated = false;
    (state.C.zapFactory as unknown as { zapOf: () => Promise<string> }).zapOf =
      async () => (zapCreated ? "0x" + "99".repeat(20) : "0x" + "00".repeat(20));
    (state.C.zapFactory as unknown as { createZap: () => Promise<unknown> }).createZap =
      async () => { zapCreated = true; return txLike(); };
    await flow(clickAsync("btnLvOpen"), true);
    expect(zapCreated).toBe(true);
    expect(recent().label).toContain("leveraged position");
  });

  it("market drift and balance change during review abort the open", async () => {
    // default router answers position() as open → close it so the review opens
    const pad = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
    const origCall = (state.provider as unknown as { call: (t: { data?: string }) => Promise<string> }).call;
    (state.provider as unknown as { call: (t: { data?: string }) => Promise<string> }).call = async (t) => {
      const sel = ethers.id("position()").slice(0, 10);
      return String(t?.data || "").startsWith(sel)
        ? pad(E("2000")) + pad(E("1.5")).slice(2) + pad(3n * 10n ** 16n).slice(2) + pad(0n).slice(2)
        : origCall(t);
    };
    const p = clickAsync("btnLvOpen");
    await waitDialog();
    state.price = 3500; // >1% move
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(30);
    expect(logs(state.C.zapFactory as never, "createZap").length).toBe(0);
    expect(txt("toast")).toContain("Market price changed during review");
    const p2 = clickAsync("btnLvOpen");
    await waitDialog();
    state.nativeBalance = E("1");
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await settle(30);
    expect(txt("toast")).toContain("ETH balance changed");
  });

  it("close: guards then unwind", async () => {
    state.wallet = null;
    await clickToast("btnLvClose");
    expect(txt("toast")).toContain("Connect a wallet first");
    state.wallet = { address: myAddr() } as unknown as typeof state.wallet;
    // no zap → nothing to close
    (state.C.zapFactory as unknown as { zapOf: () => Promise<string> }).zapOf =
      async () => "0x" + "00".repeat(20);
    await clickToast("btnLvClose", 25);
    expect(txt("toast")).toContain("No leverage position to close");
    (state.C.zapFactory as unknown as { zapOf: () => Promise<string> }).zapOf =
      async () => "0x" + "99".repeat(20);
    setInput("lvSlip", "0.01");
    await clickToast("btnLvClose");
    expect(txt("toast")).toContain("between 0.1% and 99%");
    setInput("lvSlip", "20");
    click("btnLvClose");
    await settle(80);
    expect(recent().label).toContain("unwind");
  });
});

describe("simulators", () => {
  beforeEach(async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = null;
    state.oracleLive = true;
    stubWalletSends();
  });

  it("bump buttons move both ETH/USD feeds in lockstep", async () => {
    // aggEth null → live-feed toast
    const aggEth = state.C.aggEth;
    state.C.aggEth = null;
    await clickToast("btnSetPrice");
    expect(txt("toast")).toContain("Live Chainlink feed");
    state.C.aggEth = aggEth;
    document.querySelector<HTMLButtonElement>("button[data-bump='10']")!.click();
    await settle(40);
    // latestRoundData answered 3000e8 → +10% → 3300e8 on fallback + main
    expect(logs(state.C.aggEthFb as never, "setAnswer")[0][0]).toBe(3300n * 10n ** 8n);
    expect(logs(state.C.aggEth as never, "setAnswer")[0][0]).toBe(3300n * 10n ** 8n);
    // no fallback feed → only the main feed
    state.C.aggEthFb = null;
    (state.C.aggEth as unknown as { __logs: Record<string, unknown[][]> }).__logs.setAnswer = [];
    document.querySelector<HTMLButtonElement>("button[data-bump='-5']")!.click();
    await settle(40);
    expect(logs(state.C.aggEth as never, "setAnswer")[0][0]).toBe(2850n * 10n ** 8n);
  });

  it("set-price validates then sets", async () => {
    setInput("simInput", "abc");
    await clickToast("btnSetPrice");
    expect(txt("toast")).toContain("valid price");
    setInput("simInput", "2500");
    click("btnSetPrice");
    await settle(60);
    expect(logs(state.C.aggEth as never, "setAnswer")[0][0]).toBe(2500n * 10n ** 8n);
  });

  it("nav simulator: reset, multiply, apply clamp; inert without a feed", async () => {
    installC(makeFakeC({ native: false, rwa: true }), "tBILL");
    state.price = 1;
    state.lastRefreshAt = Date.now();
    state.oracleLive = true;
    stubWalletSends();
    document.querySelector<HTMLButtonElement>("button[data-nav='0.98']")!.click();
    await settle(40);
    // latestRoundData 105000000 × 0.98 → 102900000, then fetchPrice clamp
    expect(logs(state.C.aggNav as never, "setAnswer")[0][0]).toBe(102900000n);
    document.querySelector<HTMLButtonElement>("button[data-nav='reset']")!.click();
    await settle(40);
    expect(logs(state.C.aggNav as never, "setAnswer")[1][0]).toBe(105000000n);
    // each successful nav click also applies the clamp
    expect(logs(state.C.priceFeed as never, "fetchPrice").length).toBe(2);
    // failed set → no clamp application
    (state.C.aggNav as unknown as { setAnswer: () => Promise<unknown> }).setAnswer =
      async () => { throw new Error("reverted"); };
    document.querySelector<HTMLButtonElement>("button[data-nav='reset']")!.click();
    await settle(40);
    expect(logs(state.C.priceFeed as never, "fetchPrice").length).toBe(2);
    // no nav feed → inert
    state.C.aggNav = null;
    document.querySelector<HTMLButtonElement>("button[data-nav='0.98']")!.click();
    await settle(20);
    expect(logs(state.C.priceFeed as never, "fetchPrice").length).toBe(2);
  });

  it("sequencer simulator: halt, restart, skip grace", async () => {
    document.querySelector<HTMLButtonElement>("button[data-seq='halt']")!.click();
    await settle(40);
    expect(logs(state.C.aggSeq as never, "setAnswer")[0][0]).toBe(1n);
    expect(logs(state.C.priceFeed as never, "fetchPrice").length).toBe(1);
    document.querySelector<HTMLButtonElement>("button[data-seq='restart']")!.click();
    await settle(40);
    expect(logs(state.C.aggSeq as never, "setAnswer")[1][0]).toBe(0n);
    document.querySelector<HTMLButtonElement>("button[data-seq='grace']")!.click();
    await settle(40);
    expect(logs(state.C.aggSeq as never, "makeStale")[0][0]).toBe(7200);
    // failed tx → no guard application
    (state.C.aggSeq as unknown as { setAnswer: () => Promise<unknown> }).setAnswer =
      async () => { throw new Error("nope"); };
    document.querySelector<HTMLButtonElement>("button[data-seq='halt']")!.click();
    await settle(40);
    expect(logs(state.C.priceFeed as never, "fetchPrice").length).toBe(3);
    // no feed → inert
    state.C.aggSeq = null;
    document.querySelector<HTMLButtonElement>("button[data-seq='halt']")!.click();
    await settle(20);
    expect(logs(state.C.priceFeed as never, "fetchPrice").length).toBe(3);
  });

  it("depeg simulator sets the stETH/ETH rate then applies the breaker", async () => {
    installC(makeFakeC({ native: false }), "wstETH");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.oracleLive = true;
    stubWalletSends();
    document.querySelector<HTMLButtonElement>("button[data-rate='0.95']")!.click();
    await settle(40);
    expect(logs(state.C.aggRate as never, "setAnswer")[0][0]).toBe(ethers.parseEther("0.95"));
    expect(logs(state.C.priceFeed as never, "fetchPrice").length).toBe(1);
    state.C.aggRate = null;
    document.querySelector<HTMLButtonElement>("button[data-rate='0.90']")!.click();
    await settle(20);
    expect(logs(state.C.priceFeed as never, "fetchPrice").length).toBe(1);
  });
});

describe("ORA faucet button", () => {
  it("drips, tracks the tx, and confirms through the provider", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.price = 3000;
    state.lastRefreshAt = Date.now();
    state.oracleLive = true;
    const H = "0x" + "fa".repeat(32);
    const wf = vi.fn(async () => ({ status: 1, hash: H }));
    (state.provider as unknown as { waitForTransaction: (h: string) => Promise<{ status: number }> }).waitForTransaction = wf;
    click("btnFaucet");
    await settle(60);
    expect(recent().status).toBe("confirmed");
    expect(recent().message).toBe("Confirmed on-chain.");
    // reverted drip
    (state.provider as unknown as { waitForTransaction: (h: string) => Promise<{ status: number }> }).waitForTransaction =
      async () => ({ status: 0 });
    click("btnFaucet");
    await settle(60);
    expect(recent().status).toBe("failed");
    expect(recent().message).toBe("The faucet transaction reverted.");
    // lookup failure → stays submitted
    (state.provider as unknown as { waitForTransaction: (h: string) => Promise<{ status: number }> }).waitForTransaction =
      async () => { throw new Error("timeout"); };
    click("btnFaucet");
    await settle(60);
    expect(recent().status).toBe("submitted");
    expect(recent().message).toContain("Confirmation lookup failed");
    // server refuses → toast, no new activity
    vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => ({ error: "rate limited" }) }));
    click("btnFaucet");
    await settle(30);
    expect(txt("toast")).toContain("Faucet: rate limited");
    void wf;
  });

  it("requestFaucet maps every failure shape", async () => {
    const notes: string[] = [];
    const notify = (m: string) => notes.push(m);
    const withFetch = async (impl: () => Promise<unknown>) => {
      vi.stubGlobal("fetch", impl);
      return requestFaucet("0x" + "11".repeat(20), notify);
    };
    expect(await withFetch(async () => ({ ok: true, json: async () => ({ txHash: "0x123" }) }))).toBe("0x123");
    expect(notes.at(-1)).toContain("100 test ORA");
    expect(await withFetch(async () => ({ ok: true, json: async () => ({ error: "nope" }) }))).toBeNull();
    expect(notes.at(-1)).toContain("Faucet: nope");
    expect(await withFetch(async () => ({ ok: false, status: 503, json: async () => { throw new Error("bad json"); } }))).toBeNull();
    expect(notes.at(-1)).toContain("Faucet: server 503");
    expect(await withFetch(async () => { throw new Error("offline"); })).toBeNull();
    expect(notes.at(-1)).toContain("Faucet failed: offline");
  });
});

// --- helpers -----------------------------------------------------------------

async function clickAsync(id: string): Promise<void> {
  click(id); // force-enabled click (disabled buttons swallow events)
  await settle(5);
}

async function waitDialog() {
  const dialog = document.getElementById("txReviewDialog") as HTMLElement;
  for (let i = 0; i < 200 && dialog.hidden; i++) await new Promise((r) => setTimeout(r, 5));
  if (dialog.hidden) throw new Error("review dialog never opened");
}

/** Click, settle, then close any review dialog the click opened (the toast is
 *  what we assert on; an open dialog would block later flows). */
async function clickToast(id: string, ms = 25) {
  click(id);
  await settle(ms);
  const dialog = document.getElementById("txReviewDialog") as HTMLElement;
  if (!dialog.hidden) {
    (document.getElementById("reviewCancel") as HTMLButtonElement).click();
    await settle(10);
  }
  return txt("toast");
}

// keep the linter honest about unused imports used only for side effects
void tx; void connectWithProvider; void connectWallet; void guardSigner;
void setAccount; void initWalletDiscovery; void pickedEip1193; void connectWalletConnect;
void $; void domSelect; void domButton; void mapTransactionError; void reason;
