// Tier-3 coverage gaps: every remaining uncovered line/branch in the wholly
// new ORA contracts — constructor validation, checked-transfer revert paths
// (driven through the MockFlakyToken scaffold), failed ETH sends
// (EthRejector), repeated oracle-failure transitions, and per-feed edges.
// The production tokens revert internally instead of returning false, so the
// `require(token.transfer(...))` branches are unreachable with them; the
// flaky stand-in makes each one reachable at a chosen step.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E } = require("./helpers");

const HOUR = 3600;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

const addr = async (c) => c.getAddress();

async function deploy(name, ...args) {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function impersonate(a, eth = "10") {
  await ethers.provider.send("hardhat_setBalance", [a, "0x" + E(eth).toString(16)]);
  return ethers.getImpersonatedSigner(a);
}

describe("Tier-3 coverage gaps", () => {
  // ---------------------------------------------------------------- oracles
  async function oracleFixture() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const aggEth = await deploy("SettableAggregator", 8, "ETH / USD", 2000n * 10n ** 8n);
    const aggRate = await deploy("SettableAggregator", 18, "stETH / ETH", E("1"));
    const aggSeq = await deploy("SettableAggregator", 0, "L2 Sequencer Up", 0n);
    await aggSeq.makeStale(2 * HOUR); // out of the restart grace, answer 0 = up
    const wst = await deploy("MockWstETH");
    return { deployer, alice, bob, aggEth, aggRate, aggSeq, wst };
  }

  describe("WstETHPriceFeed", () => {
    it("rejects a bad deviation bound, a zero rate timeout and an EOA feed at deploy", async () => {
      const f = await loadFixture(oracleFixture);
      const base = [
        await addr(f.aggEth), await addr(f.aggRate), await addr(f.wst),
        48 * HOUR, 24 * HOUR, await addr(f.aggSeq),
      ];
      const WPF = await ethers.getContractFactory("WstETHPriceFeed");
      await expect(WPF.deploy(...base, 0)).to.be.revertedWith("WstETHPriceFeed: bad deviation");
      await expect(WPF.deploy(...base, 10001)).to.be.revertedWith("WstETHPriceFeed: bad deviation");
      await expect(WPF.deploy(base[0], base[1], base[2], 48 * HOUR, 0, base[5], 5000))
        .to.be.revertedWith("WstETHPriceFeed: zero timeout");
      // an EOA carries no code — OraCheckContract refuses it outright
      await expect(WPF.deploy(f.alice.address, base[1], base[2], 48 * HOUR, 24 * HOUR, base[5], 5000))
        .to.be.revertedWith("Account code size cannot be zero");
    });

    it("rejects a broken initial composite (zero or reverting wstETH rate) and a down sequencer", async () => {
      const f = await loadFixture(oracleFixture);
      const wstZero = await deploy("MockWstETH");
      await wstZero.setStEthPerToken(0);
      const wstBroken = await deploy("MockWstETH");
      await wstBroken.setRevertPerToken(true);
      const aggSeqDown = await deploy("SettableAggregator", 0, "L2 Sequencer Down", 1n);
      await aggSeqDown.makeStale(2 * HOUR);
      const WPF = await ethers.getContractFactory("WstETHPriceFeed");
      for (const wst of [wstZero, wstBroken]) {
        await expect(WPF.deploy(await addr(f.aggEth), await addr(f.aggRate), await addr(wst),
          48 * HOUR, 24 * HOUR, await addr(f.aggSeq), 5000))
          .to.be.revertedWith("WstETHPriceFeed: initial feed response invalid");
      }
      await expect(WPF.deploy(await addr(f.aggEth), await addr(f.aggRate), await addr(f.wst),
        48 * HOUR, 24 * HOUR, await addr(aggSeqDown), 5000))
        .to.be.revertedWith("WstETHPriceFeed: sequencer down at deploy");
    });

    it("exposes the raw stETH/ETH rate, and caps an above-par rate", async () => {
      const f = await loadFixture(oracleFixture);
      const WPF = await ethers.getContractFactory("WstETHPriceFeed");
      const wfeed = await WPF.deploy(await addr(f.aggEth), await addr(f.aggRate), await addr(f.wst),
        48 * HOUR, 24 * HOUR, await addr(f.aggSeq), 5000);
      await wfeed.waitForDeployment();
      const p0 = await wfeed.lastGoodPrice(); // 2000 * 1.0 * 1.2

      const [rate, ok] = await wfeed.getStEthEthRate();
      expect(rate).to.equal(E("1"));
      expect(ok).to.equal(true);

      // 1.2 stETH/ETH is above the 1.0 cap — the composite must not exceed
      // 2000 * 1.0 * 1.2 = p0
      await f.aggRate.setAnswer(E("1.2"));
      await wfeed.fetchPrice();
      expect(await wfeed.lastGoodPrice()).to.equal(p0);
      expect(await wfeed.depegged()).to.equal(false);
    });

    it("a stale rate feed marks the oracle down; a second bad fetch is quiet", async () => {
      const f = await loadFixture(oracleFixture);
      const WPF = await ethers.getContractFactory("WstETHPriceFeed");
      const wfeed = await WPF.deploy(await addr(f.aggEth), await addr(f.aggRate), await addr(f.wst),
        48 * HOUR, 24 * HOUR, await addr(f.aggSeq), 5000);
      await wfeed.waitForDeployment();

      await time.increase(30 * HOUR); // rate feed (24h) stale, ETH/USD (48h) fresh
      const p0 = await wfeed.lastGoodPrice();
      await expect(wfeed.fetchPrice()).to.emit(wfeed, "OracleStatusChanged").withArgs(false);
      expect(await wfeed.oracleLive()).to.equal(false);
      expect(await wfeed.lastGoodPrice()).to.equal(p0);
      // second consecutive bad fetch: already down, no repeat event
      await expect(wfeed.fetchPrice()).to.not.emit(wfeed, "OracleStatusChanged");

      await f.aggRate.setAnswer(E("1")); // feed publishes again
      await expect(wfeed.fetchPrice()).to.emit(wfeed, "OracleStatusChanged").withArgs(true);
      expect(await wfeed.oracleLive()).to.equal(true);

      // now age BOTH feeds past their timeouts: the ETH/USD read fails on
      // its own (the left leg of the composite ok-check)
      await f.aggRate.setAnswer(E("1"));
      await f.aggEth.setAnswer(2000n * 10n ** 8n);
      await time.increase(50 * HOUR); // beyond the 48h ETH/USD timeout
      await expect(wfeed.fetchPrice()).to.emit(wfeed, "OracleStatusChanged").withArgs(false);
      expect(await wfeed.oracleLive()).to.equal(false);
      expect(await wfeed.lastGoodPrice()).to.equal(p0);
    });

    it("the view getPrice() refuses a composite move beyond the deviation bound", async () => {
      const f = await loadFixture(oracleFixture);
      const WPF = await ethers.getContractFactory("WstETHPriceFeed");
      const wfeed = await WPF.deploy(await addr(f.aggEth), await addr(f.aggRate), await addr(f.wst),
        48 * HOUR, 24 * HOUR, await addr(f.aggSeq), 5000);
      await wfeed.waitForDeployment();
      const p0 = await wfeed.getPrice();
      await f.aggEth.setAnswer(5000n * 10n ** 8n); // +150% composite print
      expect(await wfeed.getPrice()).to.equal(p0);
    });

    it("fetchPrice with the sequencer down: first call flags, second is quiet", async () => {
      const f = await loadFixture(oracleFixture);
      const WPF = await ethers.getContractFactory("WstETHPriceFeed");
      const wfeed = await WPF.deploy(await addr(f.aggEth), await addr(f.aggRate), await addr(f.wst),
        48 * HOUR, 24 * HOUR, await addr(f.aggSeq), 5000);
      await wfeed.waitForDeployment();
      const p0 = await wfeed.lastGoodPrice();
      await f.aggSeq.setAnswer(1); // sequencer down
      await expect(wfeed.fetchPrice()).to.emit(wfeed, "OracleStatusChanged").withArgs(false);
      expect(await wfeed.lastGoodPrice()).to.equal(p0);
      await expect(wfeed.fetchPrice()).to.not.emit(wfeed, "OracleStatusChanged");
    });
  });

  describe("ChainlinkPriceFeed", () => {
    it("rejects a zero timeout; repeated sequencer-down fetches are quiet", async () => {
      const f = await loadFixture(oracleFixture);
      const CLPF = await ethers.getContractFactory("ChainlinkPriceFeed");
      await expect(CLPF.deploy(await addr(f.aggEth), 0, await addr(f.aggSeq), ethers.ZeroAddress, 5000))
        .to.be.revertedWith("ChainlinkPriceFeed: zero timeout");
      const feed = await CLPF.deploy(await addr(f.aggEth), 48 * HOUR, await addr(f.aggSeq),
        ethers.ZeroAddress, 5000);
      await feed.waitForDeployment();
      await f.aggSeq.setAnswer(1);
      const p0 = await feed.lastGoodPrice();
      await expect(feed.fetchPrice()).to.emit(feed, "OracleStatusChanged").withArgs(false);
      expect(await feed.lastGoodPrice()).to.equal(p0);
      await expect(feed.fetchPrice()).to.not.emit(feed, "OracleStatusChanged");
    });
  });

  describe("RWAPriceFeed", () => {
    it("rejects a zero timeout and an invalid initial NAV; repeated bad fetches are quiet", async () => {
      const [deployer] = await ethers.getSigners();
      const aggNav = await deploy("SettableAggregator", 18, "mTBILL NAV", E("1.05"));
      const aggStale = await deploy("SettableAggregator", 18, "mTBILL NAV", E("1.05"));
      await aggStale.makeStale(2 * HOUR);
      const RWA = await ethers.getContractFactory("RWAPriceFeed");
      await expect(RWA.deploy(await addr(aggNav), 0)).to.be.revertedWith("RWAPriceFeed: zero timeout");
      await expect(RWA.deploy(await addr(aggStale), HOUR))
        .to.be.revertedWith("RWAPriceFeed: initial feed response invalid");
      const feed = await RWA.deploy(await addr(aggNav), HOUR);
      await feed.waitForDeployment();
      await time.increase(2 * HOUR); // NAV feed now stale
      const p0 = await feed.lastGoodPrice();
      await expect(feed.fetchPrice()).to.emit(feed, "OracleStatusChanged").withArgs(false);
      expect(await feed.lastGoodPrice()).to.equal(p0);
      await expect(feed.fetchPrice()).to.not.emit(feed, "OracleStatusChanged");
    });
  });

  describe("WTBillPriceFeed + OraGuardian constructors and guards", () => {
    it("WTBillPriceFeed rejects zero addresses", async () => {
      const [deployer, alice] = await ethers.getSigners();
      const standIn = await deploy("MockFlakyToken");
      const WTPF = await ethers.getContractFactory("WTBillPriceFeed");
      await expect(WTPF.deploy(ethers.ZeroAddress, await addr(standIn)))
        .to.be.revertedWith("WTBillPriceFeed: zero address");
      await expect(WTPF.deploy(await addr(standIn), ethers.ZeroAddress))
        .to.be.revertedWith("WTBillPriceFeed: zero address");
    });

    it("OraGuardian rejects zero guardians and zero pause targets", async () => {
      const [deployer, alice] = await ethers.getSigners();
      const G = await ethers.getContractFactory("OraGuardian");
      await expect(G.deploy(ethers.ZeroAddress))
        .to.be.revertedWith("OraGuardian: guardian is zero address");
      const g = await G.deploy(alice.address);
      await g.waitForDeployment();
      await expect(g.connect(alice).setGuardian(ethers.ZeroAddress))
        .to.be.revertedWith("OraGuardian: guardian is zero address");
      const [,, bob] = await ethers.getSigners();
      await expect(g.connect(bob).setGuardian(bob.address))
        .to.be.revertedWith("OraGuardian: caller is not guardian");
      await expect(g.connect(alice).pauseBorrowing(ethers.ZeroAddress, DAY))
        .to.be.revertedWith("OraGuardian: borrowerOps is zero address");
    });
  });

  // ------------------------------------------------------ token-wired flows
  async function flakyFixture() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const lqty = await deploy("MockFlakyToken");
    const lusd = await deploy("MockFlakyToken");
    const coll = await deploy("MockFlakyToken");
    const tm = await deploy("MockFlakyToken");   // any contract: stands in for
    const bo = await deploy("MockFlakyToken");   // the gated core callers
    const ap = await deploy("MockFlakyToken");
    return { deployer, alice, bob, lqty, lusd, coll, tm, bo, ap };
  }

  describe("BranchStaking", () => {
    it("non-owners cannot rewire; increaseF_* on an empty pool accrues nothing", async () => {
      const f = await loadFixture(flakyFixture);
      const staking = await deploy("BranchStaking");
      await staking.setCollToken(await addr(f.coll));
      await staking.setAddresses(await addr(f.lqty), await addr(f.lusd),
        await addr(f.tm), await addr(f.bo), await addr(f.ap));
      // ownership was renounced on wiring
      await expect(staking.connect(f.alice).setAddresses(await addr(f.lqty), await addr(f.lusd),
        await addr(f.tm), await addr(f.bo), await addr(f.ap))).to.be.reverted;

      // nobody staked: the fee-per-staked accrual divides by zero staked → 0
      const tmSigner = await impersonate(await addr(f.tm));
      await expect(staking.connect(tmSigner).increaseF_ETH(E("1")))
        .to.emit(staking, "F_ETHUpdated").withArgs(0);
      const boSigner = await impersonate(await addr(f.bo));
      await expect(staking.connect(boSigner).increaseF_LUSD(E("1")))
        .to.emit(staking, "F_LUSDUpdated").withArgs(0);
    });

    it("every checked transfer in stake/unstake can fail, and gains can be claimed without unstaking", async () => {
      const f = await loadFixture(flakyFixture);
      const staking = await deploy("BranchStaking");
      const stakingAddr = await addr(staking);
      await staking.setCollToken(await addr(f.coll));
      await staking.setAddresses(await addr(f.lqty), await addr(f.lusd),
        await addr(f.tm), await addr(f.bo), await addr(f.ap));

      const { alice } = f;
      await f.lqty.connect(alice).faucet(E("1000"));
      await f.lqty.connect(alice).approve(stakingAddr, ethers.MaxUint256);
      // fund the pool with lusd + collateral so gains can be paid out
      await f.lusd.connect(alice).faucet(E("1000"));
      await f.lusd.connect(alice).transfer(stakingAddr, E("1000"));
      await f.coll.connect(alice).faucet(E("1000"));
      await f.coll.connect(alice).transfer(stakingAddr, E("1000"));

      // transferFrom failure on the very first stake
      await f.lqty.setFailTransferFrom(true);
      await expect(staking.connect(alice).stake(E("100")))
        .to.be.revertedWith("BranchStaking: ORA transferFrom failed");
      await f.lqty.setFailTransferFrom(false);

      await staking.connect(alice).stake(E("100"));
      // accrue both gain streams
      const tmSigner = await impersonate(await addr(f.tm));
      const boSigner = await impersonate(await addr(f.bo));
      await staking.connect(tmSigner).increaseF_ETH(E("50"));
      await staking.connect(boSigner).increaseF_LUSD(E("50"));

      // unstake(0): withdraw gains only, stake untouched
      await staking.connect(alice).unstake(0);
      expect(await staking.stakes(alice.address)).to.equal(E("100"));

      // LQTY payout failure on unstake
      await f.lqty.setFailTransferTo(alice.address, true);
      await expect(staking.connect(alice).unstake(E("10")))
        .to.be.revertedWith("BranchStaking: LQTY transfer failed");
      await f.lqty.setFailTransferTo(alice.address, false);

      // orUSD payout failure on unstake
      await f.lusd.setFailTransferTo(alice.address, true);
      await expect(staking.connect(alice).unstake(E("10")))
        .to.be.revertedWith("BranchStaking: LUSD transfer failed");
      await f.lusd.setFailTransferTo(alice.address, false);

      // collateral-gain payout failure on unstake (accrue fresh gains first —
      // the earlier unstake(0) claimed the previous round)
      await staking.connect(tmSigner).increaseF_ETH(E("50"));
      await f.coll.setFailTransferTo(alice.address, true);
      await expect(staking.connect(alice).unstake(E("10")))
        .to.be.revertedWith("BranchStaking: sending collateral gain failed");
      await f.coll.setFailTransferTo(alice.address, false);

      // and the orUSD payout failure on a second (gain-carrying) stake
      await staking.connect(tmSigner).increaseF_ETH(E("50"));
      await staking.connect(boSigner).increaseF_LUSD(E("50"));
      await f.lusd.setFailTransferTo(alice.address, true);
      await expect(staking.connect(alice).stake(E("100")))
        .to.be.revertedWith("BranchStaking: LUSD transfer failed");
      await f.lusd.setFailTransferTo(alice.address, false);
      await staking.connect(alice).stake(E("100")); // now it goes through
      expect(await staking.stakes(alice.address)).to.equal(E("200"));
    });
  });

  describe("BranchFeeReceiver + BranchCommunityIssuance + InterestRouter", () => {
    it("BranchFeeReceiver: owner-only wiring; a failing sweep token reverts", async () => {
      const f = await loadFixture(flakyFixture);
      const recv = await deploy("BranchFeeReceiver");
      await recv.setAddresses(await addr(f.tm), await addr(f.bo));
      await expect(recv.connect(f.alice).setAddresses(await addr(f.tm), await addr(f.bo)))
        .to.be.reverted; // wiring is one-shot
      const flaky = await deploy("MockFlakyToken");
      await flaky.connect(f.alice).faucet(E("10"));
      await flaky.connect(f.alice).transfer(await addr(recv), E("10"));
      await flaky.setFailTransferTo(f.deployer.address, true);
      await expect(recv.sweep(await addr(flaky), f.deployer.address))
        .to.be.revertedWith("BranchFeeReceiver: sweep failed");
    });

    it("BranchCommunityIssuance: wiring/activation gates and a failing payout", async () => {
      const f = await loadFixture(flakyFixture);
      const ora = await deploy("MockFlakyToken");
      const sp = await deploy("MockFlakyToken");
      const ci = await deploy("BranchCommunityIssuance");
      await expect(ci.connect(f.alice).setAddresses(await addr(ora), await addr(sp)))
        .to.be.reverted; // onlyOwner
      await ci.setAddresses(await addr(ora), await addr(sp));
      await expect(ci.connect(f.alice).activate()).to.be.reverted; // onlyOwner
      await expect(ci.activate())
        .to.be.revertedWith("BranchCommunityIssuance: fund with ORA before activating");
      await ora.connect(f.alice).faucet(E("1000"));
      await ora.connect(f.alice).transfer(await addr(ci), E("1000"));
      await ci.activate();
      // payout failure: the SP asks for ORA but the transfer is made to fail
      await ora.setFailTransferTo(f.alice.address, true);
      const spSigner = await impersonate(await addr(sp));
      await expect(ci.connect(spSigner).sendLQTY(f.alice.address, E("1")))
        .to.be.revertedWith("BranchCommunityIssuance: ORA transfer failed");
    });

    it("InterestRouter: one-shot wiring, zero-address guard, failing vault/treasury legs", async () => {
      const f = await loadFixture(flakyFixture);
      const orusd = await deploy("MockFlakyToken");
      const vaultLike = await deploy("MockFlakyToken");
      const treasuryLike = await deploy("MockFlakyToken");
      const router = await deploy("InterestRouter");
      await router.setAddresses(await addr(orusd), await addr(vaultLike), await addr(treasuryLike));
      await expect(router.setAddresses(await addr(orusd), await addr(vaultLike), await addr(treasuryLike)))
        .to.be.revertedWith("InterestRouter: caller is not owner");
      const router2 = await deploy("InterestRouter");
      await expect(router2.setAddresses(ethers.ZeroAddress, await addr(vaultLike), await addr(treasuryLike)))
        .to.be.revertedWith("InterestRouter: zero address");

      await orusd.connect(f.alice).faucet(E("100"));
      await orusd.connect(f.alice).transfer(await addr(router), E("100"));
      await orusd.setFailTransferTo(await addr(vaultLike), true);
      await expect(router.distribute()).to.be.revertedWith("InterestRouter: vault transfer failed");
      await orusd.setFailTransferTo(await addr(vaultLike), false);
      await orusd.setFailTransferTo(await addr(treasuryLike), true);
      await expect(router.distribute()).to.be.revertedWith("InterestRouter: treasury transfer failed");
    });
  });

  describe("SorUSDVault + WTBill", () => {
    it("SorUSDVault: dust deposits computing to zero shares revert; checked transfers can fail", async () => {
      const [deployer, alice] = await ethers.getSigners();
      const asset = await deploy("MockFlakyToken");
      const vault = await deploy("SorUSDVault", await addr(asset));
      await asset.connect(alice).faucet(E("10000"));
      await asset.connect(alice).approve(await addr(vault), ethers.MaxUint256);
      await vault.connect(alice).deposit(E("5000")); // first deposit mints dead shares
      // inflate totalAssets past totalSupply so a 1-wei deposit computes to 0 shares
      await asset.connect(alice).transfer(await addr(vault), E("500"));
      await expect(vault.connect(alice).deposit(1))
        .to.be.revertedWith("SorUSD: deposit computes to zero shares");
      // transfer-in failure
      await asset.setFailTransferFrom(true);
      await expect(vault.connect(alice).deposit(E("10")))
        .to.be.revertedWith("SorUSD: transfer in failed");
      await asset.setFailTransferFrom(false);
      // transfer-out failure on redeem
      await asset.setFailTransferTo(alice.address, true);
      await expect(vault.connect(alice).redeem(E("10")))
        .to.be.revertedWith("SorUSD: transfer out failed");
      await asset.setFailTransferTo(alice.address, false);
    });

    it("WTBill: the rate decays over time; zero-amount guards and checked transfers", async () => {
      const [deployer, treasury, alice] = await ethers.getSigners();
      const tbill = await deploy("MockTBill");
      const wtbill = await deploy("WTBill", await addr(tbill), treasury.address);
      await tbill.connect(alice).faucet(E("1000"));
      await tbill.connect(alice).approve(await addr(wtbill), ethers.MaxUint256);

      await expect(wtbill.connect(alice).wrap(0)).to.be.revertedWith("WTBill: zero amount");
      await wtbill.connect(alice).wrap(E("1000"));

      // half a year passes: the 2%/yr skim decays the redemption rate
      await time.increase(YEAR / 2);
      const rate0 = await wtbill.rate();
      await wtbill.settle();
      expect(await wtbill.rate()).to.be.lt(rate0);
      expect(await wtbill.skimAccrued()).to.be.gt(0);
      // settling again in the same block: zero elapsed time, rate unchanged
      await wtbill.settle();
      expect(await wtbill.rate()).to.equal(await wtbill.rate());

      await expect(wtbill.connect(alice).unwrap(0)).to.be.revertedWith("WTBill: zero shares");
      // terminal state: the rate has fully decayed to dust (simulated by
      // setting the storage slot directly — reaching it naturally takes
      // millennia). At dust scale the per-second skim truncates to zero, so
      // settle() finds the rate unchanged and only refreshes the timestamp.
      await ethers.provider.send("hardhat_setStorageAt",
        [await addr(wtbill), "0x3", "0x" + (100n).toString(16).padStart(64, "0")]);
      await wtbill.settle();
      expect(await wtbill.rate()).to.equal(100n);
      // claimSkim pays the treasury — make the transfer fail
      await tbill.setFailTransfers(true);
      await expect(wtbill.claimSkim()).to.be.revertedWith("WTBill: transfer failed");
      // unwrap pays the user — same switch
      await expect(wtbill.connect(alice).unwrap(E("10")))
        .to.be.revertedWith("WTBill: transfer out failed");
      // wrap pulls the deposit — same switch
      await expect(wtbill.connect(alice).wrap(E("10")))
        .to.be.revertedWith("WTBill: transfer in failed");
      await tbill.setFailTransfers(false);
    });
  });

  describe("BatchLiquidator + OraSwapPool forwarding edges", () => {
    it("BatchLiquidator: compensation forwarding, sweepETH and sweepToken failures", async () => {
      const [deployer, alice] = await ethers.getSigners();
      const bl = await deploy("BatchLiquidator");
      const flaky = await deploy("MockFlakyToken");
      // empty batch → straight to compensation forwarding
      await expect(bl.batchLiquidateTroves(deployer.address, [], ethers.ZeroAddress))
        .to.not.be.reverted; // no orUSD configured
      await expect(bl.batchLiquidateTroves(deployer.address, [], await addr(flaky)))
        .to.not.be.reverted; // orUSD configured but nothing held
      // token compensation that fails to forward reverts the sweep
      await flaky.connect(alice).faucet(E("5"));
      await flaky.connect(alice).transfer(await addr(bl), E("5"));
      await flaky.setFailTransferTo(deployer.address, true);
      await expect(bl.batchLiquidateTroves(deployer.address, [], await addr(flaky)))
        .to.be.revertedWith("BatchLiquidator: compensation forward failed");
      // sweepETH to a receiver that cannot take ETH
      const rejector = await deploy("EthRejector");
      await rejector.setRejectEth(true);
      await deployer.sendTransaction({ to: await addr(bl), value: E("1") });
      await expect(bl.sweepETH(await addr(rejector)))
        .to.be.revertedWith("BatchLiquidator: ETH sweep failed");
      // sweepToken with the still-failing token
      await expect(bl.sweepToken(await addr(flaky), deployer.address))
        .to.be.revertedWith("BatchLiquidator: token sweep failed");
    });

    it("OraSwapPool: checked transfers and the ETH leg can fail", async () => {
      const [deployer, alice] = await ethers.getSigners();
      const flaky = await deploy("MockFlakyToken");
      const pool = await deploy("OraSwapPool", await addr(flaky));
      await flaky.connect(alice).faucet(E("2000"));
      await flaky.connect(alice).approve(await addr(pool), ethers.MaxUint256);

      await flaky.setFailTransferFrom(true);
      await expect(pool.connect(alice).addLiquidity(E("100"), { value: E("1") }))
        .to.be.revertedWith("OraSwapPool: transfer failed");
      await flaky.setFailTransferFrom(false);
      await pool.connect(alice).addLiquidity(E("1000"), { value: E("1") });

      await flaky.setFailTransferFrom(true);
      await expect(pool.connect(alice).swapOrUSDForETH(E("10"), 0))
        .to.be.revertedWith("OraSwapPool: transfer failed");
      await flaky.setFailTransferFrom(false);

      // a swapper that cannot receive ETH fails the payout leg
      const rejector = await deploy("EthRejector");
      await rejector.setRejectEth(true);
      await flaky.connect(alice).transfer(await addr(rejector), E("50"));
      await rejector.approve(await addr(flaky), await addr(pool));
      await expect(rejector.swapForETH(await addr(pool), E("10")))
        .to.be.revertedWith("OraSwapPool: ETH send failed");

      // orUSD payout failure on the ETH→orUSD direction
      await flaky.setFailTransferTo(alice.address, true);
      await expect(pool.connect(alice).swapETHForOrUSD(0, { value: E("0.01") }))
        .to.be.revertedWith("OraSwapPool: transfer failed");
      await flaky.setFailTransferTo(alice.address, false);
    });
  });
});
