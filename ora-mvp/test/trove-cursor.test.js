// TroveCursor: O(page) cursor pagination over the sorted list (offset pages
// re-walk from the head and OOG past ~700 troves). Values must equal the
// protocol's entire debt/coll (pending rewards + rates interest included).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, ratesFixtureSeeded } = require("./helpers");

describe("TroveCursor", () => {
  it("pages the whole list with O(1)-per-page cost, entire values exact", async () => {
    const f = await loadFixture(ratesFixtureSeeded); // whale + cursor-less stack
    const { tm, bo, sorted, bob, carol } = f;
    await bo.connect(bob).openTroveWithRate(E("10000"), E("0.05"), Z, Z, { value: E("10") });
    await bo.connect(carol).openTroveWithRate(E("10000"), E("0.07"), Z, Z, { value: E("10") });
    const C = await ethers.getContractFactory("TroveCursor");
    const cursor = await C.deploy();
    await cursor.waitForDeployment();
    const tmAddr = await tm.getAddress(), sAddr = await sorted.getAddress();

    // pages of 2 over 3 troves: [2 rows, next] -> [1 row, 0x0]
    const [p1, next1, size] = await cursor.scan(tmAddr, sAddr, ethers.ZeroAddress, 2);
    expect(size).to.equal(3n);
    expect(p1.length).to.equal(2);
    expect(next1).to.not.equal(ethers.ZeroAddress);
    const [p2, next2] = await cursor.scan(tmAddr, sAddr, next1, 2);
    expect(p2.length).to.equal(1);
    expect(next2).to.equal(ethers.ZeroAddress);

    const seen = [...p1, ...p2];
    expect(new Set(seen.map(r => r.owner)).size).to.equal(3);
    for (const r of seen) {
      const [d, c] = await tm.getEntireDebtAndColl(r.owner);
      expect(r.debt).to.equal(d);
      expect(r.coll).to.equal(c);
    }
  });
});
