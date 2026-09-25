// Keeper scan load test — answers "does the scan path hold at 5k+ troves?"
// Opens N troves on the rates branch, then measures MultiTroveGetter scan
// cost (gas + wall latency) at several depths, plus a paginated full scan.
//
//   npx hardhat run scripts/loadtest-keeper-scan.js       # N=5000 (~7 min)
//   SCAN_N=1000 npx hardhat run scripts/loadtest-keeper-scan.js
//
// The keeper (scripts/bots/liquidator.js) pages through the list in
// ORA_SCAN_TROVES chunks; the table below justifies the default.
const hre = require("hardhat");
const { ethers } = hre;
const { E, Z, ratesFixtureSeeded } = require("../test/helpers");

const N = Number(process.env.SCAN_N || 5000);

async function main() {
  console.log(`opening ${N} troves...`);
  const tOpen0 = Date.now();
  const f = await ratesFixtureSeeded();
  const { bo } = f;
  await ethers.provider.send("hardhat_setBalance",
    [f.deployer.address, "0x" + E("30000").toString(16)]); // fund the funding
  for (let i = 0; i < N; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await f.deployer.sendTransaction({ to: w.address, value: E("2.1") });
    // healthy 200%-ICR troves: 5000 of them must not drag TCR below CCR
    await bo.connect(w).openTroveWithRate(E("2000"), E("0.05"), Z, Z, { value: E("2") });
    if ((i + 1) % 1000 === 0) console.log(`  ...${i + 1} (${((Date.now() - tOpen0) / 1000).toFixed(0)}s)`);
  }
  console.log(`opened in ${((Date.now() - tOpen0) / 1000).toFixed(0)}s`);

  const MTG = await ethers.getContractFactory("MultiTroveGetter");
  const mtg = await MTG.deploy(await f.tm.getAddress(), await f.sorted.getAddress());
  await mtg.waitForDeployment();

  console.log("\n single-call scan cost (eth_call, local EDR):");
  console.log("   depth |      gas | latency");
  for (const k of [100, 500, 1000, 2000, 5000].filter(k => k <= N)) {
    const t0 = Date.now();
    try {
      const gas = await mtg.getMultipleSortedTroves.estimateGas(0, k);
      console.log(`  ${String(k).padStart(5)} | ${Number(gas).toLocaleString("en-US").padStart(9)} | ${Date.now() - t0}ms`);
    } catch {
      console.log(`  ${String(k).padStart(5)} |       OOG | exceeds the 30M eth_call budget — page instead`);
    }
  }

  console.log("\n cursor full scan (TroveCursor pages of 500, as the keeper does):");
  const TC = await ethers.getContractFactory("TroveCursor");
  const cursor = await TC.deploy();
  await cursor.waitForDeployment();
  const t1 = Date.now();
  let seen = 0, next = ethers.ZeroAddress, pages = 0;
  for (;;) {
    const [rows, nxt] = await cursor.scan(await f.tm.getAddress(), await f.sorted.getAddress(), next, 500);
    seen += rows.length;
    pages++;
    if (nxt === ethers.ZeroAddress) break;
    next = nxt;
  }
  const ms = Date.now() - t1;
  console.log(`  ${seen} troves in ${pages} pages, ${ms}ms (${(seen / (ms / 1000)).toFixed(0)}/s)`);
  if (seen < N) { console.error(`FAIL: saw ${seen}, expected ${N}`); process.exit(1); }
  console.log("\nNOTE: offset pages (MultiTroveGetter) re-walk from the head and OOG");
  console.log("past ~700 troves — keepers must use TroveCursor (see ORA_SCAN_TROVES).");
}

main().catch(e => { console.error(e); process.exit(1); });
