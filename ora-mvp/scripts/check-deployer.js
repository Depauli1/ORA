// Pre-deploy gate for CI: verifies the deployer key resolves and the address
// holds enough Base Sepolia ETH to deploy. Exits 1 with funding instructions
// if not — this is the expected "waiting for faucet" state of the pipeline.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.ORA_RPC_URL || "https://sepolia.base.org";
const MIN = ethers.parseEther(process.env.ORA_MIN_DEPLOY_ETH || "0.03");

function deployerKey() {
  if (process.env.ORA_DEPLOYER_KEY) return process.env.ORA_DEPLOYER_KEY;
  for (const f of [".secret", ".testnet-deployer.key"]) {
    const p = path.join(__dirname, "..", f);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  throw new Error("No deployer key found (.secret / .testnet-deployer.key / ORA_DEPLOYER_KEY)");
}

async function main() {
  const wallet = new ethers.Wallet(deployerKey());
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const [bal, net] = await Promise.all([provider.getBalance(wallet.address), provider.getNetwork()]);
  console.log(`Network:  chainId ${net.chainId} (${RPC})`);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance:  ${ethers.formatEther(bal)} ETH (need >= ${ethers.formatEther(MIN)})`);
  // GitHub Actions annotation — visible via the API even when raw logs aren't
  if (process.env.GITHUB_ACTIONS) {
    const kind = bal < MIN ? "error title=Deployer unfunded" : "notice title=Deployer funded";
    console.log(`::${kind}::chainId ${net.chainId} | deployer ${wallet.address} | balance ${ethers.formatEther(bal)} ETH | need ${ethers.formatEther(MIN)} ETH`);
  }

  if (bal < MIN) {
    console.log("\n==================== ACTION NEEDED ====================");
    console.log(`Send Base Sepolia ETH to the deployer address:`);
    console.log(`\n    ${wallet.address}\n`);
    console.log("Faucets (free, no mainnet balance needed):");
    console.log("  - https://portal.cdp.coinbase.com/products/faucet  (Coinbase, pick Base Sepolia)");
    console.log("  - https://www.alchemy.com/faucets/base-sepolia");
    console.log("  - https://faucet.quicknode.com/base/sepolia");
    console.log("\n~0.05 ETH deploys + seeds the ERC20 branches.");
    console.log("Then re-run this workflow (push any change to ora-mvp/.deploy-testnet-trigger).");
    console.log("=======================================================");
    process.exit(1);
  }
  console.log("\nFunded — proceeding with deployment.");
}

main().catch(e => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Deployer check crashed (RPC problem?)::${(e.shortMessage || e.message || "").slice(0, 200)}`);
  }
  console.error("CHECK FAILED:", e.shortMessage || e.message);
  process.exit(1);
});
