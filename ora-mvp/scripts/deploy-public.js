// Public-testnet variant of deploy.js (e.g. Base Sepolia): one funded deployer
// key; a deterministic secondary "treasury" wallet is derived from it so the
// ORA faucet allocation lands on an address that is NOT transfer-locked
// (LQTYToken locks the multisig = deployer for year 1).
//
// Usage:
//   node scripts/gen-deployer.js          # once; fund the printed address
//   npx hardhat run scripts/deploy-public.js --network baseSepolia
//
// Testnet-only venues (OraSwapPool demo AMM + LeverZapFactory) are skipped
// automatically on mainnet chains (see scripts/deploy-guards.js) — the
// manifest keeps the fields as null and the app/seeds/verifiers degrade.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;

function deployerKey() {
  if (process.env.ORA_DEPLOYER_KEY) return process.env.ORA_DEPLOYER_KEY;
  for (const f of [".secret"]) {
    const p = path.join(__dirname, "..", f);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  throw new Error("No deployer key: run scripts/gen-deployer.js or set ORA_DEPLOYER_KEY");
}

const key = deployerKey();
const treasuryKey = ethers.keccak256(ethers.toUtf8Bytes(key + ":ora-treasury"));

// deploy.js destructures [deployer, , , , treasury] from getSigners()
const orig = ethers.getSigners.bind(ethers);
ethers.getSigners = async () => {
  const s = await orig();
  const deployer = s[0];
  const treasury = new ethers.Wallet(treasuryKey, ethers.provider);
  console.log("Treasury (derived):", treasury.address);
  // Give the treasury a little gas for later faucet transfers
  const bal = await ethers.provider.getBalance(treasury.address);
  if (bal === 0n) {
    await (await deployer.sendTransaction({ to: treasury.address, value: ethers.parseEther("0.005") })).wait();
    console.log("Treasury funded with 0.005 ETH for gas");
  }
  return [deployer, deployer, deployer, deployer, treasury];
};

require("./deploy.js");
