// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IPriceFeed.sol";
import "../Dependencies/AggregatorV3Interface.sol";
import "../Dependencies/CheckContract.sol";
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
contract RWAPriceFeed is CheckContract, ChainlinkFeedReader, IPriceFeed {
    using SafeMath for uint256;

    string constant public NAME = "RWAPriceFeed";

    AggregatorV3Interface public immutable navAggregator;
    uint8 public immutable navDecimals;
    uint public immutable timeout;

    uint constant public MAX_UP_DRIFT = 2e16;       // +2% max increase per fetch
    uint constant public SHOCK_THRESHOLD = 2e16;    // >2% below high-water mark = shock
    uint constant public DECIMAL_PRECISION = 1e18;

    uint public lastGoodPrice;
    uint public highWaterMark;
    bool public oracleLive;
    bool public navShock;

    event OracleStatusChanged(bool _live);
    event NavShock(bool _active, uint _nav, uint _highWaterMark);

    constructor(address _navAggregator, uint _timeout) public {
        checkContract(_navAggregator);
        require(_timeout > 0, "RWAPriceFeed: zero timeout");

        AggregatorV3Interface agg = AggregatorV3Interface(_navAggregator);
        uint8 dec = agg.decimals();

        navAggregator = agg;
        navDecimals = dec;
        timeout = _timeout;

        (uint nav, bool ok) = _readFeed(agg, dec, _timeout);
        require(ok, "RWAPriceFeed: initial feed response invalid");
        lastGoodPrice = nav;
        highWaterMark = nav;
        oracleLive = true;
    }

    // View variant for frontends: the price fetchPrice() would use right now.
    function getPrice() external view returns (uint) {
        (uint nav, bool ok) = _readFeed(navAggregator, navDecimals, timeout);
        if (!ok) { return lastGoodPrice; }
        return _clampUp(nav);
    }

    // Raw reported NAV + feed health, for monitoring/UI.
    function getNav() external view returns (uint nav, bool ok) {
        return _readFeed(navAggregator, navDecimals, timeout);
    }

    function fetchPrice() external override returns (uint) {
        (uint nav, bool ok) = _readFeed(navAggregator, navDecimals, timeout);

        if (!ok) {
            if (oracleLive) { oracleLive = false; emit OracleStatusChanged(false); }
            return lastGoodPrice;
        }
        if (!oracleLive) { oracleLive = true; emit OracleStatusChanged(true); }

        uint price = _clampUp(nav);

        lastGoodPrice = price;
        if (price > highWaterMark) { highWaterMark = price; }

        bool shock = price < highWaterMark.mul(DECIMAL_PRECISION.sub(SHOCK_THRESHOLD)).div(DECIMAL_PRECISION);
        if (shock != navShock) {
            navShock = shock;
            emit NavShock(shock, price, highWaterMark);
        }

        emit LastGoodPriceUpdated(price);
        return price;
    }

    // Ratchet: never accept more than +2% above the last accepted price.
    function _clampUp(uint _nav) internal view returns (uint) {
        uint cap = lastGoodPrice.mul(DECIMAL_PRECISION.add(MAX_UP_DRIFT)).div(DECIMAL_PRECISION);
        return _nav > cap ? cap : _nav;
    }
}
