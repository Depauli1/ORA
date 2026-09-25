// Basescan verification automation: walks the manifest's `verify` section
// (constructor args captured at deploy time) and verifies every contract.
//
// Usage:
//   npx hardhat run scripts/verify-deployment.js --network baseSepolia
//   npx hardhat run scripts/verify-deployment.js --network baseSepolia -- --dry-run
//   npx hardhat run scripts/verify-deployment.js --network baseSepolia -- --from 20
//
// Env: BASESCAN_API_KEY (one Etherscan-V2 key covers Base + Base Sepolia).
// Already-verified contracts are skipped (not failures).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deserArgs } = require("./manifest-lib");

async function main(argv, hreOverride) {
  argv = argv || process.argv.slice(2);
  const h = hreOverride || hre;
  const dryRun = argv.includes("--dry-run");
  const fromIdx = argv.indexOf("--from");
  const from = fromIdx >= 0 ? Number(argv[fromIdx + 1]) : 0;
  const manIdx = argv.indexOf("--manifest");
  const net = h.network.name;
  const suffix = net === "localhost" || net === "hardhat" ? "" : "-" + net;
  const manifestPath = manIdx >= 0
    ? argv[manIdx + 1]
    : path.join(__dirname, "..", "app", `deployment${suffix}.json`);
  if (!fs.existsSync(manifestPath)) throw new Error("manifest not found: " + manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const entries = (manifest.verify || []).slice(from);
  if (!entries.length) throw new Error("manifest has no verify section — redeploy with the current deploy.js");

  console.log(`${dryRun ? "[dry-run] " : ""}verifying ${entries.length} contracts on ${net} from ${manifestPath}`);
  let ok = 0, skipped = 0, failed = 0;
  for (const [i, e] of entries.entries()) {
    const label = `[${from + i}] ${e.contract} @ ${e.address}`;
    if (dryRun) {
      console.log(`  would verify ${label} (${e.artifact}, ${e.args.length} args)`);
      ok++;
      continue;
    }
    try {
      await h.run("verify:verify", {
        address: e.address,
        constructorArguments: deserArgs(e.args),
        contract: e.artifact,
      });
      console.log(`  verified ${label}`);
      ok++;
    } catch (err) {
      const msg = String(err.message || err);
      if (/already verified|alreadyverified|already been verified/i.test(msg)) {
        console.log(`  already verified ${label}`);
        skipped++;
      } else {
        console.error(`  FAILED ${label}: ${msg.slice(0, 300)}`);
        failed++;
      }
    }
  }
  console.log(`\ndone: ${ok} verified, ${skipped} already-verified, ${failed} failed`);
  if (failed) process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
module.exports = { main };
