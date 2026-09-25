// Fee/issuance plumbing: BranchFeeReceiver accrual + sweep, the
// ZeroCommunityIssuance stub, and BranchCommunityIssuance's SP-gated paths
// (inactive short-circuit, sendLQTY payout).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, rwaFixtureSeeded } = require("./helpers");

async function impersonate(addr, eth = "10") {
  await ethers.provider.send("hardhat_setBalance", [addr, "0x" + E(eth).toString(16)]);
  return ethers.getImpersonatedSigner(addr);
}

describe("Fee routing + issuance stubs", () => {
  it("BranchFeeReceiver accrues TM/BO fees and sweeps to the owner", async () => {
    const f = await loadFixture(rwaFixtureSeeded);
    const { tm, bo, wtbill, orUSD, alice, deployer } = f;
    const R = await ethers.getContractFactory("BranchFeeReceiver");
    const recv = await R.deploy();
    await recv.waitForDeployment();
    await recv.setAddresses(await tm.getAddress(), await bo.getAddress());
    expect(await recv.troveManagerAddress()).to.equal(await tm.getAddress());
    // unauthorized accrual reverts
    await expect(recv.connect(alice).increaseF_ETH(1)).to.be.reverted;
    await expect(recv.connect(alice).increaseF_LUSD(1)).to.be.reverted;
    // TM + BO accrue
    await recv.connect(await impersonate(await tm.getAddress())).increaseF_ETH(E("3"));
    await recv.connect(await impersonate(await bo.getAddress())).increaseF_LUSD(E("50"));
    expect(await recv.F_ETH()).to.equal(E("3"));
    expect(await recv.F_LUSD()).to.equal(E("50"));
    // sweep forwards whatever the contract holds
    await wtbill.connect(alice).faucet(E("3"));
    await wtbill.connect(alice).transfer(await recv.getAddress(), E("3"));
    const t0 = await wtbill.balanceOf(deployer.address);
    await expect(recv.sweep(await wtbill.getAddress(), deployer.address))
      .to.emit(recv, "FeesSwept").withArgs(await wtbill.getAddress(), deployer.address, E("3"));
    expect(await wtbill.balanceOf(deployer.address)).to.equal(t0 + E("3"));
    await expect(recv.connect(alice).sweep(await orUSD.getAddress(), alice.address))
      .to.be.reverted; // owner-only
  });

  it("ZeroCommunityIssuance issues nothing, forever", async () => {
    const Z = await ethers.getContractFactory("ZeroCommunityIssuance");
    const z = await Z.deploy();
    await z.waitForDeployment();
    expect(await z.issueLQTY.staticCall()).to.equal(0n);
    await z.sendLQTY(ethers.ZeroAddress, E("100")); // no-op, never reverts
  });

  it("BranchCommunityIssuance: inactive returns 0; sendLQTY pays from the cap", async () => {
    const f = await loadFixture(rwaFixtureSeeded);
    const { branchCI, sp, ora, alice } = f;
    // inactive short-circuit on a fresh instance (impersonate its SP)
    const B = await ethers.getContractFactory("BranchCommunityIssuance");
    const fresh = await B.deploy();
    await fresh.waitForDeployment();
    await fresh.setAddresses(await ora.getAddress(), await sp.getAddress());
    const spSigner = await impersonate(await sp.getAddress());
    expect(await fresh.connect(spSigner).issueLQTY.staticCall()).to.equal(0n);
    // active instance pays ORA out of its funded cap
    const o0 = await ora.balanceOf(alice.address);
    await branchCI.connect(spSigner).sendLQTY(alice.address, E("100"));
    expect(await ora.balanceOf(alice.address)).to.equal(o0 + E("100"));
    // non-SP callers are gated
    await expect(branchCI.connect(alice).issueLQTY()).to.be.reverted;
    await expect(branchCI.connect(alice).sendLQTY(alice.address, 1)).to.be.reverted;
  });
});
