// OraSwapPool — minimal x*y=k orUSD/ETH demo AMM (0.3% fee).
// Unit tests for quoting/swapping/liquidity + a randomized fuzz of the
// constant-product invariant: with fees, k must never decrease.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, rng, randRange } = require("./helpers");

async function fixture() {
  const [deployer, alice, bob] = await ethers.getSigners();
  // any mintable ERC20 works as the "orUSD" side for pool-only tests
  const MockTBill = await ethers.getContractFactory("MockTBill");
  const usd = await MockTBill.deploy();
  const Pool = await ethers.getContractFactory("OraSwapPool");
  const pool = await Pool.deploy(await usd.getAddress());
  for (const s of [alice, bob]) {
    for (let i = 0; i < 3; i++) await usd.connect(s).faucet(E("100000"));
    await usd.connect(s).approve(await pool.getAddress(), ethers.MaxUint256);
  }
  await pool.connect(alice).addLiquidity(E("40000"), { value: E("20") }); // $2000/ETH
  return { deployer, alice, bob, usd, pool };
}

const k = async pool => (await pool.reserveOrUSD()) * (await pool.reserveETH());

describe("OraSwapPool (demo AMM)", () => {
  it("constructor rejects zero token; bare ETH transfers revert", async () => {
    const Pool = await ethers.getContractFactory("OraSwapPool");
    await expect(Pool.deploy(ethers.ZeroAddress)).to.be.revertedWith("OraSwapPool: zero address");
    const { pool, alice } = await loadFixture(fixture);
    await expect(alice.sendTransaction({ to: await pool.getAddress(), value: E("1") }))
      .to.be.revertedWith("OraSwapPool: use swap functions");
  });

  it("addLiquidity requires both sides and tracks reserves", async () => {
    const { pool, bob } = await loadFixture(fixture);
    await expect(pool.connect(bob).addLiquidity(0, { value: E("1") }))
      .to.be.revertedWith("OraSwapPool: zero amounts");
    await expect(pool.connect(bob).addLiquidity(E("100"), { value: 0 }))
      .to.be.revertedWith("OraSwapPool: zero amounts");
    await pool.connect(bob).addLiquidity(E("2000"), { value: E("1") });
    expect(await pool.reserveOrUSD()).to.equal(E("42000"));
    expect(await pool.reserveETH()).to.equal(E("21"));
    expect(await pool.spotPrice()).to.equal(E("2000"));
  });

  it("quotes match the x*y=k closed form with a 30bps fee", async () => {
    const { pool } = await loadFixture(fixture);
    const inUsd = E("1000");
    const inWithFee = inUsd * 9970n;
    const expected = inWithFee * E("20") / (E("40000") * 10000n + inWithFee);
    expect(await pool.getETHOut(inUsd)).to.equal(expected);
    const inEth = E("1");
    const inWithFee2 = inEth * 9970n;
    const expected2 = inWithFee2 * E("40000") / (E("20") * 10000n + inWithFee2);
    expect(await pool.getOrUSDOut(inEth)).to.equal(expected2);
  });

  it("swapOrUSDForETH pays out the quote and updates reserves", async () => {
    const { pool, bob } = await loadFixture(fixture);
    const quote = await pool.getETHOut(E("2000"));
    const before = await ethers.provider.getBalance(bob.address);
    const tx = await pool.connect(bob).swapOrUSDForETH(E("2000"), quote);
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    expect((await ethers.provider.getBalance(bob.address)) - before + gas).to.equal(quote);
    expect(await pool.reserveOrUSD()).to.equal(E("42000"));
    expect(await pool.reserveETH()).to.equal(E("20") - quote);
  });

  it("swapETHForOrUSD pays out the quote", async () => {
    const { pool, usd, bob } = await loadFixture(fixture);
    const quote = await pool.getOrUSDOut(E("1"));
    const before = await usd.balanceOf(bob.address);
    await pool.connect(bob).swapETHForOrUSD(quote, { value: E("1") });
    expect((await usd.balanceOf(bob.address)) - before).to.equal(quote);
  });

  it("slippage guards revert when minOut is not met", async () => {
    const { pool, bob } = await loadFixture(fixture);
    const quote = await pool.getETHOut(E("2000"));
    await expect(pool.connect(bob).swapOrUSDForETH(E("2000"), quote + 1n))
      .to.be.revertedWith("OraSwapPool: slippage");
    const quote2 = await pool.getOrUSDOut(E("1"));
    await expect(pool.connect(bob).swapETHForOrUSD(quote2 + 1n, { value: E("1") }))
      .to.be.revertedWith("OraSwapPool: slippage");
  });

  it("round trip loses only the fee (~0.6% for two 30bps hops)", async () => {
    const { pool, bob } = await loadFixture(fixture);
    const ethOut = await pool.connect(bob).swapOrUSDForETH.staticCall(E("2000"), 0);
    await pool.connect(bob).swapOrUSDForETH(E("2000"), 0);
    const usdBack = await pool.connect(bob).swapETHForOrUSD.staticCall(0, { value: ethOut });
    expect(usdBack).to.be.gt(E("2000") * 985n / 1000n); // > 98.5% back
    expect(usdBack).to.be.lt(E("2000"));                // never a free lunch
  });

  it("FUZZ: k never decreases across random swaps and liquidity adds", async () => {
    const { pool, alice, bob } = await loadFixture(fixture);
    const next = rng(1337);
    let kPrev = await k(pool);
    for (let i = 0; i < 150; i++) {
      const actor = Number(randRange(next, 0n, 1n)) ? alice : bob;
      const action = Number(randRange(next, 0n, 2n));
      try {
        if (action === 0) {
          await pool.connect(actor).swapOrUSDForETH(randRange(next, E("1"), E("5000")), 0);
        } else if (action === 1) {
          await pool.connect(actor).swapETHForOrUSD(0, { value: randRange(next, E("0.001"), E("3")) });
        } else {
          await pool.connect(actor).addLiquidity(randRange(next, E("1"), E("1000")),
            { value: randRange(next, E("0.001"), E("0.5")) });
        }
      } catch (e) {
        throw new Error(`fuzz op ${i} (action ${action}) reverted unexpectedly: ${e.message}`);
      }
      const kNow = await k(pool);
      expect(kNow, `k decreased at op ${i}`).to.be.gte(kPrev);
      kPrev = kNow;
      expect(await pool.reserveETH()).to.be.gt(0n);
      expect(await pool.reserveOrUSD()).to.be.gt(0n);
    }
    // pool solvency: actual balances cover book reserves
    expect(await ethers.provider.getBalance(await pool.getAddress())).to.be.gte(await pool.reserveETH());
  });
});
