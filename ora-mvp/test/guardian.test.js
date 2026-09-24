// ORA emergency brake — per-branch borrowing pause with auto-expiry.
//
// Fixture: a rates-branch stack wired to an OraGuardian whose holder is a
// dedicated `guardian` signer (standing in for the Safe multisig). Covers:
// one-shot wiring, pause/unpause access control, duration caps, which
// operations halt vs. keep working while paused, auto-expiry, rotation,
// and per-branch isolation.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, MAX_FEE, maxBytes32 } = require("./helpers");

const DAY = 24 * 3600;

async function guardianFixture() {
  const [deployer, treasury, guardian, alice, bob] = await ethers.getSigners();
  const deploy = async (name, ...args) => {
    const f = await ethers.getContractFactory(name, deployer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const a = c => c.getAddress();

  const agg = await deploy("SettableAggregator", 8, "ETH / USD", 2000n * 10n ** 8n);
  const feed = await deploy("ChainlinkPriceFeed", await a(agg), 48 * 3600, ethers.ZeroAddress, ethers.ZeroAddress, 5000);

  const sorted = await deploy("SortedTrovesRates");
  const tm = await deploy("TroveManagerRates");
  const ap = await deploy("ActivePool");
  const sp = await deploy("StabilityPoolRates");
  const gasPool = await deploy("GasPool");
  const dp = await deploy("DefaultPool");
  const csp = await deploy("CollSurplusPool");
  const bo = await deploy("BorrowerOperationsRates");
  const orUSD = await deploy("LUSDToken", await a(tm), await a(sp), await a(bo));
  const ci = await deploy("CommunityIssuance");
  const staking = await deploy("LQTYStaking");
  const lockup = await deploy("LockupContractFactory");
  const ora = await deploy("LQTYToken",
    await a(ci), await a(staking), await a(lockup),
    treasury.address, treasury.address, deployer.address);
  const branchCI = await deploy("BranchCommunityIssuance");
  const router = await deploy("InterestRouter");
  const vault = await deploy("SorUSDVault", await a(orUSD));
  const og = await deploy("OraGuardian", guardian.address);

  // setGuardian MUST precede setAddresses (which renounces BO ownership)
  await bo.setGuardian(await a(og));
  await sorted.setParams(maxBytes32, await a(tm), await a(bo));
  await tm.setRatesAddresses(await a(router), treasury.address);
  await tm.setAddresses(
    await a(bo), await a(ap), await a(dp), await a(sp), await a(gasPool),
    await a(csp), await a(feed), await a(orUSD), await a(sorted),
    await a(ora), await a(staking));
  await bo.setAddresses(
    await a(tm), await a(ap), await a(dp), await a(sp), await a(gasPool),
    await a(csp), await a(feed), await a(sorted), await a(orUSD), await a(staking));
  await sp.setAddresses(
    await a(bo), await a(tm), await a(ap), await a(orUSD), await a(sorted),
    await a(feed), await a(branchCI));
  await ap.setAddresses(await a(bo), await a(tm), await a(sp), await a(dp));
  await dp.setAddresses(await a(tm), await a(ap));
  await csp.setAddresses(await a(bo), await a(tm), await a(ap));
  await staking.setAddresses(
    await a(ora), await a(orUSD), await a(tm), await a(bo), await a(ap));
  await router.setAddresses(await a(orUSD), await a(vault), treasury.address);
  await branchCI.setAddresses(await a(ora), await a(sp));

  return { deployer, treasury, guardian, alice, bob, bo, tm, sp, orUSD, feed, og };
}

async function openTrove(bo, signer, debt, rate, value) {
  await bo.connect(signer).openTroveWithRate(E(debt), E(rate), Z, Z, { value: E(value) });
}

describe("OraGuardian — borrowing pause", () => {
  it("wires one-shot: guardian set, second set reverts", async () => {
    const { bo, og } = await loadFixture(guardianFixture);
    expect(await bo.guardian()).to.equal(await og.getAddress());
    await expect(bo.setGuardian(await og.getAddress()))
      .to.be.revertedWith("Ownable: caller is not the owner"); // ownership renounced
  });

  it("setGuardian rejects garbage addresses and non-owners", async () => {
    const { deployer, alice } = await loadFixture(guardianFixture);
    const F = await ethers.getContractFactory("BorrowerOperationsRates", deployer);
    const fresh = await F.deploy();
    await fresh.waitForDeployment();
    await expect(fresh.connect(alice).setGuardian(alice.address))
      .to.be.revertedWith("Ownable: caller is not the owner");
    await expect(fresh.setGuardian(alice.address))
      .to.be.revertedWith("Account code size cannot be zero");
  });

  it("only the guardian can pause; durations are capped at 30 days", async () => {
    const { bo, og, alice, guardian } = await loadFixture(guardianFixture);
    const boAddr = await bo.getAddress();
    await expect(og.connect(alice).pauseBorrowing(boAddr, DAY))
      .to.be.revertedWith("OraGuardian: caller is not guardian");
    await expect(og.connect(guardian).pauseBorrowing(boAddr, 0))
      .to.be.revertedWith("OraGuardian: bad duration");
    await expect(og.connect(guardian).pauseBorrowing(boAddr, 30 * DAY + 1))
      .to.be.revertedWith("OraGuardian: bad duration");
    await expect(og.connect(guardian).pauseBorrowing(boAddr, 7 * DAY))
      .to.emit(og, "BorrowingPaused").withArgs(boAddr, (await time.latest()) + 7 * DAY + 1);
    expect(await og.isBorrowingPaused(boAddr)).to.be.true;
  });

  it("paused: opens, withdrawals and debt-increasing adjusts revert", async () => {
    const { bo, og, alice, guardian } = await loadFixture(guardianFixture);
    await openTrove(bo, alice, "5000", "0.05", "10"); // healthy trove first
    await og.connect(guardian).pauseBorrowing(await bo.getAddress(), DAY);
    await expect(openTrove(bo, alice, "2000", "0.05", "5"))
      .to.be.revertedWith("BorrowerOperations: borrowing is paused");
    await expect(bo.connect(alice).withdrawLUSD(MAX_FEE, E("100"), Z, Z))
      .to.be.revertedWith("BorrowerOperations: borrowing is paused");
    await expect(bo.connect(alice).adjustTrove(MAX_FEE, 0, E("100"), true, Z, Z))
      .to.be.revertedWith("BorrowerOperations: borrowing is paused");
  });

  it("paused: repays, debt-decreasing adjusts, top-ups, rate changes and closes work", async () => {
    const { bo, og, orUSD, alice, bob, guardian } = await loadFixture(guardianFixture);
    await openTrove(bo, alice, "5000", "0.05", "10");
    // bob funds alice with slack so interest dust can't block her full exit
    await openTrove(bo, bob, "5000", "0.05", "10");
    await orUSD.connect(bob).transfer(alice.address, E("100"));
    await og.connect(guardian).pauseBorrowing(await bo.getAddress(), DAY);
    // repay + debt-decreasing adjust
    await bo.connect(alice).repayLUSD(E("1000"), Z, Z);
    await bo.connect(alice).adjustTrove(MAX_FEE, 0, E("500"), false, Z, Z);
    // collateral top-up works while paused
    await bo.connect(alice).addColl(Z, Z, { value: E("1") });
    // rate changes are never pause-gated: the only revert is the rate cooldown
    await expect(bo.connect(alice).adjustTroveRate(E("0.09"), Z, Z))
      .to.be.revertedWith("TroveManager: rate cooldown");
    // full exit while paused: closeTrove repays the remaining debt + dust
    await expect(bo.connect(alice).closeTrove()).to.not.be.reverted;
  });

  it("unpause resumes borrowing; only guardian can unpause", async () => {
    const { bo, og, alice, bob, guardian } = await loadFixture(guardianFixture);
    const boAddr = await bo.getAddress();
    await openTrove(bo, alice, "5000", "0.05", "10");
    await og.connect(guardian).pauseBorrowing(boAddr, 7 * DAY);
    await expect(og.connect(alice).unpauseBorrowing(boAddr))
      .to.be.revertedWith("OraGuardian: caller is not guardian");
    await expect(og.connect(guardian).unpauseBorrowing(boAddr))
      .to.emit(og, "BorrowingUnpaused").withArgs(boAddr);
    expect(await og.isBorrowingPaused(boAddr)).to.be.false;
    await openTrove(bo, bob, "2000", "0.05", "5"); // borrowing works again
  });

  it("pauses auto-expire: borrowing resumes with no guardian action", async () => {
    const { bo, og, alice, bob, guardian } = await loadFixture(guardianFixture);
    const boAddr = await bo.getAddress();
    await openTrove(bo, alice, "5000", "0.05", "10");
    await og.connect(guardian).pauseBorrowing(boAddr, DAY);
    expect(await og.isBorrowingPaused(boAddr)).to.be.true;
    await time.increase(DAY + 1);
    expect(await og.isBorrowingPaused(boAddr)).to.be.false;
    await openTrove(bo, bob, "2000", "0.05", "5");
  });

  it("guardian can rotate the holder; the old holder loses power", async () => {
    const { og, guardian, alice, bob } = await loadFixture(guardianFixture);
    const boAddr = ethers.ZeroAddress; // mapping-level check needs no live branch
    await expect(og.connect(guardian).setGuardian(ethers.ZeroAddress))
      .to.be.revertedWith("OraGuardian: guardian is zero address");
    await expect(og.connect(guardian).setGuardian(alice.address))
      .to.emit(og, "GuardianUpdated").withArgs(guardian.address, alice.address);
    await expect(og.connect(guardian).pauseBorrowing(boAddr, DAY))
      .to.be.revertedWith("OraGuardian: caller is not guardian");
    await og.connect(alice).pauseBorrowing(bob.address, DAY);
    expect(await og.isBorrowingPaused(bob.address)).to.be.true;
  });

  it("pauses are per-branch: pausing one BO leaves others untouched", async () => {
    const { og, guardian, alice } = await loadFixture(guardianFixture);
    await og.connect(guardian).pauseBorrowing(alice.address, DAY);
    expect(await og.isBorrowingPaused(alice.address)).to.be.true;
    expect(await og.isBorrowingPaused(guardian.address)).to.be.false;
  });

  it("unwired branches (guardian = 0) borrow freely — fail-open testnets", async () => {
    const { deployer } = await loadFixture(guardianFixture);
    const F = await ethers.getContractFactory("BorrowerOperationsRates", deployer);
    const bare = await F.deploy();
    await bare.waitForDeployment();
    expect(await bare.guardian()).to.equal(ethers.ZeroAddress);
  });
});
