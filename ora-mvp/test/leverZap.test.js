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
      await expect(zap.connect(carol).leverOpen(E("0.05"), 6000, 6, 2000, { value: E("1") }))
        .to.be.revertedWith("LeverZap: caller is not owner");
      await expect(zap.connect(carol).leverClose(2000))
        .to.be.revertedWith("LeverZap: caller is not owner");
      await expect(zap.connect(carol).exec(carol.address, "0x", 0))
        .to.be.revertedWith("LeverZap: caller is not owner");
    });
  });

  describe("parameter guards", () => {
    it("rejects zero deposit, LTV out of (0, 80%], too-small first borrow, double open", async () => {
      const { zap, bob } = await loadFixture(zapFixture);
      await expect(zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 2000))
        .to.be.revertedWith("LeverZap: no ETH sent");
      await expect(zap.connect(bob).leverOpen(E("0.05"), 0, 6, 2000, { value: E("2") }))
        .to.be.revertedWith("LeverZap: LTV must be in (0, 80%]");
      await expect(zap.connect(bob).leverOpen(E("0.05"), 8001, 6, 2000, { value: E("2") }))
        .to.be.revertedWith("LeverZap: LTV must be in (0, 80%]");
      // 0.5 ETH * $2000 * 60% = 600 orUSD < 1800 minimum
      await expect(zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 2000, { value: E("0.5") }))
        .to.be.revertedWith("LeverZap: deposit too small for min 1800 orUSD debt");
      await zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 2000, { value: E("2") });
      await expect(zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 2000, { value: E("2") }))
        .to.be.revertedWith("LeverZap: position already open");
    });

    it("slippage guard: caps TOTAL equity lost to swap costs across the atomic op", async () => {
      const { zap, bob } = await loadFixture(zapFixture);
      // demo pool depth costs ~11% of equity on a 2.5x open -> a 2% budget must revert
      await expect(zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 200, { value: E("2") }))
        .to.be.revertedWith("LeverZap: slippage exceeded");
      await expect(zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 10000, { value: E("2") }))
        .to.be.revertedWith("LeverZap: bad slippage");
      // nothing partial happened — position can still open within a sane budget
      await zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 2000, { value: E("2") });
      const [, , , status] = await zap.position();
      expect(status).to.equal(1n);
      await expect(zap.connect(bob).leverClose(10000)).to.be.revertedWith("LeverZap: bad slippage");
      await zap.connect(bob).leverClose(2000);
    });
  });

  describe("leverOpen", () => {
    it("levers 2 ETH toward the ~2.5x target at the chosen rate", async () => {
      const { zap, tm, bob, zapAddr } = await loadFixture(zapFixture);
      await zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 2000, { value: E("2") });
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
      await zap.connect(bob).leverOpen(E("0.05"), 3333, 6, 2000, { value: E("3") }); // 1.5x target
      const [, coll] = await zap.position();
      expect(coll).to.be.gte(E("4"));
      expect(coll).to.be.lte(E("4.6"));
    });
  });

  describe("leverClose", () => {
    it("fully unwinds without flash loans and returns ~all ETH", async () => {
      const { zap, tm, orUSD, bob, zapAddr } = await loadFixture(zapFixture);
      await zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 2000, { value: E("2") });
      const before = await ethers.provider.getBalance(bob.address);
      const tx = await zap.connect(bob).leverClose(2000);
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
      await expect(zap.connect(bob).leverClose(2000))
        .to.be.revertedWith("LeverZap: no open position");
      await zap.connect(bob).leverOpen(E("0.05"), 5000, 6, 2000, { value: E("2") });
      await zap.connect(bob).leverClose(2000);
      await zap.connect(bob).leverOpen(E("0.07"), 5000, 6, 2000, { value: E("2") }); // reopen works
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

  describe("edge coverage: leftover sweeps, unwind guards, hostile counterparties", () => {
    it("sweeps orUSD left over when the loop budget runs out mid-compound", async () => {
      const { zap, bob, zapAddr, orUSD } = await loadFixture(zapFixture);
      // _loops = 1: after one compound round the freshly withdrawn orUSD is
      // left in the zap and must be swept into collateral by the cleanup
      await zap.connect(bob).leverOpen(E("0.05"), 6000, 1, 5000, { value: E("4") });
      const [, , , status] = await zap.position();
      expect(status).to.equal(1n);
      expect(await orUSD.balanceOf(zapAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(zapAddr)).to.equal(0n);
      await zap.connect(bob).leverClose(2000);
    });

    it("leverClose reverts when the unwind cannot make progress (price dropped)", async () => {
      const { zap, bob, agg } = await loadFixture(zapFixture);
      await zap.connect(bob).leverOpen(E("0.05"), 6000, 6, 5000, { value: E("3") });
      // -50% is the largest single move the feed accepts; at $1000 the
      // position has no equity and the unwind cannot make progress
      await agg.setAnswer(1000n * 10n ** 8n);
      await expect(zap.connect(bob).leverClose(2000))
        .to.be.revertedWith("LeverZap: cannot unwind further (ICR too thin)");
    });

    it("leverClose enforces the aggregate slippage budget on the way out", async () => {
      const h = await loadFixture(hostileFixture);
      // healthy-looking entry, the pool funds exactly one close round but pays
      // no ETH back for the leftover orUSD — equity0 > 0 and balance == 0
      // must trip the aggregate bound for any budget below 100%
      await h.htm.setDebtColl(E("10000"), E("7"));
      const pool = await h.mkPool(0, E("10200"));
      const zap = await h.mkZap(pool);
      await expect(zap.leverClose(2000)).to.be.revertedWith("LeverZap: slippage exceeded");
    });

    it("the ETH sweep to an owner that cannot receive ETH reverts", async () => {
      const { bob, bo, tm, feed, pool, orUSD } = await loadFixture(zapFixture);
      const rejector = await (await ethers.getContractFactory("EthRejector")).deploy();
      await rejector.waitForDeployment();
      const LZ = await ethers.getContractFactory("LeverZap");
      const zap2 = await LZ.deploy(await rejector.getAddress(), await bo.getAddress(),
        await tm.getAddress(), await feed.getAddress(), await pool.getAddress(), await orUSD.getAddress());
      await zap2.waitForDeployment();
      // fund the rejector (it still accepts ETH), drive the open…
      const [rich] = await ethers.getSigners();
      await rich.sendTransaction({ to: await rejector.getAddress(), value: E("3") });
      await rejector.openLevered(await zap2.getAddress(), E("0.05"), 6000, 6, 5000, { value: E("2") });
      // …then flip it into reject mode: the exit sweep must fail loudly
      await rejector.setRejectEth(true);
      await expect(rejector.closeLevered(await zap2.getAddress(), 2000))
        .to.be.revertedWith("LeverZap: ETH sweep failed");
    });

    it("exec surfaces a failing call", async () => {
      const { zap, bob } = await loadFixture(zapFixture);
      const rejector = await (await ethers.getContractFactory("EthRejector")).deploy();
      await rejector.waitForDeployment();
      const data = rejector.interface.encodeFunctionData("boom");
      await expect(zap.connect(bob).exec(await rejector.getAddress(), data, 0))
        .to.be.revertedWith("LeverZap: exec failed");
    });

    // Hostile counterparties: the zap must not trust its engines or its pool.
    // A pool that takes the orUSD but pays no collateral leaves the reported
    // position with no equity — the aggregate guard must refuse to open.
    async function hostileFixture() {
      const f = await loadFixture(zapFixture);
      const { deployer, bo, tm, feed } = f;
      const Flaky = await ethers.getContractFactory("MockFlakyToken");
      const orUSD2 = await Flaky.deploy();
      await orUSD2.waitForDeployment();
      const htm = await (await ethers.getContractFactory("HostileTM")).deploy();
      await htm.waitForDeployment();
      const hbo = await (await ethers.getContractFactory("HostileBO")).deploy(await htm.getAddress());
      await hbo.waitForDeployment();
      await orUSD2.faucet(E("50000")); // the hostile pools pay out from this
      const HP = await ethers.getContractFactory("HostilePool");
      const mkPool = async (ethOut, orUsdOut) => {
        const p = await HP.deploy(await orUSD2.getAddress(), BigInt(ethOut), BigInt(orUsdOut));
        await p.waitForDeployment();
        await orUSD2.transfer(await p.getAddress(), BigInt(orUsdOut) + 500n);
        return p;
      };
      const LZ = await ethers.getContractFactory("LeverZap");
      const mkZap = async (pool) => {
        const z = await LZ.deploy(deployer.address, await hbo.getAddress(), await htm.getAddress(),
          await feed.getAddress(), await pool.getAddress(), await orUSD2.getAddress());
        await z.waitForDeployment();
        return z;
      };
      return { ...f, deployer, orUSD2, htm, hbo, mkPool, mkZap };
    }

    it("refuses to open when the engines/pool leave no equity at all", async () => {
      const h = await loadFixture(hostileFixture);
      // engine reports the minimum debt with zero collateral; the pool pays
      // no ETH for the orUSD it takes
      await h.htm.setDebtColl(E("1800"), 0);
      await h.htm.setStatus(0); // no position yet — the open guard must pass
      const pool = await h.mkPool(0, 0);
      const zap = await h.mkZap(pool);
      await expect(zap.leverOpen(E("0.05"), 6000, 6, 5000, { value: E("2") }))
        .to.be.revertedWith("LeverZap: slippage exceeded");
    });

    it("gives up after 20 unwind rounds and reverts 'unwind incomplete'", async () => {
      const h = await loadFixture(hostileFixture);
      // a big healthy-looking position, but the pool pays 1 wei per round —
      // 20 rounds cannot retire the debt, so the close must abort loudly
      await h.htm.setDebtColl(E("10000"), E("7"));
      const pool = await h.mkPool(0, 1);
      const zap = await h.mkZap(pool);
      await expect(zap.leverClose(2000))
        .to.be.revertedWith("LeverZap: unwind incomplete — try again or use exec()");
    });

    it("exits cleanly when a full unwind leaves nothing to sweep", async () => {
      const h = await loadFixture(hostileFixture);
      // debt exactly covers the gas compensation, collateral zero: the close
      // path exits on round 1 with no orUSD and no ETH left behind
      await h.htm.setDebtColl(E("200"), 0);
      const pool = await h.mkPool(0, 0);
      const zap = await h.mkZap(pool);
      await expect(zap.leverClose(2000)).to.emit(zap, "LeverClosed").withArgs(0, 0);
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
        await zap.connect(bob).leverOpen(rate, ltv, 6, 5000, { value: dep }); // big deposits on the shallow demo pool
        const [debt, coll, , status] = await zap.position();
        expect(status, `open ${i}`).to.equal(1n);
        expect(coll).to.be.gt(dep); // always levered above the raw deposit
        const before = await ethers.provider.getBalance(bob.address);
        const tx = await zap.connect(bob).leverClose(2000);
        const rc = await tx.wait();
        const back = (await ethers.provider.getBalance(bob.address)) - before + rc.gasUsed * rc.gasPrice;
        expect(await tm.getTroveStatus(zapAddr), `close ${i}`).to.not.equal(1n);
        expect(back, `return ${i} (dep ${ethers.formatEther(dep)}, ltv ${ltv})`).to.be.gt(dep * 95n / 100n);
        expect(await orUSD.balanceOf(zapAddr)).to.equal(0n);
      }
    });
  });
});
