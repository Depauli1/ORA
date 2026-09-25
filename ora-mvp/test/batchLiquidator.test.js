// Batch liquidation sequencing, externalized from the size-capped
// TroveManager forks (V2/RWA/Rates implement single-trove liquidation
// only). Covers: the new standalone liquidate() in normal + recovery
// mode, the revert-stubs, and the BatchLiquidator's skip-on-failure
// semantics over explicit lists and head-walks.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, MAX_FEE, rwaFixtureSeeded, ratesFixtureSeeded } = require("./helpers");

const CLOSED_BY_LIQUIDATION = 3n;

async function fundAndApprove(f, signer, shares) {
  await f.wtbill.connect(signer).faucet(shares);
  await f.wtbill.connect(signer).approve(await f.bo.getAddress(), ethers.MaxUint256);
}

async function rwaBaitFixture() {
  const f = await rwaFixtureSeeded(); // whale 500k/300k, SP 250k
  const { bo, bob, carol } = f;
  await fundAndApprove(f, bob, E("12000"));
  await bo.connect(bob).openTrove(MAX_FEE, E("11600"), E("12000"), Z, Z); // ~106.8%
  await fundAndApprove(f, carol, E("12000"));
  await bo.connect(carol).openTrove(MAX_FEE, E("11600"), E("12000"), Z, Z);
  const BL = await ethers.getContractFactory("BatchLiquidator");
  const bl = await BL.deploy();
  await bl.waitForDeployment();
  return { ...f, bl };
}

describe("BatchLiquidator + standalone liquidate()", () => {
  it("fork stubs revert with pointers to the BatchLiquidator", async () => {
    const { tm, bob } = await loadFixture(rwaBaitFixture);
    await expect(tm.liquidateTroves(5))
      .to.be.revertedWith("TroveManager: use BatchLiquidator.liquidateTroves");
    await expect(tm.batchLiquidateTroves([bob.address]))
      .to.be.revertedWith("TroveManager: use BatchLiquidator.batchLiquidateTroves");
  });

  it("standalone liquidate() closes an underwater trove (SP offset path)", async () => {
    const f = await loadFixture(rwaBaitFixture);
    const { tm, sp, aggNav, feed, bob, carol } = f;
    await aggNav.setAnswer(100500000n); // $1.005 -> baits ~102.2% (< 103% floor)
    const price = await feed.getPrice();
    expect(await tm.getCurrentICR(bob.address, price)).to.be.lt(E("1.03"));
    const spBefore = await sp.getTotalLUSDDeposits();
    await expect(tm.connect(carol).liquidate(bob.address))
      .to.emit(tm, "Liquidation");
    expect(await tm.getTroveStatus(bob.address)).to.equal(CLOSED_BY_LIQUIDATION);
    // debt was absorbed by the Stability Pool, not redistributed
    expect(await sp.getTotalLUSDDeposits()).to.be.lt(spBefore);
  });

  it("standalone liquidate() reverts 'nothing to liquidate' on a healthy trove", async () => {
    const { tm, bob } = await loadFixture(rwaBaitFixture); // baits at ~106.8%, healthy
    await expect(tm.liquidate(bob.address))
      .to.be.revertedWith("TroveManager: nothing to liquidate");
  });

  it("batchLiquidateTroves skips healthy/dead troves, closes the underwater one", async () => {
    const f = await loadFixture(rwaBaitFixture);
    const { tm, bl, aggNav, bob, alice, carol } = f;
    await aggNav.setAnswer(100500000n); // only the baits are underwater; whale safe
    const dead = "0x000000000000000000000000000000000000dEaD";
    const orUSDAddr = await f.orUSD.getAddress();
    const tx = await bl.connect(carol).batchLiquidateTroves(
      await tm.getAddress(), [bob.address, alice.address, dead], orUSDAddr);
    await expect(tx).to.emit(bl, "TroveLiquidationAttempted")
      .withArgs(await tm.getAddress(), bob.address, true);
    await expect(tx).to.emit(bl, "TroveLiquidationAttempted")
      .withArgs(await tm.getAddress(), alice.address, false);
    await expect(tx).to.emit(bl, "TroveLiquidationAttempted")
      .withArgs(await tm.getAddress(), dead, false);
    expect(await tm.getTroveStatus(bob.address)).to.equal(CLOSED_BY_LIQUIDATION);
    expect(await tm.getTroveStatus(alice.address)).to.equal(1n); // whale untouched
  });

  it("liquidateTroves(n) walks head-first and clears every underwater trove", async () => {
    const f = await loadFixture(rwaBaitFixture);
    const { tm, sorted, bl, aggNav, bob, carol, dave } = f;
    void dave;
    await aggNav.setAnswer(100500000n);
    await bl.connect(carol).liquidateTroves(
      await tm.getAddress(), await sorted.getAddress(), 10, await f.orUSD.getAddress());
    expect(await tm.getTroveStatus(bob.address)).to.equal(CLOSED_BY_LIQUIDATION);
    expect(await tm.getTroveStatus(carol.address)).to.equal(CLOSED_BY_LIQUIDATION);
  });

  it("rates branch: mixed liquidation (partial SP offset + redistribution)", async () => {
    const f = await loadFixture(ratesFixtureSeeded); // whale 100ETH/60k, SP 10k
    const { tm, bo, sp, agg, feed, bob, carol } = f;
    await bo.connect(bob).openTroveWithRate(E("15000"), E("0.05"), Z, Z, { value: E("10") });
    await agg.setAnswer(1200n * 10n ** 8n); // -40% (within the 50% guard)
    const price = await feed.getPrice();
    const icr = await tm.getCurrentICR(bob.address, await feed.getPrice());
    expect(icr).to.be.lt(E("1.1"));
    expect(await tm.getTCR(price)).to.be.gt(E("1.5")); // still normal mode
    const spBefore = await sp.getTotalLUSDDeposits();
    await tm.connect(carol).liquidate(bob.address);
    expect(await tm.getTroveStatus(bob.address)).to.equal(CLOSED_BY_LIQUIDATION);
    // SP covered 10k of the ~15k debt; the rest redistributed to the whale
    expect(await sp.getTotalLUSDDeposits()).to.be.lt(spBefore);
    expect(await sp.getTotalLUSDDeposits()).to.be.gt(0); // SP not drained
  });

  it("rates branch: recovery-mode liquidation (ICR < 100% redistributes)", async () => {
    const f = await loadFixture(ratesFixtureSeeded);
    const { tm, bo, agg, feed, bob, carol } = f;
    await bo.connect(bob).openTroveWithRate(E("15000"), E("0.05"), Z, Z, { value: E("10") });
    await agg.setAnswer(1000n * 10n ** 8n); // -50% (guard boundary, inclusive): TCR ~146% -> recovery mode
    const price = await feed.getPrice();
    expect(await tm.getTCR(price)).to.be.lt(E("1.5"));
    await tm.connect(carol).liquidate(bob.address);
    expect(await tm.getTroveStatus(bob.address)).to.equal(CLOSED_BY_LIQUIDATION);
  });
});

describe("BatchLiquidator compensation forwarding", () => {
  it("keeper receives native + orUSD gas compensation for the sweep", async () => {
    const f = await loadFixture(ratesFixtureSeeded);
    const { tm, bo, sorted, agg, orUSD, bob, carol } = f;
    await bo.connect(bob).openTroveWithRate(E("15000"), E("0.05"), Z, Z, { value: E("10") });
    await agg.setAnswer(1200n * 10n ** 8n); // bait underwater, normal mode
    const BL = await ethers.getContractFactory("BatchLiquidator");
    const bl = await BL.deploy();
    await bl.waitForDeployment();
    const eth0 = await ethers.provider.getBalance(carol.address);
    const orusd0 = await orUSD.balanceOf(carol.address);
    const tx = await bl.connect(carol).liquidateTroves(
      await tm.getAddress(), await sorted.getAddress(), 5, await orUSD.getAddress());
    const r = await tx.wait();
    const gasCost = r.gasUsed * r.gasPrice;
    const eth1 = await ethers.provider.getBalance(carol.address);
    const orusd1 = await orUSD.balanceOf(carol.address);
    expect(await tm.getTroveStatus(bob.address)).to.equal(3n);
    expect(eth1 - eth0 + gasCost).to.be.gt(0); // native comp arrived
    expect(orusd1 - orusd0).to.equal(E("200")); // 200 orUSD comp arrived
    // nothing stranded in the helper
    expect(await ethers.provider.getBalance(await bl.getAddress())).to.equal(0n);
    expect(await orUSD.balanceOf(await bl.getAddress())).to.equal(0n);
  });
});

describe("BatchLiquidator sweeps", () => {
  it("sweepETH / sweepToken recover stranded compensation", async () => {
    const f = await loadFixture(ratesFixtureSeeded);
    const { tm, bo, sorted, agg, orUSD, wtbill, bob, carol, dave } = f;
    void wtbill;
    await bo.connect(bob).openTroveWithRate(E("15000"), E("0.05"), Z, Z, { value: E("10") });
    await agg.setAnswer(1200n * 10n ** 8n);
    const BL = await ethers.getContractFactory("BatchLiquidator");
    const bl = await BL.deploy();
    await bl.waitForDeployment();
    // route the sweep through a contract that cannot receive ETH: the
    // auto-forward fails silently and the compensation strands in the helper
    const NC = await ethers.getContractFactory("NonPayableCaller");
    const nc = await NC.deploy();
    await nc.waitForDeployment();
    await nc.sweep(await bl.getAddress(), await tm.getAddress(),
      await sorted.getAddress(), 5, await orUSD.getAddress());
    expect(await tm.getTroveStatus(bob.address)).to.equal(3n);
    expect(await ethers.provider.getBalance(await bl.getAddress())).to.be.gt(0n);
    expect(await orUSD.balanceOf(await bl.getAddress())).to.equal(E("200"));
    // anyone can sweep the stranded funds to a chosen recipient
    const e0 = await ethers.provider.getBalance(dave.address);
    await bl.sweepETH(dave.address);
    expect(await ethers.provider.getBalance(dave.address)).to.be.gt(e0);
    expect(await ethers.provider.getBalance(await bl.getAddress())).to.equal(0n);
    await bl.sweepToken(await orUSD.getAddress(), dave.address);
    expect(await orUSD.balanceOf(dave.address)).to.equal(E("200"));
    // empty sweeps are harmless no-ops
    await bl.sweepETH(carol.address);
    await bl.sweepToken(await orUSD.getAddress(), carol.address);
  });
});
