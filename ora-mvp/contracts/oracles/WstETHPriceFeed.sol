// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/IPriceFeed.sol";
import "../dependencies08/AggregatorV3Interface.sol";
import "../dependencies08/OraCheckContract.sol";
import "./ChainlinkFeedReader.sol";
import "./SequencerGuard.sol";

interface IWstETHRate {
    function stEthPerToken() external view returns (uint256);
}

/*
 * ORA Phase 1.5 — wstETH/USD composite oracle with depeg circuit breaker.
 *
 *   wstETH/USD = ETH/USD (Chainlink)
 *              x stETH/ETH market rate (Chainlink, capped at 1.0)
 *              x wstETH/stETH exchange rate (from the wstETH contract)
 *
 * Depeg circuit breaker: if the stETH/ETH market rate falls below
 * DEPEG_THRESHOLD, the `depegged` flag flips and DepegCircuitBreaker fires
 * (monitoring/frontend hook). Collateral keeps being priced at the REAL
 * (lower) market rate — conservative for the protocol: no borrowing against
 * phantom value, and underwater troves stay liquidatable. The rate is always
 * capped at 1.0 so stETH is never priced above ETH.
 *
 * If any feed is broken/stale the adapter falls back to lastGoodPrice and
 * flags the oracle as down.
 */
contract WstETHPriceFeed is OraCheckContract, ChainlinkFeedReader, SequencerGuard, IPriceFeed {

    string constant public NAME = "WstETHPriceFeed";

    AggregatorV3Interface public immutable ethUsdAggregator;
    AggregatorV3Interface public immutable stEthEthAggregator;
    IWstETHRate public immutable wstETH;
    uint8 public immutable ethUsdDecimals;
    uint8 public immutable stEthEthDecimals;
    // Per-feed heartbeats: ETH/USD updates far more often than stETH/ETH, so
    // each feed gets its own staleness window (Chainlink heartbeat + margin).
    uint256 public immutable ethUsdTimeout;
    uint256 public immutable stEthEthTimeout;
    uint256 public immutable maxDeviationBps; // max single-fetch move vs lastGoodPrice

    uint256 constant public DEPEG_THRESHOLD = 96e16;  // stETH/ETH < 0.96 trips the breaker
    uint256 constant public RATE_CAP = 1e18;          // stETH never priced above ETH

    uint256 public lastGoodPrice;
    bool public oracleLive;
    bool public depegged;

    event OracleStatusChanged(bool _live);
    event DepegCircuitBreaker(bool _active, uint256 _stEthEthRate);

    constructor(
        address _ethUsdAggregator,
        address _stEthEthAggregator,
        address _wstETH,
        uint256 _ethUsdTimeout,
        uint256 _stEthEthTimeout,
        address _sequencerUptimeFeed,
        uint256 _maxDeviationBps
    ) SequencerGuard(_sequencerUptimeFeed) {
        require(_maxDeviationBps > 0 && _maxDeviationBps <= 10000, "WstETHPriceFeed: bad deviation");
        maxDeviationBps = _maxDeviationBps;
        checkContract(_ethUsdAggregator);
        checkContract(_stEthEthAggregator);
        checkContract(_wstETH);
        if (_sequencerUptimeFeed != address(0)) { checkContract(_sequencerUptimeFeed); }
        require(_ethUsdTimeout > 0 && _stEthEthTimeout > 0, "WstETHPriceFeed: zero timeout");

        AggregatorV3Interface ethAgg = AggregatorV3Interface(_ethUsdAggregator);
        AggregatorV3Interface rateAgg = AggregatorV3Interface(_stEthEthAggregator);
        uint8 ethDec = ethAgg.decimals();
        uint8 rateDec = rateAgg.decimals();

        ethUsdAggregator = ethAgg;
        stEthEthAggregator = rateAgg;
        wstETH = IWstETHRate(_wstETH);
        ethUsdDecimals = ethDec;
        stEthEthDecimals = rateDec;
        ethUsdTimeout = _ethUsdTimeout;
        stEthEthTimeout = _stEthEthTimeout;

        (uint256 price, bool ok, ) = _currentPrice(ethAgg, rateAgg, ethDec, rateDec, IWstETHRate(_wstETH), _ethUsdTimeout, _stEthEthTimeout);
        require(ok, "WstETHPriceFeed: initial feed response invalid");
        require(_sequencerUpAt(_sequencerUptimeFeed), "WstETHPriceFeed: sequencer down at deploy");
        lastGoodPrice = price;
        oracleLive = true;
    }

    function _currentPrice(
        AggregatorV3Interface _ethAgg,
        AggregatorV3Interface _rateAgg,
        uint8 _ethDec,
        uint8 _rateDec,
        IWstETHRate _wst,
        uint256 _ethUsdTimeout,
        uint256 _stEthEthTimeout
    )
        internal
        view
        returns (uint256 price, bool ok, bool depeg)
    {
        (uint256 ethUsd, bool okEth) = _readFeed(_ethAgg, _ethDec, _ethUsdTimeout);
        (uint256 rate, bool okRate) = _readFeed(_rateAgg, _rateDec, _stEthEthTimeout);
        if (!okEth || !okRate) { return (0, false, false); }

        depeg = rate < DEPEG_THRESHOLD;
        if (rate > RATE_CAP) { rate = RATE_CAP; }

        try _wst.stEthPerToken() returns (uint256 perToken) {
            if (perToken == 0) { return (0, false, depeg); }
            price = ethUsd * rate / 1e18 * perToken / 1e18;
            return (price, true, depeg);
        } catch {
            return (0, false, depeg);
        }
    }

    // View variant for frontends.
    function getPrice() external view returns (uint256) {
        if (!_sequencerUp()) { return lastGoodPrice; }
        (uint256 price, bool ok, ) = _currentPrice(
            ethUsdAggregator, stEthEthAggregator, ethUsdDecimals, stEthEthDecimals, wstETH, ethUsdTimeout, stEthEthTimeout);
        if (ok) {
            uint256 diff = price > lastGoodPrice ? price - lastGoodPrice : lastGoodPrice - price;
            if (diff * 10000 > lastGoodPrice * maxDeviationBps) { ok = false; }
        }
        return ok ? price : lastGoodPrice;
    }

    // Current stETH/ETH market rate (uncapped) + feed health, for monitoring/UI.
    function getStEthEthRate() external view returns (uint256 rate, bool ok) {
        return _readFeed(stEthEthAggregator, stEthEthDecimals, stEthEthTimeout);
    }

    function fetchPrice() external override returns (uint256) {
        if (!_sequencerUp()) {
            if (oracleLive) { oracleLive = false; emit OracleStatusChanged(false); }
            return lastGoodPrice;
        }
        (uint256 price, bool ok, bool depeg) = _currentPrice(
            ethUsdAggregator, stEthEthAggregator, ethUsdDecimals, stEthEthDecimals, wstETH, ethUsdTimeout, stEthEthTimeout);

        // Deviation guard: a composite move beyond maxDeviationBps in a single
        // fetch is treated as a broken input (no secondary composite source to
        // confirm) — serve lastGoodPrice, flag the oracle down.
        if (ok) {
            uint256 diff = price > lastGoodPrice ? price - lastGoodPrice : lastGoodPrice - price;
            if (diff * 10000 > lastGoodPrice * maxDeviationBps) { ok = false; }
        }

        if (!ok) {
            if (oracleLive) { oracleLive = false; emit OracleStatusChanged(false); }
            return lastGoodPrice;
        }

        if (!oracleLive) { oracleLive = true; emit OracleStatusChanged(true); }
        if (depeg != depegged) {
            depegged = depeg;
            (uint256 rawRate, ) = _readFeed(stEthEthAggregator, stEthEthDecimals, stEthEthTimeout);
            emit DepegCircuitBreaker(depeg, rawRate);
        }

        lastGoodPrice = price;
        emit LastGoodPriceUpdated(price);
        return price;
    }
}
