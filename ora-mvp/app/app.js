/* ORA Protocol — testnet MVP frontend (ethers v6, served locally) */
"use strict";

const $ = id => document.getElementById(id);
const Z = "0x0000000000000000000000000000000000000000";
const MAX_FEE = ethers.parseEther("0.05"); // 5% max fee tolerance
const GAS_COMP = 200n * 10n ** 18n;        // 200 orUSD gas compensation
const MCR = 1.1;

// Well-known hardhat testnet keys (public, demo only)
const ACCOUNTS = {
  alice:  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bob:    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  carol:  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
};
const TREASURY_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

let provider, wallet, treasury, dep, C = {}, price = 0, busy = false;

const fmt = (v, d = 2) =>
  Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: d });
const fmtUsd = (v, d = 2) => "$" + fmt(v, d);
const short = a => a.slice(0, 6) + "…" + a.slice(-4);

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
  const A = dep.addresses, B = dep.abis;
  C.priceFeed = new ethers.Contract(A.priceFeed, B.priceFeed, signer);
  C.troveManager = new ethers.Contract(A.troveManager, B.troveManager, signer);
  C.borrowerOps = new ethers.Contract(A.borrowerOperations, B.borrowerOperations, signer);
  C.stabilityPool = new ethers.Contract(A.stabilityPool, B.stabilityPool, signer);
  C.orUSD = new ethers.Contract(A.orUSDToken, B.orUSDToken, signer);
  C.ora = new ethers.Contract(A.oraToken, B.oraToken, signer);
  C.staking = new ethers.Contract(A.oraStaking, B.oraStaking, signer);
  C.multiGetter = new ethers.Contract(A.multiTroveGetter, B.multiTroveGetter, signer);
}

function setAccount(name) {
  const w = new ethers.Wallet(ACCOUNTS[name], provider);
  wallet = new ethers.NonceManager(w);
  wallet.address = w.address; // convenience for display/lookups
  connectContracts(wallet);
  $("addr").textContent = w.address;
}

async function refresh() {
  try {
    const me = wallet.address;
    const [p, tcr, recovery, supply, nTroves, spTotal, rate,
           ethBal, orusdBal, oraBal, trove, entire,
           spDep, spEth, spOra, stake, stkEth, stkOrusd] = await Promise.all([
      C.priceFeed.getPrice(),
      C.troveManager.getTCR(await C.priceFeed.getPrice()),
      C.troveManager.checkRecoveryMode(await C.priceFeed.getPrice()),
      C.orUSD.totalSupply(),
      C.troveManager.getTroveOwnersCount(),
      C.stabilityPool.getTotalLUSDDeposits(),
      C.troveManager.getBorrowingRateWithDecay(),
      provider.getBalance(me),
      C.orUSD.balanceOf(me),
      C.ora.balanceOf(me),
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

    // Stats bar
    $("stEthPrice").textContent = fmtUsd(p);
    $("stTcr").textContent = nTroves > 0n ? (Number(tcr) / 1e16).toFixed(1) + "%" : "—";
    $("stMode").textContent = recovery ? "RECOVERY" : "Normal";
    $("stMode").className = recovery ? "bad" : "good";
    $("stSupply").textContent = fmt(supply, 0) + " orUSD";
    $("stTroves").textContent = nTroves.toString();
    $("stSp").textContent = fmt(spTotal, 0) + " orUSD";
    $("stFee").textContent = (Number(rate) / 1e16).toFixed(2) + "%";
    $("simPrice").textContent = fmtUsd(p);

    // Balances
    $("balEth").textContent = fmt(ethBal) + " ETH";
    $("balOrusd").textContent = fmt(orusdBal) + " orUSD";
    $("balOra").textContent = fmt(oraBal) + " ORA";

    // Trove panel
    const active = trove.status === 1n;
    $("troveNone").style.display = active ? "none" : "block";
    $("troveActive").style.display = active ? "block" : "none";
    if (active) {
      const debt = entire[0], coll = entire[1];
      const icr = Number(coll) * price / Number(debt) * 100;
      const liqPrice = Number(ethers.formatEther(debt)) * MCR / Number(ethers.formatEther(coll));
      $("tvColl").textContent = fmt(coll, 4) + " ETH";
      $("tvDebt").textContent = fmt(debt) + " orUSD";
      $("tvIcr").textContent = icr.toFixed(1) + "%";
      $("tvIcr").className = icr < 120 ? "bad" : icr < 150 ? "warn" : "good";
      $("tvLiq").textContent = "$" + liqPrice.toLocaleString("en-US", { maximumFractionDigits: 2 });
    }
    updateOpenPreview(rate);

    // Stability pool
    $("spDeposit").textContent = fmt(spDep) + " orUSD";
    $("spEthGain").textContent = fmt(spEth, 5) + " ETH";
    $("spOraGain").textContent = fmt(spOra, 3) + " ORA";
    $("spShare").textContent = spTotal > 0n
      ? (Number(spDep) / Number(spTotal) * 100).toFixed(2) + "%" : "0%";

    // Staking
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
      `<td>${fmt(coll, 3)} ETH</td><td>${fmt(debt, 0)} orUSD</td>` +
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

  $("accountSelect").addEventListener("change", e => { setAccount(e.target.value); refresh(); });
  ["openColl", "openDebt"].forEach(id => $(id).addEventListener("input", () => updateOpenPreview()));

  $("btnOpen").addEventListener("click", () =>
    tx("Open Trove", () => C.borrowerOps.openTrove(
      MAX_FEE, ethers.parseEther($("openDebt").value || "0"), Z, Z,
      { value: ethers.parseEther($("openColl").value || "0") })));

  const adj = () => ethers.parseEther($("adjAmount").value || "0");
  $("btnAddColl").addEventListener("click", () =>
    tx("Add collateral", () => C.borrowerOps.addColl(Z, Z, { value: adj() })));
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
      tx(`Set ETH price to $${newPrice.toFixed(0)}`,
        () => C.priceFeed.setPrice(ethers.parseEther(newPrice.toFixed(6))));
    }));
  $("btnSetPrice").addEventListener("click", () => {
    const v = parseFloat($("simInput").value);
    if (!v || v <= 0) return toast("Enter a valid price");
    tx(`Set ETH price to $${v}`, () => C.priceFeed.setPrice(ethers.parseEther(String(v))));
  });

  await refresh();
  setInterval(() => { if (!busy) refresh(); }, 8000);
}

main().catch(e => toast("Init failed: " + reason(e), 10000));
