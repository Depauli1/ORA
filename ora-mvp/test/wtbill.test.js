// WTBill (wmTBILL) — the RWA yield-share wrapper.
// Unit tests for wrap/unwrap/faucet/skim/claim + a randomized fuzz run of the
// custody invariant: tbill.balanceOf(wrapper) == totalSupply*rate/1e18 + skimAccrued.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, rng, randRange } = require("./helpers");

const YEAR = 365 * 24 * 3600;

async function fixture() {
  const [deployer, treasury, alice, bob] = await ethers.getSigners();
  const MockTBill = await ethers.getContractFactory("MockTBill");
  const tbill = await MockTBill.deploy();
  const WTBill = await ethers.getContractFactory("WTBill");
  const wtbill = await WTBill.deploy(await tbill.getAddress(), treasury.address);
  return { deployer, treasury, alice, bob, tbill, wtbill };
}

async function custodyGap(tbill, wtbill) {
  const bal = await tbill.balanceOf(await wtbill.getAddress());
  const need = (await wtbill.totalSupply()) * (await wtbill.rate()) / E("1") + (await wtbill.skimAccrued());
  return bal - need; // must be >= 0 and tiny
}

describe("WTBill (wmTBILL yield-share wrapper)", () => {
  it("constructor rejects zero addresses", async () => {
    const { tbill } = await loadFixture(fixture);
    const WTBill = await ethers.getContractFactory("WTBill");
    await expect(WTBill.deploy(ethers.ZeroAddress, tbill.getAddress())).to.be.reverted;
    await expect(WTBill.deploy(tbill.getAddress(), ethers.ZeroAddress)).to.be.reverted;
  });

  it("skim rate constant is 2%/yr and rate starts at 1e18", async () => {
    const { wtbill } = await loadFixture(fixture);
    expect(await wtbill.SKIM_RATE_PER_YEAR()).to.equal(E("0.02"));
    expect(await wtbill.rate()).to.equal(E("1"));
  });

  it("faucet mints exactly the requested shares (looping the 100k underlying cap)", async () => {
    const { wtbill, alice } = await loadFixture(fixture);
    await wtbill.connect(alice).faucet(E("250000")); // needs >2 underlying faucet calls
    expect(await wtbill.balanceOf(alice.address)).to.equal(E("250000"));
    expect(await wtbill.totalSupply()).to.equal(E("250000"));
  });

  it("wrap pulls underlying and mints shares at the current rate; unwrap reverses", async () => {
    const { tbill, wtbill, alice } = await loadFixture(fixture);
    await tbill.connect(alice).faucet(E("1000"));
    await tbill.connect(alice).approve(await wtbill.getAddress(), ethers.MaxUint256);
    await wtbill.connect(alice).wrap(E("1000"));
    const shares = await wtbill.balanceOf(alice.address);
    // rate ~1.0 seconds after deploy: shares within 1e-6 of 1000
    expect(shares).to.be.closeTo(E("1000"), E("0.001"));
    await wtbill.connect(alice).unwrap(shares);
    expect(await wtbill.balanceOf(alice.address)).to.equal(0n);
    // gets back what was put in, minus skim dust for the elapsed seconds
    expect(await tbill.balanceOf(alice.address)).to.be.closeTo(E("1000"), E("0.001"));
  });

  it("rate decays linearly at 2%/yr between settles", async () => {
    const { wtbill, alice } = await loadFixture(fixture);
    await wtbill.connect(alice).faucet(E("10000"));
    await wtbill.settle();
    const r0 = await wtbill.rate();
    await time.increase(YEAR / 2);
    const expected = r0 - (r0 * E("0.02") * BigInt(YEAR / 2)) / (BigInt(YEAR) * E("1"));
    expect(await wtbill.currentRate()).to.be.closeTo(expected, 10n ** 12n);
    await wtbill.settle();
    expect(await wtbill.rate()).to.be.closeTo(expected, 10n ** 12n);
  });

  it("skim decay compounds across settles (rate multiplies down, never negative)", async () => {
    const { wtbill, alice } = await loadFixture(fixture);
    await wtbill.connect(alice).faucet(E("10000"));
    for (let i = 0; i < 4; i++) {
      await time.increase(YEAR); // extreme: 4 years
      await wtbill.settle();
    }
    const r = await wtbill.rate();
    // (1 - 0.02)^4 = 0.92236816
    expect(r).to.be.closeTo(E("0.92236816"), E("0.0001"));
    expect(r).to.be.gt(0n);
  });

  it("claimSkim pays the treasury exactly skimAccrued and zeroes it", async () => {
    const { tbill, wtbill, treasury, alice } = await loadFixture(fixture);
    await wtbill.connect(alice).faucet(E("100000"));
    await time.increase(YEAR / 4);
    await wtbill.settle();
    const skim = await wtbill.skimAccrued();
    expect(skim).to.be.gt(0n);
    // ~100000 * 0.5% = ~500 mTBILL for a quarter year
    expect(skim).to.be.closeTo(E("500"), E("1"));
    const before = await tbill.balanceOf(treasury.address);
    await wtbill.connect(alice).claimSkim(); // anyone can poke; funds go to treasury only
    expect((await tbill.balanceOf(treasury.address)) - before).to.be.gte(skim);
    expect(await wtbill.skimAccrued()).to.equal(0n);
  });

  it("claimSkim reverts when nothing has accrued (zero supply)", async () => {
    const { wtbill } = await loadFixture(fixture);
    await expect(wtbill.claimSkim()).to.be.revertedWith("WTBill: nothing to claim");
  });

  it("share value tracks rate: unwrap after decay returns fewer mTBILL", async () => {
    const { tbill, wtbill, alice } = await loadFixture(fixture);
    await wtbill.connect(alice).faucet(E("1000"));
    await time.increase(YEAR);
    await wtbill.connect(alice).unwrap(E("1000"));
    const got = await tbill.balanceOf(alice.address);
    expect(got).to.be.closeTo(E("980"), E("0.01")); // 2% skimmed over a year
  });

  it("ERC20 basics: transfer, approve/transferFrom, over-balance reverts", async () => {
    const { wtbill, alice, bob } = await loadFixture(fixture);
    await wtbill.connect(alice).faucet(E("100"));
    await wtbill.connect(alice).transfer(bob.address, E("40"));
    expect(await wtbill.balanceOf(bob.address)).to.equal(E("40"));
    await wtbill.connect(bob).approve(alice.address, E("10"));
    await wtbill.connect(alice).transferFrom(bob.address, alice.address, E("10"));
    expect(await wtbill.balanceOf(bob.address)).to.equal(E("30"));
    await expect(wtbill.connect(bob).transfer(alice.address, E("31"))).to.be.reverted;
    await expect(wtbill.connect(alice).transferFrom(bob.address, alice.address, E("1"))).to.be.reverted;
    await expect(wtbill.connect(alice).transfer(ethers.ZeroAddress, E("1")))
      .to.be.revertedWith("WTBill: transfer to zero address");
  });

  it("FUZZ: custody invariant holds through random faucet/wrap/unwrap/warp/claim sequences", async () => {
    const { tbill, wtbill, alice, bob } = await loadFixture(fixture);
    const next = rng(42);
    const actors = [alice, bob];
    for (const s of actors) {
      await tbill.connect(s).faucet(E("100000"));
      await tbill.connect(s).approve(await wtbill.getAddress(), ethers.MaxUint256);
    }
    let ops = 0;
    for (let i = 0; i < 120; i++) {
      const actor = actors[Number(randRange(next, 0n, 1n))];
      const action = Number(randRange(next, 0n, 5n));
      const sharesBal = await wtbill.balanceOf(actor.address);
      const underBal = await tbill.balanceOf(actor.address);
      try {
        if (action === 0) { await wtbill.connect(actor).faucet(randRange(next, E("1"), E("50000"))); ops++; }
        else if (action === 1 && underBal > E("1")) { await wtbill.connect(actor).wrap(randRange(next, 1n, underBal)); ops++; }
        else if (action === 2 && sharesBal > 0n) { await wtbill.connect(actor).unwrap(randRange(next, 1n, sharesBal)); ops++; }
        else if (action === 3) { await time.increase(Number(randRange(next, 3600n, BigInt(90 * 24 * 3600)))); }
        else if (action === 4) { await wtbill.settle(); }
        else if (action === 5 && (await wtbill.skimAccrued()) > 0n) { await wtbill.claimSkim(); ops++; }
      } catch (e) {
        throw new Error(`fuzz op ${i} (action ${action}) reverted unexpectedly: ${e.message}`);
      }
      const gap = await custodyGap(tbill, wtbill);
      expect(gap, `custody underflow at op ${i}`).to.be.gte(0n);
      // dust: +1 wei per faucet + flooring on each op — generous bound
      expect(gap, `custody dust blowup at op ${i}`).to.be.lt(BigInt(ops + 2) * 10n ** 6n);
    }
    // rate only ever decreases
    expect(await wtbill.rate()).to.be.lte(E("1"));
  });
});
