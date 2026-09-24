// ORA Protocol — multi-branch deployment.
// Branch 1: native ETH (upstream Liquity engine, unchanged)
// Branch 2: wstETH (ERC20-collateral pool suite + Phase 2 tokenomics/soft-liq)
// Branch 3: mTBILL (Phase 4 RWA branch — NAV oracle, strict debt cap)
// Shared:   orUSD (multi-branch mint/burn), ORA token, ORA staking, issuance
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { ethers, network } = hre;
const maxBytes32 = "0x" + "f".repeat(64);

// Real Chainlink feeds per public network (env-overridable). Validated at
// deploy time: adapter constructors revert on an invalid/stale feed response.
const REAL_FEEDS = {
  baseSepolia: {
    ethUsd: process.env.ORA_ETHUSD_FEED || "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1"
  }
};
// Per-feed heartbeats (staleness windows). Testnet defaults are generous;
// on mainnet set tight values via env: ETH/USD heartbeat is 1h on L1 /
// 20 min on Base, stETH/ETH is 24h (Chainlink docs) — use heartbeat + margin.
const ETHUSD_TIMEOUT = Number(process.env.ORA_ETHUSD_HEARTBEAT || 48 * 3600);
const STETHETH_TIMEOUT = Number(process.env.ORA_STETHETH_HEARTBEAT || 48 * 3600);

// Phase 4 — RWA branch parameters
const RWA_ORACLE_TIMEOUT = 72 * 3600;                 // daily NAV + weekend cover
const RWA_DEBT_CAP = "2000000";                       // orUSD debt ceiling (strict isolation)
const RWA_ORA_ALLOCATION = "500000";                  // ORA for the RWA Stability Pool
const WST_ORA_ALLOCATION = "1000000";                 // ORA for the wstETH Stability Pool

// Rates engine — ETH v2 branch parameters
const ETH2_ORA_ALLOCATION = "500000";                 // ORA for the ETH v2 Stability Pool

async function main() {
  const [deployer, , , , treasury] = await ethers.getSigners();
  console.log(`Network: ${network.name} | Deployer: ${deployer.address}`);

  const deploy = async (name, ...args) => {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    console.log(`  ${name.padEnd(24)} ${await c.getAddress()}`);
    return c;
  };
  const a = c => c.getAddress();

  // ---------------- Oracles ----------------
  console.log("\n— Oracles —");
  const wstETH = await deploy("MockWstETH");

  let ethUsdAggregatorAddr;
  let ethUsdSettable;
  if (REAL_FEEDS[network.name]) {
    // Probe the configured Chainlink aggregator before committing to it: a
    // wrong/dead address must not brick the deploy. On failure fall back to a
    // SettableAggregator (still a real public-testnet deployment — the mock
    // feed simply powers the market simulator instead of live prices).
    const candidate = REAL_FEEDS[network.name].ethUsd;
    try {
      const probe = new ethers.Contract(candidate, [
        "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
        "function decimals() view returns (uint8)"
      ], ethers.provider);
      const [, answer, , updatedAt] = await probe.latestRoundData();
      const dec = await probe.decimals();
      const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
      if (answer <= 0n || age > ETHUSD_TIMEOUT) throw new Error(`bad answer ${answer} / age ${age}s`);
      ethUsdAggregatorAddr = candidate;
      ethUsdSettable = false;
      console.log(`  using real Chainlink ETH/USD: ${candidate}` +
        ` ($${Number(answer) / 10 ** Number(dec)}, ${age}s old)`);
    } catch (e) {
      console.log(`  WARNING: Chainlink ETH/USD probe failed at ${candidate} (${e.message?.slice(0, 80)})`);
      console.log("  falling back to a SettableAggregator ($2000) — override with ORA_ETHUSD_FEED to use a real feed");
      const aggEthUsd = await deploy("SettableAggregator", 8, "ETH / USD", 2000n * 10n ** 8n);
      ethUsdAggregatorAddr = await a(aggEthUsd);
      ethUsdSettable = true;
    }
  } else {
    const aggEthUsd = await deploy("SettableAggregator", 8, "ETH / USD", 2000n * 10n ** 8n);
    ethUsdAggregatorAddr = await a(aggEthUsd);
    ethUsdSettable = true;
  }
  // No canonical stETH/ETH feed on Base Sepolia -> settable mock everywhere
  // (also powers the depeg circuit-breaker demo).
  const aggStEthEth = await deploy("SettableAggregator", 18, "stETH / ETH", ethers.parseEther("1"));

  // L2 sequencer-uptime guard (answer 0 = up, 1 = down; 1h grace after restart).
  // Public L2s: real Chainlink uptime feed via ORA_SEQUENCER_FEED (probed).
  // Local: settable mock (answer 0), aged past the grace period -> also powers
  // the sequencer-outage demo. Base MAINNET feed for later:
  // 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433
  let sequencerFeedAddr = ethers.ZeroAddress;
  let sequencerSettable = false;
  if (REAL_FEEDS[network.name]) {
    const cand = process.env.ORA_SEQUENCER_FEED;
    if (cand) {
      try {
        const probe = new ethers.Contract(cand,
          ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], ethers.provider);
        const [, up] = await probe.latestRoundData();
        sequencerFeedAddr = cand;
        console.log(`  using L2 sequencer uptime feed: ${cand} (status ${up === 0n ? "UP" : "DOWN"})`);
      } catch (e) {
        console.log(`  WARNING: sequencer feed probe failed at ${cand} — guard disabled`);
      }
    } else {
      console.log("  no ORA_SEQUENCER_FEED set — sequencer guard disabled (fine for testnets)");
    }
  } else {
    const aggSeq = await deploy("SettableAggregator", 0, "L2 Sequencer Up", 0n);
    await (await aggSeq.makeStale(2 * 3600)).wait(); // age past the 1h restart grace
    sequencerFeedAddr = await a(aggSeq);
    sequencerSettable = true;
  }

  // Secondary ETH/USD source (multi-source hardening): a >50% single-fetch
  // move needs confirmation from BOTH sources; the fallback serves alone when
  // the primary is broken/stale. Public L2s: ORA_ETHUSD_FALLBACK_FEED (e.g.
  // an API3/Pyth Chainlink-compatible adapter); local: settable mock.
  let ethUsdFallbackAddr = ethers.ZeroAddress;
  let ethUsdFallbackSettable = false;
  if (REAL_FEEDS[network.name]) {
    const cand = process.env.ORA_ETHUSD_FALLBACK_FEED;
    if (cand) {
      try {
        const probe = new ethers.Contract(cand,
          ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], ethers.provider);
        await probe.latestRoundData();
        ethUsdFallbackAddr = cand;
        console.log(`  using ETH/USD fallback source: ${cand}`);
      } catch { console.log(`  WARNING: fallback feed probe failed at ${cand} — single-source mode`); }
    } else {
      console.log("  no ORA_ETHUSD_FALLBACK_FEED set — single-source mode (fine for testnets)");
    }
  } else {
    const aggFb = await deploy("SettableAggregator", 8, "ETH / USD (fallback)", 2000n * 10n ** 8n);
    ethUsdFallbackAddr = await a(aggFb);
    ethUsdFallbackSettable = true;
  }
  const MAX_DEVIATION_BPS = 5000; // 50% single-fetch move cap (upstream Liquity philosophy)

  const priceFeed = await deploy("ChainlinkPriceFeed",
    ethUsdAggregatorAddr, ETHUSD_TIMEOUT, sequencerFeedAddr, ethUsdFallbackAddr, MAX_DEVIATION_BPS);
  const priceFeed2 = await deploy("WstETHPriceFeed",
    ethUsdAggregatorAddr, await a(aggStEthEth), await a(wstETH),
    ETHUSD_TIMEOUT, STETHETH_TIMEOUT, sequencerFeedAddr, MAX_DEVIATION_BPS);

  // Phase 4: tokenized T-bill fund (RWA). NAV per share starts at $1.05; on
  // mainnet the aggregator would be the fund administrator's NAV oracle.
  const tBill = await deploy("MockTBill");
  const aggNav = await deploy("SettableAggregator", 8, "mTBILL NAV / USD", 105n * 10n ** 6n);
  const priceFeed3 = await deploy("RWAPriceFeed", await a(aggNav), RWA_ORACLE_TIMEOUT);

  console.log(`  ETH/USD: $${ethers.formatEther(await priceFeed.getPrice())}` +
    ` | wstETH/USD: $${ethers.formatEther(await priceFeed2.getPrice())}` +
    ` | mTBILL NAV: $${ethers.formatEther(await priceFeed3.getPrice())}`);

  // ---------------- Branch 1: native ETH ----------------
  console.log("\n— Branch 1: native ETH —");
  const sortedTroves = await deploy("SortedTroves");
  const troveManager = await deploy("TroveManager");
  const activePool = await deploy("ActivePool");
  const stabilityPool = await deploy("StabilityPool");
  const gasPool = await deploy("GasPool");
  const defaultPool = await deploy("DefaultPool");
  const collSurplusPool = await deploy("CollSurplusPool");
  const borrowerOperations = await deploy("BorrowerOperations");
  const hintHelpers = await deploy("HintHelpers");
  const multiTroveGetter = await deploy("MultiTroveGetter", await a(troveManager), await a(sortedTroves));

  // orUSD — registers branch 1 in its constructor; deployer is branch registrar
  const orUSD = await deploy("LUSDToken",
    await a(troveManager), await a(stabilityPool), await a(borrowerOperations));

  // ---------------- Shared ORA token & staking ----------------
  console.log("\n— ORA token & staking —");
  const communityIssuance = await deploy("CommunityIssuance");
  const oraStaking = await deploy("LQTYStaking");
  const lockupFactory = await deploy("LockupContractFactory");
  const oraToken = await deploy("LQTYToken",
    await a(communityIssuance), await a(oraStaking), await a(lockupFactory),
    treasury.address, treasury.address, deployer.address);

  // ---------------- Emergency brake: borrowing-pause guardian ----------------
  // One guardian for all branches; ORA_GUARDIAN should be a Safe multisig on
  // production (defaults to the deployer for dev/testnet deploys).
  console.log("\n\u2014 Guardian (borrowing-pause) \u2014");
  const guardianHolder = process.env.ORA_GUARDIAN || deployer.address;
  const guardian = await deploy("OraGuardian", guardianHolder);
  if (!process.env.ORA_GUARDIAN && network.name !== "localhost" && network.name !== "hardhat") {
    console.log("  WARNING: ORA_GUARDIAN unset \u2014 guardian = deployer EOA. Set a Safe multisig for production.");
  }

  // ---------------- Keeper helper: external batch liquidations ----------------
  // The TM forks implement single-trove liquidation only (24KB ceiling);
  // sequencing lives here. One stateless deployment serves all branches.
  console.log("\n\u2014 BatchLiquidator \u2014");
  const batchLiquidator = await deploy("BatchLiquidator");

  // ---------------- Branch 1 wiring ----------------
  console.log("\n— Wiring branch 1 (ETH) —");
  await (await sortedTroves.setParams(maxBytes32, await a(troveManager), await a(borrowerOperations))).wait();
  await (await troveManager.setAddresses(
    await a(borrowerOperations), await a(activePool), await a(defaultPool),
    await a(stabilityPool), await a(gasPool), await a(collSurplusPool),
    await a(priceFeed), await a(orUSD), await a(sortedTroves),
    await a(oraToken), await a(oraStaking))).wait();
  // setGuardian must precede setAddresses (which renounces ownership)
  await (await borrowerOperations.setGuardian(await a(guardian))).wait();
  await (await borrowerOperations.setAddresses(
    await a(troveManager), await a(activePool), await a(defaultPool),
    await a(stabilityPool), await a(gasPool), await a(collSurplusPool),
    await a(priceFeed), await a(sortedTroves), await a(orUSD), await a(oraStaking))).wait();
  await (await stabilityPool.setAddresses(
    await a(borrowerOperations), await a(troveManager), await a(activePool),
    await a(orUSD), await a(sortedTroves), await a(priceFeed), await a(communityIssuance))).wait();
  await (await activePool.setAddresses(
    await a(borrowerOperations), await a(troveManager), await a(stabilityPool), await a(defaultPool))).wait();
  await (await defaultPool.setAddresses(await a(troveManager), await a(activePool))).wait();
  await (await collSurplusPool.setAddresses(
    await a(borrowerOperations), await a(troveManager), await a(activePool))).wait();
  await (await hintHelpers.setAddresses(await a(sortedTroves), await a(troveManager))).wait();
  await (await lockupFactory.setLQTYTokenAddress(await a(oraToken))).wait();
  await (await oraStaking.setAddresses(
    await a(oraToken), await a(orUSD), await a(troveManager),
    await a(borrowerOperations), await a(activePool))).wait();
  await (await communityIssuance.setAddresses(await a(oraToken), await a(stabilityPool))).wait();
  console.log("  branch 1 wired — ChainlinkPriceFeed live");

  // ---------------- Branch 2: wstETH (ERC20 collateral) ----------------
  console.log("\n— Branch 2: wstETH —");
  const sortedTroves2 = await deploy("SortedTroves");
  const troveManager2 = await deploy("TroveManagerV2"); // Phase 2: soft liquidations
  const activePool2 = await deploy("ActivePoolERC20");
  const stabilityPool2 = await deploy("StabilityPoolERC20");
  const gasPool2 = await deploy("GasPool");
  const defaultPool2 = await deploy("DefaultPoolERC20");
  const collSurplusPool2 = await deploy("CollSurplusPoolERC20");
  const borrowerOperations2 = await deploy("BorrowerOperationsERC20");
  const hintHelpers2 = await deploy("HintHelpers");
  const multiTroveGetter2 = await deploy("MultiTroveGetter", await a(troveManager2), await a(sortedTroves2));
  const branchStaking2 = await deploy("BranchStaking");        // Phase 2: ORA staking earns branch fees
  const branchIssuance2 = await deploy("BranchCommunityIssuance"); // Phase 2: ORA rewards for SP depositors

  console.log("\n— Wiring branch 2 (wstETH) —");
  // Register the branch on orUSD (the Phase 1 core change)
  await (await orUSD.registerBranch(
    await a(troveManager2), await a(stabilityPool2), await a(borrowerOperations2))).wait();

  await (await sortedTroves2.setParams(maxBytes32, await a(troveManager2), await a(borrowerOperations2))).wait();
  await (await troveManager2.setAddresses(
    await a(borrowerOperations2), await a(activePool2), await a(defaultPool2),
    await a(stabilityPool2), await a(gasPool2), await a(collSurplusPool2),
    await a(priceFeed2), await a(orUSD), await a(sortedTroves2),
    await a(oraToken), await a(branchStaking2))).wait();

  // setCollToken must precede setAddresses (which renounces ownership)
  await (await borrowerOperations2.setCollToken(await a(wstETH))).wait();
  // setGuardian must precede setAddresses (which renounces ownership)
  await (await borrowerOperations2.setGuardian(await a(guardian))).wait();
  await (await borrowerOperations2.setAddresses(
    await a(troveManager2), await a(activePool2), await a(defaultPool2),
    await a(stabilityPool2), await a(gasPool2), await a(collSurplusPool2),
    await a(priceFeed2), await a(sortedTroves2), await a(orUSD), await a(branchStaking2))).wait();

  await (await stabilityPool2.setCollToken(await a(wstETH))).wait();
  await (await stabilityPool2.setAddresses(
    await a(borrowerOperations2), await a(troveManager2), await a(activePool2),
    await a(orUSD), await a(sortedTroves2), await a(priceFeed2), await a(branchIssuance2))).wait();

  await (await activePool2.setAddresses(
    await a(borrowerOperations2), await a(troveManager2), await a(stabilityPool2),
    await a(defaultPool2), await a(collSurplusPool2), await a(wstETH))).wait();
  await (await defaultPool2.setAddresses(
    await a(troveManager2), await a(activePool2), await a(wstETH))).wait();
  await (await collSurplusPool2.setAddresses(
    await a(borrowerOperations2), await a(troveManager2), await a(activePool2))).wait();
  await (await collSurplusPool2.setCollToken(await a(wstETH))).wait();
  await (await hintHelpers2.setAddresses(await a(sortedTroves2), await a(troveManager2))).wait();
  // Phase 2: BranchStaking — setCollToken must precede setAddresses (which renounces ownership)
  await (await branchStaking2.setCollToken(await a(wstETH))).wait();
  await (await branchStaking2.setAddresses(
    await a(oraToken), await a(orUSD), await a(troveManager2),
    await a(borrowerOperations2), await a(activePool2))).wait();

  // Phase 2: BranchCommunityIssuance — fund 1,000,000 ORA from treasury, then activate (locks cap)
  await (await branchIssuance2.setAddresses(await a(oraToken), await a(stabilityPool2))).wait();
  await (await oraToken.connect(treasury).transfer(
    await a(branchIssuance2), ethers.parseEther(WST_ORA_ALLOCATION))).wait();
  await (await branchIssuance2.activate()).wait();
  console.log("  branch 2 wired — BranchStaking + 1M ORA issuance live");

  // ---------------- Branch 3: wmTBILL (RWA, strictly isolated) ----------------
  // RWA-tuned parameter fork: MCR 105% / CCR 115% (T-bills are low-vol), soft
  // band [103%, 105%). Collateral is wmTBILL — the yield-share wrapper that
  // skims 2%/yr of the mTBILL to the treasury and passes the rest to borrowers.
  console.log("\n— Branch 3: wmTBILL (RWA yield-share) —");
  const wtBill = await deploy("WTBill", await a(tBill), treasury.address);
  const wPriceFeed3 = await deploy("WTBillPriceFeed", await a(priceFeed3), await a(wtBill));
  const sortedTroves3 = await deploy("SortedTroves");
  const troveManager3 = await deploy("TroveManagerRWA");
  const activePool3 = await deploy("ActivePoolERC20");
  const stabilityPool3 = await deploy("StabilityPoolRWA");
  const gasPool3 = await deploy("GasPool");
  const defaultPool3 = await deploy("DefaultPoolERC20");
  const collSurplusPool3 = await deploy("CollSurplusPoolERC20");
  const borrowerOperations3 = await deploy("BorrowerOperationsRWA");
  const hintHelpers3 = await deploy("HintHelpersRWA");
  const multiTroveGetter3 = await deploy("MultiTroveGetter", await a(troveManager3), await a(sortedTroves3));
  const branchStaking3 = await deploy("BranchStaking");
  const branchIssuance3 = await deploy("BranchCommunityIssuance");

  console.log("\n— Wiring branch 3 (mTBILL) —");
  await (await orUSD.registerBranch(
    await a(troveManager3), await a(stabilityPool3), await a(borrowerOperations3))).wait();

  await (await sortedTroves3.setParams(maxBytes32, await a(troveManager3), await a(borrowerOperations3))).wait();
  await (await troveManager3.setAddresses(
    await a(borrowerOperations3), await a(activePool3), await a(defaultPool3),
    await a(stabilityPool3), await a(gasPool3), await a(collSurplusPool3),
    await a(wPriceFeed3), await a(orUSD), await a(sortedTroves3),
    await a(oraToken), await a(branchStaking3))).wait();

  // setCollToken + setDebtCap must precede setAddresses (which renounces ownership).
  // The debt cap is the RWA isolation backstop: this branch can never mint
  // more than RWA_DEBT_CAP orUSD regardless of what happens to the RWA.
  await (await borrowerOperations3.setCollToken(await a(wtBill))).wait();
  await (await borrowerOperations3.setDebtCap(ethers.parseEther(RWA_DEBT_CAP))).wait();
  // setGuardian must precede setAddresses (which renounces ownership)
  await (await borrowerOperations3.setGuardian(await a(guardian))).wait();
  await (await borrowerOperations3.setAddresses(
    await a(troveManager3), await a(activePool3), await a(defaultPool3),
    await a(stabilityPool3), await a(gasPool3), await a(collSurplusPool3),
    await a(wPriceFeed3), await a(sortedTroves3), await a(orUSD), await a(branchStaking3))).wait();

  await (await stabilityPool3.setCollToken(await a(wtBill))).wait();
  await (await stabilityPool3.setAddresses(
    await a(borrowerOperations3), await a(troveManager3), await a(activePool3),
    await a(orUSD), await a(sortedTroves3), await a(wPriceFeed3), await a(branchIssuance3))).wait();

  await (await activePool3.setAddresses(
    await a(borrowerOperations3), await a(troveManager3), await a(stabilityPool3),
    await a(defaultPool3), await a(collSurplusPool3), await a(wtBill))).wait();
  await (await defaultPool3.setAddresses(
    await a(troveManager3), await a(activePool3), await a(wtBill))).wait();
  await (await collSurplusPool3.setAddresses(
    await a(borrowerOperations3), await a(troveManager3), await a(activePool3))).wait();
  await (await collSurplusPool3.setCollToken(await a(wtBill))).wait();
  await (await hintHelpers3.setAddresses(await a(sortedTroves3), await a(troveManager3))).wait();

  await (await branchStaking3.setCollToken(await a(wtBill))).wait();
  await (await branchStaking3.setAddresses(
    await a(oraToken), await a(orUSD), await a(troveManager3),
    await a(borrowerOperations3), await a(activePool3))).wait();

  await (await branchIssuance3.setAddresses(await a(oraToken), await a(stabilityPool3))).wait();
  await (await oraToken.connect(treasury).transfer(
    await a(branchIssuance3), ethers.parseEther(RWA_ORA_ALLOCATION))).wait();
  await (await branchIssuance3.activate()).wait();
  console.log(`  branch 3 wired — debt cap ${RWA_DEBT_CAP} orUSD, ${RWA_ORA_ALLOCATION} ORA issuance live`);

  // ---------------- Branch 4: ETH v2 — user-set interest rates ----------------
  // Liquity-v2-style engine: borrowers pick an annual rate, the sorted list is
  // keyed by rate, redemptions hit the cheapest borrowers first, and accrued
  // interest is minted to the InterestRouter (80% sorUSD savers / 20% treasury).
  console.log("\n— Branch 4: ETH v2 (user-set interest rates) —");
  const sortedTroves4 = await deploy("SortedTrovesRates");
  const troveManager4 = await deploy("TroveManagerRates");
  const activePool4 = await deploy("ActivePool");
  const stabilityPool4 = await deploy("StabilityPoolRates");
  const gasPool4 = await deploy("GasPool");
  const defaultPool4 = await deploy("DefaultPool");
  const collSurplusPool4 = await deploy("CollSurplusPool");
  const borrowerOperations4 = await deploy("BorrowerOperationsRates");
  const hintHelpers4 = await deploy("HintHelpersRates", await a(troveManager4));
  const multiTroveGetter4 = await deploy("MultiTroveGetter", await a(troveManager4), await a(sortedTroves4));
  const branchIssuance4 = await deploy("BranchCommunityIssuance");
  const interestRouter = await deploy("InterestRouter");
  const sorUSDVault = await deploy("SorUSDVault", await a(orUSD));

  console.log("\n— Wiring branch 4 (ETH v2 rates) —");
  await (await orUSD.registerBranch(
    await a(troveManager4), await a(stabilityPool4), await a(borrowerOperations4))).wait();

  await (await sortedTroves4.setParams(maxBytes32, await a(troveManager4), await a(borrowerOperations4))).wait();

  // setRatesAddresses must precede setAddresses (which renounces ownership)
  await (await troveManager4.setRatesAddresses(await a(interestRouter), treasury.address)).wait();
  await (await troveManager4.setAddresses(
    await a(borrowerOperations4), await a(activePool4), await a(defaultPool4),
    await a(stabilityPool4), await a(gasPool4), await a(collSurplusPool4),
    await a(priceFeed), await a(orUSD), await a(sortedTroves4),
    await a(oraToken), await a(oraStaking))).wait();
  // setGuardian must precede setAddresses (which renounces ownership)
  await (await borrowerOperations4.setGuardian(await a(guardian))).wait();
  await (await borrowerOperations4.setAddresses(
    await a(troveManager4), await a(activePool4), await a(defaultPool4),
    await a(stabilityPool4), await a(gasPool4), await a(collSurplusPool4),
    await a(priceFeed), await a(sortedTroves4), await a(orUSD), await a(oraStaking))).wait();
  await (await stabilityPool4.setAddresses(
    await a(borrowerOperations4), await a(troveManager4), await a(activePool4),
    await a(orUSD), await a(sortedTroves4), await a(priceFeed), await a(branchIssuance4))).wait();
  await (await activePool4.setAddresses(
    await a(borrowerOperations4), await a(troveManager4), await a(stabilityPool4), await a(defaultPool4))).wait();
  await (await defaultPool4.setAddresses(await a(troveManager4), await a(activePool4))).wait();
  await (await collSurplusPool4.setAddresses(
    await a(borrowerOperations4), await a(troveManager4), await a(activePool4))).wait();

  // Interest routing: 80% to sorUSD savers, 20% to treasury (one-shot wiring)
  await (await interestRouter.setAddresses(await a(orUSD), await a(sorUSDVault), treasury.address)).wait();

  // ORA rewards for the ETH v2 Stability Pool
  await (await branchIssuance4.setAddresses(await a(oraToken), await a(stabilityPool4))).wait();
  await (await oraToken.connect(treasury).transfer(
    await a(branchIssuance4), ethers.parseEther(ETH2_ORA_ALLOCATION))).wait();
  await (await branchIssuance4.activate()).wait();

  // One-click leverage: demo orUSD/ETH AMM + per-user LeverZap proxies.
  // On a public chain the zapper would route through a real DEX instead.
  const swapPool = await deploy("OraSwapPool", await a(orUSD));
  const leverZapFactory = await deploy("LeverZapFactory",
    await a(borrowerOperations4), await a(troveManager4), await a(priceFeed),
    await a(swapPool), await a(orUSD));
  console.log("  branch 4 wired — rates engine + sorUSD vault + swap pool + LeverZap factory live");

  // ---------------- Governance: freeze the branch set ----------------
  // The branch registrar is the ONE live admin power (it can add new
  // orUSD-minting branches). Keep it during development; renounce it on
  // production deploys so the core is fully immutable.
  if (process.env.ORA_RENOUNCE_REGISTRAR === "1") {
    await (await orUSD.renounceBranchRegistrar()).wait();
    console.log("\n  branch registrar RENOUNCED — the orUSD branch set is now immutable");
  } else {
    console.log("\n  branch registrar kept live (dev mode) — set ORA_RENOUNCE_REGISTRAR=1 to freeze the branch set");
  }

  // ---------------- Export ----------------
  const abi = name => {
    const hits = [
      `contracts/${name}.sol/${name}.json`,
      `contracts/LQTY/${name}.sol/${name}.json`,
      `contracts/TestContracts/${name}.sol/${name}.json`,
      `contracts/branches/${name}.sol/${name}.json`,
      `contracts/oracles/${name}.sol/${name}.json`,
      `contracts/rates/${name}.sol/${name}.json`,
      `contracts/rwa/${name}.sol/${name}.json`,
      `contracts/rwa/WTBill.sol/${name}.json`,
      `contracts/zap/${name}.sol/${name}.json`,
      `contracts/zap/LeverZap.sol/${name}.json`,
      `contracts/guardian/${name}.sol/${name}.json`,
      `contracts/keeper/${name}.sol/${name}.json`
    ];
    for (const h of hits) {
      const p = path.join(__dirname, "..", "artifacts", h);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p)).abi;
    }
    throw new Error("artifact not found: " + name);
  };

  const out = {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    shared: {
      sequencerUptimeFeed: sequencerFeedAddr,
      sequencerSettable,
      ethUsdFallbackAggregator: ethUsdFallbackAddr,
      ethUsdFallbackSettable,
      orUSDToken: await a(orUSD),
      oraToken: await a(oraToken),
      oraStaking: await a(oraStaking),
      communityIssuance: await a(communityIssuance),
      lockupFactory: await a(lockupFactory),
      guardian: await a(guardian),
      guardianHolder,
      batchLiquidator: await a(batchLiquidator)
    },
    branches: {
      ETH: {
        native: true,
        collSymbol: "ETH",
        mcr: 1.1, ccr: 1.5, softFloor: 1.05,
        priceFeed: await a(priceFeed),
        ethUsdAggregator: ethUsdAggregatorAddr,
        ethUsdSettable,
        sortedTroves: await a(sortedTroves),
        troveManager: await a(troveManager),
        activePool: await a(activePool),
        stabilityPool: await a(stabilityPool),
        gasPool: await a(gasPool),
        defaultPool: await a(defaultPool),
        collSurplusPool: await a(collSurplusPool),
        borrowerOperations: await a(borrowerOperations),
        hintHelpers: await a(hintHelpers),
        multiTroveGetter: await a(multiTroveGetter)
      },
      wstETH: {
        native: false,
        collSymbol: "wstETH",
        mcr: 1.1, ccr: 1.5, softFloor: 1.05,
        collToken: await a(wstETH),
        priceFeed: await a(priceFeed2),
        ethUsdAggregator: ethUsdAggregatorAddr,
        ethUsdSettable,
        stEthEthAggregator: await a(aggStEthEth),
        sortedTroves: await a(sortedTroves2),
        troveManager: await a(troveManager2),
        activePool: await a(activePool2),
        stabilityPool: await a(stabilityPool2),
        gasPool: await a(gasPool2),
        defaultPool: await a(defaultPool2),
        collSurplusPool: await a(collSurplusPool2),
        borrowerOperations: await a(borrowerOperations2),
        hintHelpers: await a(hintHelpers2),
        multiTroveGetter: await a(multiTroveGetter2),
        branchStaking: await a(branchStaking2),
        communityIssuance: await a(branchIssuance2),
        faucetAmount: "10"
      },
      tBILL: {
        native: false,
        rwa: true,
        collSymbol: "wmTBILL",
        mcr: 1.05, ccr: 1.15, softFloor: 1.03,
        collToken: await a(wtBill),
        underlyingToken: await a(tBill),
        underlyingSymbol: "mTBILL",
        skimRatePerYear: 0.02,
        priceFeed: await a(wPriceFeed3),
        navPriceFeed: await a(priceFeed3),
        navAggregator: await a(aggNav),
        sortedTroves: await a(sortedTroves3),
        troveManager: await a(troveManager3),
        activePool: await a(activePool3),
        stabilityPool: await a(stabilityPool3),
        gasPool: await a(gasPool3),
        defaultPool: await a(defaultPool3),
        collSurplusPool: await a(collSurplusPool3),
        borrowerOperations: await a(borrowerOperations3),
        hintHelpers: await a(hintHelpers3),
        multiTroveGetter: await a(multiTroveGetter3),
        branchStaking: await a(branchStaking3),
        communityIssuance: await a(branchIssuance3),
        debtCap: RWA_DEBT_CAP,
        faucetAmount: "10000"
      }
      ,
      ETHv2: {
        native: true,
        rates: true,
        collSymbol: "ETH",
        mcr: 1.1, ccr: 1.5, softFloor: 1.05,
        priceFeed: await a(priceFeed),
        ethUsdAggregator: ethUsdAggregatorAddr,
        ethUsdSettable,
        sortedTroves: await a(sortedTroves4),
        troveManager: await a(troveManager4),
        activePool: await a(activePool4),
        stabilityPool: await a(stabilityPool4),
        gasPool: await a(gasPool4),
        defaultPool: await a(defaultPool4),
        collSurplusPool: await a(collSurplusPool4),
        borrowerOperations: await a(borrowerOperations4),
        hintHelpers: await a(hintHelpers4),
        multiTroveGetter: await a(multiTroveGetter4),
        communityIssuance: await a(branchIssuance4),
        interestRouter: await a(interestRouter),
        sorUSDVault: await a(sorUSDVault),
        swapPool: await a(swapPool),
        leverZapFactory: await a(leverZapFactory)
      }
    },
    abis: {
      priceFeed: abi("ChainlinkPriceFeed"),
      priceFeedWstETH: abi("WstETHPriceFeed"),
      settableAggregator: abi("SettableAggregator"),
      troveManager: abi("TroveManager"),
      borrowerOperations: abi("BorrowerOperations"),
      borrowerOperationsERC20: abi("BorrowerOperationsERC20"),
      stabilityPool: abi("StabilityPool"),
      stabilityPoolERC20: abi("StabilityPoolERC20"),
      orUSDToken: abi("LUSDToken"),
      oraToken: abi("LQTYToken"),
      oraStaking: abi("LQTYStaking"),
      sortedTroves: abi("SortedTroves"),
      hintHelpers: abi("HintHelpers"),
      multiTroveGetter: abi("MultiTroveGetter"),
      mockWstETH: abi("MockWstETH"),
      mockTBill: abi("MockTBill"),
      priceFeedRWA: abi("RWAPriceFeed"),
      troveManagerV2: abi("TroveManagerV2"),
      branchStaking: abi("BranchStaking"),
      branchCommunityIssuance: abi("BranchCommunityIssuance"),
      troveManagerRates: abi("TroveManagerRates"),
      borrowerOperationsRates: abi("BorrowerOperationsRates"),
      stabilityPoolRates: abi("StabilityPoolRates"),
      hintHelpersRates: abi("HintHelpersRates"),
      sorUSDVault: abi("SorUSDVault"),
      interestRouter: abi("InterestRouter"),
      troveManagerRWA: abi("TroveManagerRWA"),
      borrowerOperationsRWA: abi("BorrowerOperationsRWA"),
      stabilityPoolRWA: abi("StabilityPoolRWA"),
      wtBill: abi("WTBill"),
      wtBillPriceFeed: abi("WTBillPriceFeed"),
      oraSwapPool: abi("OraSwapPool"),
      leverZap: abi("LeverZap"),
      leverZapFactory: abi("LeverZapFactory"),
      guardian: abi("OraGuardian"),
      batchLiquidator: abi("BatchLiquidator")
    }
  };

  const suffix = network.name === "localhost" || network.name === "hardhat" ? "" : "-" + network.name;
  const outPath = path.join(__dirname, "..", "app", `deployment${suffix}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("\nDeployment written to", outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
