// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IPriceFeed.sol";
import "../Dependencies/AggregatorV3Interface.sol";
import "../Dependencies/CheckContract.sol";
import "./ChainlinkFeedReader.sol";
import "./SequencerGuard.sol";

/*
 * ORA Phase 1.5 — Chainlink adapter for native-collateral branches (ETH/USD).
 *
 * fetchPrice(): returns the current Chainlink price when the feed is healthy,
 * updating lastGoodPrice; on a broken/stale feed it flags the oracle as down
 * and falls back to lastGoodPrice (same fallback philosophy as upstream
 * Liquity's PriceFeed, single-oracle variant — a secondary oracle can be
 * added per branch later).
 *
 * L2 hardening: when a sequencer uptime feed is configured (Base/OP-stack
 * deployments), a sequencer outage — or the 1h grace period after a restart —
 * is treated exactly like a broken feed: oracle flagged down, lastGoodPrice
 * served. Pass address(0) on L1s and local chains.
 */
contract ChainlinkPriceFeed is CheckContract, ChainlinkFeedReader, SequencerGuard, IPriceFeed {

    string constant public NAME = "ChainlinkPriceFeed";

    AggregatorV3Interface public immutable aggregator;
    uint8 public immutable feedDecimals;
    uint public immutable timeout;  // seconds until a round is considered stale

    uint public lastGoodPrice;
    bool public oracleLive;

    event OracleStatusChanged(bool _live);

    constructor(address _aggregator, uint _timeout, address _sequencerUptimeFeed)
        public
        SequencerGuard(_sequencerUptimeFeed)
    {
        checkContract(_aggregator);
        if (_sequencerUptimeFeed != address(0)) { checkContract(_sequencerUptimeFeed); }
        require(_timeout > 0, "ChainlinkPriceFeed: zero timeout");

        AggregatorV3Interface agg = AggregatorV3Interface(_aggregator);
        uint8 dec = agg.decimals();

        aggregator = agg;
        feedDecimals = dec;
        timeout = _timeout;

        (uint price, bool ok) = _readFeed(agg, dec, _timeout);
        require(ok, "ChainlinkPriceFeed: initial feed response invalid");
        require(_sequencerUpAt(_sequencerUptimeFeed), "ChainlinkPriceFeed: sequencer down at deploy");
        lastGoodPrice = price;
        oracleLive = true;
    }

    // View variant for frontends: current price if healthy, else lastGoodPrice.
    function getPrice() external view returns (uint) {
        if (!_sequencerUp()) { return lastGoodPrice; }
        (uint price, bool ok) = _readFeed(aggregator, feedDecimals, timeout);
        return ok ? price : lastGoodPrice;
    }

    function fetchPrice() external override returns (uint) {
        if (!_sequencerUp()) {
            if (oracleLive) { oracleLive = false; emit OracleStatusChanged(false); }
            return lastGoodPrice;
        }
        (uint price, bool ok) = _readFeed(aggregator, feedDecimals, timeout);
        if (ok) {
            lastGoodPrice = price;
            if (!oracleLive) { oracleLive = true; emit OracleStatusChanged(true); }
            emit LastGoodPriceUpdated(price);
            return price;
        }
        if (oracleLive) { oracleLive = false; emit OracleStatusChanged(false); }
        return lastGoodPrice;
    }
}
