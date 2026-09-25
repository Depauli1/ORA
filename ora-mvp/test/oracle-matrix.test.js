// ChainlinkPriceFeed two-source matrix: primary x fallback (fresh/stale/
// broken) x deviation (inside/outside 10%) x sequencer (up/down/grace).
// Every cell asserts the served price AND the live/fallback flags.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E } = require("./helpers");

const P0 = 2000n * 10n ** 8n; // $2000, 8 decimals
const E2000 = E("2000");

async function matrixFixture() {
  const [deployer] = await ethers.getSigners();
  void deployer;
  const deploy = async (name, ...args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const aggP = await deploy("SettableAggregator", 8, "ETH / USD", P0);
  const aggF = await deploy("SettableAggregator", 8, "ETH / USD (fb)", P0);
  const aggS = await deploy("SettableAggregator", 0, "L2 Sequencer Up", 0n);
  await aggS.makeStale(7200); // sequencer up long ago (past the 1h grace)
  const feed = await deploy("ChainlinkPriceFeed",
    await aggP.getAddress(), 3600, await aggS.getAddress(), await aggF.getAddress(), 1000);
  return { aggP, aggF, aggS, feed };
}

async function fetchStatic(feed) {
  return feed.fetchPrice.staticCall();
}

describe("Oracle matrix (ChainlinkPriceFeed, 10% deviation)", () => {
  it("both fresh, small move: primary serves, live, no fallback", async () => {
    const { aggP, feed } = await loadFixture(matrixFixture);
    await aggP.setAnswer(2050n * 10n ** 8n); // +2.5%
    await expect(feed.fetchPrice()).to.emit(feed, "LastGoodPriceUpdated").withArgs(E("2050"));
    expect(await feed.oracleLive()).to.equal(true);
    expect(await feed.usingFallback()).to.equal(false);
    expect(await feed.getPrice()).to.equal(E("2050"));
  });

  it("primary stale + fallback fresh: fallback serves, usingFallback flips", async () => {
    const { aggP, aggF, feed } = await loadFixture(matrixFixture);
    await aggP.makeStale(7200);
    await aggF.setAnswer(2010n * 10n ** 8n);
    await expect(feed.fetchPrice()).to.emit(feed, "FallbackStatusChanged").withArgs(true);
    expect(await feed.usingFallback()).to.equal(true);
    expect(await feed.oracleLive()).to.equal(true);
    expect(await feed.getPrice()).to.equal(E("2010"));
    // primary recovers -> flips back
    await aggP.setAnswer(2010n * 10n ** 8n);
    await expect(feed.fetchPrice()).to.emit(feed, "FallbackStatusChanged").withArgs(false);
    expect(await feed.usingFallback()).to.equal(false);
  });

  it("both stale: lastGoodPrice served, oracle flagged down", async () => {
    const { aggP, aggF, feed } = await loadFixture(matrixFixture);
    await aggP.makeStale(7200);
    await aggF.makeStale(7200);
    await expect(feed.fetchPrice()).to.emit(feed, "OracleStatusChanged").withArgs(false);
    expect(await feed.oracleLive()).to.equal(false);
    expect(await fetchStatic(feed)).to.equal(E2000);
    expect(await feed.getPrice()).to.equal(E2000); // view mirrors the freeze
  });

  it("unconfirmed -20% primary move: frozen (single-source manipulation fails)", async () => {
    const { aggP, feed } = await loadFixture(matrixFixture);
    await aggP.setAnswer(1600n * 10n ** 8n); // fallback still $2000
    expect(await fetchStatic(feed)).to.equal(E2000);
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(false);
  });

  it("confirmed -20% move (both sources agree): accepted, stays live", async () => {
    const { aggP, aggF, feed } = await loadFixture(matrixFixture);
    await aggP.setAnswer(1600n * 10n ** 8n);
    await aggF.setAnswer(1605n * 10n ** 8n); // within 10% of primary -> confirms
    await expect(feed.fetchPrice()).to.emit(feed, "LastGoodPriceUpdated").withArgs(E("1600"));
    expect(await feed.oracleLive()).to.equal(true);
    expect(await feed.usingFallback()).to.equal(false);
  });

  it("broken primary (0/negative answer): fallback serves", async () => {
    const { aggP, aggF, feed } = await loadFixture(matrixFixture);
    await aggP.setAnswer(0n);
    await aggF.setAnswer(1990n * 10n ** 8n);
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(true);
    expect(await feed.usingFallback()).to.equal(true);
    expect(await feed.getPrice()).to.equal(E("1990"));
  });

  it("fallback big move while primary stale: frozen (fallback also deviation-capped)", async () => {
    const { aggP, aggF, feed } = await loadFixture(matrixFixture);
    await aggP.makeStale(7200);
    await aggF.setAnswer(1500n * 10n ** 8n); // -25% vs lastGoodPrice
    expect(await fetchStatic(feed)).to.equal(E2000);
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(false);
  });

  it("sequencer down: frozen despite fresh feeds", async () => {
    const { aggS, feed } = await loadFixture(matrixFixture);
    await aggS.setAnswer(1n);
    expect(await fetchStatic(feed)).to.equal(E2000);
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(false);
  });

  it("sequencer just restarted (in grace): frozen; after 1h: live again", async () => {
    const { aggS, aggP, feed } = await loadFixture(matrixFixture);
    await aggS.setAnswer(0n); // fresh 0 = restarted, inside grace
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(false);
    await time.increase(3601);
    await aggP.setAnswer(P0); // keep primary fresh across the warp
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(true);
  });

  it("recovers cleanly: freeze then healthy flips live again", async () => {
    const { aggP, aggF, feed } = await loadFixture(matrixFixture);
    await aggP.makeStale(7200);
    await aggF.makeStale(7200);
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(false);
    await aggP.setAnswer(P0);
    await expect(feed.fetchPrice()).to.emit(feed, "OracleStatusChanged").withArgs(true);
    expect(await feed.oracleLive()).to.equal(true);
  });

  it("constructor reverts: sequencer down / bad deviation / stale primary at deploy", async () => {
    const { aggP, aggF, aggS } = await loadFixture(matrixFixture);
    const F = await ethers.getContractFactory("ChainlinkPriceFeed");
    const P = await aggP.getAddress(), B = await aggF.getAddress(), S = await aggS.getAddress();
    await aggS.setAnswer(1n);
    await expect(F.deploy(P, 3600, S, B, 1000))
      .to.be.revertedWith("ChainlinkPriceFeed: sequencer down at deploy");
    await aggS.setAnswer(0n);
    await aggS.makeStale(7200); // up long ago — past the restart grace
    await expect(F.deploy(P, 3600, S, B, 0)).to.be.revertedWith("ChainlinkPriceFeed: bad deviation");
    await expect(F.deploy(P, 3600, S, B, 10001)).to.be.revertedWith("ChainlinkPriceFeed: bad deviation");
    await aggP.makeStale(7200);
    await expect(F.deploy(P, 3600, S, B, 1000))
      .to.be.revertedWith("ChainlinkPriceFeed: initial feed response invalid");
  });
});

describe("Oracle edges (reader guards, RWA views, sequencer faults)", () => {
  it("future-dated primary round is rejected (stale clock, not a price)", async () => {
    const { aggF, feed } = await loadFixture(matrixFixture);
    void aggF;
    const Fut = await ethers.getContractFactory("MockFutureAggregator");
    const fut = await Fut.deploy(P0);
    const F = await ethers.getContractFactory("ChainlinkPriceFeed");
    // constructor reads the primary at deploy: future round -> invalid
    const aggP2 = await (await ethers.getContractFactory("SettableAggregator"))
      .deploy(8, "ETH / USD", P0);
    const feed2 = await F.deploy(await aggP2.getAddress(), 3600, ethers.ZeroAddress,
      await fut.getAddress(), 1000);
    await aggP2.makeStale(7200); // primary stale; fallback is future-dated
    expect(await feed2.fetchPrice.staticCall()).to.equal(E2000);
    await feed2.fetchPrice();
    expect(await feed2.oracleLive()).to.equal(false);
  });

  it("reverting aggregator triggers the catch branch (no revert propagation)", async () => {
    const Rev = await ethers.getContractFactory("MockRevertingAggregator");
    const rev = await Rev.deploy();
    const aggP2 = await (await ethers.getContractFactory("SettableAggregator"))
      .deploy(8, "ETH / USD", P0);
    const F = await ethers.getContractFactory("ChainlinkPriceFeed");
    const feed2 = await F.deploy(await aggP2.getAddress(), 3600, ethers.ZeroAddress,
      await rev.getAddress(), 1000);
    await aggP2.makeStale(7200); // primary stale; fallback reverts
    await feed2.fetchPrice();
    expect(await feed2.oracleLive()).to.equal(false);
    expect(await feed2.getPrice()).to.equal(E2000);
  });

  it(">18-decimal feeds scale down (reader _scalePrice branch)", async () => {
    const agg20 = await (await ethers.getContractFactory("SettableAggregator"))
      .deploy(20, "BIG", 2000n * 10n ** 20n);
    const F = await ethers.getContractFactory("ChainlinkPriceFeed");
    const feed2 = await F.deploy(await agg20.getAddress(), 3600, ethers.ZeroAddress,
      ethers.ZeroAddress, 1000);
    expect(await feed2.getPrice()).to.equal(E("2000"));
  });

  it("sequencer nonsense round / broken feed read as down", async () => {
    const { aggP, aggF } = await loadFixture(matrixFixture);
    const F = await ethers.getContractFactory("ChainlinkPriceFeed");
    const P = await aggP.getAddress(), B = await aggF.getAddress();
    const fut0 = await (await ethers.getContractFactory("MockFutureAggregator")).deploy(0n);
    await expect(F.deploy(P, 3600, await fut0.getAddress(), B, 1000))
      .to.be.revertedWith("ChainlinkPriceFeed: sequencer down at deploy");
    const rev = await (await ethers.getContractFactory("MockRevertingAggregator")).deploy();
    await expect(F.deploy(P, 3600, await rev.getAddress(), B, 1000))
      .to.be.revertedWith("ChainlinkPriceFeed: sequencer down at deploy");
  });

  it("RWAPriceFeed views: getNav health, frozen getPrice, live recovery", async () => {
    const { rwaFixture } = require("./helpers");
    const { aggNav, navFeed: feed } = await loadFixture(rwaFixture); // RWAPriceFeed proper
    const [nav, ok] = await feed.getNav();
    expect(ok).to.equal(true);
    expect(nav).to.be.gt(0n);
    const live = await feed.getPrice();
    await aggNav.makeStale(73 * 3600); // past the 72h NAV timeout
    const [nav2, ok2] = await feed.getNav();
    expect(ok2).to.equal(false);
    void nav2;
    expect(await feed.getPrice()).to.equal(live); // frozen view
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(false);
    await aggNav.setAnswer(105n * 10n ** 6n); // fresh NAV recovers
    await feed.fetchPrice();
    expect(await feed.oracleLive()).to.equal(true);
  });
});
