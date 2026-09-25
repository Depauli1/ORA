// Finding 6: fork tests against Base Sepolia (run in CI, hermetic suite skips).
//
// Activated ONLY when ORA_FORK_URL is set (hardhat.config.js enables forking
// from that URL at the latest block). Highest-value assertion: the hardcoded
// REAL_FEEDS default in scripts/deploy.js is a live ETH/USD aggregator with a
// sane price — if Chainlink ever rotates it, this test (not mainnet users)
// finds out first.
//
// Public-RPC flakiness is absorbed by retrying each network touch up to 3x;
// the suite still FAILS if the endpoint is truly unusable.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const FORK = !!process.env.ORA_FORK_URL;
// MUST match REAL_FEEDS.baseSepolia.ethUsd in scripts/deploy.js (independent,
// hardcoded on purpose: drift between the two must be reconciled by a human).
const BASE_SEPOLIA_ETHUSD = "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1";

async function retry(label, fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) { last = e; console.log(`  [fork-retry] ${label} attempt ${i}/${tries}: ${String(e.message || e).slice(0, 100)}`); }
    await new Promise((r) => setTimeout(r, 2000 * i));
  }
  throw last;
}

(FORK ? describe : describe.skip)("fork reads — Base Sepolia", () => {
  // Mine one local block first: until a local block exists, eth_calls execute
  // "on the historical fork block" and EDR errors out (it has no hardfork
  // history for chain 84532). A zero-value self-transfer is the cheapest way
  // to move execution onto a local block; timestamps stay fork-accurate.
  before(async () => {
    const [signer] = await ethers.getSigners();
    await (await signer.sendTransaction({ to: signer.address, value: 0 })).wait();
  });

  it("forked state is present (remote contract code is visible)", async () => {
    // NOTE: Hardhat keeps the LOCAL chainId (31337) in fork mode, so an
    // eth_chainId assertion would be wrong — remote code presence is the
    // real proof that forking works.
    const code = await retry("getCode", () => ethers.provider.getCode(BASE_SEPOLIA_ETHUSD));
    expect(code).to.not.equal("0x");
    const block = await retry("getBlockNumber", () => ethers.provider.getBlockNumber());
    expect(block).to.be.greaterThan(1_000_000); // a real L2 height, not a fresh chain
  });

  it("REAL_FEEDS default is a live ETH/USD aggregator with a sane price", async () => {
    const agg = new ethers.Contract(BASE_SEPOLIA_ETHUSD, [
      "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
      "function decimals() view returns (uint8)",
      "function description() view returns (string)",
    ], ethers.provider);
    const desc = await retry("description", () => agg.description());
    expect(desc).to.match(/ETH.*USD/i);
    const dec = Number(await retry("decimals", () => agg.decimals()));
    expect(dec).to.equal(8);
    const [, answer, , updatedAt] = await retry("latestRoundData", () => agg.latestRoundData());
    const usd = Number(answer) / 1e8;
    expect(usd).to.be.greaterThan(100);   // sanity band, not a price prediction
    expect(usd).to.be.lessThan(100000);
    const age = (await ethers.provider.getBlock("latest")).timestamp - Number(updatedAt);
    expect(age).to.be.lessThan(48 * 3600); // within the deploy probe window
  });

  it("ChainlinkPriceFeed + PythFallbackAggregator verify against fork state", async () => {
    const deploy = async (name, ...args) => {
      const c = await retry(`deploy ${name}`, () => ethers.deployContract(name, args));
      await c.waitForDeployment();
      return c;
    };
    // Pyth side stays a mock (no canonical testnet id pinned); the point is
    // the REAL primary aggregator drives the feed end-to-end on fork state.
    const pyth = await deploy("MockPyth");
    const id = ethers.keccak256(ethers.toUtf8Bytes("fork ETH/USD"));
    const agg = new ethers.Contract(BASE_SEPOLIA_ETHUSD,
      ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], ethers.provider);
    const [, answer, , updatedAt] = await retry("latestRoundData", () => agg.latestRoundData());
    await pyth.setPrice(id, answer, 1000000n, -8, updatedAt); // mock confirms reality
    const fb = await deploy("PythFallbackAggregator", await pyth.getAddress(), id);
    const feed = await deploy("ChainlinkPriceFeed",
      BASE_SEPOLIA_ETHUSD, 48 * 3600, ethers.ZeroAddress, await fb.getAddress(), 1000);
    await retry("fetchPrice", () => feed.fetchPrice());
    expect(await feed.oracleLive()).to.equal(true);
    const px = Number(await feed.getPrice()) / 1e18;
    expect(px).to.be.greaterThan(100);
    expect(px).to.be.lessThan(100000);
    expect(await feed.usingFallback()).to.equal(false); // real primary serves
  });
});
