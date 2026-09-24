// wmTBILL RWA branch — per-branch risk params (MCR 105% / CCR 115%), the
// [103%, 105%) soft-liquidation band, the strict debt cap, and composite
// NAV x wrapper-rate pricing through the oracle safety machinery.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, MAX_FEE, rwaFixture, rwaFixtureSeeded } = require("./helpers");

async function fundAndApprove(f, signer, shares) {
  await f.wtbill.connect(signer).faucet(shares);
  await f.wtbill.connect(signer).approve(await f.bo.getAddress(), ethers.MaxUint256);
}

describe("RWA branch (wmTBILL, MCR 105%)", () => {
  describe("parameters", () => {
    it("MCR 105%, CCR 115%, soft floor 103%, premium 103%", async () => {
      const { tm } = await loadFixture(rwaFixture);
      expect(await tm.MCR()).to.equal(E("1.05"));
      expect(await tm.CCR()).to.equal(E("1.15"));
      expect(await tm.SOFT_LIQ_FLOOR()).to.equal(E("1.03"));
      expect(await tm.SOFT_LIQ_PREMIUM()).to.equal(E("1.03"));
    });

    it("composite price = NAV x wrapper rate (~$1.05 at genesis)", async () => {
      const { feed } = await loadFixture(rwaFixture);
      const p = await feed.getPrice();
      expect(p).to.be.closeTo(E("1.05"), E("0.0001"));
    });
  });

  describe("borrowing at RWA leverage", () => {
    it("opens at ~107% ICR — impossible on 110%-MCR branches", async () => {
      const f = await loadFixture(rwaFixtureSeeded);
      const { tm, bo, bob, feed } = f;
      await fundAndApprove(f, bob, E("10000"));
      await bo.connect(bob).openTrove(MAX_FEE, E("9600"), E("10000"), Z, Z);
      const icr = await tm.getCurrentICR(bob.address, await feed.getPrice());
      expect(icr).to.be.gt(E("1.05"));
      expect(icr).to.be.lt(E("1.08"));
    });

    it("rejects an open below 105% ICR", async () => {
      const f = await loadFixture(rwaFixtureSeeded);
      const { bo, bob } = f;
      await fundAndApprove(f, bob, E("10000"));
      // 10,000 coll @ $1.05 = $10,500 value; 10,300 total debt -> ICR ~101.9%
      await expect(bo.connect(bob).openTrove(MAX_FEE, E("10100"), E("10000"), Z, Z))
        .to.be.reverted;
    });

    it("first trove on the branch must clear CCR 115%", async () => {
      const f = await loadFixture(rwaFixture); // NOT seeded — empty branch
      const { bo, bob } = f;
      await fundAndApprove(f, bob, E("10000"));
      // ICR ~107% > MCR but < CCR -> rejected while TCR = ICR
      await expect(bo.connect(bob).openTrove(MAX_FEE, E("9600"), E("10000"), Z, Z))
        .to.be.reverted;
      // ICR ~127% clears CCR
      await bo.connect(bob).openTrove(MAX_FEE, E("8000"), E("10000"), Z, Z);
    });

    it("enforces the 2M orUSD debt cap on every mint", async () => {
      const f = await loadFixture(rwaFixtureSeeded); // whale already owes 300k
      const { bo, bob } = f;
      await fundAndApprove(f, bob, E("2500000"));
      await expect(bo.connect(bob).openTrove(MAX_FEE, E("1700001"), E("2500000"), Z, Z))
        .to.be.reverted; // 300k + 1.7M + gas comp > cap
      await bo.connect(bob).openTrove(MAX_FEE, E("1650000"), E("2500000"), Z, Z); // under cap
    });
  });

  describe("liquidations around the 105% MCR", () => {
    async function baitFixture() {
      const f = await rwaFixtureSeeded();
      const { bo, bob } = f;
      await fundAndApprove(f, bob, E("12000"));
      await bo.connect(bob).openTrove(MAX_FEE, E("11600"), E("12000"), Z, Z); // ~106.8%
      return f;
    }

    it("cannot liquidate above MCR (106.8% is safe here)", async () => {
      const f = await loadFixture(baitFixture);
      await expect(f.tm.liquidate(f.bob.address)).to.be.reverted;
    });

    it("a -2% NAV print drops the trove into the soft band; liquidatePartial restores exactly 105%", async () => {
      const f = await loadFixture(baitFixture);
      const { tm, aggNav, feed, bob, carol } = f;
      await aggNav.setAnswer(102900000n); // $1.029
      const price = await feed.getPrice();
      const icr = await tm.getCurrentICR(bob.address, price);
      expect(icr).to.be.gte(E("1.03"));
      expect(icr).to.be.lt(E("1.05"));
      const [debt0] = await tm.getEntireDebtAndColl(bob.address);
      await tm.connect(carol).liquidatePartial(bob.address);
      expect(await tm.getTroveStatus(bob.address)).to.equal(1n); // still ACTIVE
      const [debt1] = await tm.getEntireDebtAndColl(bob.address);
      expect(debt1).to.be.lt(debt0);
      expect(debt1).to.be.gte(E("2000")); // remainder is a valid trove
      const icrAfter = await tm.getCurrentICR(bob.address, price);
      expect(icrAfter).to.be.closeTo(E("1.05"), E("0.0001"));
    });

    it("soft-liq pays the caller 0.5% of seized collateral", async () => {
      const f = await loadFixture(baitFixture);
      const { tm, aggNav, wtbill, bob, carol } = f;
      await aggNav.setAnswer(102900000n);
      const before = await wtbill.balanceOf(carol.address);
      await tm.connect(carol).liquidatePartial(bob.address);
      expect(await wtbill.balanceOf(carol.address)).to.be.gt(before);
    });

    it("below the 103% floor only full liquidation applies", async () => {
      const f = await loadFixture(baitFixture);
      const { tm, aggNav, feed, bob, carol } = f;
      await aggNav.setAnswer(100500000n); // $1.005 -> bait ICR ~102.2%
      const icr = await tm.getCurrentICR(bob.address, await feed.getPrice());
      expect(icr).to.be.lt(E("1.03"));
      await expect(tm.connect(carol).liquidatePartial(bob.address)).to.be.reverted;
      await tm.connect(carol).liquidate(bob.address); // full liq absorbs into the SP
      expect(await tm.getTroveStatus(bob.address)).to.not.equal(1n);
    });
  });

  describe("oracle machinery through the wrapper feed", () => {
    it("passes the +2%/update NAV clamp through the composite price", async () => {
      const { aggNav, navFeed, feed } = await loadFixture(rwaFixtureSeeded);
      await aggNav.setAnswer(126000000n); // manipulated +20% print
      await feed.fetchPrice();
      const nav = await navFeed.lastGoodPrice();
      expect(nav).to.be.lte(E("1.071")); // clamped to 1.05 * 1.02
      // the view previews the NEXT fetch's ratchet step: at most another +2%
      expect(await feed.getPrice()).to.be.lte(E("1.0925"));
      // even after 3 more fetches the ratchet is nowhere near the +20% print
      await feed.fetchPrice(); await feed.fetchPrice(); await feed.fetchPrice();
      expect(await navFeed.lastGoodPrice()).to.be.lte(E("1.137"));
    });

    it("flags navShock on >2% drops and proxies it through the wrapper feed", async () => {
      const { aggNav, feed } = await loadFixture(rwaFixtureSeeded);
      expect(await feed.navShock()).to.equal(false);
      await aggNav.setAnswer(101800000n); // -3.05%
      await feed.fetchPrice();
      expect(await feed.navShock()).to.equal(true);
      expect(await feed.oracleLive()).to.equal(true);
    });

    it("composite price decays with the wrapper rate (skim reaches borrowers' pricing)", async () => {
      const { feed, wtbill, aggNav } = await loadFixture(rwaFixtureSeeded);
      const p0 = await feed.getPrice();
      await time.increase(182 * 24 * 3600);
      await aggNav.setAnswer(105000000n); // refresh NAV (staleness after warp)
      const p1 = await feed.getPrice();
      const rate = await wtbill.currentRate();
      expect(p1).to.be.closeTo(E("1.05") * rate / E("1"), E("0.0001"));
      expect(p1).to.be.lt(p0);
    });
  });

  describe("skim + custody through live borrowing", () => {
    it("treasury claims real mTBILL while troves stay solvent", async () => {
      const f = await loadFixture(rwaFixtureSeeded);
      const { tm, wtbill, tbill, aggNav, feed, treasury, alice } = f;
      await time.increase(365 * 24 * 3600 / 2);
      await wtbill.settle();
      const skim = await wtbill.skimAccrued();
      expect(skim).to.be.gt(E("4900")); // ~1% of 500k collateral
      await wtbill.claimSkim();
      expect(await tbill.balanceOf(treasury.address)).to.be.gte(skim);
      // whale is still comfortably solvent at the decayed composite price
      await aggNav.setAnswer(105000000n);
      const icr = await tm.getCurrentICR(alice.address, await feed.getPrice());
      expect(icr).to.be.gt(E("1.5"));
      // custody invariant after the claim
      const bal = await tbill.balanceOf(await wtbill.getAddress());
      const need = (await wtbill.totalSupply()) * (await wtbill.rate()) / E("1") + (await wtbill.skimAccrued());
      expect(bal - need).to.be.gte(0n);
      expect(bal - need).to.be.lt(E("0.000001"));
    });
  });
});
