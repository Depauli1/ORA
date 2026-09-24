// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

// 0.8.24 twin of Interfaces/IPriceFeed.sol (identical selectors/event).
interface IPriceFeed {
    event LastGoodPriceUpdated(uint _lastGoodPrice);

    function fetchPrice() external returns (uint256);
}
