// ORA Protocol — full core deployment + wiring for the local testnet.
// Mirrors packages/contracts/utils/deploymentHelpers.js (connectCoreContracts et al).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { ethers } = hre;
const maxBytes32 = "0x" + "f".repeat(64);

async function main() {
  const [deployer, , , , treasury] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const deploy = async (name, ...args) => {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    console.log(`  ${name.padEnd(22)} ${await c.getAddress()}`);
    return c;
  };

  console.log("\n— Deploying ORA core —");
  const priceFeed = await deploy("PriceFeedTestnet");
  const sortedTroves = await deploy("SortedTroves");
  const troveManager = await deploy("TroveManager");
  const activePool = await deploy("ActivePool");
  const stabilityPool = await deploy("StabilityPool");
  const gasPool = await deploy("GasPool");
  const defaultPool = await deploy("DefaultPool");
  const collSurplusPool = await deploy("CollSurplusPool");
  const borrowerOperations = await deploy("BorrowerOperations");
  const hintHelpers = await deploy("HintHelpers");

  // orUSD stablecoin (contract identifier kept as LUSDToken to minimize audit diff)
  const orUSD = await deploy(
    "LUSDToken",
    await troveManager.getAddress(),
    await stabilityPool.getAddress(),
    await borrowerOperations.getAddress()
  );

  console.log("\n— Deploying ORA token & staking —");
  const communityIssuance = await deploy("CommunityIssuance");
  const oraStaking = await deploy("LQTYStaking");
  const lockupFactory = await deploy("LockupContractFactory");
  const oraToken = await deploy(
    "LQTYToken",
    await communityIssuance.getAddress(),
    await oraStaking.getAddress(),
    await lockupFactory.getAddress(),
    treasury.address, // bounty / faucet treasury (transferable from day 1)
    treasury.address, // LP rewards
    deployer.address  // multisig (transfer-locked for year 1 by design)
  );

  const multiTroveGetter = await deploy(
    "MultiTroveGetter",
    await troveManager.getAddress(),
    await sortedTroves.getAddress()
  );

  console.log("\n— Wiring contracts —");
  const a = async c => await c.getAddress();

  await (await sortedTroves.setParams(maxBytes32, await a(troveManager), await a(borrowerOperations))).wait();
  await (await troveManager.setAddresses(
    await a(borrowerOperations), await a(activePool), await a(defaultPool),
    await a(stabilityPool), await a(gasPool), await a(collSurplusPool),
    await a(priceFeed), await a(orUSD), await a(sortedTroves),
    await a(oraToken), await a(oraStaking)
  )).wait();
  await (await borrowerOperations.setAddresses(
    await a(troveManager), await a(activePool), await a(defaultPool),
    await a(stabilityPool), await a(gasPool), await a(collSurplusPool),
    await a(priceFeed), await a(sortedTroves), await a(orUSD), await a(oraStaking)
  )).wait();
  await (await stabilityPool.setAddresses(
    await a(borrowerOperations), await a(troveManager), await a(activePool),
    await a(orUSD), await a(sortedTroves), await a(priceFeed), await a(communityIssuance)
  )).wait();
  await (await activePool.setAddresses(
    await a(borrowerOperations), await a(troveManager), await a(stabilityPool), await a(defaultPool)
  )).wait();
  await (await defaultPool.setAddresses(await a(troveManager), await a(activePool))).wait();
  await (await collSurplusPool.setAddresses(
    await a(borrowerOperations), await a(troveManager), await a(activePool)
  )).wait();
  await (await hintHelpers.setAddresses(await a(sortedTroves), await a(troveManager))).wait();
  await (await lockupFactory.setLQTYTokenAddress(await a(oraToken))).wait();
  await (await oraStaking.setAddresses(
    await a(oraToken), await a(orUSD), await a(troveManager),
    await a(borrowerOperations), await a(activePool)
  )).wait();
  await (await communityIssuance.setAddresses(await a(oraToken), await a(stabilityPool))).wait();
  console.log("  wiring complete");

  // Demo market conditions: ETH at $2,000
  await (await priceFeed.setPrice(ethers.parseEther("2000"))).wait();
  console.log("  ETH price set to $2000");

  // Export addresses + ABIs for the frontend
  const abi = name => {
    const hits = [
      `contracts/${name}.sol/${name}.json`,
      `contracts/LQTY/${name}.sol/${name}.json`,
      `contracts/TestContracts/${name}.sol/${name}.json`
    ];
    for (const h of hits) {
      const p = path.join(__dirname, "..", "artifacts", h);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p)).abi;
    }
    throw new Error("artifact not found: " + name);
  };

  const out = {
    chainId: 31337,
    deployer: deployer.address,
    addresses: {
      priceFeed: await a(priceFeed),
      sortedTroves: await a(sortedTroves),
      troveManager: await a(troveManager),
      activePool: await a(activePool),
      stabilityPool: await a(stabilityPool),
      gasPool: await a(gasPool),
      defaultPool: await a(defaultPool),
      collSurplusPool: await a(collSurplusPool),
      borrowerOperations: await a(borrowerOperations),
      hintHelpers: await a(hintHelpers),
      orUSDToken: await a(orUSD),
      communityIssuance: await a(communityIssuance),
      oraStaking: await a(oraStaking),
      lockupFactory: await a(lockupFactory),
      oraToken: await a(oraToken),
      multiTroveGetter: await a(multiTroveGetter)
    },
    abis: {
      priceFeed: abi("PriceFeedTestnet"),
      troveManager: abi("TroveManager"),
      borrowerOperations: abi("BorrowerOperations"),
      stabilityPool: abi("StabilityPool"),
      orUSDToken: abi("LUSDToken"),
      oraToken: abi("LQTYToken"),
      oraStaking: abi("LQTYStaking"),
      sortedTroves: abi("SortedTroves"),
      hintHelpers: abi("HintHelpers"),
      multiTroveGetter: abi("MultiTroveGetter")
    }
  };

  const outPath = path.join(__dirname, "..", "app", "deployment.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("\nDeployment written to", outPath);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
