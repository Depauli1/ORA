// Deploy chain guards: the demo AMM must never exist on mainnet.
// Two halves — (1) deploy.js skips the venue on mainnet chain ids (tested
// here through the shared helper), (2) the OraSwapPool constructor reverts
// on mainnet chain ids as an on-chain backstop. Hardhat cannot flip chain
// ids in-test, so the on-chain half is pinned by asserting the guard's
// revert string is compiled into the deployment bytecode.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { MAINNET_CHAIN_IDS, isMainnetChainId } = require("../scripts/deploy-guards");

describe("deploy guards", () => {
  it("denylists Ethereum + Base mainnet, allows all test chains", () => {
    expect(isMainnetChainId(1)).to.equal(true);
    expect(isMainnetChainId(8453)).to.equal(true);
    for (const testnet of [31337, 1337, 11155111, 84532, 84531]) {
      expect(isMainnetChainId(testnet), `chain ${testnet}`).to.equal(false);
    }
    expect([...MAINNET_CHAIN_IDS].sort((a, b) => a - b)).to.deep.equal([1, 8453]);
  });

  it("OraSwapPool bytecode carries the testnet-only backstop", async () => {
    const artifact = await ethers.getContractFactory("OraSwapPool")
      .then((f) => ({ bytecode: f.bytecode }));
    const text = artifact.bytecode;
    expect(text).to.include(Buffer.from("OraSwapPool: testnet-only venue").toString("hex").slice(0, 40));
  });

  it("OraSwapPool still deploys on the local test chain", async () => {
    const [deployer] = await ethers.getSigners();
    // the constructor only needs a non-zero token; the venue path is local-only
    const pool = await (await ethers.getContractFactory("OraSwapPool")).deploy(deployer.address);
    expect(await pool.FEE_BPS()).to.equal(30n);
  });
});
