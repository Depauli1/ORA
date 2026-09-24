// Shared fixtures for the ORA test suite. Each fixture deploys an isolated,
// fully wired stack on the in-process Hardhat network; loadFixture snapshots
// make repeated use cheap. Nothing here touches the demo chain or app files.
const { ethers } = require("hardhat");

const E = ethers.parseEther;
const Z = ethers.ZeroAddress;
const MAX_FEE = E("0.05");
const maxBytes32 = "0x" + "f".repeat(64);

async function deployCore(deployer) {
  const deploy = async (name, ...args) => {
    const f = await ethers.getContractFactory(name, deployer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  return { deploy, a: c => c.getAddress() };
}

// ---------------------------------------------------------------------------
// Rates branch (ETH v2): full user-set-interest stack as branch 1 of a fresh
// orUSD, plus the swap pool + LeverZap factory.
// ---------------------------------------------------------------------------
async function ratesFixture() {
  const [deployer, treasury, alice, bob, carol, dave] = await ethers.getSigners();
  const { deploy, a } = await deployCore(deployer);

  const agg = await deploy("SettableAggregator", 8, "ETH / USD", 2000n * 10n ** 8n);
  const feed = await deploy("ChainlinkPriceFeed", await a(agg), 48 * 3600, ethers.ZeroAddress);

  const sorted = await deploy("SortedTrovesRates");
  const tm = await deploy("TroveManagerRates");
  const ap = await deploy("ActivePool");
  const sp = await deploy("StabilityPoolRates");
  const gasPool = await deploy("GasPool");
  const dp = await deploy("DefaultPool");
  const csp = await deploy("CollSurplusPool");
  const bo = await deploy("BorrowerOperationsRates");
  const hh = await deploy("HintHelpersRates", await a(tm));

  const orUSD = await deploy("LUSDToken", await a(tm), await a(sp), await a(bo));

  const ci = await deploy("CommunityIssuance");
  const staking = await deploy("LQTYStaking");
  const lockup = await deploy("LockupContractFactory");
  const ora = await deploy("LQTYToken",
    await a(ci), await a(staking), await a(lockup),
    treasury.address, treasury.address, deployer.address);
  const branchCI = await deploy("BranchCommunityIssuance");

  const router = await deploy("InterestRouter");
  const vault = await deploy("SorUSDVault", await a(orUSD));

  await sorted.setParams(maxBytes32, await a(tm), await a(bo));
  await tm.setRatesAddresses(await a(router), treasury.address);
  await tm.setAddresses(
    await a(bo), await a(ap), await a(dp), await a(sp), await a(gasPool),
    await a(csp), await a(feed), await a(orUSD), await a(sorted),
    await a(ora), await a(staking));
  await bo.setAddresses(
    await a(tm), await a(ap), await a(dp), await a(sp), await a(gasPool),
    await a(csp), await a(feed), await a(sorted), await a(orUSD), await a(staking));
  await sp.setAddresses(
    await a(bo), await a(tm), await a(ap), await a(orUSD), await a(sorted),
    await a(feed), await a(branchCI));
  await ap.setAddresses(await a(bo), await a(tm), await a(sp), await a(dp));
  await dp.setAddresses(await a(tm), await a(ap));
  await csp.setAddresses(await a(bo), await a(tm), await a(ap));
  await staking.setAddresses(
    await a(ora), await a(orUSD), await a(tm), await a(bo), await a(ap));
  await router.setAddresses(await a(orUSD), await a(vault), treasury.address);
  await branchCI.setAddresses(await a(ora), await a(sp));
  await ora.connect(treasury).transfer(await a(branchCI), E("500000"));
  await branchCI.activate();

  // Leverage stack
  const pool = await deploy("OraSwapPool", await a(orUSD));
  const zapFactory = await deploy("LeverZapFactory",
    await a(bo), await a(tm), await a(feed), await a(pool), await a(orUSD));

  return { deployer, treasury, alice, bob, carol, dave,
    agg, feed, sorted, tm, ap, sp, dp, csp, bo, hh, gasPool,
    orUSD, ora, staking, branchCI, router, vault, pool, zapFactory };
}

// Open a whale trove so TCR clears CCR, then seed the pool at $2000.
async function ratesFixtureSeeded() {
  const f = await ratesFixture();
  const { bo, sp, orUSD, pool, alice } = f;
  // whale: 100 ETH / 60k orUSD @ 3% -> ICR ~332%
  await bo.connect(alice).openTroveWithRate(E("60000"), E("0.03"), Z, Z, { value: E("100") });
  await sp.connect(alice).provideToSP(E("10000"), Z);
  await orUSD.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
  await pool.connect(alice).addLiquidity(E("40000"), { value: E("20") });
  return f;
}

// ---------------------------------------------------------------------------
// RWA branch (wmTBILL): MCR 105% fork stack as branch 1 of a fresh orUSD.
// ---------------------------------------------------------------------------
async function rwaFixture() {
  const [deployer, treasury, alice, bob, carol] = await ethers.getSigners();
  const { deploy, a } = await deployCore(deployer);

  const tbill = await deploy("MockTBill");
  const aggNav = await deploy("SettableAggregator", 8, "mTBILL NAV / USD", 105n * 10n ** 6n);
  const navFeed = await deploy("RWAPriceFeed", await a(aggNav), 72 * 3600);
  const wtbill = await deploy("WTBill", await a(tbill), treasury.address);
  const feed = await deploy("WTBillPriceFeed", await a(navFeed), await a(wtbill));

  const sorted = await deploy("SortedTroves");
  const tm = await deploy("TroveManagerRWA");
  const ap = await deploy("ActivePoolERC20");
  const sp = await deploy("StabilityPoolRWA");
  const gasPool = await deploy("GasPool");
  const dp = await deploy("DefaultPoolERC20");
  const csp = await deploy("CollSurplusPoolERC20");
  const bo = await deploy("BorrowerOperationsRWA");
  const hh = await deploy("HintHelpersRWA");

  const orUSD = await deploy("LUSDToken", await a(tm), await a(sp), await a(bo));

  const ci = await deploy("CommunityIssuance");
  const lqtyStaking = await deploy("LQTYStaking");
  const lockup = await deploy("LockupContractFactory");
  const ora = await deploy("LQTYToken",
    await a(ci), await a(lqtyStaking), await a(lockup),
    treasury.address, treasury.address, deployer.address);
  const branchStaking = await deploy("BranchStaking");
  const branchCI = await deploy("BranchCommunityIssuance");

  await sorted.setParams(maxBytes32, await a(tm), await a(bo));
  await tm.setAddresses(
    await a(bo), await a(ap), await a(dp), await a(sp), await a(gasPool),
    await a(csp), await a(feed), await a(orUSD), await a(sorted),
    await a(ora), await a(branchStaking));
  await bo.setCollToken(await a(wtbill));
  await bo.setDebtCap(E("2000000"));
  await bo.setAddresses(
    await a(tm), await a(ap), await a(dp), await a(sp), await a(gasPool),
    await a(csp), await a(feed), await a(sorted), await a(orUSD), await a(branchStaking));
  await sp.setCollToken(await a(wtbill));
  await sp.setAddresses(
    await a(bo), await a(tm), await a(ap), await a(orUSD), await a(sorted),
    await a(feed), await a(branchCI));
  await ap.setAddresses(
    await a(bo), await a(tm), await a(sp), await a(dp), await a(csp), await a(wtbill));
  await dp.setAddresses(await a(tm), await a(ap), await a(wtbill));
  await csp.setAddresses(await a(bo), await a(tm), await a(ap));
  await csp.setCollToken(await a(wtbill));
  await hh.setAddresses(await a(sorted), await a(tm));
  await branchStaking.setCollToken(await a(wtbill));
  await branchStaking.setAddresses(
    await a(ora), await a(orUSD), await a(tm), await a(bo), await a(ap));
  await branchCI.setAddresses(await a(ora), await a(sp));
  await ora.connect(treasury).transfer(await a(branchCI), E("500000"));
  await branchCI.activate();

  return { deployer, treasury, alice, bob, carol,
    tbill, aggNav, navFeed, wtbill, feed,
    sorted, tm, ap, sp, dp, csp, bo, hh, orUSD, ora, branchStaking, branchCI };
}

// whale anchors TCR above CCR 115%
async function rwaFixtureSeeded() {
  const f = await rwaFixture();
  const { wtbill, bo, sp, alice } = f;
  await wtbill.connect(alice).faucet(E("500000"));
  await wtbill.connect(alice).approve(await f.bo.getAddress(), ethers.MaxUint256);
  await bo.connect(alice).openTrove(MAX_FEE, E("300000"), E("500000"), Z, Z); // ~175%
  await sp.connect(alice).provideToSP(E("250000"), Z);
  return f;
}

// Simple seeded PRNG for reproducible fuzz runs
function rng(seed) {
  let s = BigInt(seed);
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return s >> 11n; // 53 bits
  };
}
// random bigint in [min, max]
function randRange(next, min, max) {
  const span = max - min + 1n;
  return min + (next() % span);
}

async function openRatesTrove(f, signer, collEth, debt, rate) {
  return f.bo.connect(signer).openTroveWithRate(E(debt), E(rate), Z, Z, { value: E(collEth) });
}

module.exports = {
  E, Z, MAX_FEE, maxBytes32,
  ratesFixture, ratesFixtureSeeded, rwaFixture, rwaFixtureSeeded,
  rng, randRange, openRatesTrove
};
