// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IPriceFeed.sol";
import "../Dependencies/AggregatorV3Interface.sol";
import "../Dependencies/CheckContract.sol";
import "./ChainlinkFeedReader.sol";

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
contract WstETHPriceFeed is CheckContract, ChainlinkFeedReader, IPriceFeed {
    using SafeMath for uint256;

    string constant public NAME = "WstETHPriceFeed";

    AggregatorV3Interface public immutable ethUsdAggregator;
    AggregatorV3Interface public immutable stEthEthAggregator;
    IWstETHRate public immutable wstETH;
    uint8 public immutable ethUsdDecimals;
    uint8 public immutable stEthEthDecimals;
    uint public immutable timeout;

    uint constant public DEPEG_THRESHOLD = 96e16;  // stETH/ETH < 0.96 trips the breaker
    uint constant public RATE_CAP = 1e18;          // stETH never priced above ETH

    uint public lastGoodPrice;
    bool public oracleLive;
    bool public depegged;

    event OracleStatusChanged(bool _live);
    event DepegCircuitBreaker(bool _active, uint _stEthEthRate);

    constructor(
        address _ethUsdAggregator,
        address _stEthEthAggregator,
        address _wstETH,
        uint _timeout
    ) public {
        checkContract(_ethUsdAggregator);
        checkContract(_stEthEthAggregator);
        checkContract(_wstETH);
        require(_timeout > 0, "WstETHPriceFeed: zero timeout");

        AggregatorV3Interface ethAgg = AggregatorV3Interface(_ethUsdAggregator);
        AggregatorV3Interface rateAgg = AggregatorV3Interface(_stEthEthAggregator);
        uint8 ethDec = ethAgg.decimals();
        uint8 rateDec = rateAgg.decimals();

        ethUsdAggregator = ethAgg;
        stEthEthAggregator = rateAgg;
        wstETH = IWstETHRate(_wstETH);
        ethUsdDecimals = ethDec;
        stEthEthDecimals = rateDec;
        timeout = _timeout;

        (uint price, bool ok, ) = _currentPrice(ethAgg, rateAgg, ethDec, rateDec, IWstETHRate(_wstETH), _timeout);
        require(ok, "WstETHPriceFeed: initial feed response invalid");
        lastGoodPrice = price;
        oracleLive = true;
    }

    function _currentPrice(
        AggregatorV3Interface _ethAgg,
        AggregatorV3Interface _rateAgg,
        uint8 _ethDec,
        uint8 _rateDec,
        IWstETHRate _wst,
        uint _timeout
    )
        internal
        view
        returns (uint price, bool ok, bool depeg)
    {
        (uint ethUsd, bool okEth) = _readFeed(_ethAgg, _ethDec, _timeout);
        (uint rate, bool okRate) = _readFeed(_rateAgg, _rateDec, _timeout);
        if (!okEth || !okRate) { return (0, false, false); }

        depeg = rate < DEPEG_THRESHOLD;
        if (rate > RATE_CAP) { rate = RATE_CAP; }

        try _wst.stEthPerToken() returns (uint256 perToken) {
            if (perToken == 0) { return (0, false, depeg); }
            price = ethUsd.mul(rate).div(1e18).mul(perToken).div(1e18);
            return (price, true, depeg);
        } catch {
            return (0, false, depeg);
        }
    }

    // View variant for frontends.
    function getPrice() external view returns (uint) {
        (uint price, bool ok, ) = _currentPrice(
            ethUsdAggregator, stEthEthAggregator, ethUsdDecimals, stEthEthDecimals, wstETH, timeout);
        return ok ? price : lastGoodPrice;
    }

    // Current stETH/ETH market rate (uncapped) + feed health, for monitoring/UI.
    function getStEthEthRate() external view returns (uint rate, bool ok) {
        return _readFeed(stEthEthAggregator, stEthEthDecimals, timeout);
    }

    function fetchPrice() external override returns (uint) {
        (uint price, bool ok, bool depeg) = _currentPrice(
            ethUsdAggregator, stEthEthAggregator, ethUsdDecimals, stEthEthDecimals, wstETH, timeout);

        if (!ok) {
            if (oracleLive) { oracleLive = false; emit OracleStatusChanged(false); }
            return lastGoodPrice;
        }

        if (!oracleLive) { oracleLive = true; emit OracleStatusChanged(true); }
        if (depeg != depegged) {
            depegged = depeg;
            (uint rawRate, ) = _readFeed(stEthEthAggregator, stEthEthDecimals, timeout);
            emit DepegCircuitBreaker(depeg, rawRate);
        }

        lastGoodPrice = price;
        emit LastGoodPriceUpdated(price);
        return price;
    }
}
