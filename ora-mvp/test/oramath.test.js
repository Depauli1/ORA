// OraMath via a test harness: every branch incl. the _decPow overflow cap
// (525,600,000 minutes) and exponentiation-by-squaring parity paths.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { E } = require("./helpers");

describe("OraMath", () => {
  it("min / decMul match the 0.6 LiquityMath semantics", async () => {
    const H = await ethers.getContractFactory("OraMathHarness");
    const h = await H.deploy();
    expect(await h.min(3n, 5n)).to.equal(3n);
    expect(await h.min(5n, 3n)).to.equal(3n);
    expect(await h.decMul(E("2"), E("3"))).to.equal(E("6"));
    expect(await h.decMul(E("1.5"), E("1.5"))).to.equal(E("2.25"));
  });

  it("_decPow: zero minutes, squaring parity, and the overflow cap", async () => {
    const H = await ethers.getContractFactory("OraMathHarness");
    const h = await H.deploy();
    const base = 999998681227695000n; // BranchCommunityIssuance ISSUANCE_FACTOR
    expect(await h.decPow(base, 0n)).to.equal(E("1")); // n == 0 short-circuit
    const p1 = await h.decPow(base, 1n); // while loop skipped (n == 1)
    expect(p1).to.be.lt(E("1"));
    const p2 = await h.decPow(base, 2n); // even branch
    const p3 = await h.decPow(base, 3n); // odd branch
    expect(p2).to.be.lt(p1);
    expect(p3).to.be.lt(p2);
    expect(p2).to.be.closeTo((p1 * p1) / E("1"), E("0.000001")); // p1^2
    // the cap: absurd exponents clamp to 525,600,000 minutes
    const CAP = 525600000n;
    expect(await h.decPow(base, 10n ** 18n)).to.equal(await h.decPow(base, CAP));
  });
});
