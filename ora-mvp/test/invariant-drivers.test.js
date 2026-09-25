// Local execution of the Foundry invariant state machines (the sandbox has
// no forge binary; CI runs test/foundry/*.t.sol for real). A seeded PRNG
// drives the SAME handler contracts through 400 random ops each and asserts
// every invariant view after every op. Handler checkpoints revert on breach,
// so any thrown error fails the test with the op index attached.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// mulberry32 — deterministic across runs
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function drive(factory, ops, views, seed, warpOp) {
  // Stub the Foundry cheatcode address with a no-op runtime: EDR reverts on
  // calls to empty accounts, so without this the handler's vm.warp would
  // revert locally (under real forge the cheatcode executes instead).
  await ethers.provider.send("hardhat_setCode",
    ["0x7109709ecfa91A80626Ff3989d68F67f682E52aF", "0x60006000f3"]);
  const h = await (await ethers.getContractFactory(factory)).deploy();
  await h.waitForDeployment();
  const rand = rng(seed);
  const argless = new Set(["opSettle", "opClaim"]);
  for (let i = 0; i < 400; i++) {
    const op = ops[Math.floor(rand() * ops.length)];
    const arg = BigInt(Math.floor(rand() * 2 ** 40)) + 1n;
    try {
      if (op === warpOp) {
        const dt = BigInt(Math.floor(rand() * 30 * 86400));
        await h[op](dt);
        await time.increase(dt); // EDR mirror: the vm.warp cheatcode is a no-op here
      } else if (argless.has(op)) {
        await h[op]();
      } else {
        await h[op](arg);
      }
      for (const v of views) expect(await h[v](), `${factory}.${v} failed after op #${i} (${op})`).to.equal(true);
    } catch (e) {
      e.message = `${factory} op #${i} (${op}, arg ${arg}): ${e.message}`;
      throw e;
    }
  }
  return h;
}

describe("invariant drivers (local forge mirror)", () => {
  it("WTBill: 400 random ops preserve custody/rate/supply/skim", async () => {
    await drive("WTBillHandler",
      ["opWrap", "opUnwrap", "opFaucet", "opWarp", "opSettle", "opClaim", "opTransfer"],
      ["invCustody", "invRateBounds", "invSupply", "invSkim"], 0xbeef, "opWarp");
  });

  it("SorUSDVault: 400 random ops preserve price/supply/backing", async () => {
    await drive("VaultHandler",
      ["opDeposit", "opRedeem", "opYield", "opTransfer"],
      ["invPriceFloor", "invSupply", "invBacking", "invDeadShares"], 0xf00d, null);
  });

  it("SorUSDVault: dust deposit after a large yield donation skips instead of reverting", async () => {
    const h = await (await ethers.getContractFactory("VaultHandler")).deploy();
    await h.waitForDeployment();
    await h.opDeposit(0); // first deposit: amt 1001 -> 1 handler share + 1000 dead
    await h.opYield(100000n * 10n ** 18n - 1n); // whale donation (amt = MAX_OP) inflates the share price...
    await h.opDeposit(1); // ...so 2 wei computes to 0 shares: must SKIP, not breach
    const vault = await ethers.getContractAt("SorUSDVault", await h.vault());
    expect(await vault.balanceOf(await h.getAddress())).to.equal(1); // state unchanged by the skip
    for (const v of ["invPriceFloor", "invSupply", "invBacking", "invDeadShares"]) {
      expect(await h[v](), v).to.equal(true);
    }
  });
});
