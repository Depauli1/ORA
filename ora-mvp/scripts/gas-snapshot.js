// ORA gas snapshot — records representative operation costs and fails CI on
// regressions. Gas here is deterministic (in-process Hardhat network, fixed
// fixtures), so any delta is a real codegen/logic change.
//
//   npx hardhat run scripts/gas-snapshot.js          # (re)generate baseline
//   GAS_CHECK=1 npx hardhat run scripts/gas-snapshot.js   # CI: fail on >10% growth
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, MAX_FEE, ratesFixtureSeeded, rwaFixtureSeeded } = require("../test/helpers");

const OUT = path.join(__dirname, "..", "gas-snapshot.json");
const TOLERANCE = 0.10; // CI fails if any op costs >10% over baseline
const ops = {};
async function snap(name, txp) {
  const tx = await txp;
  const r = await tx.wait();
  ops[name] = Number(r.gasUsed);
  console.log(`  ${name.padEnd(34)} ${ops[name].toLocaleString("en-US")}`);
}

async function main() {
  console.log("— rates branch (ETH v2) —");
  {
    const f = await ratesFixtureSeeded(); // whale 100ETH/60k, SP 10k
    const { bo, tm, sp, orUSD, agg, router, vault, bob, carol } = f;
    await snap("rates.openTroveWithRate",
      bo.connect(bob).openTroveWithRate(E("15000"), E("0.05"), Z, Z, { value: E("10") }));
    await snap("rates.addColl", bo.connect(bob).addColl(Z, Z, { value: E("1") }));
    await snap("rates.withdrawLUSD", bo.connect(bob).withdrawLUSD(MAX_FEE, E("1000"), Z, Z));
    await snap("rates.repayLUSD", bo.connect(bob).repayLUSD(E("500"), Z, Z));
    await time.increase(8 * 86400); // pass the 7-day rate cooldown
    await snap("rates.adjustTroveRate", bo.connect(bob).adjustTroveRate(E("0.09"), Z, Z));
    await snap("rates.accrueTroveInterest", tm.accrueTroveInterest(bob.address));
    await snap("rates.distributeInterest", router.distribute());
    await orUSD.connect(bob).transfer(carol.address, E("2000"));
    await orUSD.connect(carol).approve(await vault.getAddress(), ethers.MaxUint256);
    await snap("sorUSD.deposit", vault.connect(carol).deposit(E("2000")));
    await snap("sorUSD.redeem", vault.connect(carol).redeem(E("1000")));
    await agg.setAnswer(1200n * 10n ** 8n); // -40%: bait underwater, normal mode
    await snap("rates.liquidate", tm.connect(carol).liquidate(bob.address));
    // guardian pause/unpause against this branch's BO
    const OG = await ethers.getContractFactory("OraGuardian");
    const og = await OG.deploy(carol.address);
    await og.waitForDeployment();
    const boAddr = await bo.getAddress();
    await snap("guardian.pauseBorrowing",
      og.connect(carol).pauseBorrowing(boAddr, 86400));
    await snap("guardian.unpauseBorrowing", og.connect(carol).unpauseBorrowing(boAddr));
  }

  console.log("— RWA branch (wmTBILL) + keeper —");
  {
    const f = await rwaFixtureSeeded(); // whale 500k/300k, SP 250k
    const { bo, tm, sp, sorted, wtbill, aggNav, orUSD, bob, carol, alice } = f;
    for (const [s, sh] of [[bob, "12000"], [carol, "12000"]]) {
      await wtbill.connect(s).faucet(E(sh));
      await wtbill.connect(s).approve(await bo.getAddress(), ethers.MaxUint256);
    }
    await snap("rwa.openTrove",
      bo.connect(bob).openTrove(MAX_FEE, E("11600"), E("12000"), Z, Z));
    await bo.connect(carol).openTrove(MAX_FEE, E("11600"), E("12000"), Z, Z);
    await snap("rwa.provideToSP", sp.connect(bob).provideToSP(E("5000"), Z));
    await snap("rwa.withdrawFromSP", sp.connect(bob).withdrawFromSP(E("1000")));
    await aggNav.setAnswer(102900000n); // -2%: soft band [103%, 105%)
    await snap("rwa.liquidatePartial", tm.connect(alice).liquidatePartial(bob.address));
    await aggNav.setAnswer(95000000n); // deeper: full liquidation territory
    const BL = await ethers.getContractFactory("BatchLiquidator");
    const bl = await BL.deploy();
    await bl.waitForDeployment();
    await snap("keeper.liquidateTroves(5)",
      bl.connect(alice).liquidateTroves(await tm.getAddress(), await sorted.getAddress(), 5,
        await orUSD.getAddress()));
    await snap("keeper.batchLiquidateTroves(skip-path)",
      bl.connect(alice).batchLiquidateTroves(await tm.getAddress(), [bob.address, carol.address],
        await orUSD.getAddress()));
  }

  const solc = {
    "0.6.11": require("solc/package.json").version,
    "0.8.24": require("solc-0.8/package.json").version
  };
  if (process.env.GAS_CHECK === "1") {
    if (!fs.existsSync(OUT)) throw new Error("no gas-snapshot.json baseline — generate one first");
    const base = JSON.parse(fs.readFileSync(OUT)).ops;
    let failed = false;
    for (const [k, v] of Object.entries(base)) {
      if (!(k in ops)) { console.error(`MISSING op in this run: ${k}`); failed = true; continue; }
      const d = (ops[k] - v) / v;
      const pct = (d * 100).toFixed(1);
      console.log(`  ${d > TOLERANCE ? "REGRESSED" : "ok"} ${k}: ${v} -> ${ops[k]} (${pct}%)`);
      if (d > TOLERANCE) failed = true;
    }
    for (const k of Object.keys(ops))
      if (!(k in base)) { console.error(`NEW op without baseline: ${k} — regenerate gas-snapshot.json`); failed = true; }
    if (failed) { console.error("\nGAS CHECK FAILED"); process.exit(1); }
    console.log("\ngas check passed.");
  } else {
    fs.writeFileSync(OUT, JSON.stringify(
      { updated: new Date().toISOString().slice(0, 10), solc, tolerance: TOLERANCE, ops }, null, 2) + "\n");
    console.log(`\nbaseline written to ${OUT}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
