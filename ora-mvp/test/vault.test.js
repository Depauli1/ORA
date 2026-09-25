// SorUSDVault: shares math (incl. the dead-shares first deposit), yield
// accrual via streamed interest, the ERC20 surface, and every revert.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, ratesFixtureSeeded } = require("./helpers");

const DEAD = "0x000000000000000000000000000000000000dEaD";

async function vaultFixture() {
  const f = await ratesFixtureSeeded(); // alice holds orUSD
  const { orUSD, vault, alice, bob } = f;
  await orUSD.connect(alice).transfer(bob.address, E("3000"));
  for (const s of [alice, bob])
    await orUSD.connect(s).approve(await vault.getAddress(), ethers.MaxUint256);
  return { ...f };
}

describe("SorUSDVault", () => {
  it("constructor rejects the zero asset", async () => {
    const V = await ethers.getContractFactory("SorUSDVault");
    await expect(V.deploy(ethers.ZeroAddress)).to.be.revertedWith("SorUSD: asset is zero address");
  });

  it("first deposit locks 1000 dead shares; share price starts at 1.0", async () => {
    const { vault, alice } = await loadFixture(vaultFixture);
    await vault.connect(alice).deposit(E("5000"));
    expect(await vault.balanceOf(DEAD)).to.equal(1000n);
    expect(await vault.balanceOf(alice.address)).to.equal(E("5000") - 1000n);
    expect(await vault.sharePrice()).to.equal(E("1"));
    expect(await vault.convertToShares(E("100"))).to.be.closeTo(E("100"), 1000n);
  });

  it("rejects dust first deposits and zero-amount calls", async () => {
    const { vault, alice } = await loadFixture(vaultFixture);
    await expect(vault.connect(alice).deposit(500n))
      .to.be.revertedWith("SorUSD: first deposit too small");
    await expect(vault.connect(alice).deposit(0)).to.be.revertedWith("SorUSD: zero assets");
    await expect(vault.connect(alice).redeem(0)).to.be.revertedWith("SorUSD: zero shares");
  });

  it("streamed interest raises the share price for all holders", async () => {
    const { vault, orUSD, alice, bob, deployer } = await loadFixture(vaultFixture);
    await vault.connect(alice).deposit(E("5000"));
    await vault.connect(bob).deposit(E("3000"));
    // InterestRouter streams yield by transferring orUSD into the vault
    await orUSD.connect(alice).transfer(await vault.getAddress(), E("500"));
    expect(await vault.totalAssets()).to.equal(E("8500"));
    expect(await vault.sharePrice()).to.be.gt(E("1"));
    const assets = await vault.connect(alice).redeem.staticCall(E("2000"));
    expect(assets).to.be.gt(E("2000")); // shares appreciated
    void deployer;
  });

  it("redeem pays pro-rata assets and burns shares", async () => {
    const { vault, orUSD, alice } = await loadFixture(vaultFixture);
    await vault.connect(alice).deposit(E("5000"));
    const o0 = await orUSD.balanceOf(alice.address);
    await vault.connect(alice).redeem(E("2000"));
    expect(await orUSD.balanceOf(alice.address)).to.be.closeTo(o0 + E("2000"), 1000n);
    expect(await vault.balanceOf(alice.address)).to.equal(E("3000") - 1000n);
  });

  it("shares are ERC20: transfer / approve / transferFrom", async () => {
    const { vault, alice, bob, carol } = await loadFixture(vaultFixture);
    await vault.connect(alice).deposit(E("5000"));
    await vault.connect(alice).transfer(bob.address, E("1000"));
    expect(await vault.balanceOf(bob.address)).to.equal(E("1000"));
    await vault.connect(alice).approve(bob.address, E("500"));
    expect(await vault.allowance(alice.address, bob.address)).to.equal(E("500"));
    await vault.connect(bob).transferFrom(alice.address, carol.address, E("500"));
    expect(await vault.balanceOf(carol.address)).to.equal(E("500"));
    await expect(vault.connect(alice).transfer(ethers.ZeroAddress, 1))
      .to.be.revertedWith("SorUSD: transfer to zero address");
  });
});
