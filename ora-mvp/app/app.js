/* ORA Protocol frontend:
 * multi-branch (ETH + wstETH + mTBILL RWA) · Chainlink/NAV oracle adapters
 * with depeg CB + NAV shock breaker · per-branch staking, ORA rewards,
 * soft liquidations · network switcher: local chain / Base Sepolia (MetaMask) */
"use strict";

const $ = id => document.getElementById(id);
const Z = "0x0000000000000000000000000000000000000000";
const MAX_FEE = ethers.parseEther("0.05");
const GAS_COMP = ethers.parseEther("200"); // refunded on close — repay = debt − 200
// Per-branch risk params (from deployment.json): the RWA T-bill branch runs
// MCR 105% / CCR 115% with a [103%, 105%) soft-liq band; others 110%/150%.
const brMcr = () => Number(bcfg().mcr) || 1.1;
const brSoft = () => Number(bcfg().softFloor) || 1.05;
const icrClass = icr => icr < brMcr() * 100 + 10 ? "bad" : icr < brMcr() * 100 + 40 ? "warn" : "good";

// Network registry. `testnet` gates simulators/faucets; `local` additionally
// enables the built-in demo accounts. Mainnet entries are wallet-only and
// show no test tooling at all.
const NETWORKS = {
  local: { label: "Local demo chain", testnet: true, local: true, file: "deployment.json" },
  baseSepolia: {
    label: "Base Sepolia", testnet: true, local: false, file: "deployment-baseSepolia.json",
    chainIdHex: "0x14a34", chainName: "Base Sepolia", rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org"
  },
  base: {
    label: "Base", testnet: false, local: false, file: "deployment-base.json",
    chainIdHex: "0x2105", chainName: "Base", rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org"
  }
};

// Well-known hardhat testnet keys (public, local demo only)
const ACCOUNTS = {
  alice:  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bob:    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  carol:  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
};
const TREASURY_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

let provider, wallet = null, treasury = null, dep, C = {}, price = 0, busy = false;
let branch = "ETH";
let netMode = "local";
let troveRows = 50; // risky-troves pagination window
const curNet = () => NETWORKS[netMode];

const fmt = (v, d = 2) =>
  Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: d });
const fmtUsd = (v, d = 2) => "$" + fmt(v, d);
const short = a => a.slice(0, 6) + "…" + a.slice(-4);
const isNative = () => dep.branches[branch].native;
const collSym = () => dep.branches[branch].collSymbol;
const bcfg = () => dep.branches[branch];
const isRWA = () => !!dep.branches[branch].rwa;
const isRates = () => !!dep.branches[branch].rates;
const faucetAmt = () => bcfg().faucetAmount || "10";
const myAddr = () => wallet ? wallet.address : Z;

function toast(msg, ms = 4200) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.style.display = "none"), ms);
}

function reason(e) {
  const m = e?.info?.error?.message || e?.shortMessage || e?.message || String(e);
  const match = m.match(/reverted with reason string '([^']+)'/);
  return rebrand(match ? match[1] : m.slice(0, 140));
}

// Contracts keep upstream Liquity identifiers verbatim (audit-diff stays
// minimal), so on-chain revert strings say LUSD/LQTY — translate any message
// to ORA branding before a user ever sees it.
function rebrand(s) {
  return String(s)
    .replace(/LUSD/g, "orUSD")
    .replace(/LQTY/g, "ORA")
    .replace(/Liquity/g, "ORA");
}

/* Pre-flight simulation: every write is eth_call'd first, so a doomed tx is
 * rejected with the DECODED revert reason before the wallet ever prompts for
 * a signature (and before any gas is spent). Non-revert simulation hiccups
 * (RPC blips, missing state) never block sending. */
function guardSigner(signer, prov) {
  if (signer.__oraGuarded) return signer;
  const orig = signer.sendTransaction.bind(signer);
  signer.sendTransaction = async (txReq) => {
    try {
      await prov.call({ ...txReq, from: signer.address });
    } catch (e) {
      if (e && (e.code === "CALL_EXCEPTION" || e.data)) {
        throw new Error("rejected in pre-flight simulation — " + reason(e));
      }
      // anything else: let the real send decide
    }
    return orig(txReq);
  };
  signer.__oraGuarded = true;
  return signer;
}

async function tx(label, fn) {
  if (!wallet) return toast("Connect a wallet first");
  if (busy) return;
  busy = true;
  try {
    toast(label + " — sending transaction…", 60000);
    const t = await fn();
    await t.wait();
    toast("✓ " + label + " confirmed");
    await refresh();
  } catch (e) {
    toast("✗ " + label + " failed: " + reason(e), 8000);
  } finally {
    busy = false;
  }
}

function connectContracts() {
  const runner = wallet ?? provider;
  const B = bcfg(), S = dep && dep.shared, A = dep && dep.abis;
  if (!B || !S || !A) {
    toast("Deployment data is stale or missing — hard-refresh the page (Ctrl/Cmd+Shift+R)", 8000);
    return;
  }
  C.priceFeed = new ethers.Contract(
    B.priceFeed, B.native ? A.priceFeed : (B.rwa ? A.priceFeedRWA : A.priceFeedWstETH), runner);
  C.aggNav = B.navAggregator
    ? new ethers.Contract(B.navAggregator, A.settableAggregator, runner) : null;
  C.aggEth = B.ethUsdSettable
    ? new ethers.Contract(B.ethUsdAggregator, A.settableAggregator, runner) : null;
  C.aggRate = B.stEthEthAggregator
    ? new ethers.Contract(B.stEthEthAggregator, A.settableAggregator, runner) : null;
  C.aggSeq = dep.shared && dep.shared.sequencerSettable && dep.shared.sequencerUptimeFeed !== Z
    ? new ethers.Contract(dep.shared.sequencerUptimeFeed, A.settableAggregator, runner) : null;
  C.troveManager = new ethers.Contract(
    B.troveManager, B.rates ? A.troveManagerRates
      : B.native ? A.troveManager : (A.troveManagerV2 || A.troveManager), runner);
  C.borrowerOps = new ethers.Contract(
    B.borrowerOperations, B.rates ? A.borrowerOperationsRates
      : B.native ? A.borrowerOperations : A.borrowerOperationsERC20, runner);
  C.stabilityPool = new ethers.Contract(
    B.stabilityPool, B.rates ? A.stabilityPoolRates
      : B.native ? A.stabilityPool : A.stabilityPoolERC20, runner);
  C.multiGetter = new ethers.Contract(B.multiTroveGetter, A.multiTroveGetter, runner);
  C.sortedTroves = new ethers.Contract(B.sortedTroves, A.sortedTroves, runner);
  C.hintHelpers = new ethers.Contract(B.hintHelpers, B.rates ? A.hintHelpersRates : A.hintHelpers, runner);
  // Rates engine extras (ETH v2 branch)
  C.vault = B.sorUSDVault ? new ethers.Contract(B.sorUSDVault, A.sorUSDVault, runner) : null;
  C.router = B.interestRouter ? new ethers.Contract(B.interestRouter, A.interestRouter, runner) : null;
  C.zapFactory = B.leverZapFactory && A.leverZapFactory
    ? new ethers.Contract(B.leverZapFactory, A.leverZapFactory, runner) : null;
  C.swapPool = B.swapPool && A.oraSwapPool
    ? new ethers.Contract(B.swapPool, A.oraSwapPool, runner) : null;
  C.collToken = B.native ? null
    : new ethers.Contract(B.collToken, B.rwa ? A.mockTBill : A.mockWstETH, runner);
  C.orUSD = new ethers.Contract(S.orUSDToken, A.orUSDToken, runner);
  C.ora = new ethers.Contract(S.oraToken, A.oraToken, runner);
  // Phase 2: each branch has its own staking pool — ETH branch uses the classic
  // LQTYStaking (native ETH gains), other branches use BranchStaking (ERC20 gains).
  C.branchStakingMode = !B.native && !!B.branchStaking;
  C.staking = C.branchStakingMode
    ? new ethers.Contract(B.branchStaking, A.branchStaking, runner)
    : new ethers.Contract(S.oraStaking, A.oraStaking, runner);
}

function setAccount(name) {
  const w = new ethers.Wallet(ACCOUNTS[name], provider);
  wallet = new ethers.NonceManager(w);
  wallet.address = w.address;
  guardSigner(wallet, provider);
  connectContracts();
  $("addr").textContent = w.address;
}

function setBranch(name) {
  if (!dep || !dep.branches) return;
  if (!dep.branches[name]) name = Object.keys(dep.branches)[0];
  branch = name;
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.branch === name));
  document.querySelectorAll(".collsym").forEach(el => (el.textContent = collSym()));
  const testnet = curNet().testnet;
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
  $("openColl").value = defs[0];
  $("openDebt").value = defs[1];
  updateSimControls();
  connectContracts();
}

function updateSimControls() {
  const settable = !!bcfg().ethUsdSettable;
  document.querySelectorAll("#priceRow button, #priceRow input").forEach(el => (el.disabled = !settable));
  $("simNote").style.display = settable || isRWA() ? "none" : "inline";
}

async function setNetwork(mode) {
  try {
    const net = NETWORKS[mode] || NETWORKS.local;
    if (!net.local) {
      const r = await fetch(net.file + "?ts=" + Date.now());
      if (!r.ok) {
        toast(net.label + " not deployed yet — run the deployment runbook, commit " + net.file + ", and reload.", 9000);
        $("networkSelect").value = netMode;
        return;
      }
      dep = await r.json();
      netMode = mode;
      provider = new ethers.JsonRpcProvider(net.rpc, parseInt(net.chainIdHex, 16), { staticNetwork: true });
      wallet = null; treasury = null;
      $("accountSelect").style.display = "none";
      $("btnConnect").style.display = "inline-block";
      $("addr").textContent = "read-only — connect a wallet to transact";
    } else {
      dep = await (await fetch(net.file + "?ts=" + Date.now())).json();
      netMode = mode;
      provider = new ethers.JsonRpcProvider(location.origin + "/rpc", undefined, { staticNetwork: true });
      treasury = new ethers.NonceManager(new ethers.Wallet(TREASURY_KEY, provider));
      $("accountSelect").style.display = "inline-block";
      $("btnConnect").style.display = "none";
    }
    // The ORA faucet is a local-chain treasury transfer only
    $("btnFaucet").disabled = !net.local;
    $("faucetRow").style.display = net.local ? "" : "none";

    // Guard against stale/partial deployment files (e.g. cached from an older
    // phase, or a public deployment made before newer branches existed).
    if (!dep || !dep.branches || !dep.abis || !dep.shared) {
      throw new Error("deployment file is invalid or from an old build — hard-refresh the page (Ctrl/Cmd+Shift+R)");
    }
    // Only show tabs for branches this deployment actually has
    document.querySelectorAll(".tab").forEach(t =>
      (t.style.display = dep.branches[t.dataset.branch] ? "" : "none"));
    if (!dep.branches[branch]) branch = Object.keys(dep.branches)[0];

    if (net.local) setAccount($("accountSelect").value);
    setBranch(dep.branches.ETH ? "ETH" : Object.keys(dep.branches)[0]);
    await refresh();
  } catch (e) {
    toast("Network switch failed: " + reason(e), 8000);
  }
}

/* EIP-6963 multi-wallet discovery: every installed browser wallet announces
 * itself (MetaMask, Rabby, Coinbase Wallet, Trust…); the user picks one.
 * Falls back to the legacy window.ethereum injection. */
const discoveredWallets = [];
window.addEventListener("eip6963:announceProvider", (e) => {
  try {
    if (!e.detail || !e.detail.info) return;
    if (discoveredWallets.some(w => w.info.uuid === e.detail.info.uuid)) return;
    discoveredWallets.push(e.detail);
    const sel = $("walletSelect");
    if (!sel) return;
    sel.innerHTML = discoveredWallets
      .map((w, i) => `<option value="${i}">${w.info.name}</option>`).join("");
    sel.style.display = discoveredWallets.length > 1 && $("btnConnect").style.display !== "none"
      ? "inline-block" : "none";
  } catch {}
});
try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch {}

function pickedEip1193() {
  if (discoveredWallets.length > 0) {
    const i = parseInt($("walletSelect").value || "0", 10) || 0;
    return (discoveredWallets[i] || discoveredWallets[0]).provider;
  }
  return window.ethereum || null;
}

async function connectWallet() {
  const net = curNet();
  const injected = pickedEip1193();
  if (!injected) return toast(`No wallet extension found — install MetaMask (or a compatible wallet) to use ${net.label}.`, 8000);
  try {
    try {
      await injected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: net.chainIdHex }]
      });
    } catch (err) {
      if (err.code === 4902) {
        await injected.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: net.chainIdHex,
            chainName: net.chainName,
            rpcUrls: [net.rpc],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: [net.explorer]
          }]
        });
      } else { throw err; }
    }
    const bp = new ethers.BrowserProvider(injected);
    await bp.send("eth_requestAccounts", []);
    const signer = await bp.getSigner();
    signer.address = await signer.getAddress();
    guardSigner(signer, bp);
    provider = bp;
    wallet = signer;
    connectContracts();
    $("addr").textContent = wallet.address;
    $("btnConnect").textContent = short(wallet.address);
    toast("✓ Wallet connected to " + curNet().label);
    await refresh();
  } catch (e) {
    toast("Wallet connection failed: " + reason(e), 8000);
  }
}

// Ensure the branch BorrowerOperations may pull our collateral tokens
/* ---------- sorted-troves hints ----------
 * With address(0) hints SortedTroves walks the whole list on-chain — fine
 * with 10 troves, ruinous gas with thousands. Compute a near-exact insert
 * position off-chain first (free view calls), as mainnet frontends must. */
async function getInsertHints(newColl, newDebt) {
  try {
    if (newDebt <= 0n || newColl <= 0n) return [Z, Z];
    const nicr = (newColl * 10n ** 20n) / newDebt; // NICR is 1e20-scaled
    const size = await C.sortedTroves.getSize();
    if (size <= 1n) return [Z, Z];
    const trials = BigInt(Math.min(15 * Math.ceil(Math.sqrt(Number(size))), 3000));
    const [approx] = await C.hintHelpers.getApproxHint(nicr, trials, 42n);
    const pos = await C.sortedTroves.findInsertPosition(nicr, approx, approx);
    return [pos[0], pos[1]];
  } catch (e) {
    console.warn("hint computation failed, falling back to zero hints", e);
    return [Z, Z]; // contracts still succeed, just cost more gas
  }
}

// Rates branch: the sorted list is keyed by annual interest rate.
async function rateInsertHints(rateWei) {
  try {
    const size = await C.sortedTroves.getSize();
    if (size <= 1n) return [Z, Z];
    const trials = BigInt(Math.min(15 * Math.ceil(Math.sqrt(Number(size))), 3000));
    const [approx] = await C.hintHelpers.getApproxHint(rateWei, trials, 42n);
    const pos = await C.sortedTroves.findInsertPosition(rateWei, approx, approx);
    return [pos[0], pos[1]];
  } catch (e) {
    console.warn("rate hint computation failed, falling back to zero hints", e);
    return [Z, Z];
  }
}

// Hints for adjusting the caller's existing trove by (dColl, dDebt) deltas.
async function adjustHints(dColl, dDebt) {
  // Rates branch: adjustments don't change the rate, so the trove never moves
  // in the list — no hints needed at all.
  if (isRates()) return [Z, Z];
  const e = await C.troveManager.getEntireDebtAndColl(myAddr());
  return getInsertHints(e[1] + dColl, e[0] + dDebt);
}

// Net debt increase for a borrow: amount + borrowing fee (with decay).
async function borrowWithFee(amount) {
  const rate = await C.troveManager.getBorrowingRateWithDecay();
  return amount + (amount * rate) / 10n ** 18n;
}

async function ensureAllowance(needed) {
  const allowance = await C.collToken.allowance(myAddr(), bcfg().borrowerOperations);
  if (allowance < needed) {
    toast("Approving " + collSym() + "…", 30000);
    const t = await C.collToken.approve(bcfg().borrowerOperations, ethers.MaxUint256);
    await t.wait();
  }
}

async function refresh() {
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
      provider.getBalance(me === Z ? bcfg().troveManager : me),
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

    price = Number(ethers.formatEther(p));

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
      } catch {}
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

    $("balEth").textContent = wallet ? fmt(ethBal) + " ETH" : "—";
    $("balOrusd").textContent = fmt(orusdBal) + " orUSD";
    $("balOra").textContent = fmt(oraBal) + " ORA";
    if (C.collToken) $("balWst").textContent = fmt(wstBal) + " " + collSym();

    const active = trove.status === 1n;
    $("troveNone").style.display = active ? "none" : "block";
    $("troveActive").style.display = active ? "block" : "none";
    if (active) {
      const debt = entire[0], coll = entire[1];
      const icr = Number(coll) * price / Number(debt) * 100;
      const liqPrice = Number(ethers.formatEther(debt)) * brMcr() / Number(ethers.formatEther(coll));
      $("tvColl").textContent = fmt(coll, 4) + " " + collSym();
      $("tvDebt").textContent = fmt(debt) + " orUSD";
      $("tvIcr").textContent = icr.toFixed(1) + "%";
      $("tvIcr").className = icrClass(icr);
      $("tvLiq").textContent = "$" + liqPrice.toLocaleString("en-US", { maximumFractionDigits: 2 });
      // Close readiness: full debt minus the refunded 200 orUSD gas comp
      const closeNeed = debt - GAS_COMP;
      const ready = orusdBal >= closeNeed;
      $("tvCloseHint").innerHTML = ready
        ? `close repays <b>${fmt(closeNeed)} orUSD</b> — wallet has ${fmt(orusdBal)} <span class="good">✓</span>`
        : `close repays <b>${fmt(closeNeed)} orUSD</b> — wallet has ${fmt(orusdBal)} ` +
          `(<span class="bad">short ${fmt(closeNeed - orusdBal)}</span>: withdraw your SP deposit or repay partially)`;
      $("btnClose").disabled = !ready;
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
      const [myRate, aggW, sysDebt, svP, svTvl, svShares, pend] = await Promise.all([
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

// Leverage Zapper (rates branch): per-user proxy owns the leveraged trove
async function myZap() {
  if (!C.zapFactory || !wallet) return null;
  const addr = await C.zapFactory.zapOf(myAddr());
  if (addr === Z) return null;
  return new ethers.Contract(addr, dep.abis.leverZap, wallet);
}

async function refreshLever() {
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
      const icr = Number(coll) * price / Number(debt) * 100;
      $("lvPos").textContent = fmt(coll, 3) + " ETH @ " + (Number(pos[2]) / 1e16).toFixed(1) + "%";
      $("lvDebt").textContent = fmt(debt) + " orUSD";
      $("lvIcr").textContent = icr.toFixed(1) + "%";
      $("lvIcr").className = icrClass(icr);
    } else {
      $("lvPos").textContent = "none";
      $("lvDebt").textContent = "—";
      $("lvIcr").textContent = "—";
      $("lvIcr").className = "";
    }
  } catch (e) { console.error(e); }
}

function updateOpenPreview(rate) {
  const coll = parseFloat($("openColl").value) || 0;
  const borrow = parseFloat($("openDebt").value) || 0;
  const fee = borrow * Number(rate ?? 5n * 10n ** 15n) / 1e18;
  const totalDebt = borrow + fee + 200;
  const icr = totalDebt > 0 ? (coll * price / totalDebt) * 100 : 0;
  const cls = icrClass(icr);
  const ratePct = parseFloat($("openRate").value) || 0;
  $("openPreview").innerHTML =
    (isRates()
      ? `Interest: <b>≈${(totalDebt * ratePct / 100).toFixed(0)} orUSD/yr</b> at ${ratePct}%/yr (no upfront fee) · Total debt (incl. 200 gas comp): <b>${totalDebt.toFixed(2)} orUSD</b><br/>`
      : `Fee: <b>${fee.toFixed(2)} orUSD</b> · Total debt (incl. 200 gas comp): <b>${totalDebt.toFixed(2)} orUSD</b><br/>`) +
    `Collateral ratio: <b class="${cls}">${icr.toFixed(1)}%</b> — liquidation below ${(brMcr() * 100).toFixed(0)}%` +
    (borrow < 1800 ? ' · <span class="bad">minimum borrow is 1,800 orUSD</span>' : "") +
    (bcfg().debtCap ? ` · isolated branch: debt cap ${Number(bcfg().debtCap).toLocaleString("en-US")} orUSD` : "");
}

async function refreshTrovesTable() {
  const rows = await C.multiGetter.getMultipleSortedTroves(0, troveRows);
  $("btnMoreTroves").style.display = rows.length >= troveRows ? "inline-block" : "none";
  const tbody = $("trovesTable").querySelector("tbody");
  tbody.innerHTML = "";
  const rowRates = isRates()
    ? await Promise.all(rows.map(r => C.troveManager.troveAnnualRate(r[0]).catch(() => 0n)))
    : null;
  let ri = -1;
  for (const r of rows) {
    ri++;
    const owner = r[0], debt = r[1], coll = r[2];
    const icr = Number(coll) * price / Number(debt) * 100;
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
  tbody.querySelectorAll("button[data-liq]").forEach(b =>
    b.addEventListener("click", () =>
      tx("Liquidate " + short(b.dataset.liq), () => C.troveManager.liquidate(b.dataset.liq)))
  );
  tbody.querySelectorAll("button[data-softliq]").forEach(b =>
    b.addEventListener("click", () =>
      tx("Soft-liquidate " + short(b.dataset.softliq), () => C.troveManager.liquidatePartial(b.dataset.softliq)))
  );
}

/* ---------- wire up UI ---------- */
async function main() {
  await setNetwork("local");

  $("networkSelect").addEventListener("change", e => setNetwork(e.target.value));
  $("btnConnect").addEventListener("click", connectWallet);
  $("accountSelect").addEventListener("change", e => { setAccount(e.target.value); refresh(); });
  document.querySelectorAll(".tab").forEach(t =>
    t.addEventListener("click", () => { troveRows = 50; setBranch(t.dataset.branch); refresh(); }));
  $("btnMoreTroves").addEventListener("click", () => { troveRows += 50; refreshTrovesTable(); });
  ["openColl", "openDebt", "openRate"].forEach(id => $(id).addEventListener("input", () => updateOpenPreview()));

  $("btnWstFaucet").addEventListener("click", () =>
    tx(collSym() + " faucet", () => C.collToken.faucet(ethers.parseEther(faucetAmt()))));

  $("btnOpen").addEventListener("click", async () => {
    const coll = ethers.parseEther($("openColl").value || "0");
    const debt = ethers.parseEther($("openDebt").value || "0");
    if (!wallet) return toast("Connect a wallet first");
    if (isRates()) {
      const pct = parseFloat($("openRate").value || "0");
      if (!(pct >= 0.5 && pct <= 100)) return toast("Interest rate must be between 0.5 and 100 %/yr");
      const rateWei = ethers.parseEther((pct / 100).toFixed(18));
      tx("Open Trove @ " + pct + "%", async () => {
        const [up, low] = await rateInsertHints(rateWei);
        return C.borrowerOps.openTroveWithRate(debt, rateWei, up, low, { value: coll });
      });
    } else if (isNative()) {
      tx("Open Trove", async () => {
        const [up, low] = await getInsertHints(coll, (await borrowWithFee(debt)) + GAS_COMP);
        return C.borrowerOps.openTrove(MAX_FEE, debt, up, low, { value: coll });
      });
    } else {
      try { await ensureAllowance(coll); } catch (e) { return toast("Approve failed: " + reason(e), 8000); }
      tx("Open Trove", async () => {
        const [up, low] = await getInsertHints(coll, (await borrowWithFee(debt)) + GAS_COMP);
        return C.borrowerOps.openTrove(MAX_FEE, debt, coll, up, low);
      });
    }
  });

  const adj = () => ethers.parseEther($("adjAmount").value || "0");
  $("btnAddColl").addEventListener("click", async () => {
    if (!wallet) return toast("Connect a wallet first");
    if (isNative()) {
      tx("Add collateral", async () => {
        const [up, low] = await adjustHints(adj(), 0n);
        return C.borrowerOps.addColl(up, low, { value: adj() });
      });
    } else {
      try { await ensureAllowance(adj()); } catch (e) { return toast("Approve failed: " + reason(e), 8000); }
      tx("Add collateral", async () => {
        const [up, low] = await adjustHints(adj(), 0n);
        return C.borrowerOps.addColl(adj(), up, low);
      });
    }
  });
  $("btnWithdrawColl").addEventListener("click", () =>
    tx("Withdraw collateral", async () => {
      const [up, low] = await adjustHints(-adj(), 0n);
      return C.borrowerOps.withdrawColl(adj(), up, low);
    }));
  $("btnBorrowMore").addEventListener("click", () =>
    tx("Borrow orUSD", async () => {
      const [up, low] = await adjustHints(0n, await borrowWithFee(adj()));
      return C.borrowerOps.withdrawLUSD(MAX_FEE, adj(), up, low);
    }));
  $("btnRepay").addEventListener("click", () =>
    tx("Repay orUSD", async () => {
      const [up, low] = await adjustHints(0n, -adj());
      return C.borrowerOps.repayLUSD(adj(), up, low);
    }));
  $("btnClose").addEventListener("click", async () => {
    if (!wallet) return toast("Connect a wallet first");
    // Pre-check: closing repays the full debt (minus the 200 orUSD gas comp)
    // from the wallet — fail with a helpful message instead of a revert.
    try {
      const [entire, bal] = await Promise.all([
        C.troveManager.getEntireDebtAndColl(myAddr()),
        C.orUSD.balanceOf(myAddr())
      ]);
      const need = entire[0] - GAS_COMP;
      if (bal < need) {
        return toast(
          `Closing this Trove needs ${fmt(need)} orUSD in your wallet — you have ${fmt(bal)} ` +
          `(short ${fmt(need - bal)}). Withdraw your Stability Pool deposit, use Repay to shrink ` +
          `the debt first, or fund this account with orUSD from another one.`, 12000);
      }
    } catch { /* fall through — let the chain report */ }
    tx("Close Trove", () => C.borrowerOps.closeTrove());
  });

  // Rates branch: change your interest rate (7-day cooldown on-chain)
  $("btnRate").addEventListener("click", () => {
    if (!wallet) return toast("Connect a wallet first");
    const pct = parseFloat($("newRate").value || "0");
    if (!(pct >= 0.5 && pct <= 100)) return toast("Interest rate must be between 0.5 and 100 %/yr");
    const rateWei = ethers.parseEther((pct / 100).toFixed(18));
    tx("Change rate to " + pct + "%", async () => {
      const [up, low] = await rateInsertHints(rateWei);
      return C.borrowerOps.adjustTroveRate(rateWei, up, low);
    });
  });

  // Redemption: the $1 hard-peg floor. Burns orUSD against the riskiest
  // troves at face value (minus the redemption fee). Full hint pipeline.
  $("btnRedeem").addEventListener("click", () => {
    const amt = ethers.parseEther($("redeemAmount").value || "0");
    if (amt === 0n) return toast("Enter an orUSD amount to redeem");
    if (isRates()) {
      // Rate-ordered redemption: no reinsertion ever happens, so no hints needed.
      return tx("Redeem orUSD", () =>
        C.troveManager.redeemCollateral(amt, Z, Z, Z, 0, 0, MAX_FEE));
    }
    tx("Redeem orUSD", async () => {
      const p = await C.priceFeed.getPrice();
      const [first, partialNICR, truncated] = await C.hintHelpers.getRedemptionHints(amt, p, 0);
      if (truncated === 0n) throw new Error("nothing redeemable at this amount");
      let up = Z, low = Z;
      try {
        const size = await C.sortedTroves.getSize();
        const trials = BigInt(Math.min(15 * Math.ceil(Math.sqrt(Number(size))), 3000));
        const [approx] = await C.hintHelpers.getApproxHint(partialNICR, trials, 42n);
        [up, low] = await C.sortedTroves.findInsertPosition(partialNICR, approx, approx);
      } catch { /* zero hints still work, just cost more gas */ }
      if (truncated < amt) toast(`Redeeming ${fmt(truncated)} orUSD (amount truncated to full troves)`, 6000);
      return C.troveManager.redeemCollateral(truncated, first, up, low, partialNICR, 0, MAX_FEE);
    });
  });

  const spAmt = () => ethers.parseEther($("spAmount").value || "0");
  $("btnSpDeposit").addEventListener("click", () =>
    tx("Stability deposit", () => C.stabilityPool.provideToSP(spAmt(), Z)));
  $("btnSpWithdraw").addEventListener("click", () =>
    tx("Stability withdrawal", () => C.stabilityPool.withdrawFromSP(spAmt())));

  // sorUSD savings vault (rates branch)
  const svAmt = () => ethers.parseEther($("svAmount").value || "0");
  $("btnSvDeposit").addEventListener("click", async () => {
    if (!wallet) return toast("Connect a wallet first");
    tx("sorUSD deposit", async () => {
      const need = svAmt();
      const allowance = await C.orUSD.allowance(myAddr(), bcfg().sorUSDVault);
      if (allowance < need) {
        toast("Approving orUSD…", 30000);
        await (await C.orUSD.approve(bcfg().sorUSDVault, ethers.MaxUint256)).wait();
      }
      return C.vault.deposit(need);
    });
  });
  $("btnSvWithdraw").addEventListener("click", () => {
    if (!wallet) return toast("Connect a wallet first");
    tx("sorUSD withdraw", async () => {
      const sh = await C.vault.balanceOf(myAddr());
      if (sh === 0n) throw new Error("no sorUSD shares to withdraw");
      return C.vault.redeem(sh);
    });
  });
  $("btnSvRoute").addEventListener("click", () => {
    if (!wallet) return toast("Connect a wallet first");
    tx("Route interest", async () => {
      const p = await C.router.pending();
      if (p === 0n) throw new Error("nothing pending — interest lands in the router whenever a trove is touched (or poke accrueTroveInterest)");
      return C.router.distribute();
    });
  });

  // Leverage zapper (rates branch)
  $("btnLvOpen").addEventListener("click", async () => {
    if (!wallet) return toast("Connect a wallet first");
    const collEth = parseFloat($("lvColl").value) || 0;
    const ltvBps = BigInt($("lvLev").value);
    const ratePct = parseFloat($("lvRate").value) || 5;
    const firstBorrow = collEth * price * Number(ltvBps) / 10000;
    if (firstBorrow < 1800) {
      return toast(`Deposit too small — the first loop must borrow ≥ 1,800 orUSD (needs ≈ ${(1800 * 10000 / Number(ltvBps) / price).toFixed(2)} ETH at this leverage)`, 8000);
    }
    let zap = await myZap();
    if (!zap) {
      await tx("Create your personal leverage Zap", () => C.zapFactory.createZap());
      zap = await myZap();
      if (!zap) return;
    }
    const lev = (10000 / (10000 - Number(ltvBps))).toFixed(1);
    tx(`Open ~${lev}× leverage with ${collEth} ETH`, () =>
      zap.leverOpen(ethers.parseEther((ratePct / 100).toFixed(6)), ltvBps, 6n,
        { value: ethers.parseEther(String(collEth)) }));
  });
  $("btnLvClose").addEventListener("click", async () => {
    if (!wallet) return toast("Connect a wallet first");
    const zap = await myZap();
    if (!zap) return toast("No leverage position to close");
    tx("Close & unwind leveraged position", () => zap.leverClose());
  });

  const stkAmt = () => ethers.parseEther($("stkInput").value || "0");
  $("btnStake").addEventListener("click", () =>
    tx("Stake ORA", async () => {
      const amt = stkAmt();
      // BranchStaking pulls ORA via transferFrom — approve once if needed
      if (C.branchStakingMode) {
        const allowance = await C.ora.allowance(myAddr(), C.staking.target);
        if (allowance < amt) await (await C.ora.approve(C.staking.target, ethers.MaxUint256)).wait();
      }
      return C.staking.stake(amt);
    }));
  $("btnUnstake").addEventListener("click", () =>
    tx("Unstake ORA", () => C.staking.unstake(stkAmt())));
  $("btnFaucet").addEventListener("click", () => {
    if (!treasury) return toast("ORA faucet is local-testnet only — earn ORA via the ETH-branch Stability Pool on public nets.", 7000);
    tx("ORA faucet", () => C.ora.connect(treasury).transfer(myAddr(), ethers.parseEther("100")));
  });

  // Market simulator: ETH/USD (settable aggregator only)
  const setEthUsd = async v =>
    tx(`Set ETH/USD to $${v.toFixed(0)}`, () => C.aggEth.setAnswer(BigInt(Math.round(v * 1e8))));
  document.querySelectorAll("button[data-bump]").forEach(b =>
    b.addEventListener("click", async () => {
      if (!C.aggEth) return toast("Live Chainlink feed — not settable");
      const rd = await C.aggEth.latestRoundData();
      setEthUsd(Number(rd[1]) / 1e8 * (1 + Number(b.dataset.bump) / 100));
    }));
  $("btnSetPrice").addEventListener("click", () => {
    if (!C.aggEth) return toast("Live Chainlink feed — not settable");
    const v = parseFloat($("simInput").value);
    if (!v || v <= 0) return toast("Enter a valid price");
    setEthUsd(v);
  });

  // NAV simulator (RWA branch): accrue yield, spike (clamped), break the buck
  document.querySelectorAll("button[data-nav]").forEach(b =>
    b.addEventListener("click", () => {
      if (!C.aggNav) return;
      const v = b.dataset.nav;
      tx(v === "reset" ? "Reset NAV to $1.05" : "Set NAV ×" + v, async () => {
        let target = 105000000n; // $1.05, 8 decimals
        if (v !== "reset") {
          const rd = await C.aggNav.latestRoundData();
          target = BigInt(Math.round(Number(rd[1]) * Number(v)));
        }
        await (await C.aggNav.setAnswer(target)).wait();
        return C.priceFeed.fetchPrice(); // apply clamp / shock breaker on-chain
      });
    }));

  // Sequencer outage simulator (local mock uptime feed)
  document.querySelectorAll("button[data-seq]").forEach(b =>
    b.addEventListener("click", () => {
      if (!C.aggSeq) return;
      const mode = b.dataset.seq;
      const label = mode === "halt" ? "Halt L2 sequencer"
        : mode === "restart" ? "Restart sequencer (grace starts)" : "Skip the 1h restart grace";
      tx(label, async () => {
        if (mode === "halt") { await (await C.aggSeq.setAnswer(1n)).wait(); }
        else if (mode === "restart") { await (await C.aggSeq.setAnswer(0n)).wait(); }
        else { await (await C.aggSeq.makeStale(2 * 3600)).wait(); }
        return C.priceFeed.fetchPrice(); // apply the guard on-chain
      });
    }));

  // Depeg simulator: stETH/ETH rate (always settable on testnets)
  document.querySelectorAll("button[data-rate]").forEach(b =>
    b.addEventListener("click", () => {
      if (!C.aggRate) return;
      const r = b.dataset.rate;
      tx(`Set stETH/ETH rate to ${r}`, async () => {
        await (await C.aggRate.setAnswer(ethers.parseEther(r))).wait();
        return C.priceFeed.fetchPrice(); // trip/reset the on-chain circuit breaker
      });
    }));

  setInterval(() => { if (!busy) refresh(); }, 8000);
}

main().catch(e => toast("Init failed: " + reason(e), 10000));
