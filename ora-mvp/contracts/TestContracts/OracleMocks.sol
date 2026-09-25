// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../dependencies08/AggregatorV3Interface.sol";

/* Test-only aggregators for the oracle failure matrix (excluded from the
 * coverage gate): a reverting feed and a feed stuck in the future. */

// latestRoundData always reverts (exercises the reader's catch branch).
contract MockRevertingAggregator is AggregatorV3Interface {
    function decimals() external pure override returns (uint8) { return 8; }
    function description() external pure override returns (string memory) { return "REVERT"; }
    function version() external pure override returns (uint256) { return 1; }
    function getRoundData(uint80) external pure override
        returns (uint80, int256, uint256, uint256, uint80) { revert("MockRevertingAggregator: no data"); }
    function latestRoundData() external pure override
        returns (uint80, int256, uint256, uint256, uint80) { revert("MockRevertingAggregator: no data"); }
}

// updatedAt/startedAt always 1h in the future (exercises the future-round guards).
contract MockFutureAggregator is AggregatorV3Interface {
    int256 private immutable _answer;
    constructor(int256 answer_) { _answer = answer_; }
    function decimals() external pure override returns (uint8) { return 8; }
    function description() external pure override returns (string memory) { return "FUTURE"; }
    function version() external pure override returns (uint256) { return 1; }
    function getRoundData(uint80) external view override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, _answer, block.timestamp + 3600, block.timestamp + 3600, 1);
    }
    function latestRoundData() external view override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, _answer, block.timestamp + 3600, block.timestamp + 3600, 1);
    }
}
