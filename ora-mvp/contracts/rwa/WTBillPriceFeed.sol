// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/SafeMath.sol";
import "../Interfaces/IPriceFeed.sol";

interface IRWAFeed {
    function fetchPrice() external returns (uint256);
    function getPrice() external view returns (uint256);
    function oracleLive() external view returns (bool);
    function navShock() external view returns (bool);
}

interface IWTBillRate {
    function currentRate() external view returns (uint256);
}

/*
 * ORA RWA yield share — price feed for wmTBILL collateral.
 *
 * wmTBILL USD price = mTBILL NAV (from the RWAPriceFeed, with its +2%/update
 * upside clamp, break-the-buck shock flag and staleness fallback) × the
 * wrapper's current mTBILL-per-share rate. All safety machinery of the
 * underlying NAV feed passes through untouched.
 */
contract WTBillPriceFeed is IPriceFeed {
    using SafeMath for uint256;

    string public constant NAME = "WTBillPriceFeed";
    uint256 internal constant DECIMAL_PRECISION = 1e18;

    IRWAFeed public immutable navFeed;
    IWTBillRate public immutable wrapper;

    constructor(address _navFeed, address _wrapper) public {
        require(_navFeed != address(0) && _wrapper != address(0), "WTBillPriceFeed: zero address");
        navFeed = IRWAFeed(_navFeed);
        wrapper = IWTBillRate(_wrapper);
    }

    function fetchPrice() external override returns (uint256) {
        uint256 nav = navFeed.fetchPrice();
        return nav.mul(wrapper.currentRate()).div(DECIMAL_PRECISION);
    }

    function getPrice() external view returns (uint256) {
        uint256 nav = navFeed.getPrice();
        return nav.mul(wrapper.currentRate()).div(DECIMAL_PRECISION);
    }

    function oracleLive() external view returns (bool) {
        return navFeed.oracleLive();
    }

    function navShock() external view returns (bool) {
        return navFeed.navShock();
    }
}
