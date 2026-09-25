// RWA recovery-mode edges at the 105% MCR / 115% CCR params: the borrowing
// gate in recovery, full liquidation (offset vs redistribute paths), the
// MCR<ICR<TCR band with SP coverage, and single-trove no-op protection.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, MAX_FEE, rwaFixtureSeeded, rwaFixture } = require("./helpers");

async function fundAndOpen(f, signer, debt, coll) {
  await f.wtbill.connect(signer).faucet(coll);
  await f.wtbill.connect(signer).approve(await f.bo.getAddress(), ethers.MaxUint256);
  await f.bo.connect(signer).openTrove(MAX_FEE, debt, coll, Z, Z);
}

// whale 500k/300k + bob 100k/93k + carol 100k/68k, then NAV -> $0.73.
// TCR ~110.8% (recovery), bob ICR ~78%, carol ~107% (MCR<ICR<TCR), whale ~122%.
async function recoveryFixture() {
  const f = await rwaFixtureSeeded();
  await fundAndOpen(f, f.bob, E("93000"), E("100000"));
  await fundAndOpen(f, f.carol, E("68000"), E("100000"));
  await f.aggNav.setAnswer(73000000n); // $0.73
  return f;
}

describe("RWA recovery mode (MCR 105% / CCR 115%)", () => {
  it("fixture sits in recovery: TCR in (105%, 115%)", async () => {
    const { tm, feed } = await loadFixture(recoveryFixture);
    const tcr = await tm.getTCR(await feed.getPrice());
    expect(tcr).to.be.gt(E("1.05"));
    expect(tcr).to.be.lt(E("1.15"));
  });

  it("recovery borrowing gate: ICR 108% reverts, ICR 120% opens", async () => {
    const f = await loadFixture(recoveryFixture);
    const { bo, wtbill } = f;
    const dave = (await ethers.getSigners())[5];
    await wtbill.connect(dave).faucet(E("200000"));
    await wtbill.connect(dave).approve(await bo.getAddress(), ethers.MaxUint256);
    // 100k coll @ $0.73 = $73k value; 67.5k debt -> ICR ~108% (< CCR, no TCR gain)
    await expect(bo.connect(dave).openTrove(MAX_FEE, E("67500"), E("100000"), Z, Z))
      .to.be.reverted;
    // 60k debt -> ICR ~121.6% (>= CCR, improves TCR) -> allowed in recovery
    await bo.connect(dave).openTrove(MAX_FEE, E("60000"), E("100000"), Z, Z);
    expect(await f.tm.getTroveStatus(dave.address)).to.equal(1n);
  });

  it("ICR <= 100% in recovery: pure redistribution, SP untouched", async () => {
    const f = await loadFixture(recoveryFixture);
    const { tm, sp, feed, bob, alice } = f;
    expect(await tm.getCurrentICR(bob.address, await feed.getPrice())).to.be.lt(E("1"));
    const spBefore = await sp.getTotalLUSDDeposits();
    const [whaleDebt0] = await tm.getEntireDebtAndColl(alice.address);
    await tm.connect(alice).liquidate(bob.address);
    expect(await tm.getTroveStatus(bob.address)).to.equal(3n);
    expect(await sp.getTotalLUSDDeposits()).to.equal(spBefore); // no offset
    const [whaleDebt1] = await tm.getEntireDebtAndColl(alice.address);
    expect(whaleDebt1).to.be.gt(whaleDebt0); // bob's debt redistributed
  });

  it("100% < ICR < MCR in recovery: SP offsets debt, remainder redistributes", async () => {
    // dave opens healthy, then falls into (100%, 105%) after the crash
    const f = await rwaFixtureSeeded();
    await fundAndOpen(f, f.bob, E("93000"), E("100000"));
    const dave = (await ethers.getSigners())[5];
    await fundAndOpen(f, dave, E("71000"), E("100000"));
    await f.aggNav.setAnswer(73000000n);
    const { tm, sp, feed, alice } = f;
    const price = await feed.getPrice();
    const icr = await tm.getCurrentICR(dave.address, price);
    expect(icr).to.be.gt(E("1"));
    expect(icr).to.be.lt(E("1.05"));
    const spBefore = await sp.getTotalLUSDDeposits();
    await tm.connect(alice).liquidate(dave.address);
    expect(await tm.getTroveStatus(dave.address)).to.equal(3n);
    const spAfter = await sp.getTotalLUSDDeposits();
    expect(spBefore - spAfter).to.be.closeTo(E("71200"), E("500")); // ~71k + gas comp
  });

  it("MCR < ICR < TCR with SP cover: offset-closes the trove", async () => {
    const f = await loadFixture(recoveryFixture);
    const { tm, sp, feed, carol, alice } = f;
    const price = await feed.getPrice();
    const icr = await tm.getCurrentICR(carol.address, price);
    expect(icr).to.be.gt(E("1.05"));
    expect(icr).to.be.lt(await tm.getTCR(price));
    await tm.connect(alice).liquidate(carol.address);
    expect(await tm.getTroveStatus(carol.address)).to.equal(3n);
    expect(await sp.getTotalLUSDDeposits()).to.be.lt(E("250000")); // SP absorbed it
  });

  it("healthy trove (ICR > TCR) in recovery: liquidate reverts", async () => {
    const f = await loadFixture(recoveryFixture);
    const { tm, feed, alice, bob } = f;
    const price = await feed.getPrice();
    expect(await tm.getCurrentICR(alice.address, price)).to.be.gt(await tm.getTCR(price));
    await expect(tm.connect(bob).liquidate(alice.address))
      .to.be.revertedWith("TroveManager: nothing to liquidate");
  });

  it("empty SP in recovery: debt redistributes to the surviving trove", async () => {
    const f = await rwaFixtureSeeded();
    await fundAndOpen(f, f.bob, E("93000"), E("100000"));
    // drain the SP while all troves are healthy (withdrawals block later);
    // the protocol keeps a 1-orUSD dust floor, so ~all of the debt redistributes
    await f.sp.connect(f.alice).withdrawFromSP(E("249999"));
    expect(await f.sp.getTotalLUSDDeposits()).to.be.lte(E("2"));
    await f.aggNav.setAnswer(73000000n);
    const [whaleDebt0] = await f.tm.getEntireDebtAndColl(f.alice.address);
    await f.tm.connect(f.bob).liquidate(f.bob.address);
    expect(await f.tm.getTroveStatus(f.bob.address)).to.equal(3n);
    const [whaleDebt1] = await f.tm.getEntireDebtAndColl(f.alice.address);
    expect(whaleDebt1).to.be.gt(whaleDebt0); // bob's debt landed on the whale
    expect(await f.sp.getTotalLUSDDeposits()).to.be.lte(E("2"));
  });

  it("single trove in recovery: liquidation is a no-op (never the last trove)", async () => {
    const f = await loadFixture(rwaFixture);
    const { tm, bo, aggNav, feed, bob, carol } = f;
    await fundAndOpen(f, bob, E("300000"), E("500000")); // lone trove, ~175%
    await aggNav.setAnswer(68000000n); // TCR = ICR ~113% -> recovery
    const price = await feed.getPrice();
    expect(await tm.getTCR(price)).to.be.lt(E("1.15"));
    await expect(tm.connect(carol).liquidate(bob.address))
      .to.be.revertedWith("TroveManager: nothing to liquidate");
    expect(await tm.getTroveStatus(bob.address)).to.equal(1n);
  });
});
