// UI wiring: every button/input listener. Declarative — all chain logic
// lives in contracts.ts/wallet.ts, all rendering in views.ts.
import { ethers } from "ethers";
import { Z, MAX_FEE, GAS_COMP, NETWORKS } from "./config";
import { state, bcfg, myAddr, isNative, isRates, collSym, brMcr } from "./state";
import {
  getInsertHints, rateInsertHints, adjustHints, borrowWithFee,
  myZap,
} from "./contracts";
import { setAccount, connectWallet, connectWithProvider, tx } from "./wallet";
import { connectWalletConnect } from "./walletconnect";
import { requestFaucet } from "./faucet";
import { addActivity, updateActivity } from "./activity";
import { setNetwork } from "./network";
import { refresh, setBranch, setView, updateOpenPreview, updateAdjustmentPreview, refreshTrovesTable, riskIncreaseBlockMessage } from "./views";
import { $, input, select, toast } from "./dom";
import { fmt, fmtNum, fmtPct, fmtUsdNum } from "./format";
import { adjustmentPreviews, healthExplanation, healthTier, openPreview as calculateOpenPreview } from "./branch";
import { reviewTransaction } from "./review";
import type { Eip1193 } from "./state";

// WalletConnect provider factory shared by the WC button and the
// no-extension fallback inside connectWallet().
async function wcProvider(): Promise<Eip1193 | null> {
  const pid = state.appConfig.walletConnectProjectId;
  if (!pid) return null;
  const net = NETWORKS[state.netMode];
  const chainId = net.chainIdHex ? parseInt(net.chainIdHex, 16) : 1;
  return connectWalletConnect({ projectId: pid, chainId });
}

function requireRiskIncreaseAllowed(action: string): boolean {
  const blocked = riskIncreaseBlockMessage();
  if (!blocked) return true;
  toast(`${action} is paused: ${blocked}`, 8000);
  return false;
}

function amountFromInput(id: string, name: string): bigint | null {
  const raw = input(id).value.trim();
  if (!raw || !Number.isFinite(Number(raw)) || Number(raw) <= 0) {
    toast(`Enter a ${name} greater than zero.`);
    return null;
  }
  try {
    return ethers.parseEther(raw);
  } catch {
    toast(`${name} must be a valid decimal amount with no more than 18 decimal places.`);
    return null;
  }
}

function inputAmount(value: bigint): string {
  const formatted = ethers.formatEther(value);
  return formatted.includes(".") ? formatted.replace(/0+$/, "").replace(/\.$/, "") : formatted;
}

function collateralMax(): bigint {
  if (!isNative()) return state.collateralBalance;
  const gasReserve = ethers.parseEther("0.02");
  return state.collateralBalance > gasReserve ? state.collateralBalance - gasReserve : 0n;
}

function projectAdjustment(kind: "borrow" | "withdraw", amount: bigint, fee = 0n) {
  if (!state.position) return null;
  const collateral = Number(ethers.formatEther(state.position.collateral));
  const debt = Number(ethers.formatEther(state.position.debt));
  const amountNumber = Number(ethers.formatEther(amount));
  const feeNumber = Number(ethers.formatEther(fee));
  const feeRate = kind === "borrow" && amountNumber > 0
    ? feeNumber / amountNumber
    : 0;
  const projections = adjustmentPreviews(
    collateral, debt, amountNumber, state.price, feeRate, isRates(), brMcr(),
  );
  return projections[kind];
}

function reviewPrice(value: number): string {
  return Number.isFinite(value) && value > 0
    ? fmtUsdNum(value)
    : "Unavailable";
}

async function ensureAllowanceTracked(needed: bigint): Promise<boolean> {
  try {
    const target = bcfg().borrowerOperations;
    const allowance = await state.C.collToken.allowance(myAddr(), target);
    if (allowance >= needed) return true;
    return tx(`Approve ${collSym()}`, () => state.C.collToken.approve(target, ethers.MaxUint256));
  } catch (e) {
    toast(`Could not approve ${collSym()}: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`, 8000);
    return false;
  }
}

export function wireActions(): void {
  select("networkSelect").addEventListener("change", (e) =>
    setNetwork((e.target as HTMLSelectElement).value));
  $("btnConnect").addEventListener("click", () => connectWallet(wcProvider));
  $("btnWC").addEventListener("click", async () => {
    const wc = await wcProvider();
    if (wc) connectWithProvider(wc, " via WalletConnect");
  });
  select("accountSelect").addEventListener("change", (e) => {
    setAccount((e.target as HTMLSelectElement).value);
    refresh();
  });
  select("branchSelect").addEventListener("change", (e) => {
    state.troveRows = 50;
    setBranch((e.target as HTMLSelectElement).value);
    void refresh();
  });
  document.querySelectorAll<HTMLButtonElement>("button[data-view]").forEach((nav) =>
    nav.addEventListener("click", () => setView(nav.dataset.view || "borrow")));
  $("btnMoreTroves").addEventListener("click", () => {
    state.troveRows += 50;
    refreshTrovesTable();
  });
  ["openColl", "openDebt", "openRate"].forEach((id) =>
    $(id).addEventListener("input", () => updateOpenPreview()));
  ["adjCollAmount", "adjDebtAmount"].forEach((id) =>
    $(id).addEventListener("input", updateAdjustmentPreview));
  $("btnOpenCollMax").addEventListener("click", () => {
    input("openColl").value = inputAmount(collateralMax());
    updateOpenPreview();
  });
  $("btnAdjCollMax").addEventListener("click", () => {
    input("adjCollAmount").value = inputAmount(collateralMax());
    updateAdjustmentPreview();
  });
  $("btnAdjDebtMax").addEventListener("click", () => {
    input("adjDebtAmount").value = inputAmount(state.orUsdBalance);
    updateAdjustmentPreview();
  });

  $("btnWstFaucet").addEventListener("click", () =>
    tx(collSym() + " faucet", () =>
      state.C.collToken.faucet(ethers.parseEther(bcfg().faucetAmount || "10"))));

  $("btnOpen").addEventListener("click", async () => {
    const coll = amountFromInput("openColl", "collateral amount");
    const debt = amountFromInput("openDebt", "borrow amount");
    if (coll === null || debt === null) return;
    if (state.position) return toast("A Trove is already open on this market.");
    if (debt < ethers.parseEther("1800")) return toast("Minimum borrow is 1,800 orUSD.");
    if (!state.wallet) return toast("Connect a wallet first");
    if (!requireRiskIncreaseAllowed("Opening a Trove")) return;
    if (state.price <= 0) return toast("Waiting for a valid market price before opening.");
    if (coll > state.collateralBalance) return toast(`Collateral amount exceeds your ${collSym()} wallet balance.`);

    const rates = isRates();
    const pct = rates ? Number(input("openRate").value || "0") : 0;
    if (rates && !(pct >= 0.5 && pct <= 100)) return toast("Interest rate must be between 0.5 and 100 %/yr");
    const fee = rates ? 0n : (debt * state.borrowingRate) / 10n ** 18n;
    const calculation = calculateOpenPreview(
      Number(ethers.formatEther(coll)), Number(ethers.formatEther(debt)),
      rates ? 0n : state.borrowingRate, state.price, brMcr(),
    );
    if (calculation.icr < brMcr() * 100) return toast(`Projected collateral ratio is below the ${fmtPct(brMcr() * 100, 0)} minimum.`);
    const network = NETWORKS[state.netMode]?.label || state.netMode;
    const label = rates ? `Open Trove @ ${pct}%` : "Open Trove";
    const riskMessage = healthExplanation(
      calculation.risk, calculation.icr, brMcr(), calculation.liquidationPrice, state.price,
    ) + (state.recoveryMode ? " Recovery Mode is active; additional protocol checks may apply." : "");
    const details = [
      { label: "Collateral", value: `${fmt(coll, 4)} ${collSym()}` },
      { label: "Borrow amount", value: `${fmt(debt)} orUSD` },
      { label: "Borrowing fee", value: rates ? "No upfront fee" : `${fmt(fee)} orUSD` },
      ...(rates ? [{ label: "Annual interest rate", value: `${pct}% / year` }] : []),
      { label: "Projected total debt", value: `${fmtNum(calculation.totalDebt)} orUSD, including 200 orUSD gas compensation` },
      { label: "Projected collateral ratio", value: fmtPct(calculation.icr) },
      { label: "Liquidation price", value: reviewPrice(calculation.liquidationPrice) },
      { label: "Network gas", value: "Estimated by your wallet at signing" },
    ];
    const accepted = await reviewTransaction({
      title: rates ? "Review new Trove" : "Review opening a Trove",
      description: `You will deposit ${collSym()} collateral and mint orUSD to your connected wallet.${!rates && !isNative() ? " Your wallet may request a separate collateral approval first." : ""}`,
      network,
      details,
      risk: calculation.risk,
      riskMessage,
    });
    if (!accepted) return;
    if (!requireRiskIncreaseAllowed("Opening a Trove")) return;
    if (coll > state.collateralBalance) return toast("Wallet collateral balance changed; review the amount and try again.");

    const latest = calculateOpenPreview(
      Number(ethers.formatEther(coll)), Number(ethers.formatEther(debt)),
      rates ? 0n : state.borrowingRate, state.price, brMcr(),
    );
    if (!(state.price > 0) || latest.icr < brMcr() * 100) {
      updateOpenPreview(state.borrowingRate);
      return toast("Market price changed during review. Check the updated position health and review again.", 8000);
    }
    if (Math.abs(latest.icr - calculation.icr) >= 1) {
      updateOpenPreview(state.borrowingRate);
      return toast("The projected ratio changed during review. Check the updated quote and review again.", 8000);
    }

    if (rates) {
      const rateWei = ethers.parseEther((pct / 100).toFixed(18));
      void tx(label, async () => {
        const [up, low] = await rateInsertHints(rateWei);
        return state.C.borrowerOps.openTroveWithRate(debt, rateWei, up, low, { value: coll });
      });
    } else if (isNative()) {
      void tx(label, async () => {
        const [up, low] = await getInsertHints(coll, (await borrowWithFee(debt)) + GAS_COMP);
        return state.C.borrowerOps.openTrove(MAX_FEE, debt, up, low, { value: coll });
      });
    } else {
      if (!(await ensureAllowanceTracked(coll))) return;
      if (!requireRiskIncreaseAllowed("Opening a Trove")) return;
      const postApprovalQuote = calculateOpenPreview(
        Number(ethers.formatEther(coll)), Number(ethers.formatEther(debt)),
        state.borrowingRate, state.price, brMcr(),
      );
      if (!(state.price > 0) || postApprovalQuote.icr < brMcr() * 100 ||
          Math.abs(postApprovalQuote.icr - calculation.icr) >= 1) {
        updateOpenPreview(state.borrowingRate);
        return toast("Market conditions changed during collateral approval. Review the updated position and try again.", 8000);
      }
      void tx(label, async () => {
        const [up, low] = await getInsertHints(coll, (await borrowWithFee(debt)) + GAS_COMP);
        return state.C.borrowerOps.openTrove(MAX_FEE, debt, coll, up, low);
      });
    }
  });

  const adjColl = (name: string) => amountFromInput("adjCollAmount", name);
  const adjDebt = (name: string) => amountFromInput("adjDebtAmount", name);
  $("btnAddColl").addEventListener("click", async () => {
    const amount = adjColl("collateral amount");
    if (amount === null) return;
    if (!state.wallet) return toast("Connect a wallet first");
    if (amount > state.collateralBalance) return toast(`Amount exceeds your ${collSym()} wallet balance.`);
    if (isNative()) {
      void tx("Add collateral", async () => {
        const [up, low] = await adjustHints(amount, 0n);
        return state.C.borrowerOps.addColl(up, low, { value: amount });
      });
    } else {
      if (!(await ensureAllowanceTracked(amount))) return;
      void tx("Add collateral", async () => {
        const [up, low] = await adjustHints(amount, 0n);
        return state.C.borrowerOps.addColl(amount, up, low);
      });
    }
  });
  $("btnWithdrawColl").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    if (!requireRiskIncreaseAllowed("Withdrawing collateral")) return;
    const amount = adjColl("collateral amount");
    if (amount === null) return;
    if (!state.position) return toast("No active Trove on this market.");
    const projection = projectAdjustment("withdraw", amount);
    if (!projection?.executable) return toast(projection?.reason || "Could not calculate the projected position.");

    const network = NETWORKS[state.netMode]?.label || state.netMode;
    const riskMessage = healthExplanation(
      projection.risk, projection.icr, brMcr(), projection.liquidationPrice, state.price,
    ) + (state.recoveryMode ? " Recovery Mode is active; additional protocol checks may apply." : "");
    const accepted = await reviewTransaction({
      title: "Review collateral withdrawal",
      description: `Withdraw collateral from your ${collSym()} Trove. The remaining debt stays open.`,
      network,
      risk: projection.risk,
      riskMessage,
      details: [
        { label: "Withdraw", value: `${fmt(amount, 4)} ${collSym()}` },
        { label: "Collateral remaining", value: `${fmtNum(projection.collateral, 4)} ${collSym()}` },
        { label: "Debt after action", value: `${fmtNum(projection.debt)} orUSD` },
        { label: "Projected collateral ratio", value: fmtPct(projection.icr) },
        { label: "Liquidation price", value: reviewPrice(projection.liquidationPrice) },
        { label: "Protocol / network fee", value: "No protocol fee; network gas estimated by your wallet" },
      ],
    });
    if (!accepted) return;
    if (!requireRiskIncreaseAllowed("Withdrawing collateral")) return;
    const latest = projectAdjustment("withdraw", amount);
    if (!latest?.executable || Math.abs(latest.icr - projection.icr) >= 1) {
      updateAdjustmentPreview();
      return toast("Market conditions changed during review. Check the updated projection and review again.", 8000);
    }
    void tx("Withdraw collateral", async () => {
      const [up, low] = await adjustHints(-amount, 0n);
      return state.C.borrowerOps.withdrawColl(amount, up, low);
    });
  });
  $("btnBorrowMore").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    if (!requireRiskIncreaseAllowed("Borrowing orUSD")) return;
    const amount = adjDebt("borrow amount");
    if (amount === null) return;
    if (!state.position) return toast("No active Trove on this market.");

    let debtIncrease: bigint;
    try { debtIncrease = isRates() ? amount : await borrowWithFee(amount); }
    catch { return toast("Could not refresh the borrowing fee; try again when market data is available.", 8000); }
    const fee = debtIncrease > amount ? debtIncrease - amount : 0n;
    const projection = projectAdjustment("borrow", amount, fee);
    if (!projection?.executable) return toast(projection?.reason || "Could not calculate the projected position.");

    const network = NETWORKS[state.netMode]?.label || state.netMode;
    const riskMessage = healthExplanation(
      projection.risk, projection.icr, brMcr(), projection.liquidationPrice, state.price,
    ) + (state.recoveryMode ? " Recovery Mode is active; additional protocol checks may apply." : "");
    const accepted = await reviewTransaction({
      title: "Review additional borrowing",
      description: "Borrow more orUSD against your existing collateralized position.",
      network,
      risk: projection.risk,
      riskMessage,
      details: [
        { label: "Borrow amount", value: `${fmt(amount)} orUSD` },
        { label: "Borrowing fee", value: isRates() ? "No upfront fee" : `${fmt(fee)} orUSD` },
        { label: "Projected total debt", value: `${fmtNum(projection.debt)} orUSD` },
        { label: "Collateral ratio after borrowing", value: fmtPct(projection.icr) },
        { label: "Liquidation price", value: reviewPrice(projection.liquidationPrice) },
        { label: "Network gas", value: "Estimated by your wallet at signing" },
      ],
    });
    if (!accepted) return;
    if (!requireRiskIncreaseAllowed("Borrowing orUSD")) return;

    let latestDebtIncrease: bigint;
    try { latestDebtIncrease = isRates() ? amount : await borrowWithFee(amount); }
    catch { return toast("Could not refresh the borrowing fee; review and try again.", 8000); }
    const latestFee = latestDebtIncrease > amount ? latestDebtIncrease - amount : 0n;
    const latest = projectAdjustment("borrow", amount, latestFee);
    if (!latest?.executable || Math.abs(latest.icr - projection.icr) >= 1) {
      updateAdjustmentPreview();
      return toast("The projected ratio changed during review. Check the updated quote and review again.", 8000);
    }
    void tx("Borrow orUSD", async () => {
      const [up, low] = await adjustHints(0n, latestDebtIncrease);
      return state.C.borrowerOps.withdrawLUSD(MAX_FEE, amount, up, low);
    });
  });
  $("btnRepay").addEventListener("click", () => {
    const amount = adjDebt("repayment amount");
    if (amount === null) return;
    if (state.wallet && amount > state.orUsdBalance) return toast("Repayment exceeds your orUSD wallet balance.");
    void tx("Repay orUSD", async () => {
      const [up, low] = await adjustHints(0n, -amount);
      return state.C.borrowerOps.repayLUSD(amount, up, low);
    });
  });
  $("btnClose").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    // Pre-check: closing repays the full debt (minus the 200 orUSD gas comp)
    // from the wallet — fail with a helpful message instead of a revert.
    try {
      const [entire, bal] = await Promise.all([
        state.C.troveManager.getEntireDebtAndColl(myAddr()),
        state.C.orUSD.balanceOf(myAddr())
      ]);
      const need = entire[0] - GAS_COMP;
      if (bal < need) {
        return toast(
          `Closing this Trove needs ${fmt(need)} orUSD in your wallet — you have ${fmt(bal)} ` +
          `(short ${fmt(need - bal)}). Withdraw your Stability Pool deposit, use Repay to shrink ` +
          `the debt first, or fund this account with orUSD from another one.`, 12000);
      }
    } catch { /* fall through — let the chain report */ }
    tx("Close Trove", () => state.C.borrowerOps.closeTrove());
  });

  // Rates branch: change your interest rate (7-day cooldown on-chain)
  $("btnRate").addEventListener("click", () => {
    if (!state.wallet) return toast("Connect a wallet first");
    const pct = parseFloat(input("newRate").value || "0");
    if (!(pct >= 0.5 && pct <= 100)) return toast("Interest rate must be between 0.5 and 100 %/yr");
    const rateWei = ethers.parseEther((pct / 100).toFixed(18));
    tx("Change rate to " + pct + "%", async () => {
      const [up, low] = await rateInsertHints(rateWei);
      return state.C.borrowerOps.adjustTroveRate(rateWei, up, low);
    });
  });

  // Redemption: the $1 hard-peg floor. Burns orUSD against the riskiest
  // troves at face value (minus the redemption fee). Full hint pipeline.
  $("btnRedeem").addEventListener("click", () => {
    const amt = amountFromInput("redeemAmount", "orUSD amount");
    if (amt === null) return;
    if (isRates()) {
      // Rate-ordered redemption: no reinsertion ever happens, so no hints needed.
      return tx("Redeem orUSD", () =>
        state.C.troveManager.redeemCollateral(amt, Z, Z, Z, 0, 0, MAX_FEE));
    }
    tx("Redeem orUSD", async () => {
      const p = await state.C.priceFeed.getPrice();
      const [first, partialNICR, truncated] = await state.C.hintHelpers.getRedemptionHints(amt, p, 0);
      if (truncated === 0n) throw new Error("nothing redeemable at this amount");
      let up = Z, low = Z;
      try {
        const size = await state.C.sortedTroves.getSize();
        const trials = BigInt(Math.min(15 * Math.ceil(Math.sqrt(Number(size))), 3000));
        const [approx] = await state.C.hintHelpers.getApproxHint(partialNICR, trials, 42n);
        [up, low] = await state.C.sortedTroves.findInsertPosition(partialNICR, approx, approx);
      } catch { /* zero hints still work, just cost more gas */ }
      if (truncated < amt) toast(`Redeeming ${fmt(truncated)} orUSD (amount truncated to full troves)`, 6000);
      return state.C.troveManager.redeemCollateral(truncated, first, up, low, partialNICR, 0, MAX_FEE);
    });
  });

  const spAmt = (name: string) => amountFromInput("spAmount", name);
  $("btnSpDeposit").addEventListener("click", () => {
    const amount = spAmt("deposit amount");
    if (amount !== null) tx("Stability Pool deposit", () => state.C.stabilityPool.provideToSP(amount, Z));
  });
  $("btnSpWithdraw").addEventListener("click", () => {
    const amount = spAmt("withdrawal amount");
    if (amount !== null) tx("Stability Pool withdrawal", () => state.C.stabilityPool.withdrawFromSP(amount));
  });

  // sorUSD savings vault (rates branch)
  $("btnSvDeposit").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    const need = amountFromInput("svAmount", "orUSD deposit amount");
    if (need === null) return;
    try {
      const allowance = await state.C.orUSD.allowance(myAddr(), bcfg().sorUSDVault);
      if (allowance < need && !(await tx("Approve orUSD for savings", () =>
        state.C.orUSD.approve(bcfg().sorUSDVault, ethers.MaxUint256)))) return;
    } catch (e) {
      return toast("Could not prepare the savings deposit: " + String(e instanceof Error ? e.message : e).slice(0, 140), 8000);
    }
    tx("Deposit to sorUSD Savings", () => state.C.vault.deposit(need));
  });
  $("btnSvWithdraw").addEventListener("click", () => {
    if (!state.wallet) return toast("Connect a wallet first");
    tx("sorUSD withdraw", async () => {
      const sh = await state.C.vault.balanceOf(myAddr());
      if (sh === 0n) throw new Error("no sorUSD shares to withdraw");
      return state.C.vault.redeem(sh);
    });
  });
  $("btnSvRoute").addEventListener("click", () => {
    if (!state.wallet) return toast("Connect a wallet first");
    tx("Route interest", async () => {
      const p = await state.C.router.pending();
      if (p === 0n) throw new Error("nothing pending — interest lands in the router whenever a trove is touched (or poke accrueTroveInterest)");
      return state.C.router.distribute();
    });
  });

  // Leverage zapper (rates branch)
  $("btnLvOpen").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    if (!requireRiskIncreaseAllowed("Opening a leveraged position")) return;
    const collWei = amountFromInput("lvColl", "ETH deposit");
    if (collWei === null) return;
    if (collWei > state.nativeBalance) return toast("Deposit exceeds your available ETH balance.");
    const collEth = Number(ethers.formatEther(collWei));
    const ltvBps = BigInt(select("lvLev").value);
    const ratePct = Number(input("lvRate").value);
    const slipPct = Number(input("lvSlip").value);
    if (!(ratePct >= 0.5 && ratePct <= 100)) return toast("Interest rate must be between 0.5% and 100% per year.");
    if (!(slipPct >= 0.1 && slipPct <= 99)) return toast("Maximum equity loss must be between 0.1% and 99%.");
    if (!(state.price > 0)) return toast("Waiting for a valid market price before opening.");
    const firstBorrow = collEth * state.price * Number(ltvBps) / 10000;
    if (firstBorrow < 1800) {
      return toast(`Deposit too small: the first loop must borrow at least 1,800 orUSD. At this leverage, try about ${fmtNum(1800 * 10000 / Number(ltvBps) / state.price, 2)} ETH or more.`, 8000);
    }
    let zap = await myZap();
    if (zap) {
      const position = await zap.position().catch(() => null);
      if (position && position[3] === 1n) return toast("A leveraged position is already open in your Zap.");
    }
    const needsZap = !zap;
    const leverage = 10000 / (10000 - Number(ltvBps));
    const projectedIcr = 10000 / Number(ltvBps) * 100;
    const liquidationPrice = state.price * brMcr() * 100 / projectedIcr;
    const tier = healthTier(projectedIcr, brMcr());
    const riskMessage = healthExplanation(tier, projectedIcr, brMcr(), liquidationPrice, state.price) +
      " This ratio is an approximation before swap impact, pool fees, and the six-step loop.";
    const quotePrice = state.price;
    const network = NETWORKS[state.netMode]?.label || state.netMode;
    const accepted = await reviewTransaction({
      title: "Review leveraged position",
      description: "Deposit ETH; the Zap will repeatedly borrow orUSD, swap it for ETH, and add the ETH as collateral.",
      network,
      risk: tier,
      riskMessage,
      details: [
        { label: "ETH deposit", value: `${fmt(collWei, 4)} ETH` },
        { label: "First borrow (approx.)", value: `${fmtNum(firstBorrow)} orUSD` },
        { label: "Per-loop LTV / target leverage", value: `${fmtPct(Number(ltvBps) / 100, 2)} / ~${fmtNum(leverage, 1)}×` },
        { label: "Projected ratio (approx.)", value: `${fmtPct(projectedIcr)} before swap impact` },
        { label: "Liquidation price (approx.)", value: reviewPrice(liquidationPrice) },
        { label: "Interest rate", value: `${ratePct}% / year; no upfront borrowing fee` },
        { label: "Maximum equity loss", value: `${slipPct}% aggregate slippage guard` },
        ...(needsZap ? [{ label: "Setup", value: "A separate Zap-creation transaction may be requested first" }] : []),
        { label: "Network gas", value: "Estimated by your wallet at signing" },
      ],
    });
    if (!accepted) return;
    if (!requireRiskIncreaseAllowed("Opening a leveraged position")) return;
    if (!(state.price > 0) || Math.abs(state.price - quotePrice) / quotePrice >= 0.01) {
      return toast("Market price changed during review. Check the updated market and review again.", 8000);
    }
    if (collWei > state.nativeBalance) return toast("Wallet ETH balance changed; review the deposit and try again.");

    if (!zap) {
      if (!(await tx("Create your personal leverage Zap", () => state.C.zapFactory.createZap()))) return;
      zap = await myZap();
      if (!zap) return;
      if (!requireRiskIncreaseAllowed("Opening a leveraged position")) return;
      if (!(state.price > 0) || Math.abs(state.price - quotePrice) / quotePrice >= 0.01) {
        return toast("Market conditions changed during Zap setup. Review the leverage quote again.", 8000);
      }
    }
    const slipBps = BigInt(Math.round(slipPct * 100));
    const label = `Open ~${fmtNum(leverage, 1)}× leveraged position`;
    void tx(label, () =>
      (zap as ethers.Contract).leverOpen(ethers.parseEther((ratePct / 100).toFixed(6)), ltvBps, 6n, slipBps,
        { value: collWei }));
  });
  $("btnLvClose").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    const zap = await myZap();
    if (!zap) return toast("No leverage position to close");
    const slipPct = Number(input("lvSlip").value);
    if (!(slipPct >= 0.1 && slipPct <= 99)) return toast("Maximum equity loss must be between 0.1% and 99%.");
    const slipBps = BigInt(Math.round(slipPct * 100));
    tx("Close & unwind leveraged position", () => (zap as ethers.Contract).leverClose(slipBps));
  });

  $("btnStake").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    const amt = amountFromInput("stkInput", "ORA stake");
    if (amt === null) return;
    if (state.C.branchStakingMode) {
      try {
        const allowance = await state.C.ora.allowance(myAddr(), state.C.staking.target);
        if (allowance < amt && !(await tx("Approve ORA for staking", () =>
          state.C.ora.approve(state.C.staking.target, ethers.MaxUint256)))) return;
      } catch (e) {
        return toast("Could not prepare the ORA stake: " + String(e instanceof Error ? e.message : e).slice(0, 140), 8000);
      }
    }
    tx("Stake ORA", () => state.C.staking.stake(amt));
  });
  $("btnUnstake").addEventListener("click", () => {
    const amount = amountFromInput("stkInput", "ORA amount");
    if (amount !== null) tx("Unstake ORA", () => state.C.staking.unstake(amount));
  });
  // ORA drip: server-side faucet (no key in the bundle). Refreshes balances
  // after a successful drip so the 100 ORA shows up immediately.
  $("btnFaucet").addEventListener("click", async () => {
    const h = await requestFaucet(myAddr());
    if (!h) return;
    const id = addActivity("Claim test ORA", state.netMode);
    updateActivity(id, { status: "submitted", hash: h, message: "Broadcast by the faucet service; waiting for confirmation." });
    if (state.provider) {
      void state.provider.waitForTransaction(h, 1, 120000).then((receipt) => {
        if (!receipt) return;
        updateActivity(id, {
          status: receipt.status === 1 ? "confirmed" : "failed",
          message: receipt.status === 1 ? "Confirmed on-chain." : "The faucet transaction reverted.",
        });
      }).catch(() => updateActivity(id, {
        status: "submitted", message: "Confirmation lookup failed; check the explorer for the final status.",
      }));
    }
    void refresh();
  });

  // Market simulator: ETH/USD (settable aggregator only). The fallback source
  // is moved in lockstep so big crashes are two-source CONFIRMED and pass the
  // 50% deviation guard — exactly how a real market crash would look.
  const setEthUsd = async (v: number) => {
    const answer = BigInt(Math.round(v * 1e8));
    if (state.C.aggEthFb && !(await tx(`Set fallback ETH/USD to ${fmtUsdNum(v, 0)}`, () =>
      state.C.aggEthFb.setAnswer(answer)))) return;
    await tx(`Set ETH/USD to ${fmtUsdNum(v, 0)}`, () => state.C.aggEth.setAnswer(answer));
  };
  document.querySelectorAll<HTMLButtonElement>("button[data-bump]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!state.C.aggEth) return toast("Live Chainlink feed — not settable");
      const rd = await state.C.aggEth.latestRoundData();
      setEthUsd(Number(rd[1]) / 1e8 * (1 + Number(b.dataset.bump) / 100));
    }));
  $("btnSetPrice").addEventListener("click", () => {
    if (!state.C.aggEth) return toast("Live Chainlink feed — not settable");
    const v = parseFloat(input("simInput").value);
    if (!v || v <= 0) return toast("Enter a valid price");
    setEthUsd(v);
  });

  // NAV simulator (RWA branch): accrue yield, spike (clamped), break the buck
  document.querySelectorAll<HTMLButtonElement>("button[data-nav]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!state.C.aggNav) return;
      const v = b.dataset.nav;
      void (async () => {
        const label = v === "reset" ? "Reset NAV to $1.05" : "Set NAV ×" + v;
        if (!(await tx(label, async () => {
          let target = 105000000n; // $1.05, 8 decimals
          if (v !== "reset") {
            const rd = await state.C.aggNav.latestRoundData();
            target = BigInt(Math.round(Number(rd[1]) * Number(v)));
          }
          return state.C.aggNav.setAnswer(target);
        }))) return;
        await tx("Apply NAV clamp and shock guard", () => state.C.priceFeed.fetchPrice());
      })();
    }));

  // Sequencer outage simulator (local mock uptime feed)
  document.querySelectorAll<HTMLButtonElement>("button[data-seq]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!state.C.aggSeq) return;
      const mode = b.dataset.seq;
      const label = mode === "halt" ? "Halt L2 sequencer"
        : mode === "restart" ? "Restart sequencer (grace starts)" : "Skip the 1h restart grace";
      void (async () => {
        const changed = await tx(label, () => {
          if (mode === "halt") return state.C.aggSeq.setAnswer(1n);
          if (mode === "restart") return state.C.aggSeq.setAnswer(0n);
          return state.C.aggSeq.makeStale(2 * 3600);
        });
        if (changed) await tx("Apply sequencer uptime guard", () => state.C.priceFeed.fetchPrice());
      })();
    }));

  // Depeg simulator: stETH/ETH rate (always settable on testnets)
  document.querySelectorAll<HTMLButtonElement>("button[data-rate]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!state.C.aggRate) return;
      const r = b.dataset.rate;
      void (async () => {
        const changed = await tx(`Set stETH/ETH rate to ${r}`, () =>
          state.C.aggRate.setAnswer(ethers.parseEther(r as string)));
        if (changed) await tx("Apply stETH/ETH circuit breaker", () => state.C.priceFeed.fetchPrice());
      })();
    }));
}
