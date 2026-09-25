// BranchStaking: per-branch ORA staking with ERC20 collateral gains.
// Driven standalone with an impersonated TroveManager (the only address the
// increaseF_* gates accept), plus ORA/fee funding from the seeded RWA fixture.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, rwaFixtureSeeded } = require("./helpers");

async function stakingFixture() {
  const f = await rwaFixtureSeeded(); // alice holds ~50k orUSD
  const { ora, wtbill, orUSD, tm, bo, ap, deployer, alice, bob } = f;
  const S = await ethers.getContractFactory("BranchStaking");
  const staking = await S.deploy();
  await staking.waitForDeployment();
  await staking.setCollToken(await wtbill.getAddress());
  await staking.setAddresses(await ora.getAddress(), await orUSD.getAddress(),
    await tm.getAddress(), await bo.getAddress(), await ap.getAddress());
  // fund stakers with ORA (treasury's allocation is outside the year-1 lock)
  const { treasury } = f;
  await ora.connect(treasury).transfer(alice.address, E("10000"));
  await ora.connect(treasury).transfer(bob.address, E("10000"));
  await ora.connect(alice).approve(await staking.getAddress(), ethers.MaxUint256);
  await ora.connect(bob).approve(await staking.getAddress(), ethers.MaxUint256);
  // impersonate the TroveManager for the increaseF_* gates
  const tmAddr = await tm.getAddress();
  await ethers.provider.send("hardhat_setBalance", [tmAddr, "0x" + E("10").toString(16)]);
  const tmSigner = await ethers.getImpersonatedSigner(tmAddr);
  const boAddr = await bo.getAddress();
  await ethers.provider.send("hardhat_setBalance", [boAddr, "0x" + E("10").toString(16)]);
  const boSigner = await ethers.getImpersonatedSigner(boAddr);
  return { ...f, staking, tmSigner, boSigner };
}

describe("BranchStaking", () => {
  it("wires addresses, then renounces ownership", async () => {
    const { staking, ora, orUSD, tm, bo, ap, deployer } = await stakingFixture();
    expect(await staking.lqtyToken()).to.equal(await ora.getAddress());
    expect(await staking.lusdToken()).to.equal(await orUSD.getAddress());
    expect(await staking.troveManagerAddress()).to.equal(await tm.getAddress());
    expect(await staking.borrowerOperationsAddress()).to.equal(await bo.getAddress());
    expect(await staking.activePoolAddress()).to.equal(await ap.getAddress());
    expect(await staking.owner()).to.equal(ethers.ZeroAddress);
    await expect(staking.connect(deployer).setCollToken(await orUSD.getAddress()))
      .to.be.reverted; // ownerless now
  });

  it("rejects zero-amount stakes", async () => {
    const { staking, alice } = await stakingFixture();
    await expect(staking.connect(alice).stake(0)).to.be.reverted;
  });

  it("stakes, accrues collateral gains, and pays them on unstake", async () => {
    const { staking, tmSigner, ora, wtbill, alice, bob } = await stakingFixture();
    await staking.connect(alice).stake(E("1000"));
    expect(await staking.stakes(alice.address)).to.equal(E("1000"));
    expect(await staking.totalLQTYStaked()).to.equal(E("1000"));
    // protocol fees arrive: fund the pool, then record them as the TM
    await wtbill.connect(alice).faucet(E("100"));
    await wtbill.connect(alice).transfer(await staking.getAddress(), E("100"));
    await staking.connect(tmSigner).increaseF_ETH(E("100"));
    expect(await staking.getPendingETHGain(alice.address)).to.equal(E("100"));
    // bob stakes afterwards: gains stay with alice (snapshot isolation)
    await staking.connect(bob).stake(E("1000"));
    expect(await staking.getPendingETHGain(bob.address)).to.equal(0n);
    const w0 = await wtbill.balanceOf(alice.address);
    await staking.connect(alice).unstake(E("1000"));
    expect(await wtbill.balanceOf(alice.address)).to.equal(w0 + E("100"));
    expect(await ora.balanceOf(alice.address)).to.equal(E("10000")); // stake returned
    expect(await staking.totalLQTYStaked()).to.equal(E("1000")); // bob's remains
  });

  it("orUSD gains accrue and pay out on re-stake", async () => {
    const { staking, tmSigner, boSigner, orUSD, alice } = await stakingFixture();
    await staking.connect(alice).stake(E("1000"));
    await orUSD.connect(alice).transfer(await staking.getAddress(), E("500"));
    await staking.connect(boSigner).increaseF_LUSD(E("500")); // LUSD fees come from BO
    expect(await staking.getPendingLUSDGain(alice.address)).to.equal(E("500"));
    const o0 = await orUSD.balanceOf(alice.address);
    await staking.connect(alice).stake(E("100")); // re-stake pays pending gains
    expect(await orUSD.balanceOf(alice.address)).to.be.closeTo(o0 + E("500"), E("0.01"));
  });

  it("unstaking more than the stake withdraws everything (_min branch)", async () => {
    const { staking, alice, ora } = await stakingFixture();
    await staking.connect(alice).stake(E("1000"));
    await staking.connect(alice).unstake(E("999999"));
    expect(await staking.stakes(alice.address)).to.equal(0n);
    expect(await ora.balanceOf(alice.address)).to.equal(E("10000"));
  });

  it("reverts: unstake without stake; increaseF from non-TM/BO", async () => {
    const { staking, alice, bob } = await stakingFixture();
    await expect(staking.connect(bob).unstake(E("1"))).to.be.reverted;
    await expect(staking.connect(alice).increaseF_ETH(E("1"))).to.be.reverted;
    await expect(staking.connect(alice).increaseF_LUSD(E("1"))).to.be.reverted;
  });
});
