// ORA coverage gate — Tier 3 (wholly new ORA code) must hold >=95% line and
// >=75% branch coverage. Tier 0/1/2 (audited/upstream-derived) are reported,
// not gated (their assurance comes from the upstream audits + the
// differential suite, not line coverage).
//
// Thresholds are ratchets: measured 2026-09 at 98.61% lines / 80.05% branches
// — gates sit a few points below so ordinary churn doesn't trip them, but a
// new Tier-3 file with weak tests will. Raise them as coverage improves.
//
//   COVERAGE=1 npx hardhat coverage && node scripts/coverage-gate.js
//   (or: npm run coverage)
const fs = require("fs");
const path = require("path");

const COV = path.join(__dirname, "..", "coverage.json");
const MIN_TIER3_LINES = 95;
const MIN_TIER3_BRANCHES = 75;

// Tier 3 = everything in these dirs/files (see AUDIT_DIFF.md Tier 3).
const TIER3 = [
  "contracts/branches/BranchCommunityIssuance.sol",
  "contracts/branches/BranchFeeReceiver.sol",
  "contracts/branches/BranchStaking.sol",
  "contracts/branches/MockTBill.sol",
  "contracts/branches/MockWstETH.sol",
  "contracts/branches/ZeroCommunityIssuance.sol",
  "contracts/oracles/",
  "contracts/rates/HintHelpersRates.sol",
  "contracts/rates/InterestRouter.sol",
  "contracts/rates/SorUSDVault.sol",
  "contracts/rwa/WTBill.sol",
  "contracts/rwa/WTBillPriceFeed.sol",
  "contracts/zap/",
  "contracts/guardian/",
  "contracts/keeper/",
  "contracts/dependencies08/",
  "contracts/Interfaces/IOraGuardian.sol",
];
// Test scaffolding (mocks, settable feeds, harnesses) is reported but never
// gated — covering test helpers with tests is circular.
const SCAFFOLD = ["Mock", "SettableAggregator", "TestContracts/", "PriceFeedTestnet"];
const isScaffold = f => SCAFFOLD.some(s => f.includes(s));
const isTier3 = f => !isScaffold(f) && TIER3.some(t => f === t || (t.endsWith("/") && f.startsWith(t)));

function pct(hit, total) { return total === 0 ? 100 : 100 * hit / total; }

const cov = JSON.parse(fs.readFileSync(COV));
let tHit = 0, tTot = 0, tBrHit = 0, tBrTot = 0, tFnHit = 0, tFnTot = 0;
const rows = [];
for (const [file, data] of Object.entries(cov)) {
  const rel = path.relative(path.join(__dirname, ".."), file);
  const st = data.s, fnMap = data.f, brMap = data.b;
  const sHit = Object.values(st).filter(x => x > 0).length, sTot = Object.keys(st).length;
  const fHit = Object.values(fnMap).filter(x => x > 0).length, fTot = Object.keys(fnMap).length;
  let bHit = 0, bTot = 0;
  for (const arr of Object.values(brMap)) for (const x of arr) { bTot++; if (x > 0) bHit++; }
  const tag = isTier3(rel) ? "T3" : "  ";
  if (isTier3(rel)) {
    tHit += sHit; tTot += sTot;
    tBrHit += bHit; tBrTot += bTot;
    tFnHit += fHit; tFnTot += fTot;
  }
  rows.push([tag, rel, pct(sHit, sTot), pct(bHit, bTot), pct(fHit, fTot)]);
}
rows.sort((a, b) => a[1].localeCompare(b[1]));
console.log("file coverage (T3 = Tier 3, gated):");
console.log("     %lines %branch %func  file");
for (const [tag, rel, l, b, f] of rows)
  console.log(`  ${tag} ${l.toFixed(1).padStart(6)} ${b.toFixed(1).padStart(7)} ${f.toFixed(1).padStart(5)}  ${rel}`);
const t3 = pct(tHit, tTot);
const t3b = pct(tBrHit, tBrTot);
const t3f = pct(tFnHit, tFnTot);
console.log(`\nTier 3 aggregate: ${t3.toFixed(2)}% lines (gate: >= ${MIN_TIER3_LINES}%), `
  + `${t3b.toFixed(2)}% branches (gate: >= ${MIN_TIER3_BRANCHES}%), ${t3f.toFixed(2)}% functions`);
let failed = false;
if (t3 < MIN_TIER3_LINES) {
  console.error(`COVERAGE GATE FAILED: Tier 3 line coverage ${t3.toFixed(2)}% < ${MIN_TIER3_LINES}%`);
  failed = true;
}
if (t3b < MIN_TIER3_BRANCHES) {
  console.error(`COVERAGE GATE FAILED: Tier 3 branch coverage ${t3b.toFixed(2)}% < ${MIN_TIER3_BRANCHES}%`);
  failed = true;
}
if (failed) process.exit(1);
console.log("coverage gate passed.");
