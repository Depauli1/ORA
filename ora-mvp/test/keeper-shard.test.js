// Finding 9: keeper sharding is a deterministic, overlap-free partition.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseShard, inShard } = require("../scripts/bots/liquidator");

describe("keeper sharding", () => {
  it("parses i/N and rejects garbage", () => {
    expect(parseShard("0/1")).to.deep.equal({ i: 0, n: 1 });
    expect(parseShard("2/3")).to.deep.equal({ i: 2, n: 3 });
    for (const bad of ["", "1", "1/", "/2", "3/3", "0/0", "1/33", "x/y", "-1/2"]) {
      expect(() => parseShard(bad)).to.throw(/bad ORA_KEEPER_SHARD/);
    }
  });

  it("partitions owners with no overlap and full coverage", () => {
    const owners = Array.from({ length: 300 }, () => ethers.Wallet.createRandom().address);
    for (const n of [1, 2, 3, 5]) {
      const hits = owners.map(o =>
        Array.from({ length: n }, (_, i) => inShard(o, { i, n })).filter(Boolean).length);
      expect(hits.every(h => h === 1)).to.equal(true); // exactly one shard each
    }
  });

  it("shards split work roughly evenly (no degenerate hash clustering)", () => {
    const owners = Array.from({ length: 900 }, () => ethers.Wallet.createRandom().address);
    const counts = [0, 0, 0];
    for (const o of owners) for (let i = 0; i < 3; i++) if (inShard(o, { i, n: 3 })) counts[i]++;
    for (const c of counts) expect(c).to.be.greaterThan(200).and.lessThan(400); // ~300 each
  });

  it("shard assignment is stable across calls (no flapping)", () => {
    const o = ethers.Wallet.createRandom().address;
    const s = { i: 1, n: 4 };
    const first = inShard(o, s);
    for (let k = 0; k < 50; k++) expect(inShard(o, s)).to.equal(first);
  });
});
