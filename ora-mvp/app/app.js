/* ORA Protocol frontend:
 * multi-branch (ETH + wstETH + mTBILL RWA) · Chainlink/NAV oracle adapters
 * with depeg CB + NAV shock breaker · per-branch staking, ORA rewards,
 * soft liquidations · network switcher: local chain / Base Sepolia (MetaMask) */
"use strict";

const $ = id => document.getElementById(id);
const Z = "0x0000000000000000000000000000000000000000";
const MAX_FEE = ethers.parseEther("0.05");
const MCR = 1.1;

const BASE_SEPOLIA = {
  chainIdHex: "0x14a34", // 84532
  rpc: "https://sepolia.base.org",
  explorer: "https://sepolia.basescan.org"
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

const fmt = (v, d = 2) =>
  Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: d });
const fmtUsd = (v, d = 2) => "$" + fmt(v, d);
const short = a => a.slice(0, 6) + "…" + a.slice(-4);
const isNative = () => dep.branches[branch].native;
const collSym = () => dep.branches[branch].collSymbol;
const bcfg = () => dep.branches[branch];
const isRWA = () => !!dep.branches[branch].rwa;
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
  return match ? match[1] : m.slice(0, 140);
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
  C.troveManager = new ethers.Contract(
    B.troveManager, B.native ? A.troveManager : (A.troveManagerV2 || A.troveManager), runner);
  C.borrowerOps = new ethers.Contract(
    B.borrowerOperations, B.native ? A.borrowerOperations : A.borrowerOperationsERC20, runner);
  C.stabilityPool = new ethers.Contract(
    B.stabilityPool, B.native ? A.stabilityPool : A.stabilityPoolERC20, runner);
  C.multiGetter = new ethers.Contract(B.multiTroveGetter, A.multiTroveGetter, runner);
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
  $("btnWstFaucet").style.display = isNative() ? "none" : "inline-block";
  $("btnWstFaucet").textContent = `Get ${Number(faucetAmt()).toLocaleString("en-US")} test ${collSym()}`;
  $("balWst").style.display = isNative() ? "none" : "inline";
  $("depegRow").style.display = !isNative() && bcfg().stEthEthAggregator ? "flex" : "none";
  $("navRow").style.display = isRWA() ? "flex" : "none";
  $("priceRow").style.display = isRWA() ? "none" : "flex";
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
    const local = mode !== "baseSepolia";
    if (!local) {
      const r = await fetch("deployment-baseSepolia.json?ts=" + Date.now());
      if (!r.ok) {
        toast("Base Sepolia not deployed yet — run the DEPLOY_BASE_SEPOLIA.md runbook, commit deployment-baseSepolia.json, and reload.", 9000);
        $("networkSelect").value = netMode;
        return;
      }
      dep = await r.json();
      netMode = "baseSepolia";
      provider = new ethers.JsonRpcProvider(BASE_SEPOLIA.rpc, 84532, { staticNetwork: true });
      wallet = null; treasury = null;
      $("accountSelect").style.display = "none";
      $("btnConnect").style.display = "inline-block";
      $("btnFaucet").disabled = true;
      $("addr").textContent = "read-only — connect a wallet to transact";
    } else {
      dep = await (await fetch("deployment.json?ts=" + Date.now())).json();
      netMode = "local";
      provider = new ethers.JsonRpcProvider(location.origin + "/rpc", undefined, { staticNetwork: true });
      treasury = new ethers.NonceManager(new ethers.Wallet(TREASURY_KEY, provider));
      $("accountSelect").style.display = "inline-block";
      $("btnConnect").style.display = "none";
      $("btnFaucet").disabled = false;
    }

    // Guard against stale/partial deployment files (e.g. cached from an older
    // phase, or a public deployment made before newer branches existed).
    if (!dep || !dep.branches || !dep.abis || !dep.shared) {
      throw new Error("deployment file is invalid or from an old build — hard-refresh the page (Ctrl/Cmd+Shift+R)");
    }
    // Only show tabs for branches this deployment actually has
    document.querySelectorAll(".tab").forEach(t =>
      (t.style.display = dep.branches[t.dataset.branch] ? "" : "none"));
    if (!dep.branches[branch]) branch = Object.keys(dep.branches)[0];

    if (local) setAccount($("accountSelect").value);
    setBranch(dep.branches.ETH ? "ETH" : Object.keys(dep.branches)[0]);
    await refresh();
  } catch (e) {
    toast("Network switch failed: " + reason(e), 8000);
  }
}

async function connectWallet() {
  if (!window.ethereum) return toast("No wallet extension found — install MetaMask (or a compatible wallet) to use Base Sepolia.", 8000);
  try {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_SEPOLIA.chainIdHex }]
      });
    } catch (err) {
      if (err.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: BASE_SEPOLIA.chainIdHex,
            chainName: "Base Sepolia",
            rpcUrls: [BASE_SEPOLIA.rpc],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: [BASE_SEPOLIA.explorer]
          }]
        });
      } else { throw err; }
    }
    const bp = new ethers.BrowserProvider(window.ethereum);
    await bp.send("eth_requestAccounts", []);
    const signer = await bp.getSigner();
    signer.address = await signer.getAddress();
    provider = bp;
    wallet = signer;
    connectContracts();
    $("addr").textContent = wallet.address;
    $("btnConnect").textContent = short(wallet.address);
    toast("✓ Wallet connected to Base Sepolia");
    await refresh();
  } catch (e) {
    toast("Wallet connection failed: " + reason(e), 8000);
  }
}

// Ensure the branch BorrowerOperations may pull our collateral tokens
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

    // Oracle status badge (depeg judged client-side from the live rate)
    const rateNum = C.aggRate ? Number(ethers.formatEther(stRate[0])) : 1;
    const depeg = !!C.aggRate && stRate[1] && rateNum < 0.96;
    $("stOracle").textContent = !oracleLive ? "FALLBACK"
      : navShock ? "NAV SHOCK" : depeg ? "DEPEG CB"
      : isRWA() ? "NAV feed ✓" : "Chainlink ✓";
    $("stOracle").className = !oracleLive ? "warn" : (navShock || depeg) ? "bad" : "good";
    if (C.aggRate) $("simRate").textContent = rateNum.toFixed(3);
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
      const liqPrice = Number(ethers.formatEther(debt)) * MCR / Number(ethers.formatEther(coll));
      $("tvColl").textContent = fmt(coll, 4) + " " + collSym();
      $("tvDebt").textContent = fmt(debt) + " orUSD";
      $("tvIcr").textContent = icr.toFixed(1) + "%";
      $("tvIcr").className = icr < 120 ? "bad" : icr < 150 ? "warn" : "good";
      $("tvLiq").textContent = "$" + liqPrice.toLocaleString("en-US", { maximumFractionDigits: 2 });
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

    await refreshTrovesTable();
  } catch (e) {
    console.error(e);
  }
}

function updateOpenPreview(rate) {
  const coll = parseFloat($("openColl").value) || 0;
  const borrow = parseFloat($("openDebt").value) || 0;
  const fee = borrow * Number(rate ?? 5n * 10n ** 15n) / 1e18;
  const totalDebt = borrow + fee + 200;
  const icr = totalDebt > 0 ? (coll * price / totalDebt) * 100 : 0;
  const cls = icr < 120 ? "bad" : icr < 150 ? "warn" : "good";
  $("openPreview").innerHTML =
    `Fee: <b>${fee.toFixed(2)} orUSD</b> · Total debt (incl. 200 gas comp): <b>${totalDebt.toFixed(2)} orUSD</b><br/>` +
    `Collateral ratio: <b class="${cls}">${icr.toFixed(1)}%</b> — liquidation below 110%` +
    (borrow < 1800 ? ' · <span class="bad">minimum borrow is 1,800 orUSD</span>' : "") +
    (bcfg().debtCap ? ` · isolated branch: debt cap ${Number(bcfg().debtCap).toLocaleString("en-US")} orUSD` : "");
}

async function refreshTrovesTable() {
  const rows = await C.multiGetter.getMultipleSortedTroves(0, 50);
  const tbody = $("trovesTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    const owner = r[0], debt = r[1], coll = r[2];
    const icr = Number(coll) * price / Number(debt) * 100;
    const liq = icr < MCR * 100;
    // Phase 2 (non-ETH branches): troves in the soft band [105%, 110%) can be
    // partially liquidated at a 3% premium instead of fully at ~10%
    const soft = !isNative() && liq && icr >= 105;
    const tr = document.createElement("tr");
    if (liq) tr.className = "liq";
    tr.innerHTML =
      `<td title="${owner}">${short(owner)}${owner === myAddr() ? " (you)" : ""}</td>` +
      `<td>${fmt(coll, 3)} ${collSym()}</td><td>${fmt(debt, 0)} orUSD</td>` +
      `<td class="${liq ? "bad" : icr < 150 ? "warn" : "good"}">${icr.toFixed(1)}%</td>` +
      `<td><button class="mini" data-liq="${owner}" ${liq ? "" : "disabled"}>Liquidate</button>` +
      (soft ? ` <button class="mini" data-softliq="${owner}" title="Partial liquidation: restores the trove to 110% at a 3% premium">Soft-liq</button>` : "") +
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
    t.addEventListener("click", () => { setBranch(t.dataset.branch); refresh(); }));
  ["openColl", "openDebt"].forEach(id => $(id).addEventListener("input", () => updateOpenPreview()));

  $("btnWstFaucet").addEventListener("click", () =>
    tx(collSym() + " faucet", () => C.collToken.faucet(ethers.parseEther(faucetAmt()))));

  $("btnOpen").addEventListener("click", async () => {
    const coll = ethers.parseEther($("openColl").value || "0");
    const debt = ethers.parseEther($("openDebt").value || "0");
    if (isNative()) {
      tx("Open Trove", () => C.borrowerOps.openTrove(MAX_FEE, debt, Z, Z, { value: coll }));
    } else {
      if (!wallet) return toast("Connect a wallet first");
      try { await ensureAllowance(coll); } catch (e) { return toast("Approve failed: " + reason(e), 8000); }
      tx("Open Trove", () => C.borrowerOps.openTrove(MAX_FEE, debt, coll, Z, Z));
    }
  });

  const adj = () => ethers.parseEther($("adjAmount").value || "0");
  $("btnAddColl").addEventListener("click", async () => {
    if (isNative()) {
      tx("Add collateral", () => C.borrowerOps.addColl(Z, Z, { value: adj() }));
    } else {
      if (!wallet) return toast("Connect a wallet first");
      try { await ensureAllowance(adj()); } catch (e) { return toast("Approve failed: " + reason(e), 8000); }
      tx("Add collateral", () => C.borrowerOps.addColl(adj(), Z, Z));
    }
  });
  $("btnWithdrawColl").addEventListener("click", () =>
    tx("Withdraw collateral", () => C.borrowerOps.withdrawColl(adj(), Z, Z)));
  $("btnBorrowMore").addEventListener("click", () =>
    tx("Borrow orUSD", () => C.borrowerOps.withdrawLUSD(MAX_FEE, adj(), Z, Z)));
  $("btnRepay").addEventListener("click", () =>
    tx("Repay orUSD", () => C.borrowerOps.repayLUSD(adj(), Z, Z)));
  $("btnClose").addEventListener("click", () =>
    tx("Close Trove", () => C.borrowerOps.closeTrove()));

  const spAmt = () => ethers.parseEther($("spAmount").value || "0");
  $("btnSpDeposit").addEventListener("click", () =>
    tx("Stability deposit", () => C.stabilityPool.provideToSP(spAmt(), Z)));
  $("btnSpWithdraw").addEventListener("click", () =>
    tx("Stability withdrawal", () => C.stabilityPool.withdrawFromSP(spAmt())));

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
