// LeverZap + LeverZapFactory — one-click leverage on the rates branch.
// Ownership gating, open/close round trips, parameter guards, fund sweeps,
// and a fuzz over deposit sizes / LTVs.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, ratesFixtureSeeded, rng, randRange } = require("./helpers");

async function zapFixture() {
  const f = await ratesFixtureSeeded();
  await f.zapFactory.connect(f.bob).createZap();
  const zapAddr = await f.zapFactory.zapOf(f.bob.address);
  const zap = await ethers.getContractAt("LeverZap", zapAddr);
  return { ...f, zap, zapAddr };
}

describe("LeverZap (one-click leverage)", () => {
  describe("factory", () => {
    it("deploys one zap per user, owned by that user", async () => {
      const { zapFactory, zap, zapAddr, bob } = await loadFixture(zapFixture);
      expect(zapAddr).to.not.equal(Z);
      expect(await zap.owner()).to.equal(bob.address);
      await expect(zapFactory.connect(bob).createZap())
        .to.be.revertedWith("LeverZapFactory: zap exists");
      expect(await zapFactory.zapOf(bob.address)).to.equal(zapAddr);
    });

    it("wires the zap to the branch contracts", async () => {
      const { zapFactory, bo, tm, pool, orUSD } = await loadFixture(zapFixture);
      expect(await zapFactory.borrowerOps()).to.equal(await bo.getAddress());
      expect(await zapFactory.troveManager()).to.equal(await tm.getAddress());
      expect(await zapFactory.pool()).to.equal(await pool.getAddress());
      expect(await zapFactory.orUSD()).to.equal(await orUSD.getAddress());
    });
  });

  describe("access control", () => {
    it("only the owner can leverOpen / leverClose / exec", async () => {
      const { zap, carol } = await loadFixture(zapFixture);
      await expect(zap.connect(carol).leverOpen(E("0.05"), 6000, 6, { value: E("1") }))
        .to.be.revertedWith("LeverZap: caller is not owner");
      await expect(zap.connect(carol).leverClose())
        .to.be.revertedWith("LeverZap: caller is not owner");
      await expect(zap.connect(carol).exec(carol.address, "0x", 0))
        .to.be.revertedWith("LeverZap: caller is not owner");
    });
  });

  describe("parameter guards", () => {
    it("rejects zero deposit, LTV out of (0, 80%], too-small first borrow, double open", async () => {
      const { zap, bob } = await loadFixture(zapFixture);
      await expect(zap.connect(bob).leverOpen(E("0.05"), 6000, 6))
        .to.be.revertedWith("LeverZap: no ETH sent");
      await expect(zap.connect(bob).leverOpen(E("0.05"), 0, 6, { value: E("2") }))
        .to.be.revertedWith("LeverZap: LTV must be in (0, 80%]");
      await expect(zap.connect(bob).leverOpen(E("0.05"), 8001, 6, { value: E("2") }))
        .to.be.revertedWith("LeverZap: LTV must be in (0, 80%]");
      // 0.5 ETH * $2000 * 60% = 600 orUSD < 1800 minimum
      await expect(zap.connect(bob).leverOpen(E("0.05"), 6000, 6, { value: E("0.5") }))
        .to.be.revertedWith("LeverZap: deposit too small for min 1800 orUSD debt");
      await zap.connect(bob).leverOpen(E("0.05"), 6000, 6, { value: E("2") });
      await expect(zap.connect(bob).leverOpen(E("0.05"), 6000, 6, { value: E("2") }))
        .to.be.revertedWith("LeverZap: position already open");
    });
  });

  describe("leverOpen", () => {
    it("levers 2 ETH toward the ~2.5x target at the chosen rate", async () => {
      const { zap, tm, bob, zapAddr } = await loadFixture(zapFixture);
      await zap.connect(bob).leverOpen(E("0.05"), 6000, 6, { value: E("2") });
      const [debt, coll, rate, status] = await zap.position();
      expect(status).to.equal(1n);
      expect(rate).to.equal(E("0.05"));
      expect(coll).to.be.gte(E("3.5"));  // >1.75x despite pool slippage
      expect(coll).to.be.lte(E("5"));    // bounded by the 2.5x geometric target
      expect(debt).to.be.gte(E("4000"));
      // trove belongs to the zap, is above MCR, holds no idle funds
      expect(await tm.getCurrentICR(zapAddr, E("2000"))).to.be.gt(E("1.1"));
      expect(await ethers.provider.getBalance(zapAddr)).to.equal(0n);
    });

    it("lower LTV gives lower leverage", async () => {
      const { zap, bob } = await loadFixture(zapFixture);
      await zap.connect(bob).leverOpen(E("0.05"), 3333, 6, { value: E("3") }); // 1.5x target
      const [, coll] = await zap.position();
      expect(coll).to.be.gte(E("4"));
      expect(coll).to.be.lte(E("4.6"));
    });
  });

  describe("leverClose", () => {
    it("fully unwinds without flash loans and returns ~all ETH", async () => {
      const { zap, tm, orUSD, bob, zapAddr } = await loadFixture(zapFixture);
      await zap.connect(bob).leverOpen(E("0.05"), 6000, 6, { value: E("2") });
      const before = await ethers.provider.getBalance(bob.address);
      const tx = await zap.connect(bob).leverClose();
      const rc = await tx.wait();
      const gas = rc.gasUsed * rc.gasPrice;
      const back = (await ethers.provider.getBalance(bob.address)) - before + gas;
      expect(await tm.getTroveStatus(zapAddr)).to.not.equal(1n);
      expect(back).to.be.gt(E("1.9"));   // round trip loses only AMM fees
      expect(back).to.be.lt(E("2.01"));
      // zap holds nothing afterwards
      expect(await ethers.provider.getBalance(zapAddr)).to.equal(0n);
      expect(await orUSD.balanceOf(zapAddr)).to.equal(0n);
    });

    it("reverts when there is no open position; zap is reusable after close", async () => {
      const { zap, bob } = await loadFixture(zapFixture);
      await expect(zap.connect(bob).leverClose())
        .to.be.revertedWith("LeverZap: no open position");
      await zap.connect(bob).leverOpen(E("0.05"), 5000, 6, { value: E("2") });
      await zap.connect(bob).leverClose();
      await zap.connect(bob).leverOpen(E("0.07"), 5000, 6, { value: E("2") }); // reopen works
      const [, , rate, status] = await zap.position();
      expect(status).to.equal(1n);
      expect(rate).to.equal(E("0.07"));
    });
  });

  describe("exec escape hatch", () => {
    it("lets the owner run arbitrary calls (rescue path)", async () => {
      const { zap, orUSD, bob, carol } = await loadFixture(zapFixture);
      // send stray orUSD to the zap, rescue it via exec
      const { alice } = await loadFixture(zapFixture);
      await orUSD.connect(alice).transfer(await zap.getAddress(), E("100"));
      const data = orUSD.interface.encodeFunctionData("transfer", [carol.address, E("100")]);
      await zap.connect(bob).exec(await orUSD.getAddress(), data, 0);
      expect(await orUSD.balanceOf(carol.address)).to.equal(E("100"));
    });
  });

  describe("FUZZ: open/close round trips across deposits and LTVs", () => {
    it("always closes fully and returns >95% of the deposit", async () => {
      const { zap, tm, orUSD, bob, zapAddr, agg } = await loadFixture(zapFixture);
      const next = rng(99);
      for (let i = 0; i < 8; i++) {
        const dep = randRange(next, E("3"), E("6")); // 3 ETH covers min debt even at 30% LTV
        const ltv = randRange(next, 3000n, 7000n);
        const rate = randRange(next, E("0.005"), E("0.5"));
        await zap.connect(bob).leverOpen(rate, ltv, 6, { value: dep });
        const [debt, coll, , status] = await zap.position();
        expect(status, `open ${i}`).to.equal(1n);
        expect(coll).to.be.gt(dep); // always levered above the raw deposit
        const before = await ethers.provider.getBalance(bob.address);
        const tx = await zap.connect(bob).leverClose();
        const rc = await tx.wait();
        const back = (await ethers.provider.getBalance(bob.address)) - before + rc.gasUsed * rc.gasPrice;
        expect(await tm.getTroveStatus(zapAddr), `close ${i}`).to.not.equal(1n);
        expect(back, `return ${i} (dep ${ethers.formatEther(dep)}, ltv ${ltv})`).to.be.gt(dep * 95n / 100n);
        expect(await orUSD.balanceOf(zapAddr)).to.equal(0n);
      }
    });
  });
});
