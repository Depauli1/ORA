// CI gate for finding 7: a PRODUCTION oracle config must never ship with
// fallbackAggregator == address(0) (or loose deviation / wide heartbeats /
// no sequencer feed). Two modes:
//
//   node scripts/check-oracle-config.js                  static policy + wiring gate (runs in CI)
//   node scripts/check-oracle-config.js --deployment <path-to-deployment-*.json>
//                                                        artifact gate (run before any prod deploy
//                                                        is announced / funded; fails closed)
//
// Exit 0 = pass, exit 1 = FAIL with the violation printed.
const fs = require("fs");
const path = require("path");
const { PROD_NETWORKS, PROD_CHAIN_IDS, POLICY, ZERO, isProdChain, assertProdConfig } = require("./oracle-policy");

let failures = 0;
const ok = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const expectThrow = (label, fn, re) => {
  try { fn(); fail(`${label} — expected a throw, got none`); }
  catch (e) { (re.test(e.message)) ? ok(`${label} throws: ${e.message.slice(0, 90)}`) : fail(`${label} threw wrong error: ${e.message.slice(0, 120)}`); }
};

function staticGate() {
  console.log("oracle-config static gate — policy invariants:");
  if (!PROD_NETWORKS.includes("base")) fail('PROD_NETWORKS must include "base"');
  else ok('PROD_NETWORKS includes "base"');
  if (!PROD_CHAIN_IDS.includes(8453)) fail("PROD_CHAIN_IDS must include 8453 (Base)");
  else ok("PROD_CHAIN_IDS includes 8453 (Base)");
  const p = POLICY.base;
  if (!p || p.requireFallback !== true) fail("POLICY.base.requireFallback must be true");
  else ok("POLICY.base.requireFallback === true");
  if (!p || p.maxDeviationBps !== 1000) fail("POLICY.base.maxDeviationBps must be 1000 (10%)");
  else ok("POLICY.base.maxDeviationBps === 1000 (10%)");
  if (!p || p.requireSequencer !== true) fail("POLICY.base.requireSequencer must be true");
  else ok("POLICY.base.requireSequencer === true");

  console.log("oracle-config static gate — fail-closed behavior:");
  const good = {
    network: "base", fallback: "0x1111111111111111111111111111111111111111",
    ethDeviationBps: 1000, wstethDeviationBps: 500, ethHeartbeat: 7200,
    stethHeartbeat: 108000, sequencer: "0x2222222222222222222222222222222222222222",
  };
  try { assertProdConfig(good); ok("compliant prod config passes"); }
  catch (e) { fail(`compliant prod config threw: ${e.message.slice(0, 120)}`); }
  expectThrow("prod config with fallback == address(0)",
    () => assertProdConfig({ ...good, fallback: ZERO }), /fallback aggregator/i);
  expectThrow("prod config with missing fallback",
    () => assertProdConfig({ ...good, fallback: undefined }), /fallback aggregator/i);
  expectThrow("prod config with 50% ETH deviation",
    () => assertProdConfig({ ...good, ethDeviationBps: 5000 }), /deviation/i);
  expectThrow("prod config with 48h ETH heartbeat",
    () => assertProdConfig({ ...good, ethHeartbeat: 48 * 3600 }), /heartbeat/i);
  expectThrow("prod config without sequencer feed",
    () => assertProdConfig({ ...good, sequencer: ZERO }), /sequencer/i);
  // The escape hatch must exist but stay OFF by default.
  delete process.env.ORA_ALLOW_SINGLE_SOURCE;
  expectThrow("fallback requirement active without the override env",
    () => assertProdConfig({ ...good, fallback: ZERO }), /fallback aggregator/i);
  try { assertProdConfig({ ...good, network: "baseSepolia", fallback: ZERO }); ok("testnets keep loose lab defaults"); }
  catch (e) { fail(`testnet config should pass: ${e.message.slice(0, 120)}`); }

  console.log("oracle-config static gate — deploy.js wiring presence:");
  const deploySrc = fs.readFileSync(path.join(__dirname, "deploy.js"), "utf8");
  for (const marker of ["assertProdConfig({", "PythFallbackAggregator", "IS_PROD_NET", "ORA_PYTH_ADDRESS"]) {
    deploySrc.includes(marker) ? ok(`deploy.js references ${marker}`) : fail(`deploy.js LOST its ${marker} wiring`);
  }
}

function artifactGate(file) {
  console.log(`oracle-config artifact gate — ${file}:`);
  let d;
  try { d = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { fail(`cannot read deployment artifact: ${e.message}`); return; }
  const s = d.shared || {};
  if (!isProdChain(d.chainId)) {
    ok(`chainId ${d.chainId} is not production — advisory only (fallback: ${s.ethUsdFallbackAggregator || "?"})`);
    return;
  }
  (s.ethUsdFallbackAggregator && s.ethUsdFallbackAggregator.toLowerCase() !== ZERO)
    ? ok(`prod fallback wired: ${s.ethUsdFallbackAggregator}`)
    : fail("PROD artifact has fallbackAggregator == address(0)");
  (s.prodPolicyEnforced === true)
    ? ok("prodPolicyEnforced === true")
    : fail("PROD artifact was not deployed under the prod policy (prodPolicyEnforced !== true)");
  for (const [k, v] of [["ethUsdDeviationBps", s.ethUsdDeviationBps], ["wstethDeviationBps", s.wstethDeviationBps]]) {
    (v !== undefined && Number(v) <= 1000)
      ? ok(`prod ${k} = ${v}bps (<= 1000)`)
      : fail(`PROD artifact ${k} = ${v} (must be <= 1000)`);
  }
}

async function main() {
  const i = process.argv.indexOf("--deployment");
  if (i !== -1 && process.argv[i + 1]) artifactGate(process.argv[i + 1]);
  else staticGate();
  console.log(failures === 0 ? "oracle-config: ALL CHECKS PASSED" : `oracle-config: ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
