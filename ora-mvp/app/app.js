/* ORA Protocol — Phase 1 frontend: multi-branch (ETH + wstETH) */
"use strict";

const $ = id => document.getElementById(id);
const Z = "0x0000000000000000000000000000000000000000";
const MAX_FEE = ethers.parseEther("0.05");
const MCR = 1.1;

// Well-known hardhat testnet keys (public, demo only)
const ACCOUNTS = {
  alice:  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bob:    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  carol:  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
};
const TREASURY_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

let provider, wallet, treasury, dep, C = {}, price = 0, busy = false;
let branch = "ETH";

const fmt = (v, d = 2) =>
  Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: d });
const fmtUsd = (v, d = 2) => "$" + fmt(v, d);
const short = a => a.slice(0, 6) + "…" + a.slice(-4);
const isNative = () => dep.branches[branch].native;
const collSym = () => dep.branches[branch].collSymbol;

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

function connectContracts(signer) {
  const B = dep.branches[branch], S = dep.shared, A = dep.abis;
  C.priceFeed = new ethers.Contract(B.priceFeed, A.priceFeed, signer);
  C.troveManager = new ethers.Contract(B.troveManager, A.troveManager, signer);
  C.borrowerOps = new ethers.Contract(
    B.borrowerOperations,
    B.native ? A.borrowerOperations : A.borrowerOperationsERC20,
    signer);
  C.stabilityPool = new ethers.Contract(
    B.stabilityPool,
    B.native ? A.stabilityPool : A.stabilityPoolERC20,
    signer);
  C.multiGetter = new ethers.Contract(B.multiTroveGetter, A.multiTroveGetter, signer);
  C.collToken = B.native ? null : new ethers.Contract(B.collToken, A.mockWstETH, signer);
  C.orUSD = new ethers.Contract(S.orUSDToken, A.orUSDToken, signer);
  C.ora = new ethers.Contract(S.oraToken, A.oraToken, signer);
  C.staking = new ethers.Contract(S.oraStaking, A.oraStaking, signer);
}

function setAccount(name) {
  const w = new ethers.Wallet(ACCOUNTS[name], provider);
  wallet = new ethers.NonceManager(w);
  wallet.address = w.address;
  connectContracts(wallet);
  $("addr").textContent = w.address;
}

function setBranch(name) {
  branch = name;
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.branch === name));
  document.querySelectorAll(".collsym").forEach(el => (el.textContent = collSym()));
  $("btnWstFaucet").style.display = isNative() ? "none" : "inline-block";
  $("balWst").style.display = isNative() ? "none" : "inline";
  connectContracts(wallet);
}

// Ensure the branch BorrowerOperations may pull our collateral tokens
async function ensureAllowance(needed) {
  const allowance = await C.collToken.allowance(wallet.address, dep.branches[branch].borrowerOperations);
  if (allowance < needed) {
    toast("Approving " + collSym() + "…", 30000);
    const t = await C.collToken.approve(dep.branches[branch].borrowerOperations, ethers.MaxUint256);
    await t.wait();
  }
}

async function refresh() {
  try {
    const me = wallet.address;
    const p = await C.priceFeed.getPrice();
    const [tcr, recovery, supply, nTroves, spTotal, rate,
           ethBal, orusdBal, oraBal, wstBal, trove, entire,
           spDep, spEth, spOra, stake, stkEth, stkOrusd] = await Promise.all([
      C.troveManager.getTCR(p),
      C.troveManager.checkRecoveryMode(p),
      C.orUSD.totalSupply(),
      C.troveManager.getTroveOwnersCount(),
      C.stabilityPool.getTotalLUSDDeposits(),
      C.troveManager.getBorrowingRateWithDecay(),
      provider.getBalance(me),
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
      C.staking.getPendingLUSDGain(me)
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
    $("simPrice").textContent = fmtUsd(p);

    $("balEth").textContent = fmt(ethBal) + " ETH";
    $("balOrusd").textContent = fmt(orusdBal) + " orUSD";
    $("balOra").textContent = fmt(oraBal) + " ORA";
    if (C.collToken) $("balWst").textContent = fmt(wstBal) + " wstETH";

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
    $("spOraGain").textContent = isNative() ? fmt(spOra, 3) + " ORA" : "— (Phase 2)";
    $("spShare").textContent = spTotal > 0n
      ? (Number(spDep) / Number(spTotal) * 100).toFixed(2) + "%" : "0%";

    $("stkAmount").textContent = fmt(stake) + " ORA";
    $("stkEth").textContent = fmt(stkEth, 5) + " ETH";
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
    (borrow < 1800 ? ' · <span class="bad">minimum borrow is 1,800 orUSD</span>' : "");
}

async function refreshTrovesTable() {
  const rows = await C.multiGetter.getMultipleSortedTroves(0, 50);
  const tbody = $("trovesTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    const owner = r[0], debt = r[1], coll = r[2];
    const icr = Number(coll) * price / Number(debt) * 100;
    const liq = icr < MCR * 100;
    const tr = document.createElement("tr");
    if (liq) tr.className = "liq";
    tr.innerHTML =
      `<td title="${owner}">${short(owner)}${owner === wallet.address ? " (you)" : ""}</td>` +
      `<td>${fmt(coll, 3)} ${collSym()}</td><td>${fmt(debt, 0)} orUSD</td>` +
      `<td class="${liq ? "bad" : icr < 150 ? "warn" : "good"}">${icr.toFixed(1)}%</td>` +
      `<td><button class="mini" data-liq="${owner}" ${liq ? "" : "disabled"}>Liquidate</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button[data-liq]").forEach(b =>
    b.addEventListener("click", () =>
      tx("Liquidate " + short(b.dataset.liq), () => C.troveManager.liquidate(b.dataset.liq)))
  );
}

/* ---------- wire up UI ---------- */
async function main() {
  provider = new ethers.JsonRpcProvider(location.origin + "/rpc", undefined, { staticNetwork: true });
  dep = await (await fetch("deployment.json")).json();
  treasury = new ethers.NonceManager(new ethers.Wallet(TREASURY_KEY, provider));
  setAccount("alice");
  setBranch("ETH");

  $("accountSelect").addEventListener("change", e => { setAccount(e.target.value); refresh(); });
  document.querySelectorAll(".tab").forEach(t =>
    t.addEventListener("click", () => { setBranch(t.dataset.branch); refresh(); }));
  ["openColl", "openDebt"].forEach(id => $(id).addEventListener("input", () => updateOpenPreview()));

  $("btnWstFaucet").addEventListener("click", () =>
    tx("wstETH faucet", () => C.collToken.faucet(ethers.parseEther("10"))));

  $("btnOpen").addEventListener("click", async () => {
    const coll = ethers.parseEther($("openColl").value || "0");
    const debt = ethers.parseEther($("openDebt").value || "0");
    if (isNative()) {
      tx("Open Trove", () => C.borrowerOps.openTrove(MAX_FEE, debt, Z, Z, { value: coll }));
    } else {
      try { await ensureAllowance(coll); } catch (e) { return toast("Approve failed: " + reason(e), 8000); }
      tx("Open Trove", () => C.borrowerOps.openTrove(MAX_FEE, debt, coll, Z, Z));
    }
  });

  const adj = () => ethers.parseEther($("adjAmount").value || "0");
  $("btnAddColl").addEventListener("click", async () => {
    if (isNative()) {
      tx("Add collateral", () => C.borrowerOps.addColl(Z, Z, { value: adj() }));
    } else {
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
    tx("Stake ORA", () => C.staking.stake(stkAmt())));
  $("btnUnstake").addEventListener("click", () =>
    tx("Unstake ORA", () => C.staking.unstake(stkAmt())));
  $("btnFaucet").addEventListener("click", () =>
    tx("ORA faucet", () => C.ora.connect(treasury).transfer(wallet.address, ethers.parseEther("100"))));

  document.querySelectorAll("button[data-bump]").forEach(b =>
    b.addEventListener("click", () => {
      const newPrice = price * (1 + Number(b.dataset.bump) / 100);
      tx(`Set ${collSym()} price to $${newPrice.toFixed(0)}`,
        () => C.priceFeed.setPrice(ethers.parseEther(newPrice.toFixed(6))));
    }));
  $("btnSetPrice").addEventListener("click", () => {
    const v = parseFloat($("simInput").value);
    if (!v || v <= 0) return toast("Enter a valid price");
    tx(`Set ${collSym()} price to $${v}`, () => C.priceFeed.setPrice(ethers.parseEther(String(v))));
  });

  await refresh();
  setInterval(() => { if (!busy) refresh(); }, 8000);
}

main().catch(e => toast("Init failed: " + reason(e), 10000));
