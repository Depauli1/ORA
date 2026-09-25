// Fail-closed validation for a complete Base Sepolia deployment.
//
// Checks the manifest's chain identity and four-branch shape, then confirms
// every recorded deployment address has bytecode on the target network. Use
// with check-addresses.js (nonce replay) and watch-invariants.js (protocol
// accounting/oracle health) as the deployment workflow's post-deploy gates.
//
// Usage:
//   ORA_RPC_URL=https://sepolia.base.org node scripts/check-public-deployment.js [manifest]
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { BASE_SEPOLIA_CHAIN_ID, assertBaseSepoliaChainId } = require("./deploy-guards");

const NETWORK = "baseSepolia";
const REQUIRED_BRANCHES = ["ETH", "wstETH", "tBILL", "ETHv2"];
const COMMON_BRANCH_ADDRESSES = [
  "priceFeed", "sortedTroves", "troveManager", "activePool", "stabilityPool",
  "gasPool", "defaultPool", "collSurplusPool", "borrowerOperations",
  "hintHelpers", "multiTroveGetter",
];
const REQUIRED_SHARED_ADDRESSES = [
  "orUSDToken", "oraToken", "oraStaking", "communityIssuance", "lockupFactory",
  "guardian", "guardianHolder", "batchLiquidator", "troveCursor",
];
const MAX_PARALLEL_CODE_CHECKS = 8;

function isDeployedAddress(value) {
  return typeof value === "string"
    && ethers.isAddress(value)
    && value.toLowerCase() !== ethers.ZeroAddress.toLowerCase();
}

function validateManifest(manifest) {
  const problems = [];
  const fail = message => problems.push(message);

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be a JSON object");
  }

  if (Number(manifest.chainId) !== BASE_SEPOLIA_CHAIN_ID) {
    fail(`top-level chainId must be ${BASE_SEPOLIA_CHAIN_ID}`);
  }
  if (!manifest.meta || manifest.meta.network !== NETWORK) {
    fail(`meta.network must be ${NETWORK}`);
  }
  if (Number(manifest.meta?.chainId) !== BASE_SEPOLIA_CHAIN_ID) {
    fail(`meta.chainId must be ${BASE_SEPOLIA_CHAIN_ID}`);
  }
  if (!isDeployedAddress(manifest.meta?.deployer)) {
    fail("meta.deployer must be a non-zero address");
  }

  for (const key of REQUIRED_SHARED_ADDRESSES) {
    if (!isDeployedAddress(manifest.shared?.[key])) {
      fail(`shared.${key} must be a non-zero address`);
    }
  }

  const branches = manifest.branches;
  if (!branches || typeof branches !== "object" || Array.isArray(branches)) {
    fail("branches must be an object");
  } else {
    const actual = Object.keys(branches).sort();
    const expected = [...REQUIRED_BRANCHES].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`branches must be exactly ${REQUIRED_BRANCHES.join(", ")}`);
    }

    for (const name of REQUIRED_BRANCHES) {
      const branch = branches[name];
      if (!branch || typeof branch !== "object") {
        fail(`branches.${name} is missing`);
        continue;
      }
      for (const key of COMMON_BRANCH_ADDRESSES) {
        if (!isDeployedAddress(branch[key])) {
          fail(`branches.${name}.${key} must be a non-zero address`);
        }
      }
      if (typeof branch.mcr !== "number" || !Number.isFinite(branch.mcr)
        || typeof branch.ccr !== "number" || !Number.isFinite(branch.ccr)) {
        fail(`branches.${name} must declare finite mcr and ccr parameters`);
      }
    }

    const expectedFlags = {
      ETH: { native: true, rwa: false, rates: false },
      wstETH: { native: false, rwa: false, rates: false },
      tBILL: { native: false, rwa: true, rates: false },
      ETHv2: { native: true, rwa: false, rates: true },
    };
    const expectedRiskParams = {
      ETH: { mcr: 1.1, ccr: 1.5, softFloor: 1.05 },
      wstETH: { mcr: 1.1, ccr: 1.5, softFloor: 1.05 },
      tBILL: { mcr: 1.05, ccr: 1.15, softFloor: 1.03 },
      ETHv2: { mcr: 1.1, ccr: 1.5, softFloor: 1.05 },
    };
    for (const [name, flags] of Object.entries(expectedFlags)) {
      const branch = branches[name];
      if (!branch) continue;
      for (const [key, expected] of Object.entries(flags)) {
        if (Boolean(branch[key]) !== expected) {
          fail(`branches.${name}.${key} must be ${expected}`);
        }
      }
      for (const [key, expected] of Object.entries(expectedRiskParams[name])) {
        if (branch[key] !== expected) {
          fail(`branches.${name}.${key} must be ${expected}`);
        }
      }
    }

    for (const [name, keys] of Object.entries({
      wstETH: ["collToken", "stEthEthAggregator", "branchStaking", "communityIssuance"],
      tBILL: ["collToken", "underlyingToken", "navPriceFeed", "branchStaking", "communityIssuance"],
      ETHv2: ["interestRouter", "sorUSDVault", "swapPool", "leverZapFactory", "communityIssuance"],
    })) {
      for (const key of keys) {
        if (!isDeployedAddress(branches[name]?.[key])) {
          fail(`branches.${name}.${key} must be a non-zero address on Base Sepolia`);
        }
      }
    }
    if (Number(branches.tBILL?.debtCap) !== 2_000_000) {
      fail("branches.tBILL.debtCap must be 2,000,000 orUSD");
    }
    if (branches.tBILL?.skimRatePerYear !== 0.02) {
      fail("branches.tBILL.skimRatePerYear must be 0.02");
    }
  }

  if (!Array.isArray(manifest.verify) || manifest.verify.length < 60) {
    fail("verify must record at least 60 deployed contracts for the full protocol");
  } else {
    const seen = new Set();
    for (const [index, entry] of manifest.verify.entries()) {
      if (!entry || typeof entry.contract !== "string" || !entry.contract) {
        fail(`verify[${index}].contract is missing`);
      }
      if (!isDeployedAddress(entry?.address)) {
        fail(`verify[${index}].address must be a non-zero address`);
        continue;
      }
      const address = entry.address.toLowerCase();
      if (seen.has(address)) fail(`verify contains duplicate address ${entry.address}`);
      seen.add(address);
      if (!Number.isInteger(entry.nonce) || entry.nonce < 0) {
        fail(`verify[${index}].nonce must be a non-negative integer`);
      }
      if (typeof entry.artifact !== "string" || !entry.artifact.includes(":")) {
        fail(`verify[${index}].artifact must be a Hardhat fully-qualified contract name`);
      }
      if (!Array.isArray(entry.args)) fail(`verify[${index}].args must be an array`);
      if (typeof entry.bytecodeHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(entry.bytecodeHash)) {
        fail(`verify[${index}].bytecodeHash must be a 32-byte hex hash`);
      }
    }
  }

  if (!manifest.abis || typeof manifest.abis !== "object") {
    fail("abis must be present for the app and protocol monitor");
  }

  if (problems.length) {
    throw new Error(`invalid Base Sepolia deployment manifest:\n- ${problems.join("\n- ")}`);
  }
  return manifest;
}

async function checkOnchain(manifest, provider) {
  const network = await provider.getNetwork();
  assertBaseSepoliaChainId(network.chainId);

  const missing = [];
  for (let start = 0; start < manifest.verify.length; start += MAX_PARALLEL_CODE_CHECKS) {
    const batch = manifest.verify.slice(start, start + MAX_PARALLEL_CODE_CHECKS);
    const results = await Promise.all(batch.map(async entry => ({
      entry,
      code: await provider.getCode(entry.address),
    })));
    for (const { entry, code } of results) {
      if (!code || code === "0x") missing.push(`${entry.contract} @ ${entry.address}`);
    }
  }
  if (missing.length) {
    throw new Error(`no on-chain bytecode for ${missing.length} manifest contract(s):\n- ${missing.join("\n- ")}`);
  }
  return { chainId: Number(network.chainId), contractsChecked: manifest.verify.length };
}

async function main(argv = process.argv.slice(2)) {
  const manifestPath = argv[0]
    || process.env.ORA_DEPLOYMENT
    || path.join(__dirname, "..", "app", "deployment-baseSepolia.json");
  const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  const rpc = process.env.ORA_RPC_URL || "https://sepolia.base.org";
  const provider = new ethers.JsonRpcProvider(rpc);
  const result = await checkOnchain(manifest, provider);
  console.log(`Base Sepolia deployment verified: chainId ${result.chainId}, ${result.contractsChecked} contracts have bytecode.`);
  console.log(`Manifest: ${manifestPath}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error("PUBLIC DEPLOYMENT CHECK FAILED:", error.shortMessage || error.message || error);
    process.exit(1);
  });
}

module.exports = { validateManifest, checkOnchain, main };
