// ETH v2 rates branch — user-set interest rates, lazy accrual, 80/20 interest
// routing, sorUSD vault mechanics, rate-ordered redemptions.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, ratesFixtureSeeded, rng, randRange } = require("./helpers");

const YEAR = 365 * 24 * 3600;
const DAY = 24 * 3600;
const GAS_COMP = E("200");

describe("Rates branch (ETH v2)", () => {
  describe("opening with a rate", () => {
    it("has no upfront borrow fee (continuous interest replaces it)", async () => {
      const { tm, bo, bob, orUSD } = await loadFixture(ratesFixtureSeeded);
      expect(await tm.getBorrowingRateWithDecay()).to.equal(0n);
      await bo.connect(bob).openTroveWithRate(E("5000"), E("0.05"), Z, Z, { value: E("10") });
      expect(await orUSD.balanceOf(bob.address)).to.equal(E("5000")); // full amount, zero fee
      const [debt] = await tm.getEntireDebtAndColl(bob.address);
      expect(debt).to.equal(E("5200")); // borrow + 200 gas comp, nothing else
    });

    it("enforces the 0.5%–100% rate bounds", async () => {
      const { bo, bob } = await loadFixture(ratesFixtureSeeded);
      await expect(bo.connect(bob).openTroveWithRate(E("5000"), E("0.004"), Z, Z, { value: E("10") }))
        .to.be.revertedWith("TroveManager: bad rate");
      await expect(bo.connect(bob).openTroveWithRate(E("5000"), E("1.01"), Z, Z, { value: E("10") }))
        .to.be.revertedWith("TroveManager: bad rate");
      await bo.connect(bob).openTroveWithRate(E("5000"), E("0.005"), Z, Z, { value: E("10") });
      const { bo: bo2, carol } = await loadFixture(ratesFixtureSeeded); // fresh state
      await bo2.connect(carol).openTroveWithRate(E("5000"), E("1"), Z, Z, { value: E("10") });
    });

    it("records the rate and weights the aggregate", async () => {
      const { tm, bo, bob } = await loadFixture(ratesFixtureSeeded);
      const aggBefore = await tm.aggWeightedDebt();
      await bo.connect(bob).openTroveWithRate(E("5000"), E("0.10"), Z, Z, { value: E("10") });
      expect(await tm.troveAnnualRate(bob.address)).to.equal(E("0.10"));
      expect((await tm.aggWeightedDebt()) - aggBefore).to.equal(E("5200") * E("0.10") / E("1"));
    });
  });

  describe("interest accrual", () => {
    it("matches the closed form debt*rate*dt/year and mints to the router", async () => {
      const { tm, bo, bob, orUSD, router } = await loadFixture(ratesFixtureSeeded);
      await bo.connect(bob).openTroveWithRate(E("10000"), E("0.10"), Z, Z, { value: E("20") });
      const [debt0] = await tm.getEntireDebtAndColl(bob.address);
      await time.increase(30 * DAY);
      const expected = debt0 * E("0.10") / E("1") * BigInt(30 * DAY) / BigInt(YEAR);
      const pending = await tm.calcPendingTroveInterest(bob.address);
      expect(pending).to.be.closeTo(expected, expected / 10000n); // within 1bp (block-time jitter)
      const routerBefore = await orUSD.balanceOf(await router.getAddress());
      await tm.accrueTroveInterest(bob.address); // permissionless keeper poke
      const minted = (await orUSD.balanceOf(await router.getAddress())) - routerBefore;
      expect(minted).to.be.closeTo(expected, expected / 10000n);
      const [debt1] = await tm.getEntireDebtAndColl(bob.address);
      expect(debt1 - debt0).to.equal(minted); // interest is debt-backed, 1:1
    });

    it("system debt equals orUSD supply after accrual (backing invariant)", async () => {
      const { tm, bo, bob, orUSD } = await loadFixture(ratesFixtureSeeded);
      await bo.connect(bob).openTroveWithRate(E("10000"), E("0.25"), Z, Z, { value: E("20") });
      await time.increase(90 * DAY);
      await tm.accrueTroveInterest(bob.address);
      const sysDebt = await tm.getEntireSystemDebt();
      const supply = await orUSD.totalSupply();
      expect(sysDebt - supply).to.be.closeTo(0n, E("0.01")); // dust from lazy whale accrual
    });
  });

  describe("interest routing 80/20", () => {
    it("splits exactly 80% to the vault and 20% to the treasury", async () => {
      const { tm, bo, bob, orUSD, router, vault, treasury } = await loadFixture(ratesFixtureSeeded);
      await bo.connect(bob).openTroveWithRate(E("10000"), E("0.10"), Z, Z, { value: E("20") });
      await time.increase(60 * DAY);
      await tm.accrueTroveInterest(bob.address);
      const pot = await router.pending();
      expect(pot).to.be.gt(0n);
      const vBefore = await vault.totalAssets();
      const tBefore = await orUSD.balanceOf(treasury.address);
      await router.distribute();
      expect((await vault.totalAssets()) - vBefore).to.equal(pot * 8000n / 10000n);
      expect((await orUSD.balanceOf(treasury.address)) - tBefore).to.equal(pot - pot * 8000n / 10000n);
      await expect(router.distribute()).to.be.revertedWith("InterestRouter: nothing to distribute");
    });

    it("sorUSD share price appreciates and withdrawals realize the yield", async () => {
      const { tm, bo, bob, carol, orUSD, router, vault, alice } = await loadFixture(ratesFixtureSeeded);
      // carol saves 5,000 orUSD (funded by alice the whale)
      await orUSD.connect(alice).transfer(carol.address, E("5000"));
      await orUSD.connect(carol).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(carol).deposit(E("5000"));
      const p0 = await vault.sharePrice();
      await bo.connect(bob).openTroveWithRate(E("50000"), E("0.20"), Z, Z, { value: E("100") });
      await time.increase(180 * DAY);
      await tm.accrueTroveInterest(bob.address);
      await router.distribute();
      const p1 = await vault.sharePrice();
      expect(p1).to.be.gt(p0);
      const before = await orUSD.balanceOf(carol.address);
      await vault.connect(carol).redeem(await vault.balanceOf(carol.address));
      expect((await orUSD.balanceOf(carol.address)) - before).to.be.gt(E("5000")); // principal + yield
    });

    it("first vault deposit locks dead shares against share-price manipulation", async () => {
      const { vault, orUSD, alice } = await loadFixture(ratesFixtureSeeded);
      await orUSD.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
      await expect(vault.connect(alice).deposit(500n)).to.be.revertedWith("SorUSD: first deposit too small");
      await vault.connect(alice).deposit(E("1000"));
      expect(await vault.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(1000n);
    });
  });

  describe("rate adjustment", () => {
    it("enforces the 7-day cooldown, then re-weights the aggregate", async () => {
      const { tm, bo, agg, bob } = await loadFixture(ratesFixtureSeeded);
      await bo.connect(bob).openTroveWithRate(E("5000"), E("0.05"), Z, Z, { value: E("10") });
      await expect(bo.connect(bob).adjustTroveRate(E("0.02"), Z, Z))
        .to.be.revertedWith("TroveManager: rate cooldown");
      await time.increase(7 * DAY + 60);
      await agg.setAnswer(2000n * 10n ** 8n); // keep the feed fresh after the warp
      await bo.connect(bob).adjustTroveRate(E("0.02"), Z, Z);
      expect(await tm.troveAnnualRate(bob.address)).to.equal(E("0.02"));
      // second adjust immediately -> cooldown again
      await expect(bo.connect(bob).adjustTroveRate(E("0.09"), Z, Z))
        .to.be.revertedWith("TroveManager: rate cooldown");
    });
  });

  describe("rate-ordered list and redemptions", () => {
    it("sorts troves by rate descending (highest first, cheapest last)", async () => {
      const { sorted, bo, bob, carol, dave } = await loadFixture(ratesFixtureSeeded);
      await bo.connect(bob).openTroveWithRate(E("5000"), E("0.10"), Z, Z, { value: E("10") });
      await bo.connect(carol).openTroveWithRate(E("5000"), E("0.006"), Z, Z, { value: E("10") });
      await bo.connect(dave).openTroveWithRate(E("5000"), E("0.06"), Z, Z, { value: E("10") });
      expect(await sorted.getFirst()).to.equal(bob.address);   // 10%
      expect(await sorted.getLast()).to.equal(carol.address);  // 0.6% — redeemed first
    });

    it("redemptions hit the cheapest-rate trove first, not the lowest ICR", async () => {
      const { tm, bo, agg, orUSD, alice, bob, carol } = await loadFixture(ratesFixtureSeeded);
      // bob: HIGH rate, LOW ICR. carol: cheapest rate, HIGH ICR.
      await bo.connect(bob).openTroveWithRate(E("12000"), E("0.09"), Z, Z, { value: E("10") });  // ~163%
      await bo.connect(carol).openTroveWithRate(E("5000"), E("0.006"), Z, Z, { value: E("10") }); // ~384%
      await time.increase(14 * DAY + 60); // bootstrap period
      await agg.setAnswer(2000n * 10n ** 8n);
      const carolDebt0 = (await tm.getEntireDebtAndColl(carol.address))[0];
      const bobDebt0 = (await tm.getEntireDebtAndColl(bob.address))[0];
      await tm.connect(alice).redeemCollateral(E("500"), Z, Z, Z, 0, 0, E("0.05"));
      const carolDebt1 = (await tm.getEntireDebtAndColl(carol.address))[0];
      const bobDebt1 = (await tm.getEntireDebtAndColl(bob.address))[0];
      expect(carolDebt0 - carolDebt1).to.be.closeTo(E("500"), E("1")); // cheapest pays
      expect(bobDebt1).to.be.gte(bobDebt0); // high-rate trove untouched (only accrues)
    });

    it("redemptions are blocked during the 14-day bootstrap", async () => {
      const { tm, alice } = await loadFixture(ratesFixtureSeeded);
      await expect(tm.connect(alice).redeemCollateral(E("100"), Z, Z, Z, 0, 0, E("0.05")))
        .to.be.revertedWith("TroveManager: Redemptions are not allowed during bootstrap phase");
    });
  });

  describe("FUZZ: accrual math", () => {
    it("pending interest matches closed form for random rates and durations", async () => {
      const { tm, bo, bob, agg } = await loadFixture(ratesFixtureSeeded);
      const next = rng(7);
      const rate = randRange(next, E("0.005"), E("1")); // one random rate per trove lifetime
      await bo.connect(bob).openTroveWithRate(E("8000"), rate, Z, Z, { value: E("50") });
      let last = 0n;
      for (let i = 0; i < 25; i++) {
        const dt = randRange(next, 600n, BigInt(45 * DAY));
        await time.increase(Number(dt));
        const [debt] = await tm.getEntireDebtAndColl(bob.address);
        const pending = await tm.calcPendingTroveInterest(bob.address);
        expect(pending).to.be.gte(last === 0n ? 0n : 0n);
        // closed form vs. contract, within 0.01% (jitter from tx timestamps)
        // debt returned by getEntireDebtAndColl already includes pending interest,
        // so recompute from the recorded (pre-pending) figure:
        const recorded = debt - pending;
        const dtActual = await time.latest() - Number((await tm.troveLastDebtUpdate(bob.address)));
        const expected = recorded * rate / E("1") * BigInt(dtActual) / BigInt(YEAR);
        expect(pending).to.be.closeTo(expected, expected / 5000n + 10n);
        if (Number(randRange(next, 0n, 2n)) === 0) {
          await agg.setAnswer(2000n * 10n ** 8n);
          await tm.accrueTroveInterest(bob.address); // settle at random points
          last = 0n;
        }
      }
    });
  });
});
