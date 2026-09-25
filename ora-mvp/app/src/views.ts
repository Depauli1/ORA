// Read path + rendering: branch switching, the big refresh(), leverage
// panel, open-trove preview, risky-troves table. Faithful port of the
// app.js view layer — same elements, same strings, same fallbacks.
import { ethers } from "ethers";
import { Z, GAS_COMP, NETWORKS } from "./config";
import {
  state, dep, bcfg, provider, myAddr,
  isNative, isRWA, isRates, collSym, faucetAmt, brMcr, brSoft,
} from "./state";
import { myZap, connectContracts } from "./contracts";
import { tx } from "./wallet";
import { updateSimControls } from "./network";
import { $, input, button, toast } from "./dom";
import { fmt, fmtUsd, short, icrClass } from "./format";

export function setBranch(name: string): void {
  const d = dep();
  if (!d || !d.branches) return;
  if (!d.branches[name]) name = Object.keys(d.branches)[0];
  state.branch = name;
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.branch === name));
  document.querySelectorAll<HTMLElement>(".collsym").forEach((el) => (el.textContent = collSym()));
  applyBranchVisibility();
  connectContracts();
}

function applyBranchVisibility(): void {
  const testnet = NETWORKS[state.netMode].testnet;
  // Mock-collateral faucets exist only on testnets
  $("btnWstFaucet").style.display = !isNative() && testnet ? "inline-block" : "none";
  $("btnWstFaucet").textContent = `Get ${Number(faucetAmt()).toLocaleString("en-US")} test ${collSym()}`;
  $("balWst").style.display = isNative() ? "none" : "inline";
  // Market/oracle simulators are testnet tooling — never shown on mainnet
  $("simTools").style.display = testnet ? "" : "none";
  $("simTitle").textContent = testnet ? "Market Simulator" : "Risky Troves";
  $("simSub").textContent = testnet
    ? "testnet oracle control — crash the market, run liquidations"
    : `troves nearest liquidation — anyone can liquidate below ${(brMcr() * 100).toFixed(0)}%`;
  const { C } = state;
  $("depegRow").style.display = testnet && !isNative() && bcfg().stEthEthAggregator ? "flex" : "none";
  $("seqRow").style.display = testnet && C.aggSeq && !isRWA() ? "flex" : "none";
  $("navRow").style.display = testnet && isRWA() ? "flex" : "none";
  $("priceRow").style.display = !testnet || isRWA() ? "none" : "flex";
  // Rates-engine UI (ETH v2 branch)
  const rates = isRates();
  $("rateField").style.display = rates ? "" : "none";
  $("rateKv").style.display = rates ? "" : "none";
  $("rateAdjustRow").style.display = rates ? "" : "none";
  $("btnRate").style.display = rates ? "inline-block" : "none";
  $("sorusdCard").style.display = rates ? "" : "none";
  $("leverCard").style.display = rates && bcfg().leverZapFactory ? "" : "none";
  $("troveHint").innerHTML = rates
    ? 'borrow orUSD against <b class="collsym">ETH</b> · pay the rate <b>you</b> choose'
    : 'borrow orUSD against <b class="collsym">' + collSym() + '</b> · 0% interest';
  $("redeemHint").textContent = rates
    ? "Rate-ordered: redeems against the LOWEST-interest-rate troves first — paying a higher rate is redemption protection. Fee: 0.5% floor + rate. Disabled during the 14-day bootstrap period."
    : "Redeems against the lowest-collateral troves at face value, minus the redemption fee (0.5% floor + rate). Disabled during the 14-day bootstrap period after launch.";
  $("stFeeLabel").textContent = rates ? "Avg Borrow Rate" : "Borrow Fee";
  // sensible open-trove defaults per collateral
  const defs = isRWA() ? ["10000", "5000"] : isNative() ? ["5", "4000"] : ["6", "6000"];
  input("openColl").value = defs[0];
  input("openDebt").value = defs[1];
  updateSimControls();
}

export async function refresh(): Promise<void> {
  const { C } = state;
  try {
    const me = myAddr();
    const p = await C.priceFeed.getPrice();
    const [tcr, recovery, supply, nTroves, spTotal, rate,
           ethBal, orusdBal, oraBal, wstBal, trove, entire,
           spDep, spEth, spOra, stake, stkEth, stkOrusd,
           oracleLive, stRate, navShock] = await Promise.all([
      C.troveManager.getTCR(p),
      C.troveManager.checkRecoveryMode(p),
      C.orUSD.totalSupply(),
      C.troveManager.getTroveOwnersCount(),
      C.stabilityPool.getTotalLUSDDeposits(),
      C.troveManager.getBorrowingRateWithDecay(),
      provider().getBalance(me === Z ? bcfg().troveManager : me),
      C.orUSD.balanceOf(me),
      C.ora.balanceOf(me),
      C.collToken ? C.collToken.balanceOf(me) : 0n,
      C.troveManager.Troves(me),
      C.troveManager.getEntireDebtAndColl(me),
      C.stabilityPool.getCompoundedLUSDDeposit(me),
      C.stabilityPool.getDepositorETHGain(me),
      C.stabilityPool.getDepositorLQTYGain(me),
      C.staking.stakes(me),
      C.staking.getPendingETHGain(me),
      C.staking.getPendingLUSDGain(me),
      C.priceFeed.oracleLive(),
      C.aggRate ? C.priceFeed.getStEthEthRate() : [0n, true],
      isRWA() ? C.priceFeed.navShock() : false
    ]);
    void oracleLive; void navShock;

    state.price = Number(ethers.formatEther(p));

    $("stEthPrice").textContent = fmtUsd(p);
    $("stTcr").textContent = nTroves > 0n ? (Number(tcr) / 1e16).toFixed(1) + "%" : "—";
    $("stMode").textContent = recovery ? "RECOVERY" : "Normal";
    $("stMode").className = recovery ? "bad" : "good";
    $("stSupply").textContent = fmt(supply, 0) + " orUSD";
    $("stTroves").textContent = nTroves.toString();
    $("stSp").textContent = fmt(spTotal, 0) + " orUSD";
    $("stFee").textContent = (Number(rate) / 1e16).toFixed(2) + "%";

    if (C.aggRate) $("simRate").textContent = Number(ethers.formatEther(stRate[0])).toFixed(3);
    if (C.aggSeq && !isRWA()) {
      try {
        const [up, rd] = await Promise.all([C.priceFeed.sequencerUp(), C.aggSeq.latestRoundData()]);
        const halted = rd[1] !== 0n;
        $("simSeq").textContent = up ? "UP" : halted ? "DOWN" : "GRACE (1h)";
        $("simSeq").className = up ? "good" : "bad";
        if (!up) toast((halted ? "L2 sequencer DOWN" : "sequencer restart grace period") +
          " — oracles are serving lastGoodPrice", 6000);
      } catch { /* ignore sequencer read failures */ }
    }
    if (C.aggNav) {
      const nav = await C.aggNav.latestRoundData();
      $("simNav").textContent = "$" + (Number(nav[1]) / 1e8).toFixed(4);
    }

    // ETH/USD shown in the simulator row (branch price may be derived)
    if (C.aggEth) {
      const rd = await C.aggEth.latestRoundData();
      $("simPrice").textContent = "$" + (Number(rd[1]) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 2 });
    } else {
      $("simPrice").textContent = fmtUsd(p) + (isNative() ? "" : ` (${collSym()})`);
    }

    $("balEth").textContent = state.wallet ? fmt(ethBal) + " ETH" : "—";
    $("balOrusd").textContent = fmt(orusdBal) + " orUSD";
    $("balOra").textContent = fmt(oraBal) + " ORA";
    if (C.collToken) $("balWst").textContent = fmt(wstBal) + " " + collSym();

    const active = trove.status === 1n;
    $("troveNone").style.display = active ? "none" : "block";
    $("troveActive").style.display = active ? "block" : "none";
    if (active) {
      const debt = entire[0], coll = entire[1];
      const icr = Number(coll) * state.price / Number(debt) * 100;
      const liqPrice = Number(ethers.formatEther(debt)) * brMcr() / Number(ethers.formatEther(coll));
      $("tvColl").textContent = fmt(coll, 4) + " " + collSym();
      $("tvDebt").textContent = fmt(debt) + " orUSD";
      $("tvIcr").textContent = icr.toFixed(1) + "%";
      $("tvIcr").className = icrClass(icr, brMcr() * 100);
      $("tvLiq").textContent = "$" + liqPrice.toLocaleString("en-US", { maximumFractionDigits: 2 });
      // Close readiness: full debt minus the refunded 200 orUSD gas comp
      const closeNeed = debt - GAS_COMP;
      const ready = orusdBal >= closeNeed;
      $("tvCloseHint").innerHTML = ready
        ? `close repays <b>${fmt(closeNeed)} orUSD</b> — wallet has ${fmt(orusdBal)} <span class="good">✓</span>`
        : `close repays <b>${fmt(closeNeed)} orUSD</b> — wallet has ${fmt(orusdBal)} ` +
          `(<span class="bad">short ${fmt(closeNeed - orusdBal)}</span>: withdraw your SP deposit or repay partially)`;
      button("btnClose").disabled = !ready;
    }
    updateOpenPreview(rate);

    $("spDeposit").textContent = fmt(spDep) + " orUSD";
    $("spEthGain").textContent = fmt(spEth, 5) + " " + collSym();
    $("spOraGain").textContent = fmt(spOra, 3) + " ORA";
    $("spShare").textContent = spTotal > 0n
      ? (Number(spDep) / Number(spTotal) * 100).toFixed(2) + "%" : "0%";

    $("stkAmount").textContent = fmt(stake) + " ORA";
    $("stkEth").textContent = fmt(stkEth, 5) + " " + (C.branchStakingMode ? collSym() : "ETH");
    $("stkOrusd").textContent = fmt(stkOrusd, 3) + " orUSD";

    if (isRates()) {
      const [myRate, aggW, sysDebt, svP, svTvl, svShares, pend]: bigint[] = await Promise.all([
        C.troveManager.troveAnnualRate(me),
        C.troveManager.aggWeightedDebt(),
        C.troveManager.getEntireSystemDebt(),
        C.vault.sharePrice(),
        C.vault.totalAssets(),
        C.vault.balanceOf(me),
        C.router.pending()
      ]);
      $("tvRate").textContent = (Number(myRate) / 1e16).toFixed(2) + "% /yr";
      $("svPrice").textContent = Number(ethers.formatEther(svP)).toFixed(6) + " orUSD";
      $("svTvl").textContent = fmt(svTvl, 0) + " orUSD";
      $("svBal").textContent = fmt(svShares) + " (" + fmt(svShares * svP / 10n ** 18n) + " orUSD)";
      // interest stream/yr × savers' 80% share ÷ vault TVL
      $("svApy").textContent = (svTvl > 0n ? Number(aggW) * 0.8 / Number(svTvl) * 100 : 0).toFixed(2) + "%";
      $("svPending").textContent = fmt(pend);
      $("stFee").textContent = (sysDebt > 0n ? Number(aggW) / Number(sysDebt) * 100 : 0).toFixed(2) + "%";
      await refreshLever();
    }

    await refreshTrovesTable();
  } catch (e) {
    console.error(e);
  }
}

export async function refreshLever(): Promise<void> {
  const { C } = state;
  if (!C.zapFactory) return;
  try {
    if (C.swapPool) {
      const spot = await C.swapPool.spotPrice();
      $("lvPool").textContent = "$" + Number(ethers.formatEther(spot)).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " /ETH";
    }
    const zap = await myZap();
    const pos = zap ? await zap.position() : null;
    if (pos && pos[3] === 1n) {
      const debt = pos[0], coll = pos[1];
      const icr = Number(coll) * state.price / Number(debt) * 100;
      $("lvPos").textContent = fmt(coll, 3) + " ETH @ " + (Number(pos[2]) / 1e16).toFixed(1) + "%";
      $("lvDebt").textContent = fmt(debt) + " orUSD";
      $("lvIcr").textContent = icr.toFixed(1) + "%";
      $("lvIcr").className = icrClass(icr, brMcr() * 100);
    } else {
      $("lvPos").textContent = "none";
      $("lvDebt").textContent = "—";
      $("lvIcr").textContent = "—";
      $("lvIcr").className = "";
    }
  } catch (e) { console.error(e); }
}

export function updateOpenPreview(rate?: bigint): void {
  const coll = parseFloat(input("openColl").value) || 0;
  const borrow = parseFloat(input("openDebt").value) || 0;
  const fee = borrow * Number(rate ?? 5n * 10n ** 15n) / 1e18;
  const totalDebt = borrow + fee + 200;
  const icr = totalDebt > 0 ? (coll * state.price / totalDebt) * 100 : 0;
  const cls = icrClass(icr, brMcr() * 100);
  const ratePct = parseFloat(input("openRate").value) || 0;
  $("openPreview").innerHTML =
    (isRates()
      ? `Interest: <b>≈${(totalDebt * ratePct / 100).toFixed(0)} orUSD/yr</b> at ${ratePct}%/yr (no upfront fee) · Total debt (incl. 200 gas comp): <b>${totalDebt.toFixed(2)} orUSD</b><br/>`
      : `Fee: <b>${fee.toFixed(2)} orUSD</b> · Total debt (incl. 200 gas comp): <b>${totalDebt.toFixed(2)} orUSD</b><br/>`) +
    `Collateral ratio: <b class="${cls}">${icr.toFixed(1)}%</b> — liquidation below ${(brMcr() * 100).toFixed(0)}%` +
    (borrow < 1800 ? ' · <span class="bad">minimum borrow is 1,800 orUSD</span>' : "") +
    (bcfg().debtCap ? ` · isolated branch: debt cap ${Number(bcfg().debtCap).toLocaleString("en-US")} orUSD` : "");
}

export async function refreshTrovesTable(): Promise<void> {
  const { C } = state;
  const rows = await C.multiGetter.getMultipleSortedTroves(0, state.troveRows);
  $("btnMoreTroves").style.display = rows.length >= state.troveRows ? "inline-block" : "none";
  const tbody = $("trovesTable").querySelector("tbody") as HTMLElement;
  tbody.innerHTML = "";
  const rowRates = isRates()
    ? await Promise.all(rows.map((r: { 0: string }) => C.troveManager.troveAnnualRate(r[0]).catch(() => 0n)))
    : null;
  let ri = -1;
  for (const r of rows) {
    ri++;
    const owner = r[0], debt = r[1], coll = r[2];
    const icr = Number(coll) * state.price / Number(debt) * 100;
    const liq = icr < brMcr() * 100;
    // Phase 2 (non-ETH branches): troves in the soft band [softFloor, MCR) can
    // be partially liquidated at a 3% premium instead of fully at ~10%
    const soft = !isNative() && liq && icr >= brSoft() * 100;
    const tr = document.createElement("tr");
    if (liq) tr.className = "liq";
    tr.innerHTML =
      `<td title="${owner}">${short(owner)}${owner === myAddr() ? " (you)" : ""}` +
      (rowRates ? ` <span class="hint">@ ${(Number(rowRates[ri]) / 1e16).toFixed(1)}%</span>` : "") + `</td>` +
      `<td>${fmt(coll, 3)} ${collSym()}</td><td>${fmt(debt, 0)} orUSD</td>` +
      `<td class="${liq ? "bad" : icr < brMcr() * 100 + 40 ? "warn" : "good"}">${icr.toFixed(1)}%</td>` +
      `<td><button class="mini" data-liq="${owner}" ${liq ? "" : "disabled"}>Liquidate</button>` +
      (soft ? ` <button class="mini" data-softliq="${owner}" title="Partial liquidation: restores the trove to ${(brMcr() * 100).toFixed(0)}% at a 3% premium">Soft-liq</button>` : "") +
      `</td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll<HTMLButtonElement>("button[data-liq]").forEach((b) =>
    b.addEventListener("click", () =>
      tx("Liquidate " + short(b.dataset.liq ?? ""), () => C.troveManager.liquidate(b.dataset.liq)))
  );
  tbody.querySelectorAll<HTMLButtonElement>("button[data-softliq]").forEach((b) =>
    b.addEventListener("click", () =>
      tx("Soft-liquidate " + short(b.dataset.softliq ?? ""), () => C.troveManager.liquidatePartial(b.dataset.softliq)))
  );
}
