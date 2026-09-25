// Public-testnet bootstrap: opens a first trove + Stability Pool deposit on
// each branch from the single funded deployer key, so the protocol is alive
// (TCR defined, SP non-empty, AMM liquid) the moment the frontend loads.
//
// Adaptive: ERC20 branches (wstETH, wmTBILL) cost only gas — always seeded.
// Native-ETH branches need real testnet ETH for collateral and are seeded
// only if the deployer balance allows. Idempotent: skips troves that exist.
//
// Usage: npx hardhat run scripts/seed-public.js --network baseSepolia
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers, network } = hre;

const E = ethers.parseEther;
const Z = ethers.ZeroAddress;
const maxFee = E("0.05");

async function main() {
  const suffix = network.name === "localhost" || network.name === "hardhat" ? "" : "-" + network.name;
  const depPath = path.join(__dirname, "..", "app", `deployment${suffix}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath));
  const [deployer] = await ethers.getSigners();
  console.log(`Seeding ${network.name} as ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  const orUSD = await ethers.getContractAt("LUSDToken", dep.shared.orUSDToken);
  const results = [];
  const section = async (label, fn) => {
    try { await fn(); results.push(`  OK    ${label}`); }
    catch (e) { results.push(`  SKIP  ${label} — ${(e.shortMessage || e.message || "").slice(0, 100)}`); }
  };

  // ---- wstETH branch (ERC20 — gas-only cost) ----
  await section("wstETH branch: trove + SP", async () => {
    const B = dep.branches.wstETH;
    const tm = await ethers.getContractAt("TroveManagerV2", B.troveManager);
    if ((await tm.getTroveStatus(deployer.address)) === 1n) throw new Error("trove already open");
    const wst = await ethers.getContractAt("MockWstETH", B.collToken);
    const bo = await ethers.getContractAt("BorrowerOperationsERC20", B.borrowerOperations);
    const sp = await ethers.getContractAt("StabilityPoolERC20", B.stabilityPool);
    const feed = await ethers.getContractAt("WstETHPriceFeed", B.priceFeed);
    const price = await feed.getPrice();
    const coll = E("25");
    const debt = (coll * price / 10n ** 18n) / 2n; // ICR ~200%
    await (await wst.faucet(coll)).wait();
    await (await wst.approve(B.borrowerOperations, ethers.MaxUint256)).wait();
    await (await bo.openTrove(maxFee, debt, coll, Z, Z)).wait();
    await (await sp.provideToSP(E("5000"), Z)).wait();
    console.log(`[wstETH] trove: 25 wstETH / ${ethers.formatEther(debt)} orUSD + 5,000 SP`);
  });

  // ---- wmTBILL branch (ERC20 — gas-only cost) ----
  await section("wmTBILL branch: trove + SP", async () => {
    const B = dep.branches.tBILL;
    const tm = await ethers.getContractAt("TroveManagerRWA", B.troveManager);
    if ((await tm.getTroveStatus(deployer.address)) === 1n) throw new Error("trove already open");
    const wt = await ethers.getContractAt("WTBill", B.collToken);
    const bo = await ethers.getContractAt("BorrowerOperationsRWA", B.borrowerOperations);
    const sp = await ethers.getContractAt("StabilityPoolRWA", B.stabilityPool);
    await (await wt.faucet(E("40000"))).wait();
    await (await wt.approve(B.borrowerOperations, ethers.MaxUint256)).wait();
    await (await bo.openTrove(maxFee, E("25000"), E("40000"), Z, Z)).wait(); // ICR ~166% (CCR 115%)
    await (await sp.provideToSP(E("8000"), Z)).wait();
    console.log("[wmTBILL] trove: 40,000 wmTBILL / 25,000 orUSD + 8,000 SP");
  });

  // ---- native ETH branches (need real testnet ETH — adaptive) ----
  const feedEth = await ethers.getContractAt("ChainlinkPriceFeed", dep.branches.ETH.priceFeed);
  const priceEth = await feedEth.getPrice(); // 1e18 USD per ETH
  // first trove must clear CCR 150% — target ICR 165% on 2,000 orUSD total debt
  const collNeeded = (E("3300") * 10n ** 18n) / priceEth;

  await section("ETH branch: trove + SP", async () => {
    const B = dep.branches.ETH;
    const tm = await ethers.getContractAt("TroveManager", B.troveManager);
    if ((await tm.getTroveStatus(deployer.address)) === 1n) throw new Error("trove already open");
    const bal = await ethers.provider.getBalance(deployer.address);
    if (bal < collNeeded + E("0.02")) {
      throw new Error(`needs ${ethers.formatEther(collNeeded)} ETH collateral — balance too low, fund the deployer and re-run`);
    }
    const bo = await ethers.getContractAt("BorrowerOperations", B.borrowerOperations);
    const sp = await ethers.getContractAt("StabilityPool", B.stabilityPool);
    await (await bo.openTrove(maxFee, E("1800"), Z, Z, { value: collNeeded })).wait();
    await (await sp.provideToSP(E("1000"), Z)).wait();
    console.log(`[ETH] trove: ${ethers.formatEther(collNeeded)} ETH / 1,800 orUSD + 1,000 SP`);
  });

  await section("ETH v2 branch: trove @4% + SP", async () => {
    const B = dep.branches.ETHv2;
    const tm = await ethers.getContractAt("TroveManagerRates", B.troveManager);
    if ((await tm.getTroveStatus(deployer.address)) === 1n) throw new Error("trove already open");
    const bal = await ethers.provider.getBalance(deployer.address);
    if (bal < collNeeded + E("0.02")) {
      throw new Error(`needs ${ethers.formatEther(collNeeded)} ETH collateral — balance too low, fund the deployer and re-run`);
    }
    const bo = await ethers.getContractAt("BorrowerOperationsRates", B.borrowerOperations);
    const sp = await ethers.getContractAt("StabilityPoolRates", B.stabilityPool);
    await (await bo.openTroveWithRate(E("1800"), E("0.04"), Z, Z, { value: collNeeded })).wait();
    await (await sp.provideToSP(E("1000"), Z)).wait();
    console.log(`[ETHv2] trove: ${ethers.formatEther(collNeeded)} ETH / 1,800 orUSD @ 4% + 1,000 SP`);
  });

  // ---- sorUSD vault + demo AMM (funded from the orUSD borrowed above) ----
  await section("sorUSD vault seed", async () => {
    const B = dep.branches.ETHv2;
    const vault = await ethers.getContractAt("SorUSDVault", B.sorUSDVault);
    if ((await vault.totalAssets()) > 0n) throw new Error("already seeded");
    if ((await orUSD.balanceOf(deployer.address)) < E("2000")) throw new Error("not enough free orUSD");
    await (await orUSD.approve(B.sorUSDVault, ethers.MaxUint256)).wait();
    await (await vault.deposit(E("2000"))).wait();
    console.log("[ETHv2] sorUSD vault seeded: 2,000 orUSD");
  });

  await section("demo AMM liquidity (orUSD/ETH)", async () => {
    const B = dep.branches.ETHv2;
    if (!B.swapPool) { console.log("[ETHv2] no demo AMM on this chain — skipping pool seed"); return; }
    const pool = await ethers.getContractAt("OraSwapPool", B.swapPool);
    if ((await pool.reserveETH()) > 0n) throw new Error("already seeded");
    const ethIn = E("0.02");
    const usdIn = ethIn * priceEth / 10n ** 18n; // match the oracle price
    const bal = await ethers.provider.getBalance(deployer.address);
    if (bal < ethIn + E("0.01")) throw new Error("balance too low for pool ETH");
    if ((await orUSD.balanceOf(deployer.address)) < usdIn) throw new Error("not enough free orUSD");
    await (await orUSD.approve(B.swapPool, ethers.MaxUint256)).wait();
    await (await pool.addLiquidity(usdIn, { value: ethIn })).wait();
    console.log(`[ETHv2] AMM seeded: ${ethers.formatEther(usdIn)} orUSD / 0.02 ETH`);
  });

  console.log("\n==== Seed summary ====");
  results.forEach(r => console.log(r));
  console.log(`\nRemaining balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log("SKIPped native-ETH sections are normal on a low balance — fund more and re-run to fill them in.");
}

main().catch(e => { console.error("SEED FAILED:", e.shortMessage || e.message); process.exit(1); });
