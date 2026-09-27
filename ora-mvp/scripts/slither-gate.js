// Slither CI gate with tier classification (mirrors AUDIT_DIFF.md).
//
//   Tier 3 (wholly new ORA code):      High -> FAIL. Medium -> warn.
//   Tier 2 (forks of audited code):    High -> FAIL unless the triage entry
//                                      cites an audited base AND the gate can
//                                      MECHANICALLY prove the finding is
//                                      inherited (same detector on the same
//                                      function in the mapped upstream file,
//                                      anchored in Tier 0/1). A fork-introduced
//                                      High can never be triaged away.
//                                      Medium -> FAIL unless triaged in
//                                      scripts/slither-triage.json (check +
//                                      path + written reason).
//                                      Low/Info -> reported, not gated (same
//                                      policy as the audited upstream, whose
//                                      Low/Info findings are equally present).
//   Tier 0/1 (audited core) + scaffold: informational only.
//
// The old gate excluded Tier 2 entirely via a --filter-paths substring regex
// ("TroveManager|BorrowerOperations|StabilityPool|...") that matched the fork
// file names — the fork-kill-zone was the one place the gate never looked.
// This rewrite classifies every finding in JS from one unfiltered Slither run.
//
// CLI:  node scripts/slither-gate.js slither-all.json [--triage slither-triage.json]
// Lib:  const { evaluate } = require("./slither-gate")   (see test/slither-gate.test.js)
const fs = require("fs");

// --- Tier maps (keep in sync with AUDIT_DIFF.md and scripts/coverage-gate.js) ---
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
  "contracts/Interfaces/IOraGuardian.sol"
];

// Tier-2 file -> its audited base (AUDIT_DIFF Tier 2 table). The RWA files
// are constants-only rebases of the V2/ERC20 forks, so their proof chains
// run one level deeper and must anchor in Tier 0/1.
const TIER2_BASE = {
  "contracts/branches/ActivePoolERC20.sol": ["contracts/ActivePool.sol"],
  "contracts/branches/BorrowerOperationsERC20.sol": ["contracts/BorrowerOperations.sol"],
  "contracts/branches/CollSurplusPoolERC20.sol": ["contracts/CollSurplusPool.sol"],
  "contracts/branches/DefaultPoolERC20.sol": ["contracts/DefaultPool.sol"],
  "contracts/branches/StabilityPoolERC20.sol": ["contracts/StabilityPool.sol"],
  "contracts/branches/TroveManagerV2.sol": ["contracts/TroveManager.sol"],
  "contracts/rates/TroveManagerRates.sol": ["contracts/TroveManager.sol"],
  "contracts/rates/BorrowerOperationsRates.sol": ["contracts/BorrowerOperations.sol"],
  "contracts/rates/SortedTrovesRates.sol": ["contracts/SortedTroves.sol"],
  "contracts/rates/StabilityPoolRates.sol": ["contracts/StabilityPool.sol"],
  "contracts/rwa/TroveManagerRWA.sol": ["contracts/branches/TroveManagerV2.sol"],
  "contracts/rwa/BorrowerOperationsRWA.sol": ["contracts/branches/BorrowerOperationsERC20.sol"],
  "contracts/rwa/StabilityPoolRWA.sol": ["contracts/branches/StabilityPoolERC20.sol"],
  "contracts/rwa/HintHelpersRWA.sol": ["contracts/HintHelpers.sol"],
  "contracts/rwa/LiquityBaseRWA.sol": ["contracts/Dependencies/LiquityBase.sol"]
};

// Scaffold = test harness only. Unlike the coverage gate (which also exempts
// the Mocks/SettableAggregator), the SLITHER gate keeps gating them: they are
// deployed to public testnets, and the previous gate never excluded them —
// tightening, never loosening.
const SCAFFOLD = ["TestContracts/", "PriceFeedTestnet"];

// --- helpers ----------------------------------------------------------------
function normalizePath(p) {
  const i = (p || "").indexOf("contracts/");
  return i >= 0 ? p.slice(i) : (p || "");
}
function sourcePathOf(finding) {
  for (const el of finding.elements || []) {
    const sm = el.source_mapping;
    if (sm && sm.filename_relative) return normalizePath(sm.filename_relative);
  }
  return "";
}
function primaryFnOf(finding) {
  for (const el of finding.elements || []) if (el.type === "function") return el.name;
  return "";
}
const isScaffold = p => SCAFFOLD.some(s => p.includes(s));
const isTier3 = p => TIER3.some(t => p === t || (t.endsWith("/") && p.startsWith(t)));
const tier2Bases = p => TIER2_BASE[p] || null;

// Index every finding by "file|check" -> set of primary function names, for
// the inheritance proof.
function indexByFileCheck(detectors) {
  const idx = new Map();
  for (const d of detectors) {
    const key = sourcePathOf(d) + "|" + d.check;
    if (!idx.has(key)) idx.set(key, new Set());
    const fn = primaryFnOf(d);
    if (fn) idx.get(key).add(fn);
    else idx.get(key).add("*"); // nameless finding (e.g. constructor constants)
  }
  return idx;
}

// Prove that a Tier-2 finding is inherited: the same detector fired on the
// same primary function in one of its mapped bases, where the chain must
// ultimately anchor in a file that is NOT itself a Tier-2 fork (i.e. Tier 0/1
// audited code). Depth-capped at 3 (RWA -> V2/ERC20 -> upstream).
function inheritsFromAuditedBase(finding, idx, bases, depth = 0) {
  if (depth > 3 || !bases) return false;
  const fn = primaryFnOf(finding);
  for (const base of bases) {
    const hits = idx.get(base + "|" + finding.check);
    if (hits && (fn ? hits.has(fn) : hits.has("*"))) {
      if (!TIER2_BASE[base]) return true; // anchored in audited Tier 0/1
      // Base is itself a fork: its copy must anchor further up.
      if (inheritsFromAuditedBase({ ...finding, check: finding.check }, idx, TIER2_BASE[base], depth + 1)) return true;
    }
    // Also try the base's own bases directly (name may be preserved upstream
    // even when it changed in the immediate fork, e.g. openTroveWithRate).
    if (TIER2_BASE[base] &&
        inheritsFromAuditedBase(finding, idx, TIER2_BASE[base], depth + 1)) return true;
  }
  return false;
}

function triageMatches(entry, finding) {
  return entry.check === finding.check &&
    finding._path.includes(entry.path) &&
    (entry.impact || "Medium") === finding.impact;
}

// --- the gate ----------------------------------------------------------------
// Returns { fail: [...], warn: [...], counts: {...} } — pure, unit-tested.
function evaluate(detectors, triage) {
  const idx = indexByFileCheck(detectors);
  const fail = [], warn = [];
  const counts = { t3: {}, t2: {}, other: 0 };
  for (const d of detectors) {
    const p = sourcePathOf(d);
    d._path = p;
    const label = `${d.impact} ${d.check} @ ${p}${primaryFnOf(d) ? "::" + primaryFnOf(d) : ""}`;
    if (!p) { warn.push(`unmapped-source ${label}`); continue; }

    if (isTier3(p) && !isScaffold(p)) {
      counts.t3[d.impact] = (counts.t3[d.impact] || 0) + 1;
      if (d.impact === "High") fail.push(`TIER 3 ${label}`);
      else if (d.impact === "Medium") warn.push(`T3-medium ${label}`);
      continue;
    }

    if (TIER2_BASE[p] && !isScaffold(p)) {
      counts.t2[d.impact] = (counts.t2[d.impact] || 0) + 1;
      if (d.impact === "High") {
        const entry = triage.find(e => triageMatches(e, d));
        const proven = inheritsFromAuditedBase(d, idx, TIER2_BASE[p]);
        if (entry && proven) { warn.push(`T2-high INHERITED (proof: ${entry.inheritedFrom}) ${label}`); }
        else if (entry && !proven) fail.push(`TIER 2 HIGH not provably inherited (triage cites ${entry.inheritedFrom} but no matching audited-base finding) ${label}`);
        else if (!entry) fail.push(`TIER 2 HIGH untriaged ${label}`);
        else fail.push(`TIER 2 HIGH ${label}`);
      } else if (d.impact === "Medium") {
        const entry = triage.find(e => triageMatches(e, d));
        if (entry) warn.push(`T2-medium triaged (${entry.reason.slice(0, 80)}) ${label}`);
        else fail.push(`TIER 2 MEDIUM untriaged ${label}`);
      }
      // Low/Info in Tier 2: counted, never gated (documented blanket policy).
      continue;
    }

    counts.other++;
  }
  return { fail, warn, counts };
}

function loadTriage(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).triage || [];
}

const oneLine = s => String(s).replace(/\s+/g, " ").trim();

// --- CLI ---------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonPath = args.find(a => !a.startsWith("--"));
  const triageFlag = args.indexOf("--triage");
  const triageFile = triageFlag >= 0 ? args[triageFlag + 1] : require("path").join(__dirname, "slither-triage.json");
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    console.log("::error title=Slither gate::no JSON output found at " + jsonPath + " (slither crashed?)");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const detectors = (data.results && data.results.detectors) || [];
  const { fail, warn, counts } = evaluate(detectors, loadTriage(triageFile));

  for (const f of fail) console.log(`::error title=Slither gate::${oneLine(f).slice(0, 400)}`);
  for (const w of warn.slice(0, 40)) console.log(`::warning title=Slither gate::${oneLine(w).slice(0, 300)}`);
  const c = k => counts[k] ? Object.entries(counts[k]).map(([i, n]) => `${n} ${i}`).join(", ") : "0";
  console.log(`\nSlither tier gate: TIER 3 [${c("t3")}] | TIER 2 [${c("t2")}] | other/info [${counts.other}]`);
  console.log(`policy: T3 high=fail | T2 high=fail-unless-provably-inherited, medium=triaged, low/info=reported`);
  if (fail.length > 0) {
    console.log(`FAIL — ${fail.length} gating finding(s):`);
    for (const f of fail) console.log("  ✗ " + oneLine(f));
    process.exit(1);
  }
  console.log("PASS — no untriaged high/medium findings in Tier 2/3");
}

module.exports = { evaluate, loadTriage, sourcePathOf, primaryFnOf, inheritsFromAuditedBase, TIER2_BASE, TIER3 };
