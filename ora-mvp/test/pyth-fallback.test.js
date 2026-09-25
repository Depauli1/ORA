// PythFallbackAggregator: exponent scaling, fail-safe mappings, and the
// two-source confirm path through the real ChainlinkPriceFeed machinery.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E } = require("./helpers");

const ETH_ID = ethers.keccak256(ethers.toUtf8Bytes("pyth ETH/USD"));

async function pythFixture() {
  const deploy = async (name, ...args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const pyth = await deploy("MockPyth");
  await pyth.setPrice(ETH_ID, 2000n * 10n ** 8n, 1000000n, -8, await time.latest());
  const agg = await deploy("PythFallbackAggregator", await pyth.getAddress(), ETH_ID);
  return { pyth, agg };
}

describe("PythFallbackAggregator", () => {
  it("scales any Pyth exponent to 8 decimals", async () => {
    const { pyth, agg } = await loadFixture(pythFixture);
    const now = await time.latest();
    // expo -8: identity
    expect((await agg.latestRoundData())[1]).to.equal(2000n * 10n ** 8n);
    // expo -6: $2000.00 -> x100
    await pyth.setPrice(ETH_ID, 2000n * 10n ** 6n, 100n, -6, now);
    expect((await agg.latestRoundData())[1]).to.equal(2000n * 10n ** 8n);
    // expo -10: $2000.0000000000 -> /100
    await pyth.setPrice(ETH_ID, 2000n * 10n ** 10n, 10n ** 10n, -10, now);
    expect((await agg.latestRoundData())[1]).to.equal(2000n * 10n ** 8n);
    expect(await agg.decimals()).to.equal(8);
    expect(await agg.description()).to.equal("Pyth fallback");
    expect(await agg.version()).to.equal(1);
  });

  it("round fields track publishTime; getRoundData mirrors latest", async () => {
    const { agg } = await loadFixture(pythFixture);
    const [rid, , started, updated, air] = await agg.latestRoundData();
    expect(rid).to.equal(updated);
    expect(started).to.equal(updated);
    expect(air).to.equal(updated);
    expect([await agg.getRoundData(999)]).to.deep.equal([[rid, 2000n * 10n ** 8n, started, updated, air]]);
  });

  it("zero/negative Pyth prices surface as answer 0 (reader rejects)", async () => {
    const { pyth, agg } = await loadFixture(pythFixture);
    const now = await time.latest();
    await pyth.setPrice(ETH_ID, 0n, 0n, -8, now);
    expect((await agg.latestRoundData())[1]).to.equal(0n);
    await pyth.setPrice(ETH_ID, -500n, 0n, -8, now);
    expect((await agg.latestRoundData())[1]).to.equal(0n);
  });

  it("constructor fails closed: zero pyth / zero id / unpublished id", async () => {
    const { pyth } = await loadFixture(pythFixture);
    const A = await ethers.getContractFactory("PythFallbackAggregator");
    await expect(A.deploy(ethers.ZeroAddress, ETH_ID)).to.be.reverted;
    await expect(A.deploy(await pyth.getAddress(), ethers.ZeroHash)).to.be.revertedWith("PythFallback: zero price id");
    const unknown = ethers.keccak256(ethers.toUtf8Bytes("nope"));
    await expect(A.deploy(await pyth.getAddress(), unknown)).to.be.reverted;
    // published but unusable initial readings fail the deploy probe too
    const now = await time.latest();
    await pyth.setPrice(ETH_ID, 2000n * 10n ** 8n, 0n, -8, now + 3600);
    await expect(A.deploy(await pyth.getAddress(), ETH_ID)).to.be.revertedWith("PythFallback: bad initial price");
    await pyth.setPrice(ETH_ID, 0n, 0n, -8, now);
    await expect(A.deploy(await pyth.getAddress(), ETH_ID)).to.be.revertedWith("PythFallback: bad initial price");
  });

  it("two-source confirm through the real adapter: Pyth-confirmed crash accepted", async () => {
    const { pyth, agg } = await loadFixture(pythFixture);
    const deploy = async (name, ...args) => {
      const c = await (await ethers.getContractFactory(name)).deploy(...args);
      await c.waitForDeployment();
      return c;
    };
    const aggP = await deploy("SettableAggregator", 8, "ETH / USD", 2000n * 10n ** 8n);
    const feed = await deploy("ChainlinkPriceFeed",
      await aggP.getAddress(), 3600, ethers.ZeroAddress, await agg.getAddress(), 1000);
    // primary crashes -20% unconfirmed -> frozen
    await aggP.setAnswer(1600n * 10n ** 8n);
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(false);
    // Pyth confirms $1605 -> accepted, live
    await pyth.setPrice(ETH_ID, 1605n * 10n ** 8n, 1000000n, -8, await time.latest());
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(true);
    expect(await feed.getPrice()).to.equal(E("1600"));
  });

  it("stale Pyth publishTime is governed by the feed heartbeat", async () => {
    const { pyth, agg } = await loadFixture(pythFixture);
    const deploy = async (name, ...args) => {
      const c = await (await ethers.getContractFactory(name)).deploy(...args);
      await c.waitForDeployment();
      return c;
    };
    const aggP = await deploy("SettableAggregator", 8, "ETH / USD", 2000n * 10n ** 8n);
    const feed = await deploy("ChainlinkPriceFeed",
      await aggP.getAddress(), 3600, ethers.ZeroAddress, await agg.getAddress(), 1000);
    await aggP.makeStale(7200); // primary down; Pyth must serve...
    await pyth.setPrice(ETH_ID, 2000n * 10n ** 8n, 1000000n, -8, (await time.latest()) - 7200);
    await feed.fetchPrice(); // ...but its publishTime is past the heartbeat
    expect(await feed.oracleLive()).to.equal(false);
    expect(await feed.usingFallback()).to.equal(false);
  });
});
