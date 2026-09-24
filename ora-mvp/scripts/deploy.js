// ORA Protocol — Phase 1 multi-branch deployment.
// Branch 1: native ETH (upstream Liquity engine, unchanged)
// Branch 2: wstETH (ERC20-collateral pool suite, same TroveManager bytecode)
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
const ORACLE_TIMEOUT = 48 * 3600; // generous staleness window for testnets

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
    ethUsdAggregatorAddr = REAL_FEEDS[network.name].ethUsd;
    ethUsdSettable = false;
    console.log(`  using real Chainlink ETH/USD: ${ethUsdAggregatorAddr}`);
  } else {
    const aggEthUsd = await deploy("SettableAggregator", 8, "ETH / USD", 2000n * 10n ** 8n);
    ethUsdAggregatorAddr = await a(aggEthUsd);
    ethUsdSettable = true;
  }
  // No canonical stETH/ETH feed on Base Sepolia -> settable mock everywhere
  // (also powers the depeg circuit-breaker demo).
  const aggStEthEth = await deploy("SettableAggregator", 18, "stETH / ETH", ethers.parseEther("1"));

  const priceFeed = await deploy("ChainlinkPriceFeed", ethUsdAggregatorAddr, ORACLE_TIMEOUT);
  const priceFeed2 = await deploy("WstETHPriceFeed",
    ethUsdAggregatorAddr, await a(aggStEthEth), await a(wstETH), ORACLE_TIMEOUT);
  console.log(`  ETH/USD: $${ethers.formatEther(await priceFeed.getPrice())}` +
    ` | wstETH/USD: $${ethers.formatEther(await priceFeed2.getPrice())}`);

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

  // ---------------- Branch 1 wiring ----------------
  console.log("\n— Wiring branch 1 (ETH) —");
  await (await sortedTroves.setParams(maxBytes32, await a(troveManager), await a(borrowerOperations))).wait();
  await (await troveManager.setAddresses(
    await a(borrowerOperations), await a(activePool), await a(defaultPool),
    await a(stabilityPool), await a(gasPool), await a(collSurplusPool),
    await a(priceFeed), await a(orUSD), await a(sortedTroves),
    await a(oraToken), await a(oraStaking))).wait();
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
    await a(branchIssuance2), ethers.parseEther("1000000"))).wait();
  await (await branchIssuance2.activate()).wait();
  console.log("  branch 2 wired — BranchStaking + 1M ORA issuance live");

  // ---------------- Export ----------------
  const abi = name => {
    const hits = [
      `contracts/${name}.sol/${name}.json`,
      `contracts/LQTY/${name}.sol/${name}.json`,
      `contracts/TestContracts/${name}.sol/${name}.json`,
      `contracts/branches/${name}.sol/${name}.json`,
      `contracts/oracles/${name}.sol/${name}.json`
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
      orUSDToken: await a(orUSD),
      oraToken: await a(oraToken),
      oraStaking: await a(oraStaking),
      communityIssuance: await a(communityIssuance),
      lockupFactory: await a(lockupFactory)
    },
    branches: {
      ETH: {
        native: true,
        collSymbol: "ETH",
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
        communityIssuance: await a(branchIssuance2)
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
      troveManagerV2: abi("TroveManagerV2"),
      branchStaking: abi("BranchStaking"),
      branchCommunityIssuance: abi("BranchCommunityIssuance")
    }
  };

  const suffix = network.name === "localhost" || network.name === "hardhat" ? "" : "-" + network.name;
  const outPath = path.join(__dirname, "..", "app", `deployment${suffix}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("\nDeployment written to", outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
