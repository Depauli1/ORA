// Public-testnet release gates: manifest must describe the full Base Sepolia
// protocol, and every recorded deployment must exist on chain before release.
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { validateManifest, checkOnchain } = require("../scripts/check-public-deployment");

const LOCAL_MANIFEST = path.join(__dirname, "..", "app", "deployment.json");

function baseSepoliaFixture() {
  const manifest = JSON.parse(fs.readFileSync(LOCAL_MANIFEST, "utf8"));
  manifest.chainId = 84532;
  manifest.meta.chainId = 84532;
  manifest.meta.network = "baseSepolia";
  return manifest;
}

async function expectReject(promise, pattern) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  expect(error, "expected promise to reject").to.be.instanceOf(Error);
  expect(error.message).to.match(pattern);
}

describe("Base Sepolia deployment gate", () => {
  it("accepts a complete four-branch manifest with the testnet venues", () => {
    const manifest = baseSepoliaFixture();
    expect(validateManifest(manifest)).to.equal(manifest);
    expect(manifest.verify).to.have.length.at.least(60);
  });

  it("rejects missing branches, production-risk parameter drift, and absent testnet venues", () => {
    const noBranch = baseSepoliaFixture();
    delete noBranch.branches.ETHv2;
    expect(() => validateManifest(noBranch)).to.throw(/branches must be exactly/);

    const wrongMcr = baseSepoliaFixture();
    wrongMcr.branches.tBILL.mcr = 1.1;
    expect(() => validateManifest(wrongMcr)).to.throw(/branches.tBILL.mcr must be 1.05/);

    const noZap = baseSepoliaFixture();
    noZap.branches.ETHv2.leverZapFactory = null;
    expect(() => validateManifest(noZap)).to.throw(/branches.ETHv2.leverZapFactory/);

    const changedDebtCap = baseSepoliaFixture();
    changedDebtCap.branches.tBILL.debtCap = 2_500_000;
    expect(() => validateManifest(changedDebtCap)).to.throw(/debtCap must be 2,000,000 orUSD/);
  });

  it("rejects malformed or duplicate deployment records", () => {
    const missingShared = baseSepoliaFixture();
    missingShared.shared.guardian = "0x0000000000000000000000000000000000000000";
    expect(() => validateManifest(missingShared)).to.throw(/shared.guardian must be a non-zero address/);

    const duplicate = baseSepoliaFixture();
    duplicate.verify[1].address = duplicate.verify[0].address;
    expect(() => validateManifest(duplicate)).to.throw(/verify contains duplicate address/);
  });

  it("confirms all manifest contracts have bytecode on Base Sepolia", async () => {
    const manifest = validateManifest(baseSepoliaFixture());
    const result = await checkOnchain(manifest, {
      getNetwork: async () => ({ chainId: 84532n }),
      getCode: async () => "0x60006000",
    });
    expect(result.chainId).to.equal(84532);
    expect(result.contractsChecked).to.equal(manifest.verify.length);
  });

  it("fails closed on an RPC for the wrong chain or missing bytecode", async () => {
    const manifest = validateManifest(baseSepoliaFixture());
    await expectReject(checkOnchain(manifest, {
      getNetwork: async () => ({ chainId: 8453n }),
      getCode: async () => "0x60006000",
    }), /expected Base Sepolia chainId 84532, got 8453/);

    const missingAddress = manifest.verify[0].address.toLowerCase();
    await expectReject(checkOnchain(manifest, {
      getNetwork: async () => ({ chainId: 84532n }),
      getCode: async address => address.toLowerCase() === missingAddress ? "0x" : "0x60006000",
    }), /no on-chain bytecode for 1 manifest contract/);
  });
});
