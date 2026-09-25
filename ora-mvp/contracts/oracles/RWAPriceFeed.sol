// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/IPriceFeed.sol";
import "../dependencies08/AggregatorV3Interface.sol";
import "../dependencies08/OraCheckContract.sol";
import "./ChainlinkFeedReader.sol";

/*
 * ORA Phase 4 — NAV oracle adapter for tokenized T-bill / money-market fund
 * collateral (RWA branch).
 *
 * Reads NAV-per-share in USD from an aggregator (on mainnet: the fund
 * administrator's NAV oracle; on testnets: a SettableAggregator). T-bill fund
 * NAV has a very specific shape — it grinds up a few basis points a day and
 * essentially never jumps — so this adapter enforces that shape:
 *
 *  1. UPSIDE DRIFT CLAMP: the price used by the protocol can rise at most
 *     +2% per fetch (a ratchet). A manipulated or fat-fingered NAV spike
 *     cannot instantly inflate borrowing power.
 *
 *  2. BREAK-THE-BUCK BREAKER: NAV drops are accepted immediately and in full
 *     (conservative — collateral is never priced above what the feed
 *     reports), but a drop of more than 2% below the high-water mark flips
 *     the sticky `navShock` flag (monitoring/frontend hook). The flag clears
 *     only when NAV recovers to within 2% of the high-water mark.
 *
 *  3. STALENESS: NAV is published daily on business days; after the timeout
 *     (72h, covering weekends) the adapter falls back to lastGoodPrice and
 *     flags the oracle as down.
 */
contract RWAPriceFeed is OraCheckContract, ChainlinkFeedReader, IPriceFeed {

    string constant public NAME = "RWAPriceFeed";

    AggregatorV3Interface public immutable navAggregator;
    uint8 public immutable navDecimals;
    uint256 public immutable timeout;

    uint256 constant public MAX_UP_DRIFT = 2e16;       // +2% max increase per fetch
    uint256 constant public SHOCK_THRESHOLD = 2e16;    // >2% below high-water mark = shock
    uint256 constant public DECIMAL_PRECISION = 1e18;

    uint256 public lastGoodPrice;
    uint256 public highWaterMark;
    bool public oracleLive;
    bool public navShock;

    event OracleStatusChanged(bool _live);
    event NavShock(bool _active, uint256 _nav, uint256 _highWaterMark);

    constructor(address _navAggregator, uint256 _timeout) {
        checkContract(_navAggregator);
        require(_timeout > 0, "RWAPriceFeed: zero timeout");

        AggregatorV3Interface agg = AggregatorV3Interface(_navAggregator);
        uint8 dec = agg.decimals();

        navAggregator = agg;
        navDecimals = dec;
        timeout = _timeout;

        (uint256 nav, bool ok) = _readFeed(agg, dec, _timeout);
        require(ok, "RWAPriceFeed: initial feed response invalid");
        lastGoodPrice = nav;
        highWaterMark = nav;
        oracleLive = true;
    }

    // View variant for frontends: the price fetchPrice() would use right now.
    function getPrice() external view returns (uint256) {
        (uint256 nav, bool ok) = _readFeed(navAggregator, navDecimals, timeout);
        if (!ok) { return lastGoodPrice; }
        return _clampUp(nav);
    }

    // Raw reported NAV + feed health, for monitoring/UI.
    function getNav() external view returns (uint256 nav, bool ok) {
        return _readFeed(navAggregator, navDecimals, timeout);
    }

    function fetchPrice() external override returns (uint256) {
        (uint256 nav, bool ok) = _readFeed(navAggregator, navDecimals, timeout);

        if (!ok) {
            if (oracleLive) { oracleLive = false; emit OracleStatusChanged(false); }
            return lastGoodPrice;
        }
        if (!oracleLive) { oracleLive = true; emit OracleStatusChanged(true); }

        uint256 price = _clampUp(nav);

        lastGoodPrice = price;
        if (price > highWaterMark) { highWaterMark = price; }

        bool shock = price < highWaterMark * (DECIMAL_PRECISION - SHOCK_THRESHOLD) / DECIMAL_PRECISION;
        if (shock != navShock) {
            navShock = shock;
            emit NavShock(shock, price, highWaterMark);
        }

        emit LastGoodPriceUpdated(price);
        return price;
    }

    // Ratchet: never accept more than +2% above the last accepted price.
    function _clampUp(uint256 _nav) internal view returns (uint256) {
        uint256 cap = lastGoodPrice * (DECIMAL_PRECISION + MAX_UP_DRIFT) / DECIMAL_PRECISION;
        return _nav > cap ? cap : _nav;
    }
}
