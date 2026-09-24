// Seeds both ORA branches with a realistic market.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "deployment.json")));
  const signers = await ethers.getSigners();
  const maxFee = ethers.parseEther("0.05");
  const Z = ethers.ZeroAddress;
  const E = ethers.parseEther;

  // ---- Branch 1: native ETH ----
  const bo = await ethers.getContractAt("BorrowerOperations", dep.branches.ETH.borrowerOperations);
  const sp = await ethers.getContractAt("StabilityPool", dep.branches.ETH.stabilityPool);

  const ethTroves = [
    { s: 5, coll: "400", debt: "300000" }, // whale, ~266%
    { s: 6, coll: "10",  debt: "12000"  }, // ~163%
    { s: 7, coll: "5",   debt: "7000"   }, // ~138%
    { s: 8, coll: "3",   debt: "4800"   }  // ~119%
  ];
  for (const t of ethTroves) {
    await (await bo.connect(signers[t.s]).openTrove(maxFee, E(t.debt), Z, Z, { value: E(t.coll) })).wait();
    console.log(`[ETH] trove: ${t.coll} ETH / ${t.debt} orUSD (${signers[t.s].address.slice(0,8)})`);
  }
  await (await sp.connect(signers[5]).provideToSP(E("150000"), Z)).wait();
  await (await sp.connect(signers[6]).provideToSP(E("8000"), Z)).wait();
  console.log("[ETH] Stability Pool seeded: 158,000 orUSD");

  // ---- Branch 2: wstETH ----
  const wst = await ethers.getContractAt("MockWstETH", dep.branches.wstETH.collToken);
  const bo2 = await ethers.getContractAt("BorrowerOperationsERC20", dep.branches.wstETH.borrowerOperations);
  const sp2 = await ethers.getContractAt("StabilityPoolERC20", dep.branches.wstETH.stabilityPool);

  const wstTroves = [
    { s: 9,  coll: "200", debt: "250000" }, // ~192% at $2400
    { s: 10, coll: "8",   debt: "13500"  }, // ~140%
    { s: 11, coll: "2.5", debt: "4900"   }  // ~117%
  ];
  for (const t of wstTroves) {
    const s = signers[t.s];
    await (await wst.connect(s).faucet(E(t.coll))).wait();
    await (await wst.connect(s).approve(dep.branches.wstETH.borrowerOperations, ethers.MaxUint256)).wait();
    await (await bo2.connect(s).openTrove(maxFee, E(t.debt), E(t.coll), Z, Z)).wait();
    console.log(`[wstETH] trove: ${t.coll} wstETH / ${t.debt} orUSD (${s.address.slice(0,8)})`);
  }
  await (await sp2.connect(signers[9]).provideToSP(E("120000"), Z)).wait();
  console.log("[wstETH] Stability Pool seeded: 120,000 orUSD");

  // ---- Branch 3: wmTBILL (RWA yield-share, MCR 105%) ----
  const wtbill = await ethers.getContractAt("WTBill", dep.branches.tBILL.collToken);
  const bo3 = await ethers.getContractAt("BorrowerOperationsRWA", dep.branches.tBILL.borrowerOperations);
  const sp3 = await ethers.getContractAt("StabilityPoolRWA", dep.branches.tBILL.stabilityPool);

  // Price ≈ $1.05 (NAV × wrapper rate). MCR 105% / CCR 115%: T-bill desks run
  // tight. The bait trove sits ~107% so a −2% NAV print drops it into the
  // [103%, 105%) soft-liquidation band.
  const rwaTroves = [
    { s: 12, coll: "500000", debt: "300000" }, // treasury desk, ~175%
    { s: 13, coll: "60000",  debt: "52000"  }, // ~121%
    { s: 14, coll: "12000",  debt: "11600"  }  // ~107% — soft-liq bait after a NAV shock
  ];
  for (const t of rwaTroves) {
    const s = signers[t.s];
    // WTBill.faucet mints wmTBILL shares directly (it loops the MockTBill faucet internally)
    await (await wtbill.connect(s).faucet(E(t.coll))).wait();
    await (await wtbill.connect(s).approve(dep.branches.tBILL.borrowerOperations, ethers.MaxUint256)).wait();
    await (await bo3.connect(s).openTrove(maxFee, E(t.debt), E(t.coll), Z, Z)).wait();
    console.log(`[wmTBILL] trove: ${t.coll} wmTBILL / ${t.debt} orUSD (${s.address.slice(0,8)})`);
  }
  await (await sp3.connect(signers[12]).provideToSP(E("250000"), Z)).wait();
  console.log("[wmTBILL] Stability Pool seeded: 250,000 orUSD");

  // ---- Branch 4: ETH v2 (user-set interest rates) ----
  const bo4 = await ethers.getContractAt("BorrowerOperationsRates", dep.branches.ETHv2.borrowerOperations);
  const sp4 = await ethers.getContractAt("StabilityPoolRates", dep.branches.ETHv2.stabilityPool);
  const orUSD = await ethers.getContractAt("LUSDToken", dep.shared.orUSDToken);
  const vault = await ethers.getContractAt("SorUSDVault", dep.branches.ETHv2.sorUSDVault);

  // rate = annual interest, 1e18-scaled. The 0.6%-rate trove is the redemption
  // bait: healthy ICR but the cheapest rate, so redemptions hit it FIRST —
  // demonstrating rate-ordered (not ICR-ordered) redemptions.
  const v2Troves = [
    { s: 15, coll: "200", debt: "150000", rate: "0.035" }, // whale, ~267%, 3.5%
    { s: 16, coll: "15",  debt: "18000",  rate: "0.06"  }, // ~165%, 6%
    { s: 17, coll: "12",  debt: "14000",  rate: "0.006" }, // ~169%, 0.6% — redemption bait
    { s: 18, coll: "4",   debt: "5800",   rate: "0.09"  }  // ~133%, 9%
  ];
  for (const t of v2Troves) {
    await (await bo4.connect(signers[t.s]).openTroveWithRate(E(t.debt), E(t.rate), Z, Z, { value: E(t.coll) })).wait();
    console.log(`[ETHv2] trove: ${t.coll} ETH / ${t.debt} orUSD @ ${Number(t.rate) * 100}% (${signers[t.s].address.slice(0, 8)})`);
  }
  await (await sp4.connect(signers[15]).provideToSP(E("60000"), Z)).wait();
  console.log("[ETHv2] Stability Pool seeded: 60,000 orUSD");

  // Seed the sorUSD savings vault (also locks the dead shares)
  await (await orUSD.connect(signers[15]).approve(dep.branches.ETHv2.sorUSDVault, ethers.MaxUint256)).wait();
  await (await vault.connect(signers[15]).deposit(E("25000"))).wait();
  console.log("[ETHv2] sorUSD vault seeded: 25,000 orUSD");

  // Seed the demo orUSD/ETH AMM at the oracle price (~$2000/ETH) so the
  // one-click leverage zapper has a venue to swap through.
  const pool = await ethers.getContractAt("OraSwapPool", dep.branches.ETHv2.swapPool);
  await (await orUSD.connect(signers[15]).approve(dep.branches.ETHv2.swapPool, ethers.MaxUint256)).wait();
  await (await pool.connect(signers[15]).addLiquidity(E("40000"), { value: E("20") })).wait();
  console.log("[ETHv2] swap pool seeded: 40,000 orUSD / 20 ETH");
}

main().catch(e => { console.error(e); process.exit(1); });
