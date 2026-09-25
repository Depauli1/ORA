// UI wiring: every button/input listener. Declarative — all chain logic
// lives in contracts.ts/wallet.ts, all rendering in views.ts.
import { ethers } from "ethers";
import { Z, MAX_FEE, GAS_COMP, NETWORKS } from "./config";
import { state, bcfg, myAddr, isNative, isRates, collSym } from "./state";
import {
  getInsertHints, rateInsertHints, adjustHints, borrowWithFee,
  ensureAllowance, myZap,
} from "./contracts";
import { setAccount, connectWallet, connectWithProvider, tx } from "./wallet";
import { connectWalletConnect } from "./walletconnect";
import { requestFaucet } from "./faucet";
import { setNetwork } from "./network";
import { refresh, setBranch, updateOpenPreview, refreshTrovesTable } from "./views";
import { $, input, select, toast } from "./dom";
import { fmt, reason } from "./format";
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
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      state.troveRows = 50;
      setBranch(t.dataset.branch || "ETH");
      refresh();
    }));
  $("btnMoreTroves").addEventListener("click", () => {
    state.troveRows += 50;
    refreshTrovesTable();
  });
  ["openColl", "openDebt", "openRate"].forEach((id) =>
    $(id).addEventListener("input", () => updateOpenPreview()));

  $("btnWstFaucet").addEventListener("click", () =>
    tx(collSym() + " faucet", () =>
      state.C.collToken.faucet(ethers.parseEther(bcfg().faucetAmount || "10"))));

  $("btnOpen").addEventListener("click", async () => {
    const coll = ethers.parseEther(input("openColl").value || "0");
    const debt = ethers.parseEther(input("openDebt").value || "0");
    if (!state.wallet) return toast("Connect a wallet first");
    if (isRates()) {
      const pct = parseFloat(input("openRate").value || "0");
      if (!(pct >= 0.5 && pct <= 100)) return toast("Interest rate must be between 0.5 and 100 %/yr");
      const rateWei = ethers.parseEther((pct / 100).toFixed(18));
      tx("Open Trove @ " + pct + "%", async () => {
        const [up, low] = await rateInsertHints(rateWei);
        return state.C.borrowerOps.openTroveWithRate(debt, rateWei, up, low, { value: coll });
      });
    } else if (isNative()) {
      tx("Open Trove", async () => {
        const [up, low] = await getInsertHints(coll, (await borrowWithFee(debt)) + GAS_COMP);
        return state.C.borrowerOps.openTrove(MAX_FEE, debt, up, low, { value: coll });
      });
    } else {
      try { await ensureAllowance(coll); } catch (e) { return toast("Approve failed: " + reason(e), 8000); }
      tx("Open Trove", async () => {
        const [up, low] = await getInsertHints(coll, (await borrowWithFee(debt)) + GAS_COMP);
        return state.C.borrowerOps.openTrove(MAX_FEE, debt, coll, up, low);
      });
    }
  });

  const adj = () => ethers.parseEther(input("adjAmount").value || "0");
  $("btnAddColl").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    if (isNative()) {
      tx("Add collateral", async () => {
        const [up, low] = await adjustHints(adj(), 0n);
        return state.C.borrowerOps.addColl(up, low, { value: adj() });
      });
    } else {
      try { await ensureAllowance(adj()); } catch (e) { return toast("Approve failed: " + reason(e), 8000); }
      tx("Add collateral", async () => {
        const [up, low] = await adjustHints(adj(), 0n);
        return state.C.borrowerOps.addColl(adj(), up, low);
      });
    }
  });
  $("btnWithdrawColl").addEventListener("click", () =>
    tx("Withdraw collateral", async () => {
      const [up, low] = await adjustHints(-adj(), 0n);
      return state.C.borrowerOps.withdrawColl(adj(), up, low);
    }));
  $("btnBorrowMore").addEventListener("click", () =>
    tx("Borrow orUSD", async () => {
      const [up, low] = await adjustHints(0n, await borrowWithFee(adj()));
      return state.C.borrowerOps.withdrawLUSD(MAX_FEE, adj(), up, low);
    }));
  $("btnRepay").addEventListener("click", () =>
    tx("Repay orUSD", async () => {
      const [up, low] = await adjustHints(0n, -adj());
      return state.C.borrowerOps.repayLUSD(adj(), up, low);
    }));
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
    const amt = ethers.parseEther(input("redeemAmount").value || "0");
    if (amt === 0n) return toast("Enter an orUSD amount to redeem");
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

  const spAmt = () => ethers.parseEther(input("spAmount").value || "0");
  $("btnSpDeposit").addEventListener("click", () =>
    tx("Stability deposit", () => state.C.stabilityPool.provideToSP(spAmt(), Z)));
  $("btnSpWithdraw").addEventListener("click", () =>
    tx("Stability withdrawal", () => state.C.stabilityPool.withdrawFromSP(spAmt())));

  // sorUSD savings vault (rates branch)
  const svAmt = () => ethers.parseEther(input("svAmount").value || "0");
  $("btnSvDeposit").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    tx("sorUSD deposit", async () => {
      const need = svAmt();
      const allowance = await state.C.orUSD.allowance(myAddr(), bcfg().sorUSDVault);
      if (allowance < need) {
        toast("Approving orUSD…", 30000);
        await (await state.C.orUSD.approve(bcfg().sorUSDVault, ethers.MaxUint256)).wait();
      }
      return state.C.vault.deposit(need);
    });
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
    const collEth = parseFloat(input("lvColl").value) || 0;
    const ltvBps = BigInt(select("lvLev").value);
    const ratePct = parseFloat(input("lvRate").value) || 5;
    const firstBorrow = collEth * state.price * Number(ltvBps) / 10000;
    if (firstBorrow < 1800) {
      return toast(`Deposit too small — the first loop must borrow ≥ 1,800 orUSD (needs ≈ ${(1800 * 10000 / Number(ltvBps) / state.price).toFixed(2)} ETH at this leverage)`, 8000);
    }
    let zap = await myZap();
    if (!zap) {
      await tx("Create your personal leverage Zap", () => state.C.zapFactory.createZap());
      zap = await myZap();
      if (!zap) return;
    }
    const slipBps = BigInt(Math.round((parseFloat(input("lvSlip").value) || 20) * 100));
    const lev = (10000 / (10000 - Number(ltvBps))).toFixed(1);
    tx(`Open ~${lev}× leverage with ${collEth} ETH`, () =>
      (zap as ethers.Contract).leverOpen(ethers.parseEther((ratePct / 100).toFixed(6)), ltvBps, 6n, slipBps,
        { value: ethers.parseEther(String(collEth)) }));
  });
  $("btnLvClose").addEventListener("click", async () => {
    if (!state.wallet) return toast("Connect a wallet first");
    const zap = await myZap();
    if (!zap) return toast("No leverage position to close");
    const slipBps = BigInt(Math.round((parseFloat(input("lvSlip").value) || 20) * 100));
    tx("Close & unwind leveraged position", () => (zap as ethers.Contract).leverClose(slipBps));
  });

  const stkAmt = () => ethers.parseEther(input("stkInput").value || "0");
  $("btnStake").addEventListener("click", () =>
    tx("Stake ORA", async () => {
      const amt = stkAmt();
      // BranchStaking pulls ORA via transferFrom — approve once if needed
      if (state.C.branchStakingMode) {
        const allowance = await state.C.ora.allowance(myAddr(), state.C.staking.target);
        if (allowance < amt) await (await state.C.ora.approve(state.C.staking.target, ethers.MaxUint256)).wait();
      }
      return state.C.staking.stake(amt);
    }));
  $("btnUnstake").addEventListener("click", () =>
    tx("Unstake ORA", () => state.C.staking.unstake(stkAmt())));
  // ORA drip: server-side faucet (no key in the bundle). Refreshes balances
  // after a successful drip so the 100 ORA shows up immediately.
  $("btnFaucet").addEventListener("click", async () => {
    const h = await requestFaucet(myAddr());
    if (h) refresh();
  });

  // Market simulator: ETH/USD (settable aggregator only). The fallback source
  // is moved in lockstep so big crashes are two-source CONFIRMED and pass the
  // 50% deviation guard — exactly how a real market crash would look.
  const setEthUsd = async (v: number) =>
    tx(`Set ETH/USD to $${v.toFixed(0)}`, async () => {
      const answer = BigInt(Math.round(v * 1e8));
      if (state.C.aggEthFb) await (await state.C.aggEthFb.setAnswer(answer)).wait();
      return state.C.aggEth.setAnswer(answer);
    });
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
      tx(v === "reset" ? "Reset NAV to $1.05" : "Set NAV ×" + v, async () => {
        let target = 105000000n; // $1.05, 8 decimals
        if (v !== "reset") {
          const rd = await state.C.aggNav.latestRoundData();
          target = BigInt(Math.round(Number(rd[1]) * Number(v)));
        }
        await (await state.C.aggNav.setAnswer(target)).wait();
        return state.C.priceFeed.fetchPrice(); // apply clamp / shock breaker on-chain
      });
    }));

  // Sequencer outage simulator (local mock uptime feed)
  document.querySelectorAll<HTMLButtonElement>("button[data-seq]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!state.C.aggSeq) return;
      const mode = b.dataset.seq;
      const label = mode === "halt" ? "Halt L2 sequencer"
        : mode === "restart" ? "Restart sequencer (grace starts)" : "Skip the 1h restart grace";
      tx(label, async () => {
        if (mode === "halt") { await (await state.C.aggSeq.setAnswer(1n)).wait(); }
        else if (mode === "restart") { await (await state.C.aggSeq.setAnswer(0n)).wait(); }
        else { await (await state.C.aggSeq.makeStale(2 * 3600)).wait(); }
        return state.C.priceFeed.fetchPrice(); // apply the guard on-chain
      });
    }));

  // Depeg simulator: stETH/ETH rate (always settable on testnets)
  document.querySelectorAll<HTMLButtonElement>("button[data-rate]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!state.C.aggRate) return;
      const r = b.dataset.rate;
      tx(`Set stETH/ETH rate to ${r}`, async () => {
        await (await state.C.aggRate.setAnswer(ethers.parseEther(r as string))).wait();
        return state.C.priceFeed.fetchPrice(); // trip/reset the on-chain circuit breaker
      });
    }));
}
