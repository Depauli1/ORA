require("@nomicfoundation/hardhat-ethers");

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
  return runSuper(args);
});

// Deployer key for public testnets: ORA_DEPLOYER_KEY env var, or ora-mvp/.secret
// (generate one with: node scripts/gen-deployer.js). NEVER use these keys on mainnet.
const fs = require("fs");
function deployerKey() {
  if (process.env.ORA_DEPLOYER_KEY) return process.env.ORA_DEPLOYER_KEY;
  const p = path.join(__dirname, ".secret");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return undefined;
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.6.11",
    settings: {
      optimizer: { enabled: true, runs: 100 }
    }
  },
  networks: {
    hardhat: {
      chainId: 31337,
      mining: { auto: true, interval: 5000 }
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
  }
};
