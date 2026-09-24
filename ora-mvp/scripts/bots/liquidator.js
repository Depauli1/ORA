// ORA liquidation keeper — scans every branch for troves below the branch MCR
// and liquidates them (soft-liquidation preferred inside the partial band on
// branches that support it). Each candidate is simulated with staticCall
// before any gas is spent.
//
//   one-shot (local):  node scripts/bots/liquidator.js
//   watch mode:        node scripts/bots/liquidator.js --watch
//   Base Sepolia:      ORA_RPC_URL=https://sepolia.base.org \
//                      ORA_DEPLOYMENT=app/deployment-baseSepolia.json \
//                      ORA_KEEPER_KEY=0x... node scripts/bots/liquidator.js --watch
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.ORA_RPC_URL || "http://127.0.0.1:3000/rpc";
const DEP = process.env.ORA_DEPLOYMENT || path.join(__dirname, "..", "..", "app", "deployment.json");
const POLL = Number(process.env.ORA_POLL_SECONDS || 30);
const SCAN = Number(process.env.ORA_SCAN_TROVES || 500);
// default keeper: hardhat account #19 (local demo only — set ORA_KEEPER_KEY elsewhere)
const KEY = process.env.ORA_KEEPER_KEY ||
  "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e";

const f = v => Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 2 });

async function scanOnce(dep, wallet) {
  const A = dep.abis;
  let actions = 0;
  for (const [name, B] of Object.entries(dep.branches)) {
    const tm = new ethers.Contract(B.troveManager,
      B.rates ? A.troveManagerRates : (A.troveManagerV2 || A.troveManager), wallet);
    const feedAbi = B.rwa ? (A.wtBillPriceFeed || A.priceFeedRWA) : B.native ? A.priceFeed : A.priceFeedWstETH;
    const feed = new ethers.Contract(B.priceFeed, feedAbi, wallet);
    const getter = new ethers.Contract(B.multiTroveGetter, A.multiTroveGetter, wallet);

    const price = await feed.getPrice();
    const mcr = ethers.parseEther(String(B.mcr || 1.1));
    const softFloor = ethers.parseEther(String(B.softFloor || 1.05));
    // liquidatePartial exists on the TroveManagerV2-family branches
    const hasSoft = !B.native && !B.rates && !!(A.troveManagerV2 || A.troveManagerRWA);

    const rows = await getter.getMultipleSortedTroves(0, SCAN);
    for (const r of rows) {
      const owner = r[0], debt = r[1], coll = r[2];
      if (debt === 0n) continue;
      const icr = coll * price / debt;
      if (icr >= mcr) continue;

      const inSoftBand = hasSoft && icr >= softFloor;
      const label = `${name} ${owner.slice(0, 10)} ICR ${(Number(icr) / 1e16).toFixed(2)}%`;

      // prefer the gentler partial liquidation inside the band, fall through to full
      if (inSoftBand) {
        try {
          await tm.liquidatePartial.staticCall(owner);
          const tx = await tm.liquidatePartial(owner);
          await tx.wait();
          console.log(`  SOFT-LIQ ${label} — restored to ${((B.mcr || 1.1) * 100).toFixed(0)}%`);
          actions++;
          continue;
        } catch { /* remainder too small / recovery mode -> try full */ }
      }
      try {
        await tm.liquidate.staticCall(owner);
        const tx = await tm.liquidate(owner);
        await tx.wait();
        console.log(`  LIQUIDATED ${label} — debt ${f(debt)} orUSD absorbed by the SP`);
        actions++;
      } catch (e) {
        console.log(`  skip ${label} — ${(e.shortMessage || e.message || "").slice(0, 80)}`);
      }
    }
  }
  return actions;
}

async function main() {
  const watch = process.argv.includes("--watch");
  if (!fs.existsSync(DEP)) { console.log(`deployment not found (${DEP}) — nothing to do`); return; }
  const dep = JSON.parse(fs.readFileSync(DEP));
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  const wallet = new ethers.NonceManager(new ethers.Wallet(KEY, provider));
  wallet.address = new ethers.Wallet(KEY).address;
  console.log(`ORA liquidation keeper — ${wallet.address} @ ${RPC}${watch ? ` (watch, ${POLL}s)` : " (one-shot)"}`);

  do {
    const started = Date.now();
    try {
      const n = await scanOnce(dep, wallet);
      console.log(`[${new Date().toISOString()}] scan complete — ${n} liquidation(s)`);
    } catch (e) {
      console.error("scan failed:", e.shortMessage || e.message);
      wallet.reset();
    }
    if (watch) await new Promise(r => setTimeout(r, Math.max(0, POLL * 1000 - (Date.now() - started))));
  } while (watch);
}

main().catch(e => { console.error("KEEPER FAILED:", e.shortMessage || e.message); process.exit(1); });
