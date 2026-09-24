// ORA invariant monitor — read-only health watcher for a live deployment.
// Asserts the solvency/accounting invariants that must hold at all times;
// exits 1 on any ERROR (alerting hook for CI cron), warnings don't fail.
//
//   local:        node scripts/watch-invariants.js
//   Base Sepolia: ORA_RPC_URL=https://sepolia.base.org \
//                 ORA_DEPLOYMENT=app/deployment-baseSepolia.json \
//                 node scripts/watch-invariants.js
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.ORA_RPC_URL || "http://127.0.0.1:3000/rpc";
const DEP = process.env.ORA_DEPLOYMENT || path.join(__dirname, "..", "app", "deployment.json");
const E18 = 10n ** 18n;
const f = v => Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 4 });

let errors = 0, warnings = 0;
const ok = (label, detail) => console.log(`  OK    ${label}${detail ? " — " + detail : ""}`);
const warn = (label, detail) => { warnings++; console.log(`  WARN  ${label}${detail ? " — " + detail : ""}`); };
const err = (label, detail) => { errors++; console.log(`  ERROR ${label}${detail ? " — " + detail : ""}`); };
const gate = (cond, label, detail, soft) =>
  cond ? ok(label, detail) : (soft ? warn(label, detail) : err(label, detail));

async function main() {
  if (!fs.existsSync(DEP)) {
    console.log(`deployment file not found (${DEP}) — nothing to monitor, skipping`);
    return;
  }
  const dep = JSON.parse(fs.readFileSync(DEP));
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const A = dep.abis, S = dep.shared;
  const orUSD = new ethers.Contract(S.orUSDToken, A.orUSDToken, provider);

  console.log(`ORA invariant monitor — chainId ${(await provider.getNetwork()).chainId} @ ${RPC}`);
  console.log(`deployment: ${path.basename(DEP)}\n`);

  let totalDebt = 0n;

  for (const [name, B] of Object.entries(dep.branches)) {
    console.log(`[${name}]`);
    const tm = new ethers.Contract(B.troveManager, B.rates ? A.troveManagerRates : A.troveManager, provider);
    const feedAbi = B.rwa ? (A.wtBillPriceFeed || A.priceFeedRWA) : B.native ? A.priceFeed : A.priceFeedWstETH;
    const feed = new ethers.Contract(B.priceFeed, feedAbi, provider);
    const sp = new ethers.Contract(B.stabilityPool,
      B.rates ? A.stabilityPoolRates : B.native ? A.stabilityPool : A.stabilityPoolERC20, provider);

    // 1. price sanity + oracle health
    const price = await feed.getPrice();
    gate(price > 0n, "price > 0", "$" + f(price));
    try { gate(await feed.oracleLive(), "oracle live", null, true); } catch {}
    try { if (feed.interface.getFunction("sequencerUp")) gate(await feed.sequencerUp(), "L2 sequencer up", null, true); } catch {}
    try { if (B.rwa) gate(!(await feed.navShock()), "no NAV shock", null, true); } catch {}

    // 2. solvency: TCR above water
    const nTroves = await tm.getTroveOwnersCount();
    if (nTroves > 0n) {
      const tcr = await tm.getTCR(price);
      gate(tcr > E18, "TCR > 100%", (Number(tcr) / 1e16).toFixed(1) + "%");
    } else { ok("no troves", "TCR undefined"); }

    // 3. collateral custody: book value <= actual pool balances
    const sysColl = await tm.getEntireSystemColl();
    let apBal, dpBal;
    if (B.native) {
      apBal = await provider.getBalance(B.activePool);
      dpBal = await provider.getBalance(B.defaultPool);
    } else {
      const coll = new ethers.Contract(B.collToken, A.mockWstETH, provider);
      apBal = await coll.balanceOf(B.activePool);
      dpBal = await coll.balanceOf(B.defaultPool);
    }
    gate(apBal + dpBal >= sysColl, "collateral custody covers book",
      `book ${f(sysColl)} <= actual ${f(apBal + dpBal)}`);

    // 4. Stability Pool: orUSD balance covers recorded deposits
    const spDeposits = await sp.getTotalLUSDDeposits();
    const spBal = await orUSD.balanceOf(B.stabilityPool);
    gate(spBal >= spDeposits, "SP balance covers deposits", `${f(spBal)} >= ${f(spDeposits)}`);

    const debt = await tm.getEntireSystemDebt();
    totalDebt += debt;

    // 5. branch extras
    if (B.rwa && B.underlyingToken) {
      const wt = new ethers.Contract(B.collToken, A.wtBill, provider);
      const tb = new ethers.Contract(B.underlyingToken, A.mockTBill, provider);
      const bal = await tb.balanceOf(B.collToken);
      const need = (await wt.totalSupply()) * (await wt.rate()) / E18 + (await wt.skimAccrued());
      gate(bal >= need, "wmTBILL custody invariant", `underlying ${f(bal)} >= shares*rate+skim ${f(need)}`);
      const bo = new ethers.Contract(B.borrowerOperations, A.borrowerOperationsERC20, provider);
      gate(debt <= (await bo.debtCap()), "debt under RWA cap", `${f(debt)} <= ${f(await bo.debtCap())}`);
    }
    if (B.rates) {
      const vault = new ethers.Contract(B.sorUSDVault, A.sorUSDVault, provider);
      const vAssets = await vault.totalAssets();
      const vBal = await orUSD.balanceOf(B.sorUSDVault);
      gate(vBal >= vAssets, "vault assets backed 1:1", `${f(vBal)} >= ${f(vAssets)}`);
      const agg = await tm.aggWeightedDebt();
      gate(agg <= debt, "aggWeightedDebt <= system debt (rate <= 100%)", `${f(agg)} <= ${f(debt)}`);
      if (B.swapPool) {
        const pool = new ethers.Contract(B.swapPool, A.oraSwapPool, provider);
        const [rU, rEth] = [await pool.reserveOrUSD(), await pool.reserveETH()];
        const [bU, bEth] = [await orUSD.balanceOf(B.swapPool), await provider.getBalance(B.swapPool)];
        gate(bU >= rU && bEth >= rEth, "AMM reserves backed by balances",
          `orUSD ${f(bU)}>=${f(rU)}, ETH ${f(bEth)}>=${f(rEth)}`);
      }
    }
    console.log();
  }

  // 6. global backing: total branch debt >= orUSD supply, gap = un-accrued interest
  console.log("[global]");
  const supply = await orUSD.totalSupply();
  gate(totalDebt >= supply - 10n ** 16n, "system debt covers orUSD supply",
    `debt ${f(totalDebt)} >= supply ${f(supply)}`);
  const gap = totalDebt > supply ? totalDebt - supply : 0n;
  gate(gap < supply / 100n + 10n ** 18n, "un-minted interest gap < 1% of supply",
    `${f(gap)} orUSD pending accrual`, true);

  console.log(`\n${errors} errors, ${warnings} warnings`);
  if (errors > 0) process.exit(1);
}

main().catch(e => { console.error("MONITOR FAILED:", e.shortMessage || e.message); process.exit(1); });
