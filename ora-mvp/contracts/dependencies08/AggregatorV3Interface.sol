// SPDX-License-Identifier: MIT
// 0.8.24 twin of Dependencies/AggregatorV3Interface.sol (identical selectors).
// Source: https://github.com/smartcontractkit/chainlink/blob/master/evm-contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol

pragma solidity 0.8.24;

interface AggregatorV3Interface {
  function decimals() external view returns (uint8);
  function description() external view returns (string memory);
  function version() external view returns (uint256);

  function getRoundData(uint80 _roundId)
    external
    view
    returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    );

  function latestRoundData()
    external
    view
    returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    );
}
