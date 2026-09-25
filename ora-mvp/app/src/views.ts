// Read path + rendering: branch switching, the big refresh(), leverage
// panel, open-trove preview, risky-troves table. Faithful port of the
// app.js view layer — same elements, same strings, same fallbacks.
import { ethers } from "ethers";
import { Z, GAS_COMP, NETWORKS } from "./config";
import {
  state, dep, bcfg, provider, myAddr, hasFreshMarketData, MAX_MARKET_DATA_AGE_MS,
  isNative, isRWA, isRates, collSym, faucetAmt, brMcr, brSoft,
} from "./state";
import { myZap, connectContracts } from "./contracts";
import { tx } from "./wallet";
import { updateSimControls } from "./network";
import { $, input, button } from "./dom";
import { fmt, fmtUsd, short, icrClass, reason } from "./format";
import {
  adjustmentPreviews, healthExplanation, healthMeterPct, healthTier,
  openPreview as calculateOpenPreview,
} from "./branch";

export function setView(name: string): void {
  const valid = ["borrow", "earn", "markets"].includes(name) ? name : "borrow";
  document.querySelectorAll<HTMLElement>("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== valid;
    panel.classList.toggle("is-active", !panel.hidden);
  });
  document.querySelectorAll<HTMLButtonElement>("button[data-view]").forEach((nav) => {
    const active = nav.dataset.view === valid;
    nav.classList.toggle("is-active", active);
    nav.setAttribute("aria-pressed", String(active));
  });
  if (valid === "markets") void refreshMarketsTable();
}

export function setBranch(name: string): void {
  const d = dep();
  if (!d || !d.branches) return;
  if (!d.branches[name]) name = Object.keys(d.branches)[0];
  state.branch = name;
  const branchSelect = document.getElementById("branchSelect") as HTMLSelectElement | null;
  if (branchSelect && branchSelect.value !== name) branchSelect.value = name;
  document.querySelectorAll<HTMLElement>(".collsym").forEach((el) => (el.textContent = collSym()));
  updateAssetMarks();
  applyBranchVisibility();
  connectContracts();
}

function updateAssetMarks(): void {
  const symbol = collSym();
  const mark = /bill/i.test(symbol) ? "T" : /wst/i.test(symbol) ? "w" : "Ξ";
  for (const id of ["borrowTokenMark", "openCollMark", "adjCollMark"]) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.textContent = mark;
    element.dataset.asset = /bill/i.test(symbol) ? "tbill" : /wst/i.test(symbol) ? "wsteth" : "eth";
  }
  const symbolLabel = document.getElementById("openCollSymbol");
  if (symbolLabel) symbolLabel.textContent = symbol;
}

function updateHealthMeter(
  meterId: string,
  fillId: string,
  badgeId: string,
  icr: number,
  mcr: number,
  tier: ReturnType<typeof healthTier> = healthTier(icr, mcr),
): void {
  const meter = $(meterId);
  const fill = $(fillId);
  const badge = $(badgeId);
  const max = mcr * 150;
  meter.dataset.risk = tier;
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", displayEstimate(max, 0));
  meter.setAttribute("aria-valuenow", displayEstimate(Math.min(Math.max(icr, 0), max), 1));
  meter.setAttribute("aria-valuetext", tier === "unknown"
    ? "Waiting for valid market and position data"
    : `${tier} · ${displayEstimate(icr, 1)}% collateral ratio; minimum ${displayEstimate(mcr * 100, 0)}%`);
  fill.style.width = `${healthMeterPct(icr, mcr)}%`;
  badge.dataset.risk = tier;
  badge.textContent = tier === "safe" ? "Safe" : tier === "caution" ? "Caution" : tier === "critical" ? "Critical" : "Waiting";
}

function updatePositionHealth(): void {
  if (!state.position) return;
  const collateral = Number(ethers.formatEther(state.position.collateral));
  const debt = Number(ethers.formatEther(state.position.debt));
  const icr = state.price > 0 && debt > 0 ? collateral * state.price / debt * 100 : Number.NaN;
  const liquidationPrice = collateral > 0 ? debt * brMcr() / collateral : 0;
  const tier = healthTier(icr, brMcr());
  const blocked = riskIncreaseBlockMessage();
  updateHealthMeter(
    "positionHealthMeter", "positionHealthFill", "positionHealthBadge", icr, brMcr(),
    blocked ? "unknown" : tier,
  );
  $("tvIcr").textContent = Number.isFinite(icr) ? `${icr.toFixed(1)}%` : "—";
  $("tvIcr").className = blocked || !Number.isFinite(icr) ? "warn" : icrClass(icr, brMcr() * 100);
  $("positionRiskMessage").textContent = blocked
    ? `${Number.isFinite(icr) ? `Last-known ratio ${displayEstimate(icr, 1)}%. ` : "Current ratio unavailable. "}${blocked} Risk-increasing actions are paused until the data is healthy.`
    : healthExplanation(tier, icr, brMcr(), liquidationPrice, state.price);
  if (blocked) $("positionHealthBadge").textContent = "Check data";
}

function applyBranchVisibility(): void {
  const testnet = NETWORKS[state.netMode].testnet;
  // Mock-collateral faucets exist only on testnets.
  $("btnWstFaucet").hidden = isNative() || !testnet;
  $("btnWstFaucet").textContent = `Get ${Number(faucetAmt()).toLocaleString("en-US")} test ${collSym()}`;
  $("balWst").hidden = isNative();
  // Market/oracle simulators are explicitly disclosed testnet tools.
  $("simTools").hidden = !testnet;
  $("simTitle").textContent = "Testnet market simulator";
  $("simSub").textContent = "Developer-only oracle controls; not available on mainnet.";
  $("riskSub").textContent = testnet
    ? `Nearest liquidation risk for ${collSym()} collateral; simulator is testnet-only.`
    : `Troves nearest liquidation below ${(brMcr() * 100).toFixed(0)}% for ${collSym()} collateral.`;
  const { C } = state;
  $("depegRow").hidden = !(testnet && !isNative() && bcfg().stEthEthAggregator);
  $("seqRow").hidden = !(testnet && C.aggSeq && !isRWA());
  $("navRow").hidden = !(testnet && isRWA());
  $("priceRow").hidden = !testnet || isRWA();
  $("simNote").hidden = !!bcfg().ethUsdSettable || isRWA();
  // Rates-engine features stay in the relevant market and are progressively disclosed.
  const rates = isRates();
  $("rateField").hidden = !rates;
  $("rateKv").hidden = !rates;
  $("rateAdjustRow").hidden = !rates;
  $("btnRate").hidden = !rates;
  $("sorusdCard").hidden = !rates;
  $("leverCard").hidden = !(rates && !!bcfg().leverZapFactory);
  $("troveHint").textContent = rates
    ? "Pay the annual interest rate you choose on borrowed orUSD."
    : "Borrow orUSD against your collateral · 0% interest on this market.";
  $("redeemHint").textContent = rates
    ? "Redemptions start with the lowest-interest-rate Troves. A higher rate may provide more redemption protection. Fees and availability vary with system conditions."
    : "Redemptions start with the lowest-collateral Troves. Fees and availability vary with system conditions.";
  $("stFeeLabel").textContent = rates ? "Average borrow rate" : "Borrow fee";
  // Familiar starting values for each collateral type.
  const defs = isRWA() ? ["10000", "5000"] : isNative() ? ["5", "4000"] : ["6", "6000"];
  input("openColl").value = defs[0];
  input("openDebt").value = defs[1];
  updateSimControls();
}

export async function refresh(): Promise<boolean> {
  if (!state.networkReady || !state.dep || !state.provider) return false;
  const { C } = state;
  try {
    const me = myAddr();
    const p = await C.priceFeed.getPrice();
    const [tcr, recovery, supply, nTroves, spTotal, rate,
           ethBal, orusdBal, oraBal, wstBal, trove, entire,
           spDep, spEth, spOra, stake, totalStaked, stkEth, stkOrusd,
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
      C.staking.totalLQTYStaked(),
      C.staking.getPendingETHGain(me),
      C.staking.getPendingLUSDGain(me),
      C.priceFeed.oracleLive(),
      C.aggRate ? C.priceFeed.getStEthEthRate() : [0n, true],
      isRWA() ? C.priceFeed.navShock() : false
    ]);

    state.price = Number(ethers.formatEther(p));
    state.borrowingRate = rate;
    state.nativeBalance = state.wallet ? ethBal : 0n;
    state.collateralBalance = state.wallet ? (C.collToken ? wstBal : ethBal) : 0n;
    state.orUsdBalance = state.wallet ? orusdBal : 0n;
    state.position = trove.status === 1n
      ? { collateral: entire[1] as bigint, debt: entire[0] as bigint }
      : null;
    state.oracleLive = Boolean(oracleLive);
    state.navShock = Boolean(navShock);
    state.recoveryMode = Boolean(recovery);
    state.lastRefreshError = null;

    $("stEthPrice").textContent = fmtUsd(p);
    $("borrowMarketPrice").textContent = fmtUsd(p) + (isRWA() ? " NAV-linked" : "");
    $("openCollBalance").textContent = state.wallet ? `${fmt(state.collateralBalance, 4)} ${collSym()}` : "Connect wallet";
    $("adjCollBalance").textContent = state.wallet ? `${fmt(state.collateralBalance, 4)} ${collSym()}` : "Connect wallet";
    $("adjDebtBalance").textContent = state.wallet ? `${fmt(state.orUsdBalance)} orUSD` : "Connect wallet";
    button("btnOpenCollMax").disabled = !state.wallet || state.collateralBalance <= 0n;
    button("btnAdjCollMax").disabled = !state.wallet || state.collateralBalance <= 0n;
    button("btnAdjDebtMax").disabled = !state.wallet || state.orUsdBalance <= 0n;
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
      } catch {
        $("simSeq").textContent = "Status unavailable";
        $("simSeq").className = "warn";
      }
    }
    if (C.aggNav) {
      const nav = await C.aggNav.latestRoundData();
      $("simNav").textContent = "$" + (Number(nav[1]) / 1e8).toFixed(4);
    }

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

    const active = state.position !== null;
    $("troveNone").hidden = active;
    $("troveActive").hidden = !active;
    $("troveTitle").textContent = active ? "Your Trove" : "Open a Trove";
    $("troveEyebrow").textContent = active ? "ACTIVE POSITION" : "BORROW ORUSD";
    if (state.position) {
      const debt = state.position.debt, coll = state.position.collateral;
      const collUnits = Number(ethers.formatEther(coll));
      const debtUnits = Number(ethers.formatEther(debt));
      const icr = collUnits * state.price / debtUnits * 100;
      const liqPrice = collUnits > 0 ? debtUnits * brMcr() / collUnits : 0;
      const tier = healthTier(icr, brMcr());
      $("tvColl").textContent = fmt(coll, 4) + " " + collSym();
      $("tvDebt").textContent = fmt(debt) + " orUSD";
      $("tvIcr").textContent = Number.isFinite(icr) ? icr.toFixed(1) + "%" : "—";
      $("tvIcr").className = icrClass(icr, brMcr() * 100);
      $("tvLiq").textContent = liqPrice > 0 ? "$" + liqPrice.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—";
      updateHealthMeter("positionHealthMeter", "positionHealthFill", "positionHealthBadge", icr, brMcr());
      const riskCopy = healthExplanation(tier, icr, brMcr(), liqPrice, state.price);
      $("positionRiskMessage").textContent = riskCopy;
      const closeNeed = debt - GAS_COMP;
      const ready = orusdBal >= closeNeed;
      $("tvCloseHint").textContent = ready
        ? `Closing repays ${fmt(closeNeed)} orUSD; wallet has ${fmt(orusdBal)}.`
        : `Closing needs ${fmt(closeNeed)} orUSD; wallet is short ${fmt(closeNeed - orusdBal)}. Withdraw your Stability Pool deposit or repay the Trove first.`;
      button("btnClose").disabled = !ready;
    }
    updateOpenPreview(rate);
    updateAdjustmentPreview();
    updateHealthBanner(Boolean(oracleLive), Boolean(navShock), Boolean(recovery));

    $("spTvl").textContent = fmt(spTotal, 0) + " orUSD";
    $("spApy").textContent = "Not estimated";
    $("stTvl").textContent = fmt(totalStaked, 0) + " ORA";
    $("stApy").textContent = "Not estimated";
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
      $("svApy").textContent = svTvl > 0n
        ? (Number(aggW) * 0.8 / Number(svTvl) * 100).toFixed(2) + "%"
        : "No TVL";
      $("svPending").textContent = fmt(pend);
      $("stFee").textContent = (sysDebt > 0n ? Number(aggW) / Number(sysDebt) * 100 : 0).toFixed(2) + "%";
      await refreshLever();
    }

    await refreshTrovesTable();
    if (!(document.getElementById("viewMarkets") as HTMLElement).hidden) await refreshMarketsTable();
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = null;
    updateDataFreshness();
    return true;
  } catch (e) {
    console.error(e);
    state.lastRefreshError = reason(e);
    updateDataFreshness();
    try {
      updateOpenPreview(state.borrowingRate);
      updateAdjustmentPreview();
    } catch { /* preserve the visible stale-data warning even if a panel is unavailable */ }
    return false;
  }
}

export function riskIncreaseBlockMessage(): string | null {
  if (!hasFreshMarketData()) {
    if (state.lastRefreshError) return "Market data refresh failed; wait for a successful update.";
    if (state.lastRefreshAt === null) return "Waiting for the first successful market-data refresh.";
    return `Market data is older than ${MAX_MARKET_DATA_AGE_MS / 1000} seconds; wait for it to refresh.`;
  }
  if (state.oracleLive !== true) return "Oracle status is not live; wait for the feed to recover.";
  if (state.navShock) return "The NAV shock guard is active for this market.";
  return null;
}

function syncRiskIncreaseControls(): void {
  const block = riskIncreaseBlockMessage();
  if (!state.dep) {
    button("btnOpen").disabled = true;
    button("btnLvOpen").disabled = true;
    for (const id of ["btnAddColl", "btnWithdrawColl", "btnBorrowMore", "btnRepay"]) button(id).disabled = true;
    $("lvRiskStatus").hidden = true;
    return;
  }
  updateOpenPreview(state.borrowingRate);
  updateAdjustmentPreview();
  updatePositionHealth();
  button("btnLvOpen").disabled = !!block;
  $("lvRiskStatus").hidden = !block;
  $("lvRiskStatus").textContent = block ? `Leveraged opening is paused: ${block}` : "";
}

export function updateDataFreshness(): void {
  const freshness = $("dataFreshness");
  if (state.lastRefreshError) {
    freshness.dataset.stale = "true";
    const last = state.lastRefreshAt
      ? ` Last successful update: ${new Date(state.lastRefreshAt).toLocaleTimeString()}.`
      : " No successful update has completed yet.";
    freshness.textContent = `Could not refresh on-chain data; values may be stale.${last} ${state.lastRefreshError}`;
    updateOracleBadge();
    syncRiskIncreaseControls();
    return;
  }
  if (!hasFreshMarketData()) {
    freshness.dataset.stale = "true";
    if (state.lastRefreshAt === null) {
      freshness.textContent = "Waiting for the first successful on-chain refresh; risk-increasing actions are paused.";
    } else {
      const ageSeconds = Math.max(0, Math.ceil((Date.now() - state.lastRefreshAt) / 1000));
      freshness.textContent = `On-chain data is ${ageSeconds}s old (limit ${MAX_MARKET_DATA_AGE_MS / 1000}s); risk-increasing actions are paused until it refreshes.`;
    }
    updateOracleBadge();
    syncRiskIncreaseControls();
    return;
  }
  freshness.dataset.stale = "false";
  freshness.textContent = `On-chain data updated ${new Date(state.lastRefreshAt!).toLocaleTimeString()}.`;
  updateOracleBadge();
  syncRiskIncreaseControls();
}

function updateOracleBadge(): void {
  const badge = $("oracleBadge");
  if (!hasFreshMarketData()) {
    badge.dataset.state = "unknown";
    badge.textContent = "Oracle status unknown · data stale";
  } else if (state.navShock) {
    badge.dataset.state = "shock";
    badge.textContent = "NAV shock guard active";
  } else if (state.oracleLive === true) {
    badge.dataset.state = "live";
    badge.textContent = "Oracle live";
  } else if (state.oracleLive === false) {
    badge.dataset.state = "warning";
    badge.textContent = "Oracle degraded";
  } else {
    badge.dataset.state = "pending";
    badge.textContent = "Oracle status pending";
  }
}

export function updateHealthBanner(oracleLive: boolean, navShock: boolean, recovery: boolean): void {
  const warnings: string[] = [];
  if (!oracleLive) warnings.push("Oracle status is not live. The protocol may be using its last trusted price; avoid opening or withdrawing collateral until the feed recovers.");
  if (navShock) warnings.push("The NAV shock guard is active for this market. Review the displayed collateral price before acting.");
  if (recovery) warnings.push("The protocol is in Recovery Mode. Trove adjustments may be subject to stricter rules.");
  const banner = $("healthBanner");
  banner.hidden = warnings.length === 0;
  banner.dataset.severity = !oracleLive || navShock ? "critical" : "warning";
  $("healthTitle").textContent = !oracleLive || navShock ? "Risk warning" : "System notice";
  $("healthMessage").textContent = warnings.join(" ");
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
  const coll = Number(input("openColl").value);
  const borrow = Number(input("openDebt").value);
  const ratePct = Number(input("openRate").value);
  const rates = isRates();
  const feeRate = rates ? 0n : rate ?? state.borrowingRate ?? 5n * 10n ** 15n;
  const price = state.price;
  const calculation = calculateOpenPreview(coll, borrow, feeRate, price, brMcr());
  const { fee, totalDebt, icr, liquidationPrice } = calculation;
  const hasAmounts = Number.isFinite(coll) && coll > 0 && Number.isFinite(borrow) && borrow >= 1800;
  const hasProjection = Number.isFinite(coll) && coll >= 0 && Number.isFinite(borrow) && borrow > 0;
  const inputsValid = hasAmounts;
  const rateValid = !rates || (Number.isFinite(ratePct) && ratePct >= 0.5 && ratePct <= 100);
  const balanceEnough = !state.wallet || coll <= Number(ethers.formatEther(state.collateralBalance));
  const riskBlock = riskIncreaseBlockMessage();
  const riskGateOpen = riskBlock === null;
  const healthValid = price > 0 && icr >= brMcr() * 100;
  const canOpen = inputsValid && rateValid && balanceEnough && healthValid && riskGateOpen;
  const displayTier = hasProjection && price > 0 && riskGateOpen ? calculation.risk : "unknown";
  const preview = $("openPreview");
  button("btnOpen").disabled = !canOpen;

  const severity = !riskGateOpen || price <= 0 || !inputsValid || !rateValid || !balanceEnough
    ? "warning" : calculation.risk;
  preview.dataset.severity = severity === "safe" ? "normal" : severity;
  updateHealthMeter("openHealthMeter", "openHealthFill", "openRiskBadge", icr, brMcr(), displayTier);
  if (riskBlock) $("openRiskBadge").textContent = "Paused";
  $("openFee").textContent = rates ? "No upfront fee" : borrow > 0 ? `${displayEstimate(fee)} orUSD` : "—";
  $("openTotalDebt").textContent = borrow > 0 ? `${displayEstimate(totalDebt)} orUSD` : "—";
  $("openIcr").textContent = price > 0 && borrow > 0 ? `${displayEstimate(icr, 1)}%` : "—";
  $("openLiq").textContent = liquidationPrice > 0 ? `$${displayEstimate(liquidationPrice)}` : "—";

  let message = hasProjection && price > 0
    ? healthExplanation(calculation.risk, icr, brMcr(), liquidationPrice, price)
    : price <= 0 ? "Waiting for a valid market price; opening remains disabled."
      : "Enter collateral and borrow amounts to preview position health.";
  if (rates && rateValid && hasProjection) {
    message += ` Selected interest rate: ${ratePct}% per year; interest accrues over time.`;
  }
  if (borrow > 0 && borrow < 1800) message += " Minimum borrow is 1,800 orUSD.";
  if (!rateValid) message += " Interest rate must be between 0.5% and 100% per year.";
  if (!balanceEnough) message += " Collateral amount exceeds the available wallet balance.";
  if (riskBlock) {
    if (hasProjection && price > 0) message = `Last-known estimate: ${message} ${riskBlock} Opening is paused.`;
    else message += ` ${riskBlock} Opening is paused.`;
  }
  $("openRiskCopy").textContent = message;
  const cap = Number(bcfg().debtCap || 0);
  const feeNote = rates
    ? "No upfront borrowing fee. Estimated initial debt includes the 200 orUSD gas compensation; interest accrues at the selected rate."
    : "Estimated debt includes the borrowing fee and 200 orUSD gas compensation.";
  $("openFeeNote").textContent = cap > 0
    ? `${feeNote} This market has a ${cap.toLocaleString("en-US")} orUSD debt cap.`
    : feeNote;
}

function displayEstimate(value: number, decimals = 2): string {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: decimals })
    : "—";
}

export function updateAdjustmentPreview(): void {
  const results = $("adjustmentResults");
  if (!state.position || !(state.price > 0)) {
    results.textContent = "Waiting for a Trove and valid market price to calculate projections.";
    for (const id of ["btnAddColl", "btnWithdrawColl", "btnBorrowMore", "btnRepay"]) button(id).disabled = true;
    return;
  }

  const collateralAmount = Number(input("adjCollAmount").value);
  const debtAmount = Number(input("adjDebtAmount").value);
  const collateral = Number(ethers.formatEther(state.position.collateral));
  const debt = Number(ethers.formatEther(state.position.debt));
  const feeRate = Number(state.borrowingRate) / 1e18;
  const collateralProjections = adjustmentPreviews(collateral, debt, collateralAmount, state.price, feeRate, isRates(), brMcr());
  const debtProjections = adjustmentPreviews(collateral, debt, debtAmount, state.price, feeRate, isRates(), brMcr());
  const riskBlock = riskIncreaseBlockMessage();
  const rows = [
    { key: "add", button: "btnAddColl", title: `Add ${collSym()}`, amount: collateralAmount, projections: collateralProjections },
    { key: "withdraw", button: "btnWithdrawColl", title: `Withdraw ${collSym()}`, amount: collateralAmount, projections: collateralProjections },
    { key: "borrow", button: "btnBorrowMore", title: "Borrow orUSD", amount: debtAmount, projections: debtProjections },
    { key: "repay", button: "btnRepay", title: "Repay orUSD", amount: debtAmount, projections: debtProjections },
  ] as const;
  results.replaceChildren();
  for (const row of rows) {
    const projection = row.projections[row.key];
    const riskIncreasing = row.key === "withdraw" || row.key === "borrow";
    const riskGateClosed = riskIncreasing && !!riskBlock;
    const amount = row.amount;
    const amountValid = Number.isFinite(amount) && amount > 0;
    button(row.button).disabled = !projection.executable || riskGateClosed;

    const card = document.createElement("article");
    card.className = "adjustment-result";
    card.dataset.risk = amountValid && !riskBlock ? projection.risk : "unknown";
    const unit = row.key === "add" || row.key === "withdraw" ? collSym() : "orUSD";
    const delta = row.key === "add" || row.key === "borrow" ? "+" : "−";
    const feeHint = row.key === "borrow" && !isRates() ? " + fee" : "";
    const title = document.createElement("strong");
    title.textContent = `${row.title} (${delta}${displayEstimate(amount)} ${unit}${feeHint})`;
    const balances = document.createElement("p");
    balances.textContent = `After: ${displayEstimate(projection.collateral, 4)} ${collSym()} collateral · ${displayEstimate(projection.debt)} orUSD debt`;
    const health = document.createElement("p");
    health.className = "result-health";
    health.textContent = `Ratio ${displayEstimate(projection.icr, 1)}% · liquidation price $${displayEstimate(projection.liquidationPrice)}`;
    const reasonText = document.createElement("p");
    reasonText.className = "result-reason";
    reasonText.textContent = riskGateClosed
      ? `${riskBlock} This risk-increasing action is paused.`
      : riskBlock ? `Projection uses the last known market price. ${riskBlock}`
        : projection.reason;
    card.append(title, balances, health, reasonText);
    results.appendChild(card);
  }
}

export async function refreshMarketsTable(): Promise<void> {
  const tbody = $("marketTable").querySelector("tbody") as HTMLElement;
  if (!state.dep || !state.provider || !state.networkReady) {
    tbody.replaceChildren();
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "Market data is unavailable until a network is connected.";
    row.appendChild(cell);
    tbody.appendChild(row);
    $("marketDirectoryStatus").textContent = "No network data";
    return;
  }

  $("marketDirectoryStatus").textContent = "Refreshing on-chain market data…";
  const deployment = state.dep;
  const results = await Promise.all(Object.entries(deployment.branches).map(async ([key, branch]) => {
    const tmAbi = branch.rates ? deployment.abis.troveManagerRates
      : branch.native ? deployment.abis.troveManager
        : (deployment.abis.troveManagerV2 || deployment.abis.troveManager);
    const feedAbi = branch.native ? deployment.abis.priceFeed
      : branch.rwa ? deployment.abis.priceFeedRWA : deployment.abis.priceFeedWstETH;
    try {
      const manager = new ethers.Contract(branch.troveManager, tmAbi, provider());
      const feed = new ethers.Contract(branch.priceFeed, feedAbi, provider());
      const [debt, live, price] = await Promise.all([
        manager.getEntireSystemDebt(), feed.oracleLive(), feed.getPrice(),
      ]);
      return { key, branch, debt: debt as bigint, live: Boolean(live), price: price as bigint, error: false };
    } catch {
      return { key, branch, debt: null, live: null, price: null, error: true };
    }
  }));

  tbody.replaceChildren();
  let unavailable = 0;
  for (const result of results) {
    const { key, branch } = result;
    if (result.error) unavailable++;
    const row = document.createElement("tr");
    row.dataset.current = String(key === state.branch);
    if (key === state.branch) row.classList.add("is-current");

    const market = document.createElement("td");
    market.dataset.label = "Market";
    const marketName = document.createElement("span");
    marketName.className = "market-name";
    marketName.textContent = branch.collSymbol;
    const marketSub = document.createElement("small");
    marketSub.textContent = key === branch.collSymbol ? key : `${key} market`;
    const price = document.createElement("small");
    price.className = "market-price-note";
    price.textContent = result.price === null ? "Price unavailable" : fmtUsd(result.price);
    market.append(marketName, marketSub, price);

    const oracle = document.createElement("td");
    oracle.dataset.label = "Oracle";
    const oraclePill = document.createElement("span");
    oraclePill.className = "market-status";
    oraclePill.dataset.status = result.live === null ? "unknown" : result.live ? "live" : "degraded";
    oraclePill.textContent = result.live === null ? "Unavailable" : result.live ? "Live" : "Degraded";
    oracle.appendChild(oraclePill);

    const mcr = document.createElement("td");
    mcr.dataset.label = "MCR";
    mcr.textContent = `${((Number(branch.mcr) || 1.1) * 100).toFixed(0)}%`;

    const debt = document.createElement("td");
    debt.dataset.label = "Total debt";
    debt.textContent = result.debt === null ? "Unavailable" : `${fmt(result.debt, 0)} orUSD`;

    const cap = document.createElement("td");
    cap.dataset.label = "Debt cap";
    const debtCap = Number(branch.debtCap || 0);
    cap.textContent = debtCap > 0 ? `${debtCap.toLocaleString("en-US")} orUSD` : "No cap";

    row.append(market, oracle, mcr, debt, cap);
    tbody.appendChild(row);
  }
  $("marketDirectoryStatus").textContent = unavailable
    ? `${results.length} markets · ${unavailable} data source${unavailable === 1 ? "" : "s"} unavailable`
    : `${results.length} markets · on-chain data`;
}

export async function refreshTrovesTable(): Promise<void> {
  const { C } = state;
  const rows = await C.multiGetter.getMultipleSortedTroves(0, state.troveRows);
  $("btnMoreTroves").hidden = rows.length < state.troveRows;
  const tbody = $("trovesTable").querySelector("tbody") as HTMLElement;
  tbody.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No open Troves in this market yet.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }
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
    const ownerCell = document.createElement("td");
    ownerCell.dataset.label = "Owner";
    ownerCell.title = owner;
    ownerCell.append(document.createTextNode(`${short(owner)}${owner === myAddr() ? " (you)" : ""}`));
    if (rowRates) {
      const rate = document.createElement("span");
      rate.className = "hint trove-rate";
      rate.textContent = `@ ${(Number(rowRates[ri]) / 1e16).toFixed(1)}%`;
      ownerCell.appendChild(rate);
    }
    const collateralCell = document.createElement("td");
    collateralCell.dataset.label = "Collateral";
    collateralCell.textContent = `${fmt(coll, 3)} ${collSym()}`;
    const debtCell = document.createElement("td");
    debtCell.dataset.label = "Debt";
    debtCell.textContent = `${fmt(debt, 0)} orUSD`;
    const ratioCell = document.createElement("td");
    ratioCell.dataset.label = "Collateral ratio";
    ratioCell.className = liq ? "bad" : icr < brMcr() * 100 + 40 ? "warn" : "good";
    ratioCell.textContent = `${icr.toFixed(1)}%`;
    const actionsCell = document.createElement("td");
    actionsCell.dataset.label = "Actions";
    const liquidate = document.createElement("button");
    liquidate.className = "mini";
    liquidate.dataset.liq = owner;
    liquidate.disabled = !liq;
    liquidate.title = liq ? "Liquidate this Trove" : "Only eligible below the market minimum collateral ratio";
    liquidate.setAttribute("aria-label", `Liquidate Trove owned by ${short(owner)}`);
    liquidate.textContent = "Liquidate";
    actionsCell.appendChild(liquidate);
    if (soft) {
      const partial = document.createElement("button");
      partial.className = "mini";
      partial.dataset.softliq = owner;
      partial.title = `Partial liquidation: restores the Trove to ${(brMcr() * 100).toFixed(0)}% at a 3% premium`;
      partial.setAttribute("aria-label", `Soft-liquidate Trove owned by ${short(owner)}`);
      partial.textContent = "Soft-liq";
      actionsCell.appendChild(partial);
    }
    tr.append(ownerCell, collateralCell, debtCell, ratioCell, actionsCell);
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
