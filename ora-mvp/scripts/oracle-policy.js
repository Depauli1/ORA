// ORA production oracle policy (finding 7, fail-closed).
//
// Single source of truth for what a PRODUCTION oracle config must satisfy:
//   - ETH/USD must have a live fallback source (two-source confirm active)
//   - single-fetch deviation caps must be TIGHT (10%, not the 50% lab default)
//   - heartbeats must match the aggregators' real update cadence + margin
//
// Enforced in two places: scripts/deploy.js (prod networks throw on violation)
// and scripts/check-oracle-config.js (CI gate). Testnets/localhost keep the
// loose lab defaults so the market simulator and demos keep working.
//
// Override: ORA_ALLOW_SINGLE_SOURCE=1 bypasses ONLY the fallback requirement
// (emergency prod re-deploy); everything else still applies, and the bypass
// is printed loudly. CI asserts the default path still throws.
const PROD_NETWORKS = ["base"];          // network.name values treated as production
const PROD_CHAIN_IDS = [8453];           // chainIds treated as production

const POLICY = {
  base: {
    requireFallback: true,
    maxDeviationBps: 1000,          // 10% single-fetch move cap, per asset
    maxEthHeartbeat: 24 * 3600,     // ETH/USD Chainlink heartbeat is <=1h on L2s; 24h is a sanity ceiling
    maxStethHeartbeat: 48 * 3600,   // stETH/ETH heartbeat is 24h; 48h is a sanity ceiling
    requireSequencer: true,         // L2 uptime feed is mandatory on prod
  },
};

const ZERO = "0x0000000000000000000000000000000000000000";

function isProdNetwork(networkName) {
  return PROD_NETWORKS.includes(networkName);
}

function isProdChain(chainId) {
  return PROD_CHAIN_IDS.includes(Number(chainId));
}

// Throws on any policy violation; returns true when the config is compliant
// (or the network is not production, where lab defaults are allowed).
function assertProdConfig({ network, fallback, ethDeviationBps, wstethDeviationBps, ethHeartbeat, stethHeartbeat, sequencer }) {
  if (!isProdNetwork(network)) return true;
  const p = POLICY[network];
  if (process.env.ORA_ALLOW_SINGLE_SOURCE === "1") {
    console.log("  WARNING: ORA_ALLOW_SINGLE_SOURCE=1 — prod fallback requirement BYPASSED (footgun, audit this)");
  } else if (p.requireFallback && (!fallback || fallback.toLowerCase() === ZERO)) {
    throw new Error(
      `oracle-policy: ${network} REQUIRES a fallback aggregator (fallbackAggregator == address(0)). ` +
      `Set ORA_ETHUSD_FALLBACK_FEED or ORA_PYTH_ADDRESS + ORA_ETHUSD_PYTH_ID.`
    );
  }
  for (const [label, v] of [["ETH deviation", ethDeviationBps], ["wstETH deviation", wstethDeviationBps]]) {
    if (v === undefined || v === null) throw new Error(`oracle-policy: ${network} missing ${label} (pass explicit bps)`);
    if (Number(v) > p.maxDeviationBps) {
      throw new Error(`oracle-policy: ${network} ${label} ${v}bps exceeds max ${p.maxDeviationBps}bps — tighten it.`);
    }
  }
  if (Number(ethHeartbeat) > p.maxEthHeartbeat) {
    throw new Error(`oracle-policy: ${network} ETH heartbeat ${ethHeartbeat}s exceeds max ${p.maxEthHeartbeat}s.`);
  }
  if (Number(stethHeartbeat) > p.maxStethHeartbeat) {
    throw new Error(`oracle-policy: ${network} stETH heartbeat ${stethHeartbeat}s exceeds max ${p.maxStethHeartbeat}s.`);
  }
  if (p.requireSequencer && (!sequencer || sequencer.toLowerCase() === ZERO)) {
    throw new Error(`oracle-policy: ${network} REQUIRES an L2 sequencer uptime feed (set ORA_SEQUENCER_FEED).`);
  }
  return true;
}

module.exports = { PROD_NETWORKS, PROD_CHAIN_IDS, POLICY, ZERO, isProdNetwork, isProdChain, assertProdConfig };
