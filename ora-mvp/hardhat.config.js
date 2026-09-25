require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
// Coverage is opt-in (COVERAGE=1) so normal compile/test runs stay fast.
if (process.env.COVERAGE === "1") require("solidity-coverage");

// The sandbox blocks binaries.soliditylang.org, so we use the WASM compiler
// from the `solc` npm package instead of letting Hardhat download solc.
const path = require("path");
const {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD
} = require("hardhat/builtin-tasks/task-names");
const { subtask } = require("hardhat/config");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.6.11") {
    const compilerPath = path.join(
      path.dirname(require.resolve("solc/package.json")),
      "soljson.js"
    );
    return {
      compilerPath,
      isSolcJs: true,
      version: "0.6.11",
      longVersion: "0.6.11+commit.5ef660b1"
    };
  }
  if (args.solcVersion === "0.8.24") {
    // New ORA contracts (Tier 3 + guardian + libraries) build on solc 0.8.24.
    const compilerPath = path.join(
      path.dirname(require.resolve("solc-0.8/package.json")),
      "soljson.js"
    );
    return {
      compilerPath,
      isSolcJs: true,
      version: "0.8.24",
      longVersion: "0.8.24+commit.e11b9ed9"
    };
  }
  return runSuper(args);
});

// Deployer key for public testnets, in priority order:
//   1. ORA_DEPLOYER_KEY env var (in CI: the DEPLOYER_KEY Actions secret)
//   2. ora-mvp/.secret (gitignored, local use — generate with scripts/gen-deployer.js)
// There is intentionally NO committed fallback key: any key that ever touched
// git history must be treated as public. NEVER use these keys with real funds.
const fs = require("fs");
function deployerKey() {
  if (process.env.ORA_DEPLOYER_KEY) return process.env.ORA_DEPLOYER_KEY;
  for (const f of [".secret"]) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  return undefined;
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [{
      version: "0.6.11",
      settings: {
        optimizer: { enabled: true, runs: 100 }
      }
    },
    {
      // New ORA contracts (Tier 3 + guardian + libraries). Small sources, so
      // a high runs count buys cheap calls without size pressure.
      version: "0.8.24",
      settings: {
        optimizer: { enabled: true, runs: 1000 }
      }
    }],
    overrides: {
      // TroveManagerV2 adds soft liquidations on top of an already size-capped
      // contract; runs:1 keeps it under the 24KB limit.
      "contracts/branches/TroveManagerV2.sol": {
        version: "0.6.11",
        settings: {
          optimizer: { enabled: true, runs: 1 }
        }
      },
      // TroveManagerRates adds the user-set interest-rate engine on top of the
      // size-capped v1 TroveManager; runs:1 keeps it under the 24KB limit.
      "contracts/rates/TroveManagerRates.sol": {
        version: "0.6.11",
        settings: {
          optimizer: { enabled: true, runs: 1 }
        }
      },
      // TroveManagerRWA is a constants-only fork of TroveManagerV2 (MCR 105%),
      // same size profile; runs:1 keeps it under the 24KB limit.
      "contracts/rwa/TroveManagerRWA.sol": {
        version: "0.6.11",
        settings: {
          optimizer: { enabled: true, runs: 1 }
        }
      }
    }
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Finding 6: fork mode for test/fork-reads.test.js (CI fork job only).
      // ORA_FORK_URL set -> fork Base Sepolia at latest; unset -> hermetic.
      ...(process.env.ORA_FORK_URL ? { forking: { url: process.env.ORA_FORK_URL } } : {}),
      // Pure automine: combining auto + interval mining causes an EDR race
      // where rapid tx bursts intermittently read stale nonces (NONCE_EXPIRED).
      mining: { auto: true }
    },
    localhost: {
      url: "http://127.0.0.1:8545"
    },
    baseSepolia: {
      url: process.env.ORA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: deployerKey() ? [deployerKey()] : []
    }
  },
  paths: {
    sources: "./contracts"
  },
  mocha: {
    timeout: 180000
  }
};
