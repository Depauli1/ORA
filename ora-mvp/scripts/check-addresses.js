// Nonce-determinism check: re-derives every deployed address from
// (deployer, nonce) and compares against the manifest. Catches manifest
// corruption/tampering and proves the address map replays from the
// recorded nonces. Pure offline check (no RPC needed).
//
// Usage: node scripts/check-addresses.js [manifest.json]
const fs = require("fs");
const { checkVerifyAddresses } = require("./manifest-lib");

const manifestPath = process.argv[2]
  || require("path").join(__dirname, "..", "app", "deployment.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath));
const rows = checkVerifyAddresses(manifest);
const bad = rows.filter((r) => !r.ok);
for (const r of rows) {
  if (!r.ok) console.error(`  MISMATCH ${r.contract} @ ${r.address} (nonce ${r.nonce} → ${r.expected})`);
}
console.log(`${manifestPath}: ${rows.length - bad.length}/${rows.length} addresses replay from (deployer, nonce)`);
if (bad.length) process.exit(1);
