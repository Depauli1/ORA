// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/AggregatorV3Interface.sol";

/*
 * ORA oracle hardening — Chainlink L2 sequencer-uptime check (Base et al).
 *
 * On OP-stack L2s a sequencer outage freezes on-chain activity while Chainlink
 * answers keep their last value; when the sequencer restarts, stale prices
 * would briefly be accepted as fresh. Chainlink's guidance: read the L2
 * Sequencer Uptime Feed (answer 0 = up, 1 = down) before trusting any data
 * feed, and wait a grace period after a restart so feeds can catch up.
 *
 * The guard is optional: pass address(0) on L1s / local chains to disable.
 * NOTE: the uptime feed itself is NOT staleness-checked — it only updates on
 * status changes (per Chainlink docs).
 *
 * Base mainnet uptime feed: 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433
 */
abstract contract SequencerGuard {

    AggregatorV3Interface public immutable sequencerUptimeFeed; // address(0) = disabled
    uint256 constant public SEQUENCER_GRACE_PERIOD = 3600;      // 1h after restart

    constructor(address _sequencerUptimeFeed) {
        sequencerUptimeFeed = AggregatorV3Interface(_sequencerUptimeFeed);
    }

    // true iff no guard configured, or the sequencer is up and out of grace
    function _sequencerUp() internal view returns (bool) {
        return _sequencerUpAt(address(sequencerUptimeFeed));
    }

    // address-parameterized variant so deploy-time checks can pass the address
    // in (immutables read fine in 0.8 constructors, but the shared helper
    // keeps every call site on one code path)
    function _sequencerUpAt(address _feed) internal view returns (bool) {
        if (_feed == address(0)) { return true; }
        try AggregatorV3Interface(_feed).latestRoundData() returns (
            uint80, int256 answer, uint256 startedAt, uint256, uint80
        ) {
            if (answer != 0) { return false; }                    // sequencer down
            if (startedAt > block.timestamp) { return false; }    // nonsense round
            if (block.timestamp - startedAt < SEQUENCER_GRACE_PERIOD) { return false; } // just restarted
            return true;
        } catch {
            return false; // a broken uptime feed is treated as "unknown -> unsafe"
        }
    }

    // Monitoring/frontend hook
    function sequencerUp() external view returns (bool) {
        return _sequencerUp();
    }
}
