// Oracle hardening — L2 sequencer-uptime guard (outage, restart grace period)
// and per-feed heartbeats on the Chainlink adapters.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E } = require("./helpers");

const HOUR = 3600;

async function fixture() {
  const [deployer] = await ethers.getSigners();
  const Agg = await ethers.getContractFactory("SettableAggregator");
  const aggEth = await Agg.deploy(8, "ETH / USD", 2000n * 10n ** 8n);
  const aggRate = await Agg.deploy(18, "stETH / ETH", E("1"));
  const aggSeq = await Agg.deploy(0, "L2 Sequencer Up", 0n);
  await aggSeq.makeStale(2 * HOUR); // past the restart grace at genesis

  const MockWstETH = await ethers.getContractFactory("MockWstETH");
  const wst = await MockWstETH.deploy();

  const CLPF = await ethers.getContractFactory("ChainlinkPriceFeed");
  const feed = await CLPF.deploy(await aggEth.getAddress(), 48 * HOUR, await aggSeq.getAddress());
  const WPF = await ethers.getContractFactory("WstETHPriceFeed");
  const wfeed = await WPF.deploy(
    await aggEth.getAddress(), await aggRate.getAddress(), await wst.getAddress(),
    48 * HOUR, 24 * HOUR, await aggSeq.getAddress());
  return { deployer, aggEth, aggRate, aggSeq, wst, feed, wfeed };
}

describe("Oracle hardening", () => {
  describe("L2 sequencer-uptime guard", () => {
    it("grace period constant is 1h; guard reports up at genesis", async () => {
      const { feed, wfeed } = await loadFixture(fixture);
      expect(await feed.SEQUENCER_GRACE_PERIOD()).to.equal(3600);
      expect(await feed.sequencerUp()).to.equal(true);
      expect(await wfeed.sequencerUp()).to.equal(true);
    });

    it("deploy reverts while the sequencer is down", async () => {
      const { aggEth, aggSeq } = await loadFixture(fixture);
      await aggSeq.setAnswer(1n); // down
      const CLPF = await ethers.getContractFactory("ChainlinkPriceFeed");
      await expect(CLPF.deploy(await aggEth.getAddress(), 48 * HOUR, await aggSeq.getAddress()))
        .to.be.revertedWith("ChainlinkPriceFeed: sequencer down at deploy");
    });

    it("outage: fetchPrice flags the oracle down and serves lastGoodPrice", async () => {
      const { feed, aggEth, aggSeq } = await loadFixture(fixture);
      expect(await feed.fetchPrice.staticCall()).to.equal(E("2000"));
      await aggSeq.setAnswer(1n); // sequencer goes down
      await aggEth.setAnswer(1500n * 10n ** 8n); // price crashes during the outage
      expect(await feed.sequencerUp()).to.equal(false);
      await feed.fetchPrice();
      expect(await feed.oracleLive()).to.equal(false);
      expect(await feed.getPrice()).to.equal(E("2000")); // stale-but-safe fallback
    });

    it("restart: guard holds through the 1h grace, then recovers with fresh prices", async () => {
      const { feed, aggEth, aggSeq } = await loadFixture(fixture);
      await aggSeq.setAnswer(1n);
      await aggEth.setAnswer(1500n * 10n ** 8n);
      await feed.fetchPrice();
      // sequencer restarts -> startedAt = now -> still inside grace
      await aggSeq.setAnswer(0n);
      expect(await feed.sequencerUp()).to.equal(false);
      expect(await feed.getPrice()).to.equal(E("2000"));
      // grace elapses -> fresh (crashed) price accepted
      await time.increase(HOUR + 60);
      await aggEth.setAnswer(1500n * 10n ** 8n); // keep the round fresh
      expect(await feed.sequencerUp()).to.equal(true);
      await feed.fetchPrice();
      expect(await feed.oracleLive()).to.equal(true);
      expect(await feed.getPrice()).to.equal(E("1500"));
    });

    it("guards the composite wstETH feed identically", async () => {
      const { wfeed, aggSeq } = await loadFixture(fixture);
      const p0 = await wfeed.getPrice();
      await aggSeq.setAnswer(1n);
      await wfeed.fetchPrice();
      expect(await wfeed.oracleLive()).to.equal(false);
      expect(await wfeed.getPrice()).to.equal(p0);
    });

    it("address(0) disables the guard (L1 / local deployments)", async () => {
      const { aggEth } = await loadFixture(fixture);
      const CLPF = await ethers.getContractFactory("ChainlinkPriceFeed");
      const feed = await CLPF.deploy(await aggEth.getAddress(), 48 * HOUR, ethers.ZeroAddress);
      expect(await feed.sequencerUp()).to.equal(true);
      expect(await feed.getPrice()).to.equal(E("2000"));
    });
  });

  describe("per-feed heartbeats (wstETH composite)", () => {
    it("stores distinct timeouts per feed", async () => {
      const { wfeed } = await loadFixture(fixture);
      expect(await wfeed.ethUsdTimeout()).to.equal(48 * HOUR);
      expect(await wfeed.stEthEthTimeout()).to.equal(24 * HOUR);
    });

    it("a stale stETH/ETH round trips the fallback even while ETH/USD is fresh", async () => {
      const { wfeed, aggEth, aggRate } = await loadFixture(fixture);
      const p0 = await wfeed.getPrice();
      await time.increase(30 * HOUR); // 30h: stETH/ETH (24h) stale, ETH/USD (48h) fresh
      await aggEth.setAnswer(2000n * 10n ** 8n); // refresh ETH/USD only
      await wfeed.fetchPrice();
      expect(await wfeed.oracleLive()).to.equal(false);
      expect(await wfeed.getPrice()).to.equal(p0); // lastGoodPrice served
      await aggRate.setAnswer(E("1")); // stETH/ETH publishes again
      await wfeed.fetchPrice();
      expect(await wfeed.oracleLive()).to.equal(true);
    });
  });
});
