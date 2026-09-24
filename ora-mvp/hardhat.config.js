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
    }
  },
  paths: {
    sources: "./contracts"
  }
};
