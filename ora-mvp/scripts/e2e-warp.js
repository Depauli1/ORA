// e2e chain prep: jump past the 14-day redemption bootstrap window and
// refresh every settable aggregator so the oracles stay live afterwards.
//
// Why: `redeemCollateral` reverts until systemDeploymentTime + BOOTSTRAP_PERIOD
// (14 days) — a fresh e2e deployment can never exercise the redemption flow.
// Warping 14 days alone would then stale every feed (48h heartbeat in the
// testnet config), tripping the oracle-down banner and the stale-data action
// lockout. So: warp, then re-answer the aggregators (SettableAggregator's
// setAnswer refreshes updatedAt), which is exactly what the UI simulator
// does when a human drives it.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const BOOTSTRAP = 14 * 24 * 3600; // must match TroveManager.BOOSTSTRAP_PERIOD + margin

async function main() {
  const { ethers } = hre;
  await ethers.provider.send("evm_increaseTime", [BOOTSTRAP]);
  await ethers.provider.send("evm_mine", []);

  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "deployment.json")));
  const settable = [
    ["ETH/USD", dep.branches?.ETH?.ethUsdAggregator, 2000n * 10n ** 8n],
    ["stETH/ETH", dep.branches?.wstETH?.stEthEthAggregator, 10n ** 18n],
    ["mTBILL NAV", dep.branches?.tBILL?.navAggregator, 105n * 10n ** 6n],
    ["seq uptime", dep.shared?.sequencerSettable ? dep.shared.sequencerUptimeFeed : null, 0n],
    ["ETH/USD fallback", dep.shared?.ethUsdFallbackSettable ? dep.shared.ethUsdFallbackAggregator : null, 2000n * 10n ** 8n],
  ];
  const abi = ["function setAnswer(int256)"];
  for (const [name, addr, answer] of settable) {
    if (!addr) continue;
    await new ethers.Contract(addr, abi, (await ethers.getSigners())[0]).setAnswer(answer);
    console.log(`  refreshed ${name} aggregator ${addr}`);
  }
  console.log(`chain warped +${BOOTSTRAP}s past the redemption bootstrap window`);
}

main().catch((e) => { console.error(e); process.exit(1); });
