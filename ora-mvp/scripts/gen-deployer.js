// Generates a fresh testnet deployer key -> ora-mvp/.secret (gitignored).
// Fund the printed address with Base Sepolia ETH, then run the deploy.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const p = path.join(__dirname, "..", ".secret");
if (fs.existsSync(p)) {
  const w = new ethers.Wallet(fs.readFileSync(p, "utf8").trim());
  console.log("Existing deployer:", w.address);
} else {
  const w = ethers.Wallet.createRandom();
  fs.writeFileSync(p, w.privateKey + "\n", { mode: 0o600 });
  console.log("New deployer generated:", w.address);
  console.log("Key saved to ora-mvp/.secret (gitignored). TESTNET USE ONLY.");
}
console.log("\nFund it with Base Sepolia ETH (~0.05 is plenty):");
console.log("  https://portal.cdp.coinbase.com/products/faucet");
console.log("  https://www.alchemy.com/faucets/base-sepolia");
console.log("\nThen deploy:  npx hardhat run scripts/deploy-public.js --network baseSepolia");
