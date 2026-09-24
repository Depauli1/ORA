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

  // ---- Branch 3: mTBILL (RWA) ----
  const tbill = await ethers.getContractAt("MockTBill", dep.branches.tBILL.collToken);
  const bo3 = await ethers.getContractAt("BorrowerOperationsERC20", dep.branches.tBILL.borrowerOperations);
  const sp3 = await ethers.getContractAt("StabilityPoolERC20", dep.branches.tBILL.stabilityPool);

  // NAV $1.05 — branch TCR must clear CCR (150%), so the whale anchors it
  const rwaTroves = [
    { s: 12, coll: "500000", debt: "300000" }, // treasury desk, ~174%
    { s: 13, coll: "60000",  debt: "45000"  }, // ~139%
    { s: 14, coll: "12000",  debt: "11100"  }  // ~111% — soft-liq bait after a NAV shock
  ];
  for (const t of rwaTroves) {
    const s = signers[t.s];
    for (let left = BigInt(t.coll); left > 0n; left -= 100000n) {
      await (await tbill.connect(s).faucet(E((left > 100000n ? 100000n : left).toString()))).wait();
    }
    await (await tbill.connect(s).approve(dep.branches.tBILL.borrowerOperations, ethers.MaxUint256)).wait();
    await (await bo3.connect(s).openTrove(maxFee, E(t.debt), E(t.coll), Z, Z)).wait();
    console.log(`[mTBILL] trove: ${t.coll} mTBILL / ${t.debt} orUSD (${s.address.slice(0,8)})`);
  }
  await (await sp3.connect(signers[12]).provideToSP(E("250000"), Z)).wait();
  console.log("[mTBILL] Stability Pool seeded: 250,000 orUSD");

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
}

main().catch(e => { console.error(e); process.exit(1); });
