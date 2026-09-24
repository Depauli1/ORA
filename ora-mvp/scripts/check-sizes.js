// ORA contract-size gate — fails the build before any artifact creeps back
// toward the 24,576-byte EIP-170 limit.
//
//   FAIL 22,528 (22KB) for every deployable contract, except the frozen
//         upstream TroveManager (Tier 0, never changes), capped at 23,552.
//   WARN 22,016 (21.5KB) — early signal that headroom is thinning.
//
// Usage: node scripts/check-sizes.js   (run `npx hardhat compile` first)
const fs = require("fs");
const path = require("path");

const ART = path.join(__dirname, "..", "artifacts", "contracts");
const FAIL_BYTES = 22528;
const WARN_BYTES = 22016;
// Frozen upstream files that predate the gate (Tier 0 — any growth here
// means someone touched audited code, which must fail review anyway).
const EXEMPT = { "contracts/TroveManager.sol/TroveManager.json": 23552 };

function walk(d, out) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { walk(p, out); continue; }
    if (!f.endsWith(".json") || f.endsWith(".dbg.json")) continue;
    const rel = path.relative(path.join(__dirname, "..", "artifacts"), p);
    try {
      const j = JSON.parse(fs.readFileSync(p));
      const bc = (j.deployedBytecode || "").replace(/^0x/, "");
      if (bc.length > 4) out.push([Math.round(bc.length / 2), rel]);
    } catch { /* ignore unreadable */ }
  }
  return out;
}

const rows = walk(ART, []).sort((a, b) => b[0] - a[0]);
let failed = false;
console.log("contract-size gate (FAIL > 22,528B, WARN > 22,016B; limit 24,576B):");
for (const [size, name] of rows) {
  const cap = EXEMPT["contracts/" + name] || EXEMPT[name] || FAIL_BYTES;
  const tag = size > cap ? "FAIL" : size > WARN_BYTES ? "WARN" : "ok";
  if (size > cap) failed = true;
  if (tag !== "ok" || size > 12000)
    console.log(`  ${tag.padEnd(4)} ${String(size).padStart(6)}B  ${name}`);
}
if (failed) {
  console.error("\nSIZE GATE FAILED: an artifact exceeds its cap. Shrink the contract");
  console.error("(externalize logic like BatchLiquidator) or justify raising the cap.");
  process.exit(1);
}
console.log(`\nsize gate passed (${rows.length} artifacts checked).`);
