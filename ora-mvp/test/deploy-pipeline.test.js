// Deploy pipeline: manifest codec, nonce-determinism check, manifest diff,
// Safe-bundle builder, verify dry-run. Runs against the real committed
// manifest (app/deployment.json) plus small tamper fixtures.
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const {
  serArgs, deserArgs, expectedAddress, checkVerifyAddresses, diffManifests,
} = require("../scripts/manifest-lib");
const { buildBundle, MAX_PAUSE } = require("../scripts/safe-batch");

const MANIFEST = path.join(__dirname, "..", "app", "deployment.json");
const manifest = JSON.parse(fs.readFileSync(MANIFEST));

describe("deploy pipeline", () => {
  it("arg codec round-trips BigInt + arrays through JSON", () => {
    const args = ["0xabc", 2000n * 10n ** 8n, 8, [1n, "x"], true];
    const back = deserArgs(JSON.parse(JSON.stringify(serArgs(args))));
    expect(back).to.deep.equal(args);
  });

  it("committed manifest: every address replays from (deployer, nonce)", () => {
    expect(manifest.verify.length).to.be.greaterThan(60);
    expect(manifest.meta.startNonce).to.equal(0);
    const rows = checkVerifyAddresses(manifest);
    const bad = rows.filter((r) => !r.ok);
    expect(bad, JSON.stringify(bad.slice(0, 3))).to.deep.equal([]);
  });

  it("tampered manifest is detected", () => {
    const evil = JSON.parse(JSON.stringify(manifest));
    evil.verify[5].address = "0x0000000000000000000000000000000000000001";
    const rows = checkVerifyAddresses(evil);
    expect(rows[5].ok).to.equal(false);
    expect(rows.filter((r) => !r.ok).length).to.equal(1);
  });

  it("expectedAddress matches the well-known first-deploy address", () => {
    // deployer 0xf39F... with nonce 0 → canonical hardhat first contract
    expect(expectedAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", 0))
      .to.equal("0x5FbDB2315678afecb367f032d93F642f64180aa3");
  });

  it("diff flags changed/added/removed addresses + ABI selectors", () => {
    const oldM = {
      meta: { gitCommit: "aaa" }, chainId: 1,
      branches: { ETH: { priceFeed: "0x0000000000000000000000000000000000000001" } },
      shared: {}, abis: { t: [{ type: "function", name: "f", inputs: [] }] },
      verify: [],
    };
    const newM = JSON.parse(JSON.stringify(oldM));
    newM.meta.gitCommit = "bbb";
    newM.branches.ETH.priceFeed = "0x0000000000000000000000000000000000000002";
    newM.branches.ETH.extra = "0x0000000000000000000000000000000000000003";
    newM.abis.t.push({ type: "function", name: "g", inputs: [{ type: "uint256" }] });
    const d = diffManifests(oldM, newM);
    expect(d).to.include("CHANGED ETH.priceFeed");
    expect(d).to.include("ADDED ETH.extra");
    expect(d).to.include("`aaa` → `bbb`");
    expect(d).to.include("+1");
  });

  it("safe-batch builds a valid pause bundle from the real manifest", () => {
    const b = buildBundle(manifest, [{ pause: "ETH", duration: 3600 }]);
    expect(b.chainId).to.equal(String(manifest.meta.chainId));
    const tx = b.transactions[0];
    expect(tx.to).to.equal(manifest.shared.guardian);
    expect(tx.data.slice(0, 10)).to.equal(ethers.id("pauseBorrowing(address,uint256)").slice(0, 10));
    expect(tx.contractInputsValues._borrowerOps).to.equal(manifest.branches.ETH.borrowerOperations);
    // unpause + rotate shapes
    const u = buildBundle(manifest, [{ unpause: "ETHv2" }]);
    expect(u.transactions[0].data.slice(0, 10))
      .to.equal(ethers.id("unpauseBorrowing(address)").slice(0, 10));
    const r = buildBundle(manifest, [{ rotate: "0x0000000000000000000000000000000000000001" }]);
    expect(r.transactions[0].data.slice(0, 10)).to.equal(ethers.id("setGuardian(address)").slice(0, 10));
  });

  it("safe-batch rejects bad duration / branch / address", () => {
    expect(() => buildBundle(manifest, [{ pause: "ETH", duration: MAX_PAUSE + 1 }])).to.throw(/duration/);
    expect(() => buildBundle(manifest, [{ pause: "ETH", duration: 0 }])).to.throw(/duration/);
    expect(() => buildBundle(manifest, [{ pause: "Nope" }])).to.throw(/unknown branch/);
    expect(() => buildBundle(manifest, [{ rotate: "0x123" }])).to.throw(/not an address/);
    expect(() => buildBundle(manifest, [])).to.throw(/no operations/);
  });

  it("verify dry-run enumerates the manifest without broadcasting", async () => {
    const { main } = require("../scripts/verify-deployment");
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await main(["--dry-run", "--manifest", MANIFEST], { network: { name: "hardhat" }, run: () => { throw new Error("must not verify in dry-run"); } });
    } finally { console.log = orig; }
    expect(lines[0]).to.match(/\[dry-run\] verifying \d+ contracts/);
    const n = Number(lines[0].match(/verifying (\d+)/)[1]);
    expect(n).to.equal(manifest.verify.length);
  });
});
