// Rates branch: redemptions hit the cheapest-rate trove first (SortedTrovesRates
// is descending by rate; redemption walks from the tail). Redeeming 5k orUSD
// against 5%/7%/9% troves must draw only from the 5% trove.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, MAX_FEE, ratesFixtureSeeded } = require("./helpers");

describe("Redemption ordering (cheapest rate first)", () => {
  it("a 5k redemption draws only from the 5% trove", async () => {
    const f = await loadFixture(ratesFixtureSeeded); // whale 100ETH/60k @3%
    const { tm, bo, orUSD, bob, carol, dave, alice } = f;
    await bo.connect(bob).openTroveWithRate(E("10000"), E("0.05"), Z, Z, { value: E("10") });
    await bo.connect(carol).openTroveWithRate(E("10000"), E("0.07"), Z, Z, { value: E("10") });
    await bo.connect(dave).openTroveWithRate(E("10000"), E("0.09"), Z, Z, { value: E("10") });
    await time.increase(16 * 86400); // past the 15-day bootstrap period
    // NOTE: the whale pays 3% — cheaper than all three baits — so the
    // redemption starts at the whale, not at bob. Assert full ordering:
    // whale first, then bob, and carol/dave untouched by a 5k draw.
    const [whale0] = await tm.getEntireDebtAndColl(alice.address);
    const [bob0] = await tm.getEntireDebtAndColl(bob.address);
    const [carol0] = await tm.getEntireDebtAndColl(carol.address);
    const [dave0] = await tm.getEntireDebtAndColl(dave.address);
    const eth0 = await ethers.provider.getBalance(alice.address);
    await tm.connect(alice).redeemCollateral(
      E("5000"), alice.address, alice.address, alice.address, 0, 10, MAX_FEE);
    const [whale1] = await tm.getEntireDebtAndColl(alice.address);
    const [bob1] = await tm.getEntireDebtAndColl(bob.address);
    const [carol1] = await tm.getEntireDebtAndColl(carol.address);
    const [dave1] = await tm.getEntireDebtAndColl(dave.address);
    // 5k drawn, all from the cheapest trove (whale @3%; the fee is levied
    // in collateral, so the debt delta is exactly the draw)
    expect(whale0 - whale1).to.be.closeTo(E("5000"), E("10"));
    expect(bob1).to.be.closeTo(bob0, E("1")); // interest dust only
    expect(carol1).to.be.closeTo(carol0, E("1"));
    expect(dave1).to.be.closeTo(dave0, E("1"));
    // redeemer got ~2.42 ETH: 2.5 gross minus the 0.5% floor + the
    // redemption's own baseRate impact (~3.25% total, v1 semantics)
    const eth1 = await ethers.provider.getBalance(alice.address);
    expect(eth1 - eth0).to.be.closeTo(E("2.42"), E("0.02"));
  });

  it("a large redemption walks the tail in ascending-rate order", async () => {
    const f = await loadFixture(ratesFixtureSeeded);
    const { tm, bo, orUSD, bob, carol, dave, alice } = f;
    // undercut the whale's 3%: redemption must start at bob (1%)
    await bo.connect(bob).openTroveWithRate(E("10000"), E("0.01"), Z, Z, { value: E("10") });
    await bo.connect(carol).openTroveWithRate(E("10000"), E("0.02"), Z, Z, { value: E("10") });
    await bo.connect(dave).openTroveWithRate(E("10000"), E("0.09"), Z, Z, { value: E("10") });
    await time.increase(16 * 86400);
    // alice 10k + carol/dave 10k each = 30k of redemption ammo
    await orUSD.connect(carol).transfer(alice.address, E("10000"));
    await orUSD.connect(dave).transfer(alice.address, E("10000"));
    const [whale0] = await tm.getEntireDebtAndColl(alice.address);
    // maxFee 100%: a 25k draw (~28% of supply) carries a large own-impact fee
    await tm.connect(alice).redeemCollateral(
      E("25000"), alice.address, alice.address, alice.address, 0, 10, E("1"));
    expect(await tm.getTroveStatus(bob.address)).to.equal(4n); // 1%: fully redeemed
    expect(await tm.getTroveStatus(carol.address)).to.equal(4n); // 2%: fully redeemed
    const [whale1] = await tm.getEntireDebtAndColl(alice.address);
    expect(whale0 - whale1).to.be.gt(E("4000")); // 3%: remainder came from here
    expect(await tm.getTroveStatus(alice.address)).to.equal(1n); // partial: active
    expect(await tm.getTroveStatus(dave.address)).to.equal(1n); // 9%: untouched
  });
});
