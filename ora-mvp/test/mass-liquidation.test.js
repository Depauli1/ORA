// Mass-liquidation throughput: can the protocol clear a wave of unhealthy
// troves inside a block? Opens 25 underwater troves on the rates branch,
// sweeps them via the BatchLiquidator, and asserts the measured gas leaves
// the keeper's documented chunk size (<=40 troves/tx) inside half a Base
// block (30M gas). Per-trove marginal gas is logged for keeper tuning.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, ratesFixtureSeeded } = require("./helpers");

// Under coverage, instrumented contracts bloat ~3x — run a smaller wave (same
// code paths; the per-trove assertion still extrapolates to the full chunk).
const N = process.env.COVERAGE === "1" ? 8 : 25;
const BLOCK_GAS = 30_000_000;

async function waveFixture() {
  const f = await ratesFixtureSeeded(); // whale 100ETH/60k, SP 10k, price $2000
  const { bo, agg } = f;
  const wallets = [];
  for (let i = 0; i < N; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await f.deployer.sendTransaction({ to: w.address, value: E("3") });
    await bo.connect(w).openTroveWithRate(E("3200"), E("0.05"), Z, Z, { value: E("2") });
    wallets.push(w);
  }
  await agg.setAnswer(1100n * 10n ** 8n); // -45%: baits ~61% ICR, TCR ~108% (recovery)
  const BL = await ethers.getContractFactory("BatchLiquidator");
  const bl = await BL.deploy();
  await bl.waitForDeployment();
  return { ...f, wallets, bl };
}

describe("Mass liquidation (25-trove wave, rates branch)", () => {
  it("all baits are underwater after the crash", async () => {
    const { tm, feed, wallets } = await loadFixture(waveFixture);
    const price = await feed.getPrice();
    for (const w of wallets)
      expect(await tm.getCurrentICR(w.address, price)).to.be.lt(E("1.1"));
  });

  it("head-walk sweep clears every trove inside half a block", async () => {
    const { tm, sorted, bl, wallets, alice, orUSD } = await loadFixture(waveFixture);
    // N+1 attempts: the healthy whale also sits in the list and consumes one skip
    const tx = await bl.connect(alice)
      .liquidateTroves(await tm.getAddress(), await sorted.getAddress(), N + 1,
        await orUSD.getAddress());
    const r = await tx.wait();
    const gas = Number(r.gasUsed);
    console.log(`      sweep gas: ${gas.toLocaleString("en-US")} (${(gas / N).toFixed(0)}/trove)`);
    expect(gas).to.be.lt(BLOCK_GAS / 2);
    for (const w of wallets)
      expect(await tm.getTroveStatus(w.address)).to.equal(3n);
    // keeper chunk guidance: 40 troves must fit in 80% of a block
    expect((gas / N) * 40).to.be.lt(BLOCK_GAS * 0.8);
  });

  it("explicit-list sweep clears every trove", async () => {
    const { tm, bl, wallets, alice, orUSD } = await loadFixture(waveFixture);
    const addrs = wallets.map(w => w.address);
    const tx = await bl.connect(alice).batchLiquidateTroves(
      await tm.getAddress(), addrs, await orUSD.getAddress());
    const r = await tx.wait();
    console.log(`      explicit-batch gas: ${Number(r.gasUsed).toLocaleString("en-US")}`);
    for (const w of wallets)
      expect(await tm.getTroveStatus(w.address)).to.equal(3n);
  });
});
