// HintHelpersRates.getApproxHint: random-sampling rate hints for the
// rate-ordered sorted list (empty list, exact hit, and approximate hit).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, ratesFixture, ratesFixtureSeeded } = require("./helpers");

describe("HintHelpersRates", () => {
  it("constructor rejects the zero trove manager", async () => {
    const H = await ethers.getContractFactory("HintHelpersRates");
    await expect(H.deploy(ethers.ZeroAddress)).to.be.revertedWith("HintHelpersRates: zero address");
  });

  it("empty list returns the zero hint", async () => {
    const { hh } = await loadFixture(ratesFixture); // unseeded: no troves
    const [hint, diff, seed] = await hh.getApproxHint(E("0.05"), 15, 42n);
    expect(hint).to.equal(ethers.ZeroAddress);
    expect(diff).to.equal(0n);
    expect(seed).to.equal(42n);
  });

  it("finds the closest-rate trove by sampling", async () => {
    const f = await loadFixture(ratesFixtureSeeded); // whale @3%
    const { hh, bo, tm, bob, carol, dave } = f;
    await bo.connect(bob).openTroveWithRate(E("10000"), E("0.05"), Z, Z, { value: E("10") });
    await bo.connect(carol).openTroveWithRate(E("10000"), E("0.07"), Z, Z, { value: E("10") });
    await bo.connect(dave).openTroveWithRate(E("10000"), E("0.09"), Z, Z, { value: E("10") });
    // exact hit exists (5%): with enough trials sampling must find diff 0
    const [hint, diff] = await hh.getApproxHint(E("0.05"), 200, 1234n);
    expect(diff).to.equal(0n);
    expect(await tm.troveAnnualRate(hint)).to.equal(E("0.05"));
    // no exact hit (6%): best of {3,5,7,9} is within 1pp
    const [hint2, diff2] = await hh.getApproxHint(E("0.06"), 200, 777n);
    expect(diff2).to.be.lte(E("0.01"));
    const rate = await tm.troveAnnualRate(hint2);
    expect(rate === E("0.05") || rate === E("0.07")).to.equal(true);
  });
});
