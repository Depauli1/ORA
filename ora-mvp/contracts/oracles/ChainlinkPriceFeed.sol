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
 *
 * Multi-source hardening (upstream-Liquity philosophy):
 *  - DEVIATION GUARD: a new round that moves more than maxDeviationBps from
 *    lastGoodPrice in a single fetch is NOT trusted on its own — flash-crash
 *    prints and manipulated rounds cannot instantly reprice the protocol.
 *  - SECONDARY SOURCE: an optional fallback aggregator (different provider).
 *    A large move IS accepted when both sources agree on it (a real market
 *    crash confirmed twice), and the fallback serves prices alone while the
 *    primary is broken/stale. Only when neither path yields a trustworthy
 *    price does the adapter serve lastGoodPrice and flag the oracle down.
 */
contract ChainlinkPriceFeed is CheckContract, ChainlinkFeedReader, SequencerGuard, IPriceFeed {

    string constant public NAME = "ChainlinkPriceFeed";

    AggregatorV3Interface public immutable aggregator;
    uint8 public immutable feedDecimals;
    uint public immutable timeout;  // seconds until a round is considered stale

    AggregatorV3Interface public immutable fallbackAggregator; // address(0) = none
    uint8 public immutable fallbackDecimals;
    uint public immutable maxDeviationBps; // max single-fetch move vs lastGoodPrice without confirmation

    uint public lastGoodPrice;
    bool public oracleLive;
    bool public usingFallback; // monitoring hook: primary broken, secondary serving

    event OracleStatusChanged(bool _live);
    event FallbackStatusChanged(bool _usingFallback);

    constructor(
        address _aggregator,
        uint _timeout,
        address _sequencerUptimeFeed,
        address _fallbackAggregator,
        uint _maxDeviationBps
    )
        public
        SequencerGuard(_sequencerUptimeFeed)
    {
        checkContract(_aggregator);
        if (_sequencerUptimeFeed != address(0)) { checkContract(_sequencerUptimeFeed); }
        require(_timeout > 0, "ChainlinkPriceFeed: zero timeout");
        require(_maxDeviationBps > 0 && _maxDeviationBps <= 10000, "ChainlinkPriceFeed: bad deviation");

        AggregatorV3Interface agg = AggregatorV3Interface(_aggregator);
        uint8 dec = agg.decimals();

        aggregator = agg;
        feedDecimals = dec;
        timeout = _timeout;
        maxDeviationBps = _maxDeviationBps;

        uint8 fbDec = 0;
        if (_fallbackAggregator != address(0)) {
            checkContract(_fallbackAggregator);
            fbDec = AggregatorV3Interface(_fallbackAggregator).decimals();
        }
        fallbackAggregator = AggregatorV3Interface(_fallbackAggregator);
        fallbackDecimals = fbDec;

        (uint price, bool ok) = _readFeed(agg, dec, _timeout);
        require(ok, "ChainlinkPriceFeed: initial feed response invalid");
        require(_sequencerUpAt(_sequencerUptimeFeed), "ChainlinkPriceFeed: sequencer down at deploy");
        lastGoodPrice = price;
        oracleLive = true;
    }

    // |a - b| within maxDeviationBps of b
    function _withinDeviation(uint _a, uint _b) internal view returns (bool) {
        uint diff = _a > _b ? _a - _b : _b - _a;
        return diff * 10000 <= _b * maxDeviationBps;
    }

    /* Resolve the trustworthy current price:
     *   ok=true  -> price accepted (fb = served by the fallback source)
     *   ok=false -> nothing trustworthy, caller serves lastGoodPrice */
    function _resolvePrice() internal view returns (uint price, bool ok, bool fb) {
        (uint pP, bool okP) = _readFeed(aggregator, feedDecimals, timeout);
        bool hasFb = address(fallbackAggregator) != address(0);
        uint pF; bool okF;
        if (hasFb) { (pF, okF) = _readFeed(fallbackAggregator, fallbackDecimals, timeout); }

        if (okP) {
            if (_withinDeviation(pP, lastGoodPrice)) { return (pP, true, false); }
            // big move: accept only if the second source confirms it
            if (okF && _withinDeviation(pP, pF)) { return (pP, true, false); }
            return (0, false, false);
        }
        // primary broken/stale: the fallback may serve, within deviation bounds
        if (okF && _withinDeviation(pF, lastGoodPrice)) { return (pF, true, true); }
        return (0, false, false);
    }

    // View variant for frontends: current price if healthy, else lastGoodPrice.
    function getPrice() external view returns (uint) {
        if (!_sequencerUp()) { return lastGoodPrice; }
        (uint price, bool ok, ) = _resolvePrice();
        return ok ? price : lastGoodPrice;
    }

    function fetchPrice() external override returns (uint) {
        if (!_sequencerUp()) {
            if (oracleLive) { oracleLive = false; emit OracleStatusChanged(false); }
            return lastGoodPrice;
        }
        (uint price, bool ok, bool fb) = _resolvePrice();
        if (ok) {
            lastGoodPrice = price;
            if (!oracleLive) { oracleLive = true; emit OracleStatusChanged(true); }
            if (fb != usingFallback) { usingFallback = fb; emit FallbackStatusChanged(fb); }
            emit LastGoodPriceUpdated(price);
            return price;
        }
        if (oracleLive) { oracleLive = false; emit OracleStatusChanged(false); }
        return lastGoodPrice;
    }
}
